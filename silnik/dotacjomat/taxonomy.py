"""Słowniki wspólne dla backendu i strony (te same klucze co w formularzu na stronie)."""

REGIONS = {
    "dolnoslaskie": "dolnośląskie",
    "kujawsko": "kujawsko-pomorskie",
    "lubelskie": "lubelskie",
    "lubuskie": "lubuskie",
    "lodzkie": "łódzkie",
    "malopolskie": "małopolskie",
    "mazowieckie": "mazowieckie",
    "opolskie": "opolskie",
    "podkarpackie": "podkarpackie",
    "podlaskie": "podlaskie",
    "pomorskie": "pomorskie",
    "slaskie": "śląskie",
    "swietokrzyskie": "świętokrzyskie",
    "warminsko": "warmińsko-mazurskie",
    "wielkopolskie": "wielkopolskie",
    "zachodniopomorskie": "zachodniopomorskie",
    "inne": "inne (zgodność ze starą wersją formularza)",
}
# Program FEPW (Polska Wschodnia) obejmuje też świętokrzyskie i wschodnie mazowieckie,
# ale strona traktuje "Polskę Wschodnią" jako te cztery województwa.
EAST = ["lubelskie", "podkarpackie", "podlaskie", "warminsko", "swietokrzyskie"]

FORMS = {
    "none": "jeszcze nie mam firmy",
    "jdg": "jednoosobowa działalność",
    "sc": "spółka cywilna / jawna / partnerska",
    "zoo": "spółka z o.o. / PSA",
    "sa": "spółka akcyjna / komandytowa",
    "rolne": "gospodarstwo rolne",
    "ngo": "fundacja / stowarzyszenie / spółdzielnia",
    "jst": "podmiot publiczny / JST / uczelnia",
}
BUSINESS_FORMS = ["jdg", "sc", "zoo", "sa"]
# Klienci serwisu: firmy, osoby zakładające firmę i gospodarstwa rolne.
CLIENT_FORMS = BUSINESS_FORMS + ["none", "rolne"]

SIZES = {
    "start": "dopiero zakładam",
    "micro": "mikro",
    "small": "mała",
    "medium": "średnia",
    "large": "duża",
}
MSP = ["micro", "small", "medium"]

# Klucze sekcji jak na stronie (litery PKD + dwie podsekcje wyodrębnione przez stronę).
SECTORS = {
    "A": "rolnictwo, leśnictwo, rybactwo",
    "B": "górnictwo i wydobywanie",
    "C": "przetwórstwo przemysłowe",
    "C10": "przetwórstwo rolno-spożywcze",
    "D": "energetyka",
    "E": "woda, ścieki, odpady",
    "F": "budownictwo",
    "G": "handel",
    "H": "transport i logistyka",
    "I": "zakwaterowanie i gastronomia",
    "J": "informacja i komunikacja",
    "K": "finanse i ubezpieczenia",
    "L": "nieruchomości",
    "M": "działalność profesjonalna",
    "N": "usługi administrowania",
    "N79": "turystyka",
    "O": "administracja publiczna",
    "P": "edukacja",
    "Q": "opieka zdrowotna i pomoc społeczna",
    "R": "kultura, rozrywka, rekreacja",
    "S": "pozostałe usługi",
}
SUBSECTION_PARENT = {"C10": "C", "N79": "N"}

# Działy PKD (2 pierwsze cyfry) -> klucz sekcji.
_DIVISIONS = [
    (1, 3, "A"), (5, 9, "B"), (10, 12, "C10"), (13, 33, "C"), (35, 35, "D"),
    (36, 39, "E"), (41, 43, "F"), (45, 47, "G"), (49, 53, "H"), (55, 56, "I"),
    (58, 63, "J"), (64, 66, "K"), (68, 68, "L"), (69, 75, "M"), (79, 79, "N79"),
    (77, 82, "N"), (84, 84, "O"), (85, 85, "P"), (86, 88, "Q"), (90, 93, "R"),
    (94, 96, "S"),
]


