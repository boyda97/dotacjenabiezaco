"""Adaptery źródeł.

  seed      - lista programów z pliku JSON (redakcyjna/ręczna; format jak PROGRAMS na stronie)
  rss       - kanał RSS/Atom z ogłoszeniami o naborach
  html_list - strona z listą naborów + strony szczegółów (linki wybierane wyrażeniem regularnym)
  parp      - PARP: harmonogram naborów + karty programów (pary etykieta-wartość)
  govpl     - tabele harmonogramów w szablonie gov.pl (NFOŚiGW, ARiMR, NCBR)
  portal_fe - Portal Funduszy Europejskich przez Playwright (eksperymentalne)

Konkretne źródła (adresy, wzorce linków) opisuje config/sources.json, żeby dodanie
nowego serwisu nie wymagało zmian w kodzie.
"""
from __future__ import annotations

import hashlib
import json
import re
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterator

from ..models import Program
from .base import USER_AGENT, Http, Source, html_tables, html_to_text, label_values, log


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
        if kind in ("seed", "portal_fe"):
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


class PortalFESource(Source):
    """Portal Funduszy Europejskich (funduszeunijne.gov.pl) - lista ładowana JavaScriptem.

    Otwiera listę w Playwright i zbiera (1) odpowiedzi JSON z wewnętrznego API strony,
    (2) linki do kart naborów z wyrenderowanego DOM, potem pobiera karty.
    EKSPERYMENTALNE: struktura API nie została jeszcze podejrzana - przy pierwszym
    uruchomieniu włącz options.dump_dir, żeby zapisać ruch sieciowy i dopracować parser.
    Wymaga: pip install playwright && playwright install chromium.
    """

    name = "portal_fe"

    def fetch(self) -> Iterator[Program]:
        from playwright.sync_api import sync_playwright

        url = self.options.get("url", "https://www.funduszeunijne.gov.pl/strony/skorzystaj/nabory/")
        pat = re.compile(self.options.get("link_pattern", r"/nabory/[^/?#]+/?$"))
        dump = Path(self.options["dump_dir"]) if self.options.get("dump_dir") else None
        captured = []
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(user_agent=USER_AGENT, locale="pl-PL")

            def on_response(r):
                if "json" in (r.headers.get("content-type") or ""):
                    try:
                        captured.append((r.url, r.json()))
                    except Exception:
                        pass
            page.on("response", on_response)
            for n in range(1, int(self.options.get("pages", 5)) + 1):
                page.goto(url if n == 1 else f"{url}?page={n}", wait_until="networkidle")
                links = page.eval_on_selector_all("a[href]", "els => els.map(e => [e.href, e.innerText])")
                fresh = [(h, t.strip()) for h, t in links if pat.search(h) and h.rstrip("/") != url.rstrip("/")]
                if not fresh:
                    break
                for href, anchor in dict(fresh).items():
                    try:
                        page.goto(href, wait_until="networkidle")
                        detail = html_to_text(page.content(), href)
                    except Exception as e:
                        log.warning("[portal_fe] %s: %s", href, e)
                        continue
                    yield Program(source=self.name, source_id=_id(href), name=detail["title"] or anchor,
                                  url=href, op="Fundusze Europejskie", description=detail["text"][:20000])
            browser.close()
        if dump:
            dump.mkdir(parents=True, exist_ok=True)
            (dump / "portal_fe_xhr.json").write_text(json.dumps(captured, ensure_ascii=False)[:5_000_000])


ADAPTERS.update({"parp": ParpSource, "govpl": GovPlTableSource, "portal_fe": PortalFESource})
