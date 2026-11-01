import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from dotacjomat import ai_extract, company, taxonomy as tx
from dotacjomat.classify import classify, parse_amounts, parse_dates
from dotacjomat.matching import rank, score
from dotacjomat.models import CompanyProfile, Program
from dotacjomat.pipeline import digest, update
from dotacjomat.sources import GovPlTableSource, RssSource, SeedSource
from dotacjomat.sources.adapters import GovPlNewsSource, ParpSource, PortalFESource, firm_directed
from dotacjomat.storage import Store

FIX = Path(__file__).parent / "fixtures"
ROOT = Path(__file__).parent.parent
TODAY = date(2026, 10, 26)


class FakeHttp:
    def __init__(self, pages):
        self.pages = pages
        self.posts = []

    def post(self, url, form, headers=None):
        self.posts.append(form)
        return self.get(url) if len(self.posts) == 1 else "<ul></ul>"

    def get(self, url):
        for suffix, name in self.pages.items():
            if url.endswith(suffix):
                return (FIX / name).read_text(encoding="utf-8")
        raise IOError(f"404 {url}")


def prog(**kw):
    base = dict(source="t", source_id="1", name="Test", url="https://x", goals=["digital"])
    base.update(kw)
    return Program(**base)


def firm(**kw):
    base = dict(region="mazowieckie", form="zoo", size="small", pkd="62.01.Z")
    base.update(kw)
    return CompanyProfile(**base)


class TaxonomyTest(unittest.TestCase):
    def test_pkd_to_sector(self):
        self.assertEqual(tx.sector_from_pkd("73.11.Z"), "M")
        self.assertEqual(tx.sector_from_pkd("10.71.Z"), "C10")
        self.assertEqual(tx.sector_from_pkd("79.11.A"), "N79")
        self.assertEqual(tx.sector_from_pkd("62.01.Z"), "J")
        self.assertIsNone(tx.sector_from_pkd(""))

    def test_subsection_covered_by_section(self):
        self.assertTrue(tx.sector_covers("C", "C10"))
        self.assertFalse(tx.sector_covers("C10", "C"))


class MatchingTest(unittest.TestCase):
    def test_full_match_matches_page_scoring(self):
        r = score(prog(regions=None, forms=["zoo"], sizes=["small"], sectors=["J"]), firm(goals=["digital"]), TODAY)
        self.assertTrue(r.eligible)
        self.assertEqual(r.score, 100)

    def test_hard_filters(self):
        f = firm()
        self.assertFalse(score(prog(regions=["lubelskie"]), f, TODAY).eligible)
        self.assertFalse(score(prog(forms=["jdg"]), f, TODAY).eligible)
        self.assertFalse(score(prog(sizes=["micro"]), f, TODAY).eligible)
        self.assertFalse(score(prog(sectors=["A"]), f, TODAY).eligible)
        self.assertFalse(score(prog(goals=["oze"]), firm(goals=["digital"]), TODAY).eligible)
        self.assertFalse(score(prog(status="closed"), f, TODAY).eligible)

    def test_sector_programs_hidden_without_company_sector(self):
        # NIP bez PKD z rejestru: dotacja dla pszczelarzy (tylko rolnictwo) nie trafia do firmy w ciemno
        f = firm(pkd=None, sector=None)
        self.assertFalse(score(prog(sectors=["A"]), f, TODAY).eligible)
        self.assertFalse(score(prog(sectors=["A", "C10"]), f, TODAY).eligible)
        self.assertTrue(score(prog(sectors=None), f, TODAY).eligible)
        wide = [s for s in tx.SECTORS if s not in ("A", "B", "O")]
        self.assertTrue(score(prog(sectors=wide), f, TODAY).eligible)
        self.assertTrue(score(prog(sectors=["A"]), f, TODAY, strict=False).eligible)
        self.assertTrue(score(prog(sectors=["A"]), firm(pkd="01.49.Z"), TODAY).eligible)

    def test_unknown_criteria_hidden_by_default(self):
        # strona pokazuje tylko sprawdzone dopasowania
        p = prog(regions=None, sizes=None, unknown=["regions", "sizes"])
        self.assertFalse(score(p, firm(), TODAY).eligible)
        self.assertFalse(score(prog(goals=[]), firm(goals=["digital"]), TODAY).eligible)

    def test_unknown_criteria_are_not_rejected_in_preview(self):
        r = score(prog(regions=None, sizes=None, unknown=["regions", "sizes"]), firm(), TODAY, strict=False)
        self.assertTrue(r.eligible)
        self.assertIn("check", [x.state for x in r.reasons])
        full = score(prog(), firm(), TODAY, strict=False)
        self.assertLess(r.score, full.score)

    def test_pkd_exclusion(self):
        self.assertFalse(score(prog(pkd_excluded=["62"]), firm(), TODAY).eligible)
        self.assertTrue(score(prog(pkd_excluded=["01", "46.1"]), firm(), TODAY).eligible)

    def test_rank_orders_by_score_then_deadline(self):
        a = prog(source_id="a", deadline="2026-12-31")
        b = prog(source_id="b", deadline="2026-11-05")
        c = prog(source_id="c", regions=["mazowieckie"], sizes=None, unknown=["sizes"])
        keys = [r.program.source_id for r in rank([a, b, c], firm(), TODAY, strict=False)]
        self.assertEqual(keys, ["b", "a", "c"])
        keys = [r.program.source_id for r in rank([a, b, c], firm(), TODAY)]
        self.assertEqual(keys, ["b", "a"])


