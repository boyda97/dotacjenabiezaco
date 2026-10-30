"""Model danych: Program (nabór/dotacja) i CompanyProfile (profil firmy klienta)."""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Optional

from . import taxonomy as tx


def _iso(value) -> Optional[date]:
    try:
        return date.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


@dataclass
class Program:
    """Jeden nabór/program wsparcia.

    Pola kryteriów (regions, forms, sizes, sectors) mają znaczenie:
      None  -> brak ograniczenia (np. cała Polska) albo nie udało się ustalić,
      lista -> tylko wymienione wartości.
    `unknown` wymienia kryteria, których klasyfikator nie ustalił z tekstu -
    dopasowanie nie odrzuca wtedy programu, tylko oznacza je "do sprawdzenia".
    """

    source: str
    source_id: str
    name: str
    url: str
    op: str = ""                      # operator / instytucja, np. "PARP · FENG"
    type: str = "dotacja"             # dotacja | pozyczka | mieszane
    status: str = "open"              # open | soon | closed
    start: Optional[str] = None       # ISO yyyy-mm-dd
    deadline: Optional[str] = None
    min: Optional[int] = None         # kwota wsparcia w PLN
    max: Optional[int] = None
    level: str = ""                   # np. "do 80 %"
    regions: Optional[list] = None
    forms: Optional[list] = None
    sizes: Optional[list] = None
    sectors: Optional[list] = None
    goals: list = field(default_factory=list)
    requires: list = field(default_factory=list)       # status osoby, wystarczy jeden z listy (taxonomy.PERSON)
    requires_all: list = field(default_factory=list)   # warunki obowiązkowe, np. bez_dg_12m
    pkd_excluded: list = field(default_factory=list)   # prefiksy kodów PKD wykluczonych, np. ["01", "46.1"]
    docs: list = field(default_factory=list)           # linki do regulaminów (PDF) - wejście dla ekstrakcji AI
    how: str = ""
    apply_where: str = ""                              # gdzie i jak złożyć wniosek, np. "w systemie LSI PARP"
    documents: list = field(default_factory=list)      # dokumenty do przygotowania (z regulaminu)
    description: str = ""
    unknown: list = field(default_factory=list)
    ai_extracted: bool = False

    @property
    def key(self) -> str:
        return f"{self.source}:{self.source_id}"

    def fingerprint(self) -> str:
        """Skrót treści - zmiana oznacza aktualizację naboru (np. przesunięty termin)."""
        d = asdict(self)
        d.pop("status", None)  # status wynika z dat, nie traktujemy go jako zmiany treści
        raw = json.dumps(d, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    @property
    def deadline_date(self) -> Optional[date]:
        """None dla naborów ciągłych / bez daty ("nabór ciągły" itp.)."""
        return _iso(self.deadline)

    def refresh_status(self, today: Optional[date] = None) -> None:
        today = today or date.today()
        end, start = _iso(self.deadline), _iso(self.start)
        if end and end < today:
            self.status = "closed"
        elif start and start > today:
            self.status = "soon"
        elif self.status == "soon" and start and start <= today:
            self.status = "open"
        elif self.status == "closed" and end and end >= today:
            self.status = "open"

    def to_dict(self) -> dict:
        return asdict(self)

    def to_page_dict(self) -> dict:
        """Format zgodny z tablicą PROGRAMS na stronie (null = bez ograniczeń)."""
        return {
            "id": self.key, "name": self.name, "op": self.op, "type": self.type,
            "status": self.status, "deadline": self.deadline, "min": self.min,
            "max": self.max, "level": self.level, "regions": self.regions,
            "forms": self.forms or list(tx.FORMS), "sizes": self.sizes or list(tx.SIZES),
            "sectors": self.sectors or list(tx.SECTORS), "goals": self.goals,
            "requires": self.requires, "requires_all": self.requires_all, "how": self.how, "url": self.url,
            "apply_where": self.apply_where, "documents": self.documents,
            "source": self.source, "checked": getattr(self, "checked", None),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Program":
        known = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class CompanyProfile:
    """Profil firmy z formularza (lub z rejestru po NIP).

    Osoba, która dopiero planuje firmę: form="none", size="start", bez NIP; sector/pkd = planowana branża,
    person = status osoby (bezrobotna, do 30 lat, ...), bo od niego zależą dotacje na start."""

    region: str
    form: str
    size: str
    sector: Optional[str] = None      # klucz z taxonomy.SECTORS
    pkd: Optional[str] = None         # np. "73.11.Z" - jeśli podany, wyznacza sector
    goals: list = field(default_factory=list)   # puste = dowolny cel
    types: list = field(default_factory=lambda: list(tx.TYPES))
    amount: Optional[int] = None      # orientacyjna potrzebna kwota w PLN
    nip: Optional[str] = None
    name: str = ""
    email: Optional[str] = None
    person: list = field(default_factory=list)  # klucze taxonomy.PERSON
    gmina: Optional[str] = None                  # planowane miejsce działalności (LGD, PUP właściwy dla gminy)

    @property
    def founder(self) -> bool:
        return self.form == "none" or self.size == "start"

    def __post_init__(self):
        if self.form == "none":
            self.size, self.nip = "start", None
        if not self.sector and self.pkd:
            self.sector = tx.sector_from_pkd(self.pkd)
        for fld, allowed in (("region", tx.REGIONS), ("form", tx.FORMS), ("size", tx.SIZES)):
            if getattr(self, fld) not in allowed:
                raise ValueError(f"Nieznana wartość {fld}={getattr(self, fld)!r}")
        if self.sector and self.sector not in tx.SECTORS:
            raise ValueError(f"Nieznana sekcja PKD: {self.sector!r}")
        bad = [g for g in self.goals if g not in tx.GOALS] + [x for x in self.person if x not in tx.PERSON]
        if bad:
            raise ValueError(f"Nieznane cele / statusy osoby: {bad}")

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CompanyProfile":
        d = dict(d)
        if "goal" in d and "goals" not in d:  # pojedynczy cel z formularza strony
            g = d.pop("goal")
            d["goals"] = [g] if g else []
        known = cls.__dataclass_fields__.keys()
        return cls(**{k: v for k, v in d.items() if k in known})
