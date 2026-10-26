"""Adaptery źródeł danych o dotacjach."""
from .adapters import (ADAPTERS, GovPlTableSource, HtmlListSource, ParpSource, PortalFESource,
                       RssSource, SeedSource, load_sources)
from .base import Http, Source, html_to_text