class FounderTest(unittest.TestCase):
    """Osoba, która dopiero planuje założyć firmę (bez NIP)."""

    def setUp(self):
        self.programs = list(SeedSource(path=str(ROOT / "data/programs_seed.json")).fetch())

    def test_founder_profile_normalised(self):
        f = CompanyProfile(region="lubelskie", form="none", size="micro", nip="123")
        self.assertEqual((f.size, f.nip), ("start", None))

    def test_founder_sees_only_startup_programs(self):
        f = CompanyProfile(region="lubelskie", form="none", size="start", person=["bezrobotny"])
        res = rank(self.programs, f, TODAY)
        self.assertTrue(res)
        for r in res:
            self.assertIn("none", r.program.forms)
        top = res[0].program
        self.assertIn("start", top.goals)

    def test_missing_status_is_hint_not_rejection(self):
        pup = next(p for p in self.programs if p.source_id == "start-pup")
        no_status = score(pup, CompanyProfile(region="slaskie", form="none", size="start"), TODAY)
        with_status = score(pup, CompanyProfile(region="slaskie", form="none", size="start",
                                                person=["bezrobotny"]), TODAY)
        self.assertTrue(no_status.eligible)
        self.assertGreater(with_status.score, no_status.score)
        self.assertTrue(any("urzędzie pracy" in r.text for r in no_status.reasons))

    def test_existing_company_does_not_get_founder_grants(self):
        pup = next(p for p in self.programs if p.source_id == "start-pup")
        self.assertFalse(score(pup, firm(), TODAY).eligible)


class ClassifyTest(unittest.TestCase):
    def test_dates_and_amounts(self):
        self.assertEqual(parse_dates("od 01.12.2026 do 31 stycznia 2027"), [date(2026, 12, 1), date(2027, 1, 31)])
        self.assertEqual(parse_amounts("maks. 1,5 mln zł albo 500 000 zł lub 10 tys. euro"), [1500000, 500000, 43000])

    def test_regional_msp_digital(self):
        p = prog(goals=[], name="Cyfryzacja MŚP")
        classify(p, "Nabór dla mikro, małych i średnich przedsiębiorstw z województwa lubelskiego. "
                    "Wdrożenie oprogramowania i e-commerce. Do 70 %, maksymalnie 500 000 zł. "
                    "Wnioski od 01.12.2026 do 31.01.2027.", TODAY)
        self.assertEqual(p.regions, ["lubelskie"])
        self.assertEqual(p.sizes, ["medium", "micro", "small"])
        self.assertIn("digital", p.goals)
        self.assertEqual((p.max, p.level, p.deadline, p.status), (500000, "do 70 %", "2027-01-31", "soon"))

    def test_kujawsko_pomorskie_is_not_pomorskie(self):
        p = prog(goals=[])
        classify(p, "dla firm z województwa kujawsko-pomorskiego", TODAY)
        self.assertEqual(p.regions, ["kujawsko"])

    def test_unknown_marked(self):
        p = prog(goals=[])
        classify(p, "Ogłoszenie o naborze.", TODAY)
        self.assertIn("goals", p.unknown)
        self.assertIn("sizes", p.unknown)


