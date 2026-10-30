"""Codzienna aktualizacja: pobranie ze źródeł -> klasyfikacja (+ opcjonalnie AI) -> baza -> alerty."""
from __future__ import annotations

import hashlib
import logging
import os
import smtplib
from datetime import date
from email.message import EmailMessage
from pathlib import Path
from typing import Optional

from . import taxonomy as tx
from .classify import classify
from .matching import rank
from .storage import Store, now

log = logging.getLogger("dotacjomat.pipeline")


def _raw_fp(p) -> str:
    return hashlib.sha256(f"{p.name}\n{p.url}\n{p.description}".encode()).hexdigest()[:16]


def update(store: Store, sources: list, use_ai: bool = False, http=None,
           today: Optional[date] = None, reviews: Optional[dict] = None) -> dict:
    """Pobiera wszystkie źródła. Błąd jednego źródła nie zatrzymuje pozostałych."""
    summary = {}
    for src in sources:
        started, stats, seen, error = now(), {"fetched": 0, "new": 0, "changed": 0, "removed": 0}, set(), None
        try:
            for p in src.fetch():
                stats["fetched"] += 1
                try:
                    p = _process(store, p, use_ai, http, today, reviews or {})
                except Exception as e:  # noqa: BLE001 - jeden wadliwy nabór nie psuje całego źródła
                    log.warning("[%s] pominięto %s: %s", src.name, p.key, e)
                    stats["skipped"] = stats.get("skipped", 0) + 1
                    seen.add(p.key)
                    continue
                result = store.upsert(p, p._raw)
                if result != "same":
                    stats[result] += 1
                seen.add(p.key)
        except Exception as e:  # noqa: BLE001 - logujemy i idziemy dalej
            error = f"{type(e).__name__}: {e}"
            log.exception("Źródło %s nie powiodło się", src.name)
        if seen and not error:
            stats["removed"] = store.deactivate_missing(src.name, seen)
        store.log_run(src.name, started, stats, error)
        store.commit()
        summary[src.name] = {**stats, "error": error}
    return summary


def _process(store, p, use_ai, http, today, reviews=None):
    raw = _raw_fp(p)
    cached, cached_raw = store.get(p.key)
    if cached is not None and cached_raw == raw and (cached.ai_extracted or not use_ai):
        p = cached  # treść u źródła bez zmian - nie klasyfikujemy ponownie
    elif p.source != "seed" and not getattr(p, "_classified", False) and not p.goals:
        classify(p, p.description, today)
    if reviews and p.key in reviews:
        from . import review
        review.apply(p, reviews[p.key])  # ocena Claude z data/przeglad.json (raz w tygodniu)
    elif use_ai and p.source != "seed" and not p.ai_extracted and _for_clients(p):
        _ai(p, http)
    p._raw = raw
    p.refresh_status(today)
    return p


def _for_clients(p) -> bool:
    """AI czyta tylko nabory, które mogą trafić do klientów (firmy, rolnicy, zakładający firmę).
    Nabory już rozpoznane jako tylko dla gmin i urzędów pomijamy - to ok. 2/3 Portalu FE i spory koszt."""
    return p.forms is None or bool(set(p.forms) & set(tx.CLIENT_FORMS))


def _ai(p, http=None):
    from . import ai_extract
    pdf = None
    if p.docs and http is not None:
        try:
            pdf = http.get_bytes(p.docs[0])
        except Exception as e:  # regulamin niedostępny - AI czyta sam opis
            log.warning("Nie pobrano regulaminu %s: %s", p.docs[0], e)
    try:
        data = ai_extract.extract(p, pdf)
        if data:
            ai_extract.apply(p, data)
    except Exception as e:  # noqa: BLE001
        log.warning("Ekstrakcja AI nie powiodła się dla %s: %s", p.key, e)


# --- alerty dla subskrybentów -------------------------------------------

def digest(store: Store, min_score: int = 50, today: Optional[date] = None) -> list:
    """Dla każdego aktywnego profilu z planem miesięcznym: nowe lub zmienione dopasowania od ostatniego alertu.
    Zwraca listę (profile_id, profile, [MatchResult]); oznacza je jako wysłane dopiero w send_digests()."""
    today = today or date.today()
    programs = store.programs()
    out = []
    for pid, plan, prof in store.profiles(only_active_at=today.isoformat()):
        if plan != "monthly":
            continue
        fresh = [m for m in rank(programs, prof, today, min_score=min_score)
                 if not store.already_sent(pid, m.program.key, m.program.fingerprint())]
        if fresh:
            out.append((pid, prof, fresh))
    return out


def render_digest(prof, matches) -> str:
    lines = [f"Dzień dobry{(' ' + prof.name) if prof.name else ''},", "",
             f"mamy {len(matches)} nowe lub zaktualizowane nabory pasujące do Twojej firmy:", ""]
    for m in matches:
        p = m.program
        when = f"do {p.deadline}" if p.deadline else "termin w regulaminie"
        amount = f", do {p.max:,} zł".replace(",", " ") if p.max else ""
        lines += [f"• {p.name} ({tx.STATUSES[p.status]}, {when}{amount}) – dopasowanie {m.score}%",
                  f"  {p.op}", f"  {p.url}", ""]
    lines.append("Pełne karty programów znajdziesz po zalogowaniu na dotacjenabiezaco.pl.")
    return "\n".join(lines)


def send_digests(store: Store, items: list, outbox: Optional[str] = None) -> int:
    """Wysyła e-mailem (jeśli ustawiono SMTP_HOST) albo zapisuje do katalogu outbox."""
    sent = 0
    for pid, prof, matches in items:
        body = render_digest(prof, matches)
        if os.environ.get("SMTP_HOST") and prof.email:
            msg = EmailMessage()
            msg["Subject"] = f"Dotacje na Bieżąco: {len(matches)} nowe nabory dla Twojej firmy"
            msg["From"] = os.environ.get("SMTP_FROM", "alerty@dotacjenabiezaco.pl")
            msg["To"] = prof.email
            msg.set_content(body)
            with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", 587))) as s:
                s.starttls()
                if os.environ.get("SMTP_USER"):
                    s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
                s.send_message(msg)
        else:
            d = Path(outbox or "outbox")
            d.mkdir(parents=True, exist_ok=True)
            (d / f"profil-{pid}-{date.today().isoformat()}.txt").write_text(body, encoding="utf-8")
        store.mark_sent(pid, [m.program for m in matches])
        sent += 1
    return sent
