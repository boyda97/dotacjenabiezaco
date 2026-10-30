"""Adaptery źródeł.

  seed      - lista programów z pliku JSON (redakcyjna/ręczna; format jak PROGRAMS na stronie)
  rss       - kanał RSS/Atom z ogłoszeniami o naborach
  html_list - strona z listą naborów + strony szczegółów (linki wybierane wyrażeniem regularnym)
  parp      - PARP: harmonogram naborów + karty programów (pary etykieta-wartość)
  govpl     - tabele harmonogramów w szablonie gov.pl (NFOŚiGW, ARiMR, NCBR)
  portal_fe - Portal Funduszy Europejskich: wszystkie nabory unijne (krajowe i 16 regionalnych)
  govpl_news - nabory z aktualności instytucji na gov.pl (ARiMR, NCBR)

Konkretne źródła (adresy, wzorce linków) opisuje config/sources.json, żeby dodanie
nowego serwisu nie wymagało zmian w kodzie.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterator
from urllib.parse import urljoin

from .. import taxonomy as tx
from ..models import Program
from ..classify import norm
from .base import Http, Source, html_tables, html_to_text, label_values, log


def _id(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:12]


class SeedSource(Source):
    name = "seed"

    def fetch(self) -> Iterator[Program]:
        path = Path(self.options["path"])
        for d in json.loads(path.read_text(encoding="utf-8")):
            d = dict(d)
            d.setdefault("source", self.name)
            d.setdefault("source_id", str(d.pop("id", _id(d["url"] + d["name"]))))
            d.pop("id", None)
            yield Program.from_dict(d)


class RssSource(Source):
    """options: url, op (operator), include (regex na tytuł - np. 'nab[oó]r|konkurs'), follow (bool)"""

    name = "rss"

    def __init__(self, name=None, http: Http = None, **options):
        super().__init__(name, **options)
        self.http = http or Http()

    def fetch(self) -> Iterator[Program]:
        xml = self.http.get(self.options["url"])
        root = ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
        ns = {"a": "http://www.w3.org/2005/Atom"}
        items = root.findall(".//item") or root.findall(".//a:entry", ns)
        include = re.compile(self.options.get("include", "."), re.I)
        for it in items:
            title = (it.findtext("title") or it.findtext("a:title", namespaces=ns) or "").strip()
            link = it.findtext("link") or ""
            if not link:
                el = it.find("a:link", ns)
                link = el.get("href") if el is not None else ""
            desc = it.findtext("description") or it.findtext("a:summary", namespaces=ns) or ""
            if not title or not include.search(title):
                continue
            text = html_to_text(desc)["text"]
            if self.options.get("follow") and link:
                try:
                    text += "\n" + html_to_text(self.http.get(link), link)["text"]
                except Exception as e:
                    log.warning("[%s] nie pobrano %s: %s", self.name, link, e)
            pub = it.findtext("pubDate")
            yield Program(source=self.name, source_id=_id(link or title), name=title, url=link,
                          op=self.options.get("op", ""), description=text,
                          how=self._published(pub))

    @staticmethod
    def _published(pub):
        try:
            return "" if not pub else f"Ogłoszono {parsedate_to_datetime(pub).date().isoformat()}."
        except (TypeError, ValueError):
            return ""


class HtmlListSource(Source):
    """options: url (lista; może zawierać {page}), pages (int), link_pattern (regex na URL szczegółów),
    op, max_items."""

    name = "html_list"

    def __init__(self, name=None, http: Http = None, **options):
        super().__init__(name, **options)
        self.http = http or Http()

    def fetch(self) -> Iterator[Program]:
        pat = re.compile(self.options["link_pattern"])
        seen, n = set(), 0
        for page in range(1, int(self.options.get("pages", 1)) + 1):
            url = self.options["url"].format(page=page)
            listing = html_to_text(self.http.get(url), url)
            for link, anchor in listing["links"]:
                if not pat.search(link) or link in seen:
                    continue
                seen.add(link)
                if n >= int(self.options.get("max_items", 200)):
                    return
                try:
                    detail = html_to_text(self.http.get(link), link)
                except Exception as e:
                    log.warning("[%s] nie pobrano %s: %s", self.name, link, e)
                    continue
                n += 1
                yield Program(source=self.name, source_id=_id(link), name=detail["title"] or anchor,
                              url=link, op=self.options.get("op", ""), description=detail["text"][:20000],
                              docs=self._detail_docs(detail["links"]))

    def _detail_docs(self, links):
        return [u for u, t in links if u.lower().endswith(".pdf")][:5]


ADAPTERS = {"seed": SeedSource, "rss": RssSource, "html_list": HtmlListSource}


def load_sources(config_path, http: Http = None, base_dir=None) -> list:
    """Buduje adaptery z pliku config/sources.json (pomija wpisy z "enabled": false)."""
    config_path = Path(config_path)
    base_dir = Path(base_dir or config_path.parent.parent)
    out = []
    for entry in json.loads(config_path.read_text(encoding="utf-8")):
        if not entry.get("enabled", True):
            continue
        entry = dict(entry)
        kind = entry.pop("adapter")
        cls = ADAPTERS[kind]
        for k in ("enabled", "note"):
            entry.pop(k, None)
        if kind == "seed" or "dump_dir" in entry:
            for k in ("path", "dump_dir"):
                if k in entry:
                    entry[k] = str(base_dir / entry[k])
        if kind == "seed":
            out.append(cls(**entry))
        else:
            out.append(cls(http=http, **entry))
    return out


class ParpSource(HtmlListSource):
    """PARP: harmonogram naborów + karty /component/grants/grants/<nazwa> z parami etykieta-wartość."""

    name = "parp"
    LABELS = ["Cel finansowania", "Dla kogo", "Wielkość firmy", "Miejsce realizacji",
              "Termin naboru", "Nabór", "Budżet", "Maksymalne dofinansowanie", "Dokumenty"]

    def __init__(self, name=None, http: Http = None, **options):
        options.setdefault("url", "https://www.parp.gov.pl/harmonogram-naborow")
        options.setdefault("link_pattern", r"/component/grants/grants/[^/?#]+$")
        options.setdefault("op", "PARP")
        super().__init__(name, http, **options)

    def fetch(self) -> Iterator[Program]:
        for p in super().fetch():
            fields = label_values(p.description, self.LABELS)
            if fields:
                # etykiety na początek opisu - klasyfikator i AI dostają najważniejsze pola najpierw
                head = "\n".join(f"{k}: {v}" for k, v in fields.items())
                p.description = head + "\n\n" + p.description
            yield p

    def _detail_docs(self, links):
        return [u for u, t in links if u.lower().endswith(".pdf") and re.search(r"regulamin", u + t, re.I)]


class GovPlTableSource(Source):
    """Harmonogramy naborów w szablonie gov.pl (NFOŚiGW, ARiMR, NCBR): tabela HTML.
    options: url, op, name_col / date_col / status_col / kind_col (fragmenty nagłówków), follow (bool)."""

    name = "govpl"

    def __init__(self, name=None, http: Http = None, **options):
        super().__init__(name, **options)
        self.http = http or Http()

    def _col(self, row, key, default):
        frag = self.options.get(key, default)
        return next(((t, h) for k, (t, h) in row.items() if frag in k), ("", None))

    def fetch(self) -> Iterator[Program]:
        url = self.options["url"]
        html = self.http.get(url)
        for table in html_tables(html, url):
            for row in table:
                name, link = self._col(row, "name_col", "nazw")
                if not name:
                    continue
                dates, _ = self._col(row, "date_col", "termin")
                if not dates:
                    dates = " ".join(t for k, (t, _) in row.items() if "data" in k or "od" == k or "do" == k)
                status, _ = self._col(row, "status_col", "stan")
                kind, _ = self._col(row, "kind_col", "oznacz")
                desc = " | ".join(f"{k}: {t}" for k, (t, _) in row.items() if t)
                if self.options.get("follow") and link:
                    try:
                        desc += "\n" + html_to_text(self.http.get(link), link)["text"][:20000]
                    except Exception as e:
                        log.warning("[%s] nie pobrano %s: %s", self.name, link, e)
                p = Program(source=self.name, source_id=_id(name + (link or "")), name=name,
                            url=link or url, op=self.options.get("op", ""), description=desc)
                if re.search(r"zako[nń]cz|zamkni", status, re.I):
                    p.status = "closed"
                yield p


# Program operacyjny (koniec tytułu na Portalu FE) -> województwo; programy krajowe -> None (cała Polska).
FE_REGIONS = {
    "dolnego śląska": ["dolnoslaskie"], "kujaw i pomorza": ["kujawsko"], "lubelskiego": ["lubelskie"],
    "lubuskiego": ["lubuskie"], "łódzkiego": ["lodzkie"], "małopolski": ["malopolskie"],
    "mazowsza": ["mazowieckie"], "opolskiego": ["opolskie"], "podkarpacia": ["podkarpackie"],
    "podlaskiego": ["podlaskie"], "pomorza zachodniego": ["zachodniopomorskie"], "pomorza": ["pomorskie"],
    "śląskiego": ["slaskie"], "świętokrzyskiego": ["swietokrzyskie"], "warmii i mazur": ["warminsko"],
    "wielkopolski": ["wielkopolskie"],
}
FE_NATIONAL = ("nowoczesnej gospodarki", "rozwoju społecznego", "rozwój cyfrowy", "środowisko",
               "rybactwa", "pomoc techniczna", "infrastruktura, klimat")
FE_SECTIONS = ["Informacje o naborze", "Kto może składać wnioski?", "Na co można otrzymać dofinansowanie",
               "Kryteria wyboru projektów", "Finanse", "Niezbędne dokumenty", "Inne ważne informacje",
               "Jakie środki odwoławcze", "Wyniki naboru"]


# Tytuł/opis naboru, w którym wsparcie trafia do samej firmy (inwestycja, B+R, eksport, kadry, pożyczka).
FIRM_STEMS = (r"przedsiebior|(?<![a-z])msp|(?<![a-z])firm|pracodaw|przemysl|innowac|b\+r|badan[a-z]* i (rozwoj|innowac)|"
              r"badawczo|eksport|rynk[a-z]* zagraniczn|internacjonaliz|kredyt|pozyczk|start-?up|platform[a-z]* startow|"
              r"technolog|dual-?use|podwojnego zastosowania|eurogrant|horizon|kadr[a-z]* (regionaln[a-z]* )?gospodark|"
              r"zdrowy[a-z]* (i aktywn[a-z]* )?pracownik|cyfryzac[a-z]* (msp|przedsieb|firm)|wzornict|automatyzac|robotyzac")
# Nabory, w których firma mogłaby być najwyżej realizatorem projektu dla innych albo które są inwestycją publiczną.
OPERATOR_STEMS = (r"szkol|uczni|przedszkol|edukacj|ksztalceni|uslug[a-z]* spoleczn|uslug[a-z]* zdrowotn|integrac|"
                  r"aktywizac|wlaczeni|staz|alma|bezrobotn|mieszkanc|rodzin|opiek|kultur|gotowos[a-z]* cywiln|"
                  r"obywatel|wod|sciek|drog|transport|rewitaliz|transgraniczn|wspolprac|ochron[a-z]* (przyrod|ludnos)|"
                  r"odporn[a-z]* (i gotowos|cyfrow[a-z]* region)|infrastruktur[a-z]* (spoleczn|zdrow|edukac|drogow)")


# Nabory na B+R, innowacje, technologie i przemysł (w tym obronny) nie są dla handlu i usług osobistych.
TECH_STEMS = (r"b\+r|badawcz|badan[a-z]* (i|naukow|przemysl)|innowac|technolog|dual-?use|podwojnego zastosowania|"
              r"obronn|przemysl|horizon|eurogrant|ekosystem[a-z]* innowac")
TECH_SECTORS = ["B", "C", "C10", "D", "E", "F", "H", "J", "M", "Q"]


def tech_sectors(p: Program, title: str) -> None:
    if p.sectors is None and re.search(TECH_STEMS, norm(title)):
        p.sectors = list(TECH_SECTORS)


def firm_directed(name: str, prog: str, what: str) -> bool:
    """Czy nabór daje wsparcie samej firmie (a nie: firma realizuje projekt dla innych / inwestycja publiczna)."""
    title = norm(name)
    if "interreg" in norm(prog) or re.search(r"poludniow[a-z]* baltyk|transgraniczn", title):
        return False
    if re.search(FIRM_STEMS, title):
        return True
    if re.search(OPERATOR_STEMS, title):
        return False
    # Tytuł nic nie mówi (np. "2.5 Odpady i GOZ"): decyduje pierwszy akapit "na co".
    head = norm(what[:800])
    return bool(re.search(r"przedsiebiorstw|(?<![a-z])msp|(?<![a-z])firm", head)) and not re.search(OPERATOR_STEMS, head[:200])


def _sections(text: str, heads) -> dict:
    """Dzieli tekst strony na sekcje według nagłówków (pierwsze wystąpienie każdego)."""
    pos = sorted((text.find(h), h) for h in heads if text.find(h) >= 0)
    return {h: text[a + len(h):(pos[k + 1][0] if k + 1 < len(pos) else len(text))].strip()
            for k, (a, h) in enumerate(pos)}


def _after(text: str, label: str, n: int = 300) -> str:
    i = text.find(label)
    return text[i + len(label):i + len(label) + n].strip().split("\n")[0].strip() if i >= 0 else ""


class PortalFESource(Source):
    """Portal Funduszy Europejskich (funduszeunijne.gov.pl): wszystkie nabory z programów unijnych
    2021-2027 - krajowych (FENG, FERS, FEnIKS, FEPW, FERC, FER), 16 regionalnych i Interreg.

    Lista jest ładowana przez AJAX (POST /umbraco/surface/FiltersSurface/GetNabory) z tokenem CSRF
    i ciasteczkiem sesji ze strony listy; filtr "stan naboru" = planowany + aktualny.
    Karta naboru ma stałe sekcje (Kto może składać wnioski, Na co, Finanse, Niezbędne dokumenty),
    z których adapter sam ustawia województwo, typ beneficjenta, poziom i termin.
    options: url, max_pages, max_items, statuses (lista identyfikatorów filtra stanu)."""

    name = "portal_fe"
    BASE = "https://www.funduszeunijne.gov.pl"
    LIST_API = "/umbraco/surface/FiltersSurface/GetNabory"
    STATUS_FILTER = "3762"
    STATUSES = {"planowany": "1197", "aktualny": "1198"}

    def __init__(self, name=None, http: Http = None, **options):
        super().__init__(name, **options)
        self.http = http or Http()

    def listing(self) -> list:
        url = self.options.get("url", self.BASE + "/strony/skorzystaj/nabory/")
        page = self.http.get(url)
        m = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', page)
        if not m:
            raise RuntimeError("Portal FE: brak tokenu formularza na stronie listy")
        filt = "".join(f"/{self.STATUS_FILTER}={v}" for v in self.options.get("statuses", self.STATUSES.values()))
        items, seen = [], set()
        for n in range(1, int(self.options.get("max_pages", 100)) + 1):
            body = self.http.post(self.BASE + self.LIST_API, {
                "id": "4073", "hashUrl": "domyslne=1" + filt + (f"/strona={n}" if n > 1 else ""),
                "typeOfDate": "Data ostatniej publikacji", "partialName": "MIRNaboryWnioskow2Items",
                "ctResultPagesAlias": "MIRNaboryWnioskow", "lang": "pl",
                "__RequestVerificationToken": m.group(1), "reCaptchaToken": "",
            }, headers={"X-Requested-With": "XMLHttpRequest", "Referer": url})
            fresh = 0
            for li in re.findall(r"<li class=\"row\">(.*?)</li>", body, re.S):
                a = re.search(r'<a href="(/nabory/[^"]+)" class="title">([^<]+)</a>', li)
                if not a or a.group(1) in seen:
                    continue
                seen.add(a.group(1))
                fresh += 1
                st = re.search(r'<span class="status">\s*([^<]*?)\s*</span>', li)
                dates = re.findall(r"<span>\s*(\d\d)\.(\d\d)\.(\d{4})\s*</span>", li)
                items.append({"url": self.BASE + a.group(1), "title": html.unescape(a.group(2)).strip(),
                              "status": (st.group(1) if st else "").lower(),
                              "dates": [f"{y}-{mo}-{d}" for d, mo, y in dates]})
            if not fresh:
                break
        return items

    def fetch(self) -> Iterator[Program]:
        for n, it in enumerate(self.listing()):
            if n >= int(self.options.get("max_items", 1000)):
                return
            try:
                raw = self.http.get(it["url"])
            except Exception as e:
                log.warning("[%s] nie pobrano %s: %s", self.name, it["url"], e)
                continue
            yield self.parse(it, raw)

    def parse(self, it: dict, raw: str) -> Program:
        from ..classify import classify

        page = html_to_text(raw, it["url"])
        text = page["text"]
        sec = _sections(text, FE_SECTIONS)
        name, _, prog = it["title"].rpartition(",")
        name, prog = (name or prog).strip(), prog.strip()
        p = Program(source=self.name, source_id=_id(it["url"]), name=name, url=it["url"], op=prog)
        if len(it["dates"]) >= 2:
            p.start, p.deadline = it["dates"][0], it["dates"][-1]
        elif it["dates"]:
            p.start = it["dates"][0]
        p.status = "soon" if it["status"].startswith("planow") else "closed" if it["status"].startswith("zako") else "open"

        low = prog.lower()
        if "fundusze europejskie dla polski wschodniej" in low:
            p.regions = sorted(tx.EAST)
        elif any(k in low for k in FE_NATIONAL):
            p.regions = None
        else:
            for key, regs in FE_REGIONS.items():
                if low.endswith(key):
                    p.regions = regs
                    break

        who = norm(sec.get("Kto może składać wnioski?", ""))
        firms = re.search(r"przedsiebior|msp|mikro|(?<![a-z])firm|osob[a-z]* prowadzac[a-z]* dzialalnosc", who)
        forms = set(tx.BUSINESS_FORMS) if firms else set()
        if re.search(r"organizac[a-z]* (pozarzad|spoleczn)|fundac|stowarzysz|ekonomi[a-z]* spoleczn|spoldziel", who):
            forms.add("ngo")
        if re.search(r"jednost[a-z]* samorzad|administrac|uczeln|jednost[a-z]* naukow|szkol|instytuc", who):
            forms.add("jst")
        if re.search(r"rolni|rybac|gospodarstw", who):
            forms.add("rolne")
        if re.search(r"osob[a-z]* fizyczn", who) and re.search(r"zalozen|rozpoczec|zamierzaj", who):
            forms.add("none")
        if who and (not forms or "niekonkurencyjn" in norm(text)):
            # Nabór dla wskazanego z nazwy podmiotu publicznego (np. "Województwo Lubelskie",
            # "Regionalne Centra Krwiodawstwa") albo niekonkurencyjny - nie dla firm.
            forms, firms = {"jst"}, None
        what = re.sub(r"^/wsparcie\?\s*", "", sec.get("Na co można otrzymać dofinansowanie", ""))
        if firms and not firm_directed(name, prog, what):
            # Firma jest tu tylko jednym z możliwych realizatorów projektu dla innych (szkół, bezrobotnych,
            # mieszkańców) albo inwestycji publicznej - właściciel firmy nie dostaje wsparcia dla siebie.
            forms -= set(tx.BUSINESS_FORMS) | {"none"}
            forms, firms = forms or {"jst"}, None
        if forms:
            p.forms = sorted(forms)
        if firms:
            sizes = set()
            if re.search(r"msp|mikro|malych|male |srednich|srednie ", who) or re.search(r"przedsiebiorstw(a|o)(?! realizuj)", who):
                sizes |= set(tx.MSP)
            if re.search(r"duz[aey][a-z]* przedsieb|duzych", who):
                sizes.add("large")
            if sizes:
                p.sizes = sorted(sizes)

        fin = sec.get("Finanse", "")
        lvl = re.search(r"(\d{1,3}(?:[,.]\d+)?)\s*%", fin[fin.find("Poziom dofinansowania"):][:500]) if "Poziom dofinansowania" in fin else None
        if lvl:
            p.level = f"do {lvl.group(1)} %"
        cap = _after(fin, "Maksymalna wartość", 300) or _after(fin, "Maksymalna kwota", 300)
        if cap:
            from ..classify import parse_amounts
            amounts = [a for a in parse_amounts(cap) if a >= 1000]
            if amounts:
                p.max = max(amounts)
        where = " ".join(x for x in (_after(text, "Sposób składania wniosków"), _after(text, "Miejsce składania wniosków", 200)) if x)
        p.apply_where = where[:300]
        p.docs = [u for u, t in page["links"] if u.lower().endswith(".pdf")][:5]
        intro = sec.get("Informacje o naborze", "")[:1500]
        p.description = "\n\n".join(x for x in (
            f"Program: {prog}", f"Kto może składać wnioski: {sec.get('Kto może składać wnioski?', '')[:3000]}",
            f"Na co: {what[:6000]}", f"Finanse: {fin[:2000]}", intro) if x)
        # Klasyfikator dostaje tylko nazwę i "na co": sekcja "kto może" wymienia dziesiątki typów podmiotów,
        # a "finanse" podaje pulę całego naboru, nie kwotę dla jednej firmy.
        if p.max is None:
            p.max = 0
        classify(p, f"{name}\n{what[:1500]}")
        tech_sectors(p, name)
        if p.max == 0:
            p.max = None
        if p.forms is None or not firms:
            p.unknown = sorted(set(p.unknown) - {"forms", "sizes"})
        p._classified = True
        return p


class GovPlNewsSource(Source):
    """Nabory ogłaszane w aktualnościach instytucji na gov.pl (ARiMR, NCBR), gdy harmonogram jest tylko w PDF.

    Bierze wiadomości z ostatnich `max_age_days` dni, których tytuł zapowiada nabór, czyta artykuł
    i ustala termin. Bez przyszłego terminu w tytule lub na początku artykułu wiadomość jest pomijana
    (nie wiemy, czy nabór trwa). Kilka wiadomości o tym samym naborze ("rusza", "kończy się")
    łączy w jeden wpis - wygrywa najnowsza.
    options: url (lista "wszystkie aktualności"), op, pages, max_age_days, include, exclude, forms,
    tech (true = wszystkie nabory tej instytucji to B+R, np. NCBR - tylko dla branż technicznych)."""

    name = "govpl_news"
    INCLUDE = r"nab[oó]r|wnios(ek|ki|k[oó]w)|konkurs"
    EXCLUDE = (r"podsumowan|wynik|list[ay] (rankingow|ocenionych)|wyp[lł]at|p[lł]atno|zaliczk|rozlicz|"
               r"kontrol|wniosek o p[lł]atno|zmian[ay] w|szkolenie dla pracownik|dofinansowan[a-z]* przyznan|"
               r"spotkani|info ?day|nagrani|webinar|konferencj")

    def __init__(self, name=None, http: Http = None, **options):
        super().__init__(name, **options)
        self.http = http or Http()

    def fetch(self, today: date = None) -> Iterator[Program]:
        from ..classify import classify, parse_dates

        today = today or date.today()
        oldest = today - timedelta(days=int(self.options.get("max_age_days", 120)))
        inc = re.compile(self.options.get("include", self.INCLUDE), re.I)
        exc = re.compile(self.options.get("exclude", self.EXCLUDE), re.I)
        url = self.options["url"]
        found = []
        for n in range(1, int(self.options.get("pages", 5)) + 1):
            body = self.http.get(url if n == 1 else f"{url}?page={n}&size=10")
            items = re.findall(r'class="date">\s*(\d\d)\.(\d\d)\.(\d{4})\s*</span>.*?<a href="([^"]+)">([^<]+)</a>', body, re.S)
            if not items:
                break
            for d, m, y, href, title in items:
                published = date(int(y), int(m), int(d))
                title = html.unescape(title).strip()
                if published >= oldest and inc.search(title) and not exc.search(title):
                    found.append((published, urljoin(url, href), title))
            if published < oldest:
                break
        merged = {}
        for published, link, title in sorted(found, reverse=True):
            try:
                page = html_to_text(self.http.get(link), link)
            except Exception as e:
                log.warning("[%s] nie pobrano %s: %s", self.name, link, e)
                continue
            text = page["text"]
            start = text.find(title[:40])
            body = text[start:] if start >= 0 else text
            dates = [x for x in parse_dates(f"{title}\n{body[:2500]}") if x >= today]
            if not dates:
                continue
            p = Program(source=self.name, source_id=_id(link), name=title, url=link,
                        op=self.options.get("op", ""), description=body[:20000])
            p.deadline = max(dates).isoformat()
            past = [x for x in parse_dates(body[:1500]) if published - timedelta(days=60) <= x < max(dates)]
            p.start = min(past).isoformat() if past else None
            if self.options.get("forms"):
                p.forms = list(self.options["forms"])
            p.max = 0  # kwoty w wiadomościach to zwykle budżet całego naboru, nie limit dla jednego wnioskodawcy
            classify(p, f"{title}\n{body[:6000]}", today)
            tech_sectors(p, title if not self.options.get("tech") else "b+r")
            p.max = None
            p._classified = True
            words = set(re.findall(r"[a-ząćęłńóśźż]{5,}", title.lower()))
            dup = next((k for k, (w, q) in merged.items()
                        if q.deadline == p.deadline and len(words & w) >= max(1, min(len(words), len(w)) // 3)), None)
            if dup is None:
                merged[p.key] = (words, p)
        for _, p in merged.values():
            yield p


ADAPTERS.update({"parp": ParpSource, "govpl": GovPlTableSource, "portal_fe": PortalFESource,
                 "govpl_news": GovPlNewsSource})