class SourcesTest(unittest.TestCase):
    def test_rss_filters_and_parses(self):
        src = RssSource(name="lub", http=FakeHttp({"feed": "rss.xml"}), url="https://x/feed", include="nab[oó]r")
        items = list(src.fetch())
        self.assertEqual(len(items), 1)
        self.assertIn("lubelskiego", items[0].description)

    def test_govpl_table(self):
        src = GovPlTableSource(name="nfos", http=FakeHttp({"harmonogram": "govpl.html"}),
                               url="https://www.gov.pl/web/nfosigw/harmonogram")
        items = {p.name: p for p in src.fetch()}
        self.assertEqual(set(items), {"Energia dla wsi", "Program zamknięty", "Czyste Powietrze", "Bez strony"})
        self.assertEqual(items["Energia dla wsi"].url, "https://www.gov.pl/web/nfosigw/energia-dla-wsi")
        # NFOŚiGW daje link do naboru w kolumnie "oznaczenie naboru", często opakowany przez Outlooka
        self.assertEqual(items["Czyste Powietrze"].url, "https://czystepowietrze.gov.pl/wez-dofinansowanie/")
        # bez linku do naboru zostaje harmonogram, nie mail koordynatora
        self.assertEqual(items["Bez strony"].url, "https://www.gov.pl/web/nfosigw/harmonogram")
        self.assertEqual(items["Program zamknięty"].status, "closed")

    def test_parp_detail_labels_and_docs(self):
        http = FakeHttp({"harmonogram-naborow": "parp_list.html", "sciezka-smart": "parp_detail.html",
                         "bony-na-innowacje": "parp_detail.html"})
        src = ParpSource(http=http, url="https://www.parp.gov.pl/harmonogram-naborow")
        items = list(src.fetch())
        self.assertEqual(len(items), 2)
        p = items[0]
        self.assertEqual(p.name, "Bony na innowacje dla MŚP")
        self.assertTrue(p.description.startswith("Cel finansowania:"))
        self.assertEqual(p.docs, ["https://www.parp.gov.pl/storage/regulamin-bony.pdf"])
        classify(p, p.description, TODAY)
        self.assertIn("badania", p.goals)
        self.assertEqual((p.start, p.deadline), ("2027-01-15", "2027-02-28"))


