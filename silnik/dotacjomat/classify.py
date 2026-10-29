"""Klasyfikacja surowego opisu naboru (tytuł + opis ze strony źródła) do kryteriów dopasowania.

Reguły słownikowe na tematach słów (polska fleksja), bez zewnętrznych bibliotek.
Kryterium, którego nie da się ustalić, zostaje None i trafia do `unknown`,
więc dopasowanie nie odrzuci przez nie programu.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date
from typing import Optional

from . import taxonomy as tx
from .models import Program


def norm(text: str) -> str:
    """Małe litery bez polskich znaków i z pojedynczymi spacjami."""
    t = unicodedata.normalize("NFKD", (text or "").lower().replace("ł", "l"))
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", t)


def _has(text: str, stems) -> bool:
    return any(re.search(r"(?<![a-z])" + s, text) for s in stems)


REGION_STEMS = {
    "dolnoslaskie": ["dolnoslas"], "kujawsko": ["kujawsk"], "lubelskie": ["lubelsk"],
    "lubuskie": ["lubusk"], "lodzkie": ["lodzk"], "malopolskie": ["malopols"],
    "mazowieckie": ["mazowiec", "mazowsz"], "opolskie": ["opolsk"],
    "podkarpackie": ["podkarpac"], "podlaskie": ["podlas"],
    "pomorskie": ["(?<!zachodnio)(?<!kujawsko-)(?<!kujawsko )pomorsk"],
    "slaskie": ["(?<!dolno)slask", "(?<!dolno)slaskiego"],
    "swietokrzyskie": ["swietokrzysk"], "warminsko": ["warminsk"],
    "wielkopolskie": ["wielkopols"], "zachodniopomorskie": ["zachodniopomorsk"],
}
EAST_STEMS = ["polsk[aiey]* wschodni", "fepw"]
NATIONAL_STEMS = ["cala polsk", "ogolnopolsk", "feng", "fers", "kpo", "krajow", "parp", "ncbr", "bgk"]

GOAL_STEMS = {
    "sprzet": ["maszyn", "urzadzen", "sprzet", "wyposazen", "srodk[io]w? trwal", "linii? produkcyj"],
    "budowa": ["budow", "rozbudow", "remont", "modernizac", "adaptac", "infrastruktur"],
    "nieruchomosc": ["nieruchomos", "grunt", "zakup hal"],
    "pojazdy": ["pojazd", "samochod", "flot", "elektromobil", "elektryczn[a-z]* (aut|pojazd)"],
    "digital": ["cyfryzac", "cyfrow", "oprogramowan", "e-commerce", "e-uslug", "system[a-z]* it",
                "transformac[a-z]* cyfrow", "automatyzac", "chmur"],
    "ai": ["sztuczn[a-z]* inteligenc", "(?<![a-z])ai(?![a-z])", "robotyzac", "robot[a-z]* przemyslow", "przemysl[a-z]* 4"],
    "badania": ["b\\+r", "badawczo-rozwoj", "prac[a-z]* (badawcz|rozwojow)", "prototyp"],
    "wzornictwo": ["wzornict", "design"],
    "ip": ["wlasnosc[a-z]* (intelektualn|przemyslow)", "patent", "znak[a-z]* towarow"],
    "oze": ["oze(?![a-z])", "odnawialn", "fotowolta", "pomp[a-z]* ciepla", "magazyn[a-z]* energii", "biogaz", "wiatr"],
    "efektywnosc": ["efektywnos[a-z]* energetyc", "termomoderniz", "oszczednos[a-z]* energii"],
    "goz": ["obieg[a-z]* zamkniet", "goz(?![a-z])", "recykling", "odpad"],
    "szkolenia": ["szkolen", "kurs", "kompetenc", "kwalifikac", "bur(?![a-z])", "kfs(?![a-z])"],
    "zatrudnienie": ["zatrudn", "miejsc[a-z]* pracy", "stazy", "staz", "bezrobotn"],
    "doradztwo": ["doradzt", "doradcz", "audyt", "uslug[a-z]* eksperck"],
    "eksport": ["eksport", "targ[a-z]* (miedzynarod|zagranicz)", "internacjonaliz", "ekspansj", "rynk[a-z]* zagraniczn"],
    "marketing": ["marketing", "promoc", "stron[a-z]* (www|internetow)", "sklep[a-z]* internetow"],
    "start": ["zalozen[a-z]* (firm|dzialaln)", "rozpoczec[a-z]* dzialaln", "start-?up", "nowo powstal"],
    "plynnosc": ["kapital[a-z]* obrotow", "plynnos", "biezac[a-z]* dzialaln"],
}

SIZE_STEMS = {
    "micro": ["mikro"], "small": ["malych", "male przedsieb", "maly przedsieb"],
    "medium": ["srednich", "srednie przedsieb"], "large": ["duz[aey][a-z]* przedsieb", "duzych"],
}
MSP_STEMS = ["msp", "mikro, mal", "mikro-, mal", "malych i srednich"]

FORM_STEMS = {
    "ngo": ["organizac[a-z]* pozarzad", "fundac", "stowarzysz", "ngo", "spoldziel", "ekonomi[a-z]* spoleczn"],
    "jst": ["jst(?![a-z])", "jednost[a-z]* samorzad", "gmin(?![a-z])", "gminy", "gminom", "powiat", "uczeln", "jednost[a-z]* naukow", "instytut"],
    "rolne": ["rolnik", "gospodarstw[a-z]* roln", "arimr", "prow(?![a-z])", "wpr(?![a-z])", "ps wpr"],
    "none": ["osob[a-z]* (fizyczn|bezrobotn)[a-z]* (planujac|zamierzajac)", "zalozen[a-z]* (firm|dzialaln)"],
}
BUSINESS_STEMS = ["przedsiebior", "firm", "msp", "spolk"]

TYPE_STEMS = {"pozyczka": ["pozyczk"], "mieszane": ["kredyt", "premi[a-z]* technolog", "gwarancj"]}

MONTHS = {"stycz": 1, "lut": 2, "marc": 3, "kwie": 4, "maj": 5, "czerw": 6, "lip": 7,
          "sierp": 8, "wrze": 9, "pazdz": 10, "listop": 11, "grud": 12}


def parse_dates(text: str) -> list:
    """Wszystkie daty z tekstu w kolejności wystąpienia (formaty ISO, dd.mm.rrrr, '15 grudnia 2026')."""
    t = norm(text)
    found = []
    for m in re.finditer(r"(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[./](\d{1,2})[./](\d{4})|"
                         r"(\d{1,2}) ([a-z]+) (\d{4})", t):
        try:
            if m.group(1):
                d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            elif m.group(4):
                d = date(int(m.group(6)), int(m.group(5)), int(m.group(4)))
            else:
                mon = next((v for k, v in MONTHS.items() if m.group(8).startswith(k)), None)
                if not mon:
                    continue
                d = date(int(m.group(9)), mon, int(m.group(7)))
            found.append((m.start(), d))
        except ValueError:
            continue
    return [d for _, d in sorted(found)]


_AMOUNT = re.compile(r"(\d[\d  .,]*)\s*(mld|mln|tys\.?)?\s*(zl|pln|euro|eur)")


def parse_amounts(text: str) -> list:
    """Kwoty w PLN (euro przeliczane po 4,3)."""
    out = []
    for m in _AMOUNT.finditer(norm(text)):
        num = m.group(1).replace(" ", "").replace(" ", "").rstrip(".,")
        if m.group(2):
            num = num.replace(",", ".")
            if num.count(".") > 1:
                continue
        else:
            num = num.replace(".", "").replace(",", ".")
        try:
            v = float(num)
        except ValueError:
            continue
        mult = {"mld": 1e9, "mln": 1e6, "tys": 1e3, "tys.": 1e3}.get(m.group(2) or "", 1)
        if m.group(3) in ("euro", "eur"):
            mult *= 4.3
        out.append(int(v * mult))
    return out


def classify(p: Program, text: str, today: Optional[date] = None) -> Program:
    """Uzupełnia puste pola programu na podstawie tekstu. Pola już wypełnione przez adapter zostawia."""
    t = norm(f"{p.name} {p.op} {text}")
    unknown = set(p.unknown)

    if p.regions is None and "regions" not in unknown:
        regs = [r for r, stems in REGION_STEMS.items() if _has(t, stems)]
        if _has(t, EAST_STEMS):
            regs = sorted(set(regs) | set(tx.EAST))
        if regs and not _has(t, NATIONAL_STEMS):
            p.regions = regs
        elif not regs and not _has(t, NATIONAL_STEMS):
            unknown.add("regions")

    if p.sizes is None:
        sizes = [s for s, stems in SIZE_STEMS.items() if _has(t, stems)]
        if _has(t, MSP_STEMS):
            sizes = sorted(set(sizes) | set(tx.MSP))
        if sizes:
            if "micro" in sizes and _has(t, FORM_STEMS["none"]):
                sizes.append("start")
            p.sizes = sizes
        else:
            unknown.add("sizes")

    if p.forms is None:
        forms = [f for f, stems in FORM_STEMS.items() if _has(t, stems)]
        if _has(t, BUSINESS_STEMS) or p.sizes:
            forms += tx.BUSINESS_FORMS
        if forms:
            p.forms = sorted(set(forms))
        else:
            unknown.add("forms")

    if p.sectors is None:
        # Branżę rzadko da się wiarygodnie ustalić z opisu; zostawiamy "wszystkie",
        # chyba że opis wprost wskazuje sektor rolno-spożywczy / turystykę.
        if _has(t, ["przetworstw[a-z]* rolno", "rolno-spozywcz"]):
            p.sectors = ["C10", "A"]
        elif _has(t, ["turystyk", "turystyczn"]) and _has(t, ["branz[a-z]* turystyczn", "sektor[a-z]* turystyczn"]):
            p.sectors = ["N79", "I"]
        elif _has(t, ["horeca", "gastronomi"]) and "kpo" in t:
            p.sectors = ["I", "N79", "R"]

    if not p.goals:
        p.goals = [g for g, stems in GOAL_STEMS.items() if _has(t, stems)]
        if not p.goals:
            unknown.add("goals")

    if p.type == "dotacja":
        for typ, stems in TYPE_STEMS.items():
            if _has(t, stems):
                p.type = typ
                break

    if p.max is None:
        amounts = [a for a in parse_amounts(text) if a >= 1000]
        if amounts:
            p.max = max(amounts)
            if len(amounts) > 1 and min(amounts) < p.max:
                p.min = min(amounts) if _has(t, ["minimaln", "od "]) else p.min

    if not p.level:
        m = re.search(r"(do|maks[a-z.]*|max\.?)\s*(\d{1,3})\s*%", t)
        if m:
            p.level = f"do {m.group(2)} %"

    if not p.deadline:
        dates = parse_dates(text)
        if dates:
            p.deadline = max(dates).isoformat()
            if not p.start and len(dates) > 1:
                p.start = min(dates).isoformat()

    p.unknown = sorted(unknown)
    p.refresh_status(today)
    return p
