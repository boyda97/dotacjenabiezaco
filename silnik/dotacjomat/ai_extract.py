"""Ekstrakcja kryteriów naboru modelem Claude (opis + regulamin PDF -> ustrukturyzowane pola).

Źródła nie podają PKD ani pełnych warunków jako pól - są w regulaminach. Ten moduł
czyta tekst naboru (i opcjonalnie regulamin PDF) i zwraca kryteria zgodne z taxonomy.
Wynik nadpisuje heurystykę z classify.py tylko tam, gdzie model coś ustalił.

Wymaga: pip install anthropic, oraz klucza API (ANTHROPIC_API_KEY lub `ant auth login`).
Model: DOTACJOMAT_MODEL (domyślnie claude-opus-5-5). Wynik jest cache'owany po fingerprincie
naboru w bazie, więc model czyta każdy nabór tylko raz, chyba że jego treść się zmieni.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from typing import Optional

from . import taxonomy as tx
from .models import Program

log = logging.getLogger("dotacjomat.ai")
MODEL = os.environ.get("DOTACJOMAT_MODEL", "claude-opus-5-5")


def _enum_array(values):
    return {"type": "array", "items": {"type": "string", "enum": list(values)}}


SCHEMA = {
    "type": "object",
    "properties": {
        "national": {"type": "boolean", "description": "true, jeśli nabór dotyczy całej Polski"},
        "direct_support": {"type": "boolean",
                           "description": "true, jeśli wnioskodawca dostaje wsparcie na własną działalność"},
        "regions": _enum_array([r for r in tx.REGIONS if r != "inne"]),
        "forms": _enum_array(tx.FORMS),
        "sizes": _enum_array(tx.SIZES),
        "all_sectors": {"type": "boolean"},
        "sectors": _enum_array(tx.SECTORS),
        "pkd_excluded": {"type": "array", "items": {"type": "string"}},
        "requires": _enum_array(tx.PERSON),
        "requires_all": _enum_array(tx.PERSON),
        "goals": _enum_array(tx.GOALS),
        "type": {"type": "string", "enum": list(tx.TYPES)},
        "min_pln": {"type": ["integer", "null"]},
        "max_pln": {"type": ["integer", "null"]},
        "level": {"type": "string"},
        "start": {"type": ["string", "null"]},
        "deadline": {"type": ["string", "null"]},
        "how": {"type": "string"},
        "apply_where": {"type": "string"},
        "documents": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["national", "direct_support", "regions", "forms", "sizes", "all_sectors", "sectors", "pkd_excluded",
                 "requires", "requires_all", "goals", "type", "min_pln", "max_pln", "level", "start", "deadline", "how",
                 "apply_where", "documents"],
    "additionalProperties": False,
}

SYSTEM = f"""Jesteś analitykiem funduszy UE i krajowych w Polsce. Z ogłoszenia o naborze (i regulaminu,
jeśli jest dołączony) wyciągasz kryteria, według których serwis dopasowuje nabory do firm.

Klucze, których używasz:
- forms: {json.dumps(tx.FORMS, ensure_ascii=False)}
- sizes: {json.dumps(tx.SIZES, ensure_ascii=False)}
- sectors (sekcje PKD; C10 = przetwórstwo spożywcze, N79 = turystyka): {json.dumps(tx.SECTORS, ensure_ascii=False)}
- goals (na co można wydać pieniądze): {json.dumps(tx.GOALS, ensure_ascii=False)}
- type: dotacja (bezzwrotna), pozyczka, mieszane (dotacja + kredyt/pożyczka/gwarancja)

Zasady:
- Wpisuj tylko to, co wynika z tekstu. Jeśli nabór jest dla MŚP, sizes = micro, small, medium.
- direct_support: true, gdy pieniądze idą na rozwój samego wnioskodawcy (inwestycja firmy, B+R, eksport,
  szkolenia własnych pracowników, pożyczka dla firmy, start firmy). false, gdy wnioskodawca realizuje projekt
  dla innych odbiorców (uczniów, bezrobotnych, seniorów, mieszkańców, rodzin) albo inwestycję publiczną
  (drogi, wodociągi, szkoły, szpitale), nawet jeśli firmy są na liście uprawnionych realizatorów.
- forms: formy, które realnie dostają wsparcie dla siebie. Przy direct_support = false nie wpisuj form
  firmowych (jdg, sc, zoo, sa), tylko ngo/jst, jeśli dotyczy.
- goals: tylko główne cele, na które da się wydać pieniądze w tym naborze; nie wpisuj celu, który pojawia się
  w tekście tylko pobocznie.