class PortalFETest(unittest.TestCase):
    def test_listing_uses_token_status_filter_and_pages(self):
        http = FakeHttp({"/strony/skorzystaj/nabory/": "portal_fe_page.html", "GetNabory": "portal_fe_list.html"})
        items = PortalFESource(http=http).listing()
        self.assertEqual(len(items), 2)
        self.assertEqual(http.posts[0]["__RequestVerificationToken"], "tok123")
        self.assertIn("/3762=1197/3762=1198", http.posts[0]["hashUrl"])
        self.assertEqual(http.posts[1]["hashUrl"].split("/")[-1], "strona=2")
        a, b = items
        self.assertTrue(a["url"].startswith("https://www.funduszeunijne.gov.pl/nabory/"))
        self.assertEqual((a["status"], a["dates"]), ("aktualny", ["2026-05-13", "2026-06-17"]))
        self.assertEqual(b["status"], "planowany")
        self.assertTrue(b["title"].endswith("Fundusze Europejskie dla Kujaw i Pomorza"))

    def test_detail_for_firms_and_public_only(self):
        src = PortalFESource(http=FakeHttp({}))
        it = {"url": "https://www.funduszeunijne.gov.pl/nabory/53-alma/", "status": "aktualny",
              "dates": ["2026-10-30", "2027-01-29"],
              "title": "5.3 ALMA - staże zagraniczne dla młodych (352/26), Fundusze Europejskie dla Śląskiego"}
        p = src.parse(it, (FIX / "portal_fe_detail.html").read_text(encoding="utf-8"))
        self.assertEqual((p.name, p.op), ("5.3 ALMA - staże zagraniczne dla młodych (352/26)", "Fundusze Europejskie dla Śląskiego"))
        self.assertEqual((p.start, p.deadline, p.status), ("2026-10-30", "2027-01-29", "open"))
        self.assertEqual(p.regions, ["slaskie"])
        # ALMA: firmy są na liście realizatorów, ale wsparcie (staże) dostają młodzi, nie firma
        self.assertFalse(set(tx.BUSINESS_FORMS) & set(p.forms))
        self.assertFalse(score(p, firm(region="slaskie"), TODAY).eligible)
        self.assertEqual(p.level, "do 95 %")
        self.assertIsNone(p.max)  # pula naboru (7,5 mln zł) to nie kwota dla jednej firmy
        self.assertIn("zatrudnienie", p.goals)
        self.assertIn("LSI", p.apply_where)

        it = {"url": "https://www.funduszeunijne.gov.pl/nabory/61-drogi/", "status": "planowany", "dates": ["2026-11-02", "2026-12-31"],
              "title": "6.1 Poprawa regionalnej dostępności transportowej, Fundusze Europejskie dla Lubelskiego"}
        p = src.parse(it, (FIX / "portal_fe_detail_jst.html").read_text(encoding="utf-8"))
        self.assertEqual((p.forms, p.status, p.regions), (["jst"], "soon", ["lubelskie"]))
        self.assertFalse(score(p, firm(region="lubelskie"), TODAY).eligible)

    def test_firm_directed_titles(self):
        for t in ["2.7 Lubelskie MŚP na rynkach zagranicznych", "1.1 Ścieżka SMART – nabór projektów B+R",
                  "2.33 Kredyt na wytwarzanie produktów podwójnego zastosowania", "8.4 Zdrowy pracownik",
                  "1.2 Inwestycje przedsiębiorstw w badania i innowacje", "2.12 Granty na Eurogranty"]:
            self.assertTrue(firm_directed(t, "Fundusze Europejskie dla Lubelskiego", ""), t)
        for t in ["7.2 Wzmocnienie kompetencji uczniów", "8.5 Usługi społeczne", "2.8 Gospodarka wodno-ściekowa",
                  "5.4 Lokalna kultura i turystyka", "9.1 Aktywna integracja", "5.6 Edukacja przedszkolna"]:
            self.assertFalse(firm_directed(t, "Fundusze Europejskie dla Lubelskiego", ""), t)
        self.assertFalse(firm_directed("1. Innowacyjny Południowy Bałtyk, Cyfryzacja regionu", "Interreg", ""))
        self.assertTrue(firm_directed("2.5 Odpady", "FE", "Wsparcie dla przedsiębiorstw na inwestycje w recykling"))

    def test_tech_calls_not_for_services(self):
        from dotacjomat.sources.adapters import tech_sectors
        p = prog(sectors=None, regions=None, forms=list(tx.BUSINESS_FORMS), sizes=list(tx.MSP), goals=["badania"])
        tech_sectors(p, "1.1 Ścieżka SMART – nabór projektów B+R")
        self.assertFalse(score(p, firm(pkd="96.02.Z", goals=[]), TODAY).eligible)  # fryzjer
        self.assertTrue(score(p, firm(pkd="62.01.Z", goals=[]), TODAY).eligible)   # firma IT

    def test_detail_keeps_classifier_off_full_description(self):
        it = {"url": "https://www.funduszeunijne.gov.pl/nabory/53-alma/", "status": "aktualny", "dates": ["2026-10-30", "2027-01-29"],
              "title": "5.3 ALMA, Fundusze Europejskie dla Nowoczesnej Gospodarki"}
        p = PortalFESource(http=FakeHttp({})).parse(it, (FIX / "portal_fe_detail.html").read_text(encoding="utf-8"))
        self.assertIsNone(p.regions)
        self.assertTrue(getattr(p, "_classified"))


