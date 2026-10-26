"""Dopasowanie programów do profilu firmy.

Punktacja jest zgodna ze stroną (region 25, wielkość 25, branża 15, cel 35 lub 20
przy "dowolnym celu"), rozszerzona o:
  - kryteria nieustalone przez klasyfikator ("do sprawdzenia" zamiast odrzucenia, połowa punktów),
  - wiele celów naraz, podsekcje PKD (C10 w C, N79 w N),
  - dopasowanie kwoty i bliskość terminu.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Optional

from . import taxonomy as tx
from .models import CompanyProfile, Program

OK, FAIL, CHECK = "ok", "fail", "check"


@dataclass
class Reason:
    text: str
    state: str  # ok | fail | check

    def to_dict(self):
        return {"t": self.text, "state": self.state, "ok": self.state == OK}


@dataclass
class MatchResult:
    program: Program
    score: int
    eligible: bool
    reasons: list = field(default_factory=list)
    days_left: Optional[int] = None

    @property
    def urgent(self) -> bool:
        return self.days_left is not None and 0 <= self.days_left <= 14

    def to_dict(self) -> dict:
        return {
            "program": self.program.to_page_dict(), "score": self.score,
            "eligible": self.eligible, "urgent": self.urgent, "days_left": self.days_left,
            "why": [r.to_dict() for r in self.reasons],
        }


def _criterion(values, wanted, unknown, label_ok, label_fail, covers=None):
    """Zwraca stan kryterium: OK / FAIL / CHECK."""
    if values is None:
        return (CHECK, None) if unknown else (OK, label_ok)
    hit = any((covers(v, wanted) if covers else v == wanted) for v in values)
    return (OK, label_ok) if hit else (FAIL, label_fail)


def score(program: Program, profile: CompanyProfile, today: Optional[date] = None,
          include_closed: bool = False) -> MatchResult:
    today = today or date.today()
    why: list[Reason] = []
    pts = 0.0
    unk = set(program.unknown or [])

    def fail(text):
        why.append(Reason(text, FAIL))
        return MatchResult(program, 0, False, why)

    if program.status == "closed" and not include_closed:
        return fail("nabór zamknięty")
    if program.type not in profile.types:
        return fail(f"odrzucona forma wsparcia: {tx.TYPES.get(program.type, program.type)}")

    # region (25)
    st, _ = _criterion(program.regions, profile.region, "regions" in unk, "", "")
    if st == FAIL:
        return fail("program dla innego województwa")
    pts += 25 if st == OK else 12.5
    why.append(Reason("cała Polska" if program.regions is None and st == OK else
                      ("Twoje województwo" if st == OK else "region do sprawdzenia"), st))

    # forma prawna (bez punktów, tylko filtr)
    st, _ = _criterion(program.forms, profile.form, "forms" in unk, "", "")
    if st == FAIL:
        return fail("forma działalności nie kwalifikuje się")
    why.append(Reason(tx.FORMS[profile.form] if st == OK else "forma działalności do sprawdzenia", st))

    # wielkość (25)
    st, _ = _criterion(program.sizes, profile.size, "sizes" in unk, "", "")
    if st == FAIL:
        return fail("wielkość firmy nie kwalifikuje się")
    pts += 25 if st == OK else 12.5
    size_txt = "dla nowych firm" if profile.size == "start" else f"{tx.SIZES[profile.size]} firma"
    why.append(Reason(size_txt if st == OK else "wielkość firmy do sprawdzenia", st))

    # branża (15)
    if profile.sector is None:
        pts += 7.5
        why.append(Reason("podaj branżę (PKD), by zawęzić wyniki", CHECK))
    else:
        st, _ = _criterion(program.sectors, profile.sector, "sectors" in unk, "", "",
                           covers=tx.sector_covers)
        if st == FAIL:
            return fail("branża poza zakresem programu")
        pts += 15 if st == OK else 7.5
        why.append(Reason(f"branża: {tx.SECTORS[profile.sector]}" if st == OK else "branża do sprawdzenia", st))

    # wykluczenia PKD (z regulaminu, zwykle ustalane przez ekstrakcję AI)
    if profile.pkd and program.pkd_excluded:
        code = profile.pkd.replace(" ", "")
        if any(code.startswith(prefix) for prefix in program.pkd_excluded):
            return fail(f"PKD {profile.pkd} jest wykluczone w regulaminie")

    # status osoby (dotacje na start: urząd pracy, PFRON, LGD, projekty FSE+)
    if program.requires:
        have = [x for x in program.requires if x in profile.person]
        if have:
            pts += 5
            why += [Reason(tx.PERSON[x], OK) for x in have[:2]]
        else:
            pts -= 10
            need = " lub ".join(tx.PERSON[x] for x in program.requires[:3])
            hint = next((tx.PERSON_HINT[x] for x in program.requires if x in tx.PERSON_HINT), None)
            why.append(Reason(f"wymagany status: {need}" + (f" – {hint}" if hint else ""), CHECK))

    # cel (35 / 20)
    if profile.goals:
        hits = [g for g in profile.goals if g in program.goals]
        if hits:
            # pełne punkty za pierwszy trafiony cel, premia za każdy kolejny (do limitu 100)
            pts += 35 + 3 * (len(hits) - 1)
            why += [Reason(f"cel: {tx.GOALS[g]}", OK) for g in hits]
        elif not program.goals:
            pts += 15
            why.append(Reason("zakres kosztów do sprawdzenia w regulaminie", CHECK))
        else:
            return fail("program finansuje inne cele")
    else:
        pts += 20
        why += [Reason(tx.GOALS[g], OK) for g in program.goals[:3] if g in tx.GOALS]

    missing = [x for x in program.requires_all if x not in profile.person]
    if missing:
        pts -= 5 * len(missing)
        why += [Reason(tx.PERSON_HINT.get(x, f"wymagane: {tx.PERSON[x]}"), CHECK) for x in missing]
    else:
        why += [Reason(tx.PERSON[x], OK) for x in program.requires_all]

    # osoba zakładająca firmę: programy "na start" wyżej niż ogólne
    if profile.founder and "start" in program.goals:
        pts += 10
        why.append(Reason("wsparcie na założenie firmy", OK))

    # status i termin
    days_left = None
    if program.deadline_date:
        days_left = (program.deadline_date - today).days
    if program.status == "soon":
        pts -= 5
        why.append(Reason("nabór wkrótce – przygotuj wniosek", CHECK))
    elif program.status == "closed":
        pts -= 30
    if days_left is not None and 0 <= days_left <= 14 and program.status == "open":
        why.append(Reason(f"zostało {days_left} dni do końca naboru", CHECK))

    # kwota
    if profile.amount:
        if program.max and profile.amount > program.max * 1.5:
            pts -= 10
            why.append(Reason("program pokryje tylko część potrzebnej kwoty", CHECK))
        elif program.min and profile.amount < program.min:
            pts -= 15
            why.append(Reason("minimalna wartość projektu wyższa niż potrzebujesz", CHECK))

    return MatchResult(program, int(round(max(0, min(100, pts)))), True, why, days_left)


def rank(programs: Iterable[Program], profile: CompanyProfile, today: Optional[date] = None,
         min_score: int = 1, include_closed: bool = False, limit: Optional[int] = None) -> list:
    """Lista MatchResult kwalifikujących się programów, najlepsze pierwsze."""
    res = [score(p, profile, today, include_closed) for p in programs]
    res = [r for r in res if r.eligible and r.score >= min_score]
    far = 10 ** 6
    res.sort(key=lambda r: (-r.score, r.program.status != "open",
                            r.days_left if r.days_left is not None and r.days_left >= 0 else far))
    return res[:limit] if limit else res
