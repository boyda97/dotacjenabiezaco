"""Wiersz poleceń.

  python -m dotacjomat update [--ai]                 pobierz i zaktualizuj bazę (uruchamiaj codziennie, np. cron 6:00)
  python -m dotacjomat match --region mazowieckie --form zoo --size small --pkd 62.01.Z --goal digital
  python -m dotacjomat match --region lubelskie --form none --size start --person bezrobotny   (dopiero zakładam firmę)
  python -m dotacjomat export site/programs.json      eksport naborów w formacie tablicy PROGRAMS strony
  python -m dotacjomat profile-add profil.json --plan monthly --until 2026-11-30
  python -m dotacjomat digest [--send]               alerty o nowych dopasowaniach dla subskrybentów
  python -m dotacjomat nip 5250123456                dane firmy z Białej Listy MF
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from . import company, pipeline
from .matching import rank
from .models import CompanyProfile
from .sources import Http, load_sources
from .storage import Store

ROOT = Path(__file__).resolve().parent.parent


def main(argv=None):
    ap = argparse.ArgumentParser(prog="dotacjomat", description="Silnik dopasowania dotacji")
    ap.add_argument("--db", default=os.environ.get("DOTACJOMAT_DB") or str(ROOT / "dotacjomat.db"))
    ap.add_argument("--sources", default=str(ROOT / "config" / "sources.json"))
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    u = sub.add_parser("update", help="pobierz nabory ze źródeł")
    u.add_argument("--ai", action="store_true", help="ekstrakcja kryteriów modelem Claude")
    u.add_argument("--only", help="tylko źródła o tych nazwach (po przecinku)")

    m = sub.add_parser("match", help="dopasuj nabory do firmy")
    m.add_argument("--profile", help="plik JSON z profilem")
    m.add_argument("--region"), m.add_argument("--form"), m.add_argument("--size")
    m.add_argument("--sector"), m.add_argument("--pkd")
    m.add_argument("--goal", action="append", default=[])
    m.add_argument("--person", action="append", default=[],
                   help="status osoby zakładającej firmę, np. bezrobotny, do30, niepelnosprawnosc")
    m.add_argument("--amount", type=int)
    m.add_argument("--limit", type=int, default=20)
    m.add_argument("--json", action="store_true")

    e = sub.add_parser("export", help="eksport dla strony")
    e.add_argument("out")

    pa = sub.add_parser("profile-add")
    pa.add_argument("file")
    pa.add_argument("--plan", choices=["monthly", "weekly"], default="monthly")
    pa.add_argument("--until")

    d = sub.add_parser("digest")
    d.add_argument("--send", action="store_true", help="wyślij (SMTP_HOST) lub zapisz do outbox/")
    d.add_argument("--min-score", type=int, default=50)

    n = sub.add_parser("nip")
    n.add_argument("nip")

    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if a.verbose else logging.WARNING, format="%(levelname)s %(message)s")
    store = Store(a.db)

    if a.cmd == "update":
        http = Http()
        sources = load_sources(a.sources, http=http)
        if a.only:
            names = set(a.only.split(","))
            sources = [s for s in sources if s.name in names]
        res = pipeline.update(store, sources, use_ai=a.ai, http=http)
        for name, st in res.items():
            print(f"{name:<14} pobrano {st['fetched']:>4}  nowe {st['new']:>3}  zmienione {st['changed']:>3}"
                  f"  usunięte {st['removed']:>3}" + (f"  BŁĄD: {st['error']}" if st["error"] else ""))
        return 1 if any(st["error"] for st in res.values()) else 0

    if a.cmd == "match":
        if a.profile:
            prof = CompanyProfile.from_dict(json.loads(Path(a.profile).read_text(encoding="utf-8")))
        else:
            prof = CompanyProfile(region=a.region, form=a.form, size=a.size, sector=a.sector,
                                  pkd=a.pkd, goals=a.goal, amount=a.amount, person=a.person)
        results = rank(store.programs(), prof, limit=a.limit)
        if a.json:
            print(json.dumps([r.to_dict() for r in results], ensure_ascii=False, indent=1))
        else:
            for r in results:
                flags = " ".join(("✓ " if x.state == "ok" else "? ") + x.text for x in r.reasons)
                print(f"{r.score:>3}%  {r.program.name}  [{r.program.status}, {r.program.deadline or '—'}]\n"
                      f"      {flags}\n      {r.program.url}")
            if not results:
                print("Brak pasujących naborów.")
        return 0

    if a.cmd == "export":
        data = [p.to_page_dict() for p in store.programs()]
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        Path(a.out).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"Zapisano {len(data)} naborów do {a.out}")
        return 0

    if a.cmd == "profile-add":
        prof = CompanyProfile.from_dict(json.loads(Path(a.file).read_text(encoding="utf-8")))
        print("Dodano profil", store.add_profile(prof, a.plan, a.until))
        return 0

    if a.cmd == "digest":
        items = pipeline.digest(store, a.min_score)
        if a.send:
            print("Wysłano/zapisano", pipeline.send_digests(store, items, str(ROOT / "outbox")), "alertów")
        else:
            for pid, prof, matches in items:
                print(f"--- profil {pid} ({prof.email})\n{pipeline.render_digest(prof, matches)}\n")
        return 0

    if a.cmd == "nip":
        print(json.dumps(company.lookup(a.nip), ensure_ascii=False, indent=1))
        return 0


if __name__ == "__main__":
    sys.exit(main())
