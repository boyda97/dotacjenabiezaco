"""Wspólne elementy adapterów źródeł: HTTP z ponowieniami, robots.txt, wyciąganie tekstu z HTML."""
from __future__ import annotations

import logging
import re
import time
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser
from typing import Iterator, Optional
from urllib.parse import urljoin, urlparse

from ..models import Program

log = logging.getLogger("dotacjomat.sources")
USER_AGENT = "DotacjeNaBiezacoBot/0.1 (+https://dotacjenabiezaco.pl/bot)"


class Source:
    """Adapter jednego źródła. Podklasa implementuje fetch() zwracające Programy
    (jeszcze niesklasyfikowane - klasyfikację robi pipeline na `description`)."""

    name = "base"

    def __init__(self, name: Optional[str] = None, **options):
        if name:
            self.name = name
        self.options = options

    def fetch(self) -> Iterator[Program]:
        raise NotImplementedError


class Http:
    """Prosty klient: limit tempa per host, 3 próby, poszanowanie robots.txt."""

    def __init__(self, delay: float = 1.0, timeout: float = 20.0, opener=None):
        self.delay, self.timeout = delay, timeout
        self._last: dict = {}
        self._robots: dict = {}
        self._open = opener or urllib.request.urlopen

    def allowed(self, url: str) -> bool:
        host = "{0.scheme}://{0.netloc}".format(urlparse(url))
        if host not in self._robots:
            rp = urllib.robotparser.RobotFileParser(host + "/robots.txt")
            try:
                rp.parse(self._raw(host + "/robots.txt").splitlines())
            except Exception:  # brak robots.txt = brak ograniczeń
                rp = None
            self._robots[host] = rp
        rp = self._robots[host]
        return rp is None or rp.can_fetch(USER_AGENT, url)

    def _raw(self, url: str, binary: bool = False):
        host = urlparse(url).netloc
        wait = self.delay - (time.monotonic() - self._last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "pl"})
        try:
            with self._open(req, timeout=self.timeout) as r:
                body = r.read()
                if binary:
                    return body
                charset = r.headers.get_content_charset() or "utf-8"
                return body.decode(charset, errors="replace")
        finally:
            self._last[host] = time.monotonic()

    def get_bytes(self, url: str) -> bytes:
        if not self.allowed(url):
            raise PermissionError(f"robots.txt nie pozwala pobrać {url}")
        return self._raw(url, binary=True)

    def get(self, url: str, retries: int = 3) -> str:
        if not self.allowed(url):
            raise PermissionError(f"robots.txt nie pozwala pobrać {url}")
        for attempt in range(retries):
            try:
                return self._raw(url)
            except PermissionError:
                raise
            except Exception as e:
                if attempt == retries - 1:
                    raise
                log.warning("Błąd pobierania %s (%s), ponawiam", url, e)
                time.sleep(2 ** attempt)
        raise RuntimeError("unreachable")


class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "nav", "footer", "header", "svg", "form"}
    BLOCK = {"p", "div", "li", "tr", "br", "h1", "h2", "h3", "h4", "section", "article", "td", "dd", "dt"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.links, self.title, self.h1 = [], [], "", ""
        self._skip = 0
        self._in = None

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        if tag in self.BLOCK:
            self.parts.append("\n")
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append([href, ""])
        if tag in ("title", "h1"):
            self._in = tag

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        if tag == self._in:
            self._in = None

    def handle_data(self, data):
        if self._in == "title":
            self.title += data
        elif self._in == "h1":
            self.h1 += data
        if self._skip:
            return
        self.parts.append(data)
        if self.links and self.links[-1][1] == "":
            self.links[-1][1] = data.strip()


def html_to_text(html: str, base_url: str = "") -> dict:
    """{'title', 'text', 'links': [(abs_url, anchor_text)]}"""
    p = _TextExtractor()
    p.feed(html)
    text = re.sub(r"[ \t\r\f\v]+", " ", "".join(p.parts))
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    title = (p.h1 or p.title).strip()
    links = [(urljoin(base_url, h), t) for h, t in p.links]
    return {"title": re.sub(r"\s+", " ", title), "text": text, "links": links}


class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self._row, self._cell, self._href = [], None, None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables.append([])
        elif tag == "tr" and self.tables:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell, self._href = [], None
        elif tag == "a" and self._cell is not None and self._href is None:
            self._href = dict(attrs).get("href")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None:
            self._row.append((re.sub(r"\s+", " ", "".join(self._cell)).strip(), self._href))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.tables[-1].append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def html_tables(html: str, base_url: str = "") -> list:
    """Każda tabela jako lista wierszy {nagłówek: (tekst, link)}; pierwszy wiersz = nagłówki."""
    p = _TableParser()
    p.feed(html)
    out = []
    for rows in p.tables:
        if len(rows) < 2:
            continue
        head = [h.lower() for h, _ in rows[0]]
        out.append([{head[i] if i < len(head) else str(i): (t, urljoin(base_url, h) if h else None)
                     for i, (t, h) in enumerate(r)} for r in rows[1:]])
    return out


def label_values(text: str, labels) -> dict:
    """Wyciąga pary etykieta-wartość z tekstu strony ('Dla kogo\\nMŚP z całej Polski' -> {...})."""
    pat = "|".join(re.escape(l) for l in labels)
    parts = re.split(rf"(?im)^\s*({pat})\s*:?\s*", text)
    out = {}
    for i in range(1, len(parts) - 1, 2):
        key = next(l for l in labels if l.lower() == parts[i].lower())
        out.setdefault(key, parts[i + 1].strip()[:2000])
    return out