- "Polska Wschodnia" (FEPW) = lubelskie, podkarpackie, podlaskie, swietokrzyskie, warminsko
  (+ część mazowieckiego - wtedy dodaj mazowieckie).
- all_sectors = true, jeśli nabór nie ogranicza branży; wtedy sectors może być puste.
- requires: status osoby, z którego wystarczy JEDEN (np. bezrobotny lub do30), klucze: {json.dumps(tx.PERSON, ensure_ascii=False)}
- requires_all: warunki obowiązkowe dla każdego (np. bez_dg_12m). Puste listy, jeśli nabór ich nie stawia.
- Dotacje na założenie firmy (urząd pracy, PFRON, LGD, FSE+) mają forms = none, sizes = start, goals zawiera start.
- pkd_excluded: prefiksy kodów PKD wykluczonych w regulaminie (np. "01", "46.1", "92"); pusta lista, jeśli brak.
- Kwoty w PLN jako liczby całkowite (EUR przelicz po 4,3). Daty w formacie RRRR-MM-DD.
  max_pln / min_pln to kwota wsparcia dla JEDNEGO wnioskodawcy lub projektu, nigdy pula całego naboru;
  null, jeśli tekst jej nie podaje.
- level: poziom dofinansowania, np. "do 80 %", albo "".
- how: 1-2 zdania po polsku dla przedsiębiorcy: na co konkretnie da się wydać te pieniądze.
- apply_where: 1 zdanie, gdzie i jak składa się wniosek (np. "Wniosek składasz online w systemie LSI PARP,
  podpisany podpisem kwalifikowanym."), albo "", jeśli tekst tego nie mówi.
- documents: najważniejsze dokumenty do przygotowania, krótko (np. "Biznesplan", "Oświadczenie o pomocy de minimis"),
  maksymalnie 8, tylko te wymienione w tekście; pusta lista, jeśli brak."""


def _client():
    import anthropic  # import leniwy - moduł działa bez SDK, dopóki nie włączysz AI
    return anthropic.Anthropic()


def extract(program: Program, pdf_bytes: Optional[bytes] = None, client=None) -> Optional[dict]:
    """Zwraca słownik zgodny ze SCHEMA albo None (odmowa / błąd)."""
    client = client or _client()
    content = []
    if pdf_bytes:
        content.append({"type": "document", "source": {
            "type": "base64", "media_type": "application/pdf",
            "data": base64.standard_b64encode(pdf_bytes).decode()}})
    content.append({"type": "text", "text":
                    f"Nazwa: {program.name}\nOperator: {program.op}\nURL: {program.url}\n\n"
                    f"Treść ogłoszenia:\n{program.description}"})
    resp = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if resp.stop_reason in ("refusal", "max_tokens"):
        log.warning("Ekstrakcja AI nieudana dla %s: %s", program.key, resp.stop_reason)
        return None
    text = next((b.text for b in resp.content if b.type == "text"), None)
    return json.loads(text) if text else None


def apply(program: Program, data: dict) -> Program:
    """Nakłada wynik ekstrakcji na program (wynik AI ma pierwszeństwo przed heurystyką)."""
    program.regions = None if data["national"] or not data["regions"] else data["regions"]
    program.forms = data["forms"] or program.forms
    if data.get("direct_support") is False and program.forms:
        # firma byłaby tu tylko realizatorem projektu dla innych - nie pokazujemy naboru firmom
        program.forms = [f for f in program.forms if f not in tx.CLIENT_FORMS] or ["jst"]
    program.sizes = data["sizes"] or program.sizes
    program.sectors = None if data["all_sectors"] or not data["sectors"] else data["sectors"]
    program.pkd_excluded = data["pkd_excluded"]
    program.requires = data["requires"]
    program.requires_all = data["requires_all"]
    program.goals = data["goals"] or program.goals
    program.type = data["type"]
    program.min = data["min_pln"] if data["min_pln"] is not None else program.min
    program.max = data["max_pln"] if data["max_pln"] is not None else program.max
    program.level = data["level"] or program.level
    program.start = data["start"] or program.start
    program.deadline = data["deadline"] or program.deadline
    program.how = data["how"] or program.how
    program.apply_where = data.get("apply_where") or program.apply_where
    program.documents = (data.get("documents") or program.documents)[:8]
    resolved = {"regions", "sectors", "goals"} | ({"forms"} if data["forms"] else set()) \
        | ({"sizes"} if data["sizes"] else set())
    program.unknown = sorted(set(program.unknown) - resolved)
    program.ai_extracted = True
    program.refresh_status()
    return program