def sector_from_pkd(pkd: str):
    """'73.11.Z' -> 'M', '10.71.Z' -> 'C10', '79.11.A' -> 'N79'. Zwraca None, gdy kod nieznany."""
    digits = "".join(ch for ch in (pkd or "") if ch.isdigit())
    if len(digits) < 2:
        return None
    div = int(digits[:2])
    for lo, hi, key in _DIVISIONS:
        if lo <= div <= hi:
            return key
    return None


def sector_covers(program_sector: str, company_sector: str) -> bool:
    """Program dla sekcji 'C' obejmuje też firmę z podsekcji 'C10' (i odwrotnie nie)."""
    if program_sector == company_sector:
        return True
    return SUBSECTION_PARENT.get(company_sector) == program_sector


def sector_specific(program_sectors) -> bool:
    """Czy program jest tylko dla wybranych branż (mniej niż połowa sekcji PKD)."""
    if not program_sectors:
        return False
    top = {SUBSECTION_PARENT.get(s, s) for s in program_sectors}
    return len(top) < len([s for s in SECTORS if s not in SUBSECTION_PARENT]) / 2


GOALS = {
    "sprzet": "maszyny, urządzenia, sprzęt",
    "budowa": "budowa, remont, adaptacja",
    "nieruchomosc": "zakup nieruchomości lub gruntu",
    "pojazdy": "pojazdy, flota, elektromobilność",
    "digital": "oprogramowanie, IT, e-commerce",
    "ai": "AI, robotyzacja, Przemysł 4.0",
    "badania": "badania i rozwój",
    "wzornictwo": "wzornictwo, design",
    "ip": "ochrona własności intelektualnej",
    "oze": "OZE: fotowoltaika, pompy ciepła, magazyny energii",
    "efektywnosc": "efektywność energetyczna",
    "goz": "gospodarka obiegu zamkniętego",
    "szkolenia": "szkolenia i kompetencje",
    "zatrudnienie": "zatrudnienie, staże",
    "doradztwo": "doradztwo, audyty",
    "eksport": "eksport, targi, ekspansja",
    "marketing": "marketing, promocja, www",
    "start": "założenie firmy",
    "plynnosc": "kapitał obrotowy",
}

# Status osoby zakładającej firmę - od niego zależy większość dotacji "na start".
PERSON = {
    "bezrobotny": "zarejestrowana w urzędzie pracy jako bezrobotna",
    "poszukujacy": "zarejestrowana w urzędzie pracy jako poszukująca pracy",
    "bierny": "bierna zawodowo (nie pracuje i nie szuka pracy)",
    "do30": "w wieku do 30 lat",
    "pow50": "w wieku 50+",
    "kobieta": "kobieta",
    "niepelnosprawnosc": "z orzeczeniem o niepełnosprawności",
    "student": "student ostatniego roku",
    "absolwent": "absolwent (do 4 lat od ukończenia studiów)",
    "obszar_wiejski": "firma powstanie na obszarze wiejskim",
    "bez_dg_12m": "bez działalności gospodarczej w ostatnich 12 miesiącach",
}
PERSON_HINT = {
    "bezrobotny": "zarejestruj się w urzędzie pracy jako osoba bezrobotna przed złożeniem wniosku",
    "poszukujacy": "zarejestruj się w urzędzie pracy",
    "obszar_wiejski": "sprawdź, czy Twoja gmina jest w obszarze działania LGD",
    "bez_dg_12m": "dotacja zwykle przysługuje tylko, jeśli przez ostatnie 12 miesięcy nie miałeś firmy",
}

TYPES = {"dotacja": "dotacja", "pozyczka": "pożyczka", "mieszane": "dotacja + kredyt/pożyczka"}
STATUSES = {"open": "nabór trwa", "soon": "nabór wkrótce", "closed": "nabór zamknięty"}
