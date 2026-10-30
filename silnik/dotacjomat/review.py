"""Ręczny przegląd naborów przez Claude (zamiast ekstrakcji AI przez API).

Raz w tygodniu Claude czyta nabory, które mogą trafić do klientów (`python -m dotacjomat przeglad`),
i zapisuje ocenę w data/przeglad.json: {klucz naboru: {pola}}. Pipeline nakłada ją przy każdej
aktualizacji. Pola są opcjonalne - wpisuje się tylko to, co trzeba poprawić względem heurystyki:
  direct_support  false = wsparcie nie trafia do samej firmy (firma byłaby tylko realizatorem) -> nabór znika dla firm
  forms, sizes, sectors (null = wszystkie branże), goals, regions (null = cała Polska),
  min_pln, max_pln, requires, requires_all, pkd_excluded, how, apply_where, documents, note (uzasadnienie)
"""
from __future__ import annotations

import json
from pathlib import Path

from . import taxonomy as tx
from .models import Program

FIELDS = {"forms": "forms", "sizes": "sizes", "sectors": "sectors", "goals": "goals", "regions": "regions",
          "min_pln": "min", "max_pln": "max", "requires": "requires", "requires_all": "requires_all",
          "pkd_excluded": "pkd_excluded", "how": "how", "apply_where": "apply_where", "documents": "documents",
          "level": "level"}


def load(path) -> dict:
    path = Path(path)
    if not path.exists():
        return {}
    return {k: v for k, v in json.loads(path.read_text(encoding="utf-8")).items() if not k.startswith("_")}


def apply(p: Program, d: dict) -> Program:
    for key, attr in FIELDS.items():
        if key in d:
            setattr(p, attr, d[key])
    if d.get("direct_support") is False:
        p.forms = [f for f in (p.forms or tx.FORMS) if f not in tx.BUSINESS_FORMS and f != "none"] or ["jst"]
    resolved = {k for k in ("regions", "forms", "sizes", "sectors", "goals") if k in d or k == "forms" and "direct_support" in d}
    p.unknown = sorted(set(p.unknown) - resolved)
    p.ai_extracted = True
    return p


def todo(programs, reviews: dict) -> list:
    """Nabory do przeczytania: mogą trafić do klientów i nie mają jeszcze oceny."""
    from .pipeline import _for_clients

    out = []
    for p in programs:
        if p.source == "seed" or p.key in reviews or p.status == "closed" or not _for_clients(p):
            continue
        d = p.description
        who = d.split("Kto może składać wnioski:")[1].split("Na co:")[0] if "Kto może składać wnioski:" in d else ""
        what = d.split("Na co:")[1].split("Finanse:")[0] if "Na co:" in d else d
        out.append({"key": p.key, "name": p.name, "op": p.op, "deadline": p.deadline, "url": p.url,
                    "now": {"forms": p.forms, "sizes": p.sizes, "sectors": p.sectors, "goals": p.goals,
                            "regions": p.regions, "max": p.max},
                    "who": " ".join(who.split())[:700], "what": " ".join(what.split())[:1200]})
    return out