class GovPlNewsTest(unittest.TestCase):
    def test_news_titles_dates_and_duplicates(self):
        http = FakeHttp({"wszystkie-aktualnosci": "govpl_news.html", "konczy-sie": "govpl_news_a.html",
                         "rusza": "govpl_news_b.html"})
        src = GovPlNewsSource(name="arimr", http=http, url="https://www.gov.pl/web/arimr/wszystkie-aktualnosci",
                              op="ARiMR", pages=1)
        items = list(src.fetch(today=date(2026, 10, 30)))
        self.assertEqual(len(items), 1)  # dwie wiadomości o tym samym naborze, podsumowanie i stary pominięte
        p = items[0]
        self.assertEqual(p.url, "https://www.gov.pl/web/arimr/maly-przetworstwo-konczy-sie")
        self.assertEqual((p.start, p.deadline), ("2026-10-03", "2026-11-02"))
        self.assertIn("rolne", p.forms)
        self.assertIsNone(p.max)  # budżet naboru, nie kwota dla wnioskodawcy


class PipelineTest(unittest.TestCase):
    def test_update_diff_and_digest(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(f"{d}/t.db")
            rss = RssSource(name="lub", http=FakeHttp({"feed": "rss.xml"}), url="https://x/feed", include="nab[oó]r")
            s1 = update(store, [rss], today=TODAY)["lub"]
            s2 = update(store, [rss], today=TODAY)["lub"]
            self.assertEqual((s1["new"], s2["new"], s2["changed"]), (1, 0, 0))

            store.add_profile(CompanyProfile(region="lubelskie", form="jdg", size="micro", pkd="62.01.Z",
                                             goals=["digital"], email="a@b.pl"), "monthly")
            store.add_profile(CompanyProfile(region="lubelskie", form="jdg", size="micro"), "weekly")
            items = digest(store, today=TODAY)
            self.assertEqual(len(items), 1)  # plan tygodniowy nie dostaje alertów
            store.mark_sent(items[0][0], [m.program for m in items[0][2]])
            self.assertEqual(digest(store, today=TODAY), [])

    def test_failing_source_does_not_stop_others(self):
        class Broken(SeedSource):
            name = "broken"

            def fetch(self):
                raise IOError("timeout")
                yield
        with tempfile.TemporaryDirectory() as d:
            store = Store(f"{d}/t.db")
            res = update(store, [Broken(), SeedSource(path=str(ROOT / "data/programs_seed.json"))], today=TODAY)
            self.assertIn("timeout", res["broken"]["error"])
            self.assertGreater(res["seed"]["new"], 10)


class AiApplyTest(unittest.TestCase):
    def test_apply_overrides_heuristics(self):
        p = prog(goals=[], unknown=["regions", "goals", "sizes"])
        data = {"national": True, "regions": [], "forms": ["jdg", "zoo"], "sizes": ["micro", "small"],
                "all_sectors": False, "sectors": ["C"], "pkd_excluded": ["10.1"], "requires": [], "requires_all": [], "goals": ["sprzet"],
                "type": "dotacja", "min_pln": None, "max_pln": 2000000, "level": "do 50 %",
                "start": None, "deadline": "2026-12-15", "how": "Na maszyny.",
                "apply_where": "Online w LSI.", "documents": ["Biznesplan"]}
        ai_extract.apply(p, data)
        self.assertEqual((p.apply_where, p.documents), ("Online w LSI.", ["Biznesplan"]))
        self.assertEqual(p.to_page_dict()["documents"], ["Biznesplan"])
        self.assertEqual((p.regions, p.sectors, p.pkd_excluded, p.max, p.unknown), (None, ["C"], ["10.1"], 2000000, []))
        self.assertTrue(p.ai_extracted)
        # firma spożywcza (C10) mieści się w C, ale jej PKD jest wykluczone
        f = firm(form="jdg", size="micro", pkd="10.11.Z", goals=["sprzet"])
        self.assertFalse(score(p, f, TODAY).eligible)

    def test_operator_call_hidden_from_firms(self):
        p = prog(goals=[], unknown=[])
        data = {"national": False, "direct_support": False, "regions": ["mazowieckie"], "forms": ["zoo", "ngo", "jst"],
                "sizes": [], "all_sectors": True, "sectors": [], "pkd_excluded": [], "requires": [], "requires_all": [],
                "goals": ["szkolenia"], "type": "dotacja", "min_pln": None, "max_pln": None, "level": "",
                "start": None, "deadline": "2026-12-15", "how": "", "apply_where": "", "documents": []}
        ai_extract.apply(p, data)
        self.assertEqual(p.forms, ["ngo", "jst"])
        self.assertFalse(score(p, firm(goals=["szkolenia"]), TODAY).eligible)

    def test_schema_keys_match_apply(self):
        self.assertEqual(set(ai_extract.SCHEMA["required"]), set(ai_extract.SCHEMA["properties"]))


class ReviewTest(unittest.TestCase):
    def test_review_overrides_and_todo(self):
        from dotacjomat import review
        p = prog(source="portal_fe", forms=list(tx.BUSINESS_FORMS), sizes=list(tx.MSP), regions=None, sectors=None,
                 goals=["digital"], description="Kto może składać wnioski: MŚP\n\nNa co: szkolenia uczniów")
        self.assertEqual([t["key"] for t in review.todo([p], {})], [p.key])
        review.apply(p, {"direct_support": False, "note": "realizator projektów dla szkół"})
        self.assertFalse(score(p, firm(goals=["digital"]), TODAY).eligible)
        self.assertEqual(review.todo([p], {p.key: {}}), [])
        q = prog(sectors=None, regions=None, forms=list(tx.BUSINESS_FORMS), sizes=list(tx.MSP))
        review.apply(q, {"sectors": ["J"], "max_pln": 500000})
        self.assertEqual((q.sectors, q.max), (["J"], 500000))
        # Ukryty nabór znika też dla gospodarstw, a po przeglądzie nic nie zostaje "nieznane".
        r = prog(forms=["jst", "ngo", "rolne"], regions=None)
        review.apply(r, {"direct_support": False})
        self.assertEqual(r.forms, ["jst", "ngo"])
        a = prog(source="arimr", forms=["rolne"], sizes=None, regions=None)
        a.unknown = ["regions", "sizes"]
        review.apply(a, {"sectors": ["A"]})
        self.assertEqual(a.unknown, [])

    def test_pipeline_applies_review(self):
        from dotacjomat.sources import Source

        class One(Source):
            name = "portal_fe"

            def fetch(self):
                yield prog(source="portal_fe", source_id="x", forms=list(tx.BUSINESS_FORMS), goals=["digital"])
        store = Store(":memory:")
        update(store, [One()], reviews={"portal_fe:x": {"direct_support": False}}, today=TODAY)
        self.assertEqual(store.programs()[0].forms, ["jst"])


class CompanyTest(unittest.TestCase):
    def test_nip(self):
        self.assertTrue(company.valid_nip("525-012-34-56") or not company.valid_nip("5250123456"))
        self.assertTrue(company.valid_nip("526-025-02-74"))
        self.assertFalse(company.valid_nip("1234567890"))
        self.assertEqual(company.region_from_address("ul. Prosta 1, 00-950 Warszawa"), "mazowieckie")
        self.assertEqual(company.region_from_address("Rynek 1, 50-106 Wrocław"), "dolnoslaskie")


if __name__ == "__main__":
    unittest.main()
