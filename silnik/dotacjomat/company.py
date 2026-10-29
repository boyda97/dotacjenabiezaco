"""Dane firmy po NIP.

Biała Lista MF (wl-api.mf.gov.pl) jest publiczna i bez klucza: nazwa, REGON, KRS, adres, status VAT.
PKD i forma prawna wymagają GUS BIR1.1 (klucz z api.stat.gov.pl) - do dodania, gdy będzie klucz.
"""
from __future__ import annotations

import json
import re
from datetime import date

from .sources.base import Http

# Pierwsze dwie cyfry kodu pocztowego -> województwo (przybliżenie; kilka obszarów przygranicznych się myli).
_POSTAL = [
    (0, 9, "mazowieckie"), (10, 14, "warminsko"), (15, 19, "podlaskie"), (20, 24, "lubelskie"),
    (25, 29, "swietokrzyskie"), (30, 34, "malopolskie"), (35, 39, "podkarpackie"), (40, 44, "slaskie"),
    (45, 49, "opolskie"), (50, 59, "dolnoslaskie"), (60, 64, "wielkopolskie"), (65, 69, "lubuskie"),
    (70, 78, "zachodniopomorskie"), (80, 84, "pomorskie"), (85, 89, "kujawsko"), (90, 99, "lodzkie"),
]


def clean_nip(nip: str) -> str:
    return re.sub(r"\D", "", nip or "")


def valid_nip(nip: str) -> bool:
    d = clean_nip(nip)
    if len(d) != 10:
        return False
    w = [6, 5, 7, 2, 3, 4, 5, 6, 7]
    return sum(int(a) * b for a, b in zip(d, w)) % 11 == int(d[9])


def region_from_address(address: str):
    m = re.search(r"\b(\d{2})-\d{3}\b", address or "")
    if not m:
        return None
    pref = int(m.group(1))
    return next((r for lo, hi, r in _POSTAL if lo <= pref <= hi), None)


def lookup(nip: str, http: Http = None) -> dict:
    """{'name', 'regon', 'krs', 'address', 'region', 'vat'} albo ValueError dla błędnego NIP."""
    if not valid_nip(nip):
        raise ValueError("Niepoprawny NIP (suma kontrolna)")
    http = http or Http(delay=0)
    raw = http.get(f"https://wl-api.mf.gov.pl/api/search/nip/{clean_nip(nip)}?date={date.today().isoformat()}")
    subj = (json.loads(raw).get("result") or {}).get("subject")
    if not subj:
        return {}
    addr = subj.get("workingAddress") or subj.get("residenceAddress") or ""
    return {"name": subj.get("name"), "regon": subj.get("regon"), "krs": subj.get("krs"),
            "address": addr, "region": region_from_address(addr), "vat": subj.get("statusVat"),
            "form_hint": "jdg" if not subj.get("krs") else None}
