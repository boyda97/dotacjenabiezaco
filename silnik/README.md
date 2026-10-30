# Dotacje na Bieżąco – silnik pobierania i dopasowania dotacji

Silnik serwisu [dotacjenabiezaco.pl](https://dotacjenabiezaco.pl). Pakiet Pythona nadal nazywa się `dotacjomat`
(nazwa wewnętrzna, polecenia `python -m dotacjomat ...`).

Program codziennie pobiera nabory z polskich źródeł, zamienia ich opisy na kryteria
(województwo, forma i wielkość firmy, branża, cele, kwoty, terminy) i dopasowuje je do
profilu firmy, także osoby, która **dopiero planuje założyć działalność**.

Rdzeń to czysty Python 3.10+ bez zależności. Biblioteki opcjonalne są w `requirements.txt`.

## Szybki start

```bash
python -m dotacjomat update                      # pobierz nabory ze źródeł z config/sources.json
python -m dotacjomat match --region mazowieckie --form zoo --size small --pkd 62.01.Z --goal digital
python -m dotacjomat match --region lubelskie --form none --person bezrobotny --person do30   # zakładam firmę
python -m dotacjomat export site/programs.json   # dane dla strony (format tablicy PROGRAMS)
python -m dotacjomat digest --send               # alerty e-mail dla subskrybentów
python -m unittest discover -s tests             # testy
```

Codzienna aktualizacja (cron):

```
0 6 * * *  cd /srv/dotacjomat && python -m dotacjomat update --ai && python -m dotacjomat export site/programs.json && python -m dotacjomat digest --send
```

## Jak to działa

```
źródła (config/sources.json)
  └─ adaptery: seed · portal_fe · govpl · govpl_news · parp · rss · html_list
       └─ classify.py      reguły słownikowe: regiony, MŚP, cele, kwoty, daty, typ wsparcia
       └─ ai_extract.py    (opcjonalnie, --ai) Claude czyta opis + regulamin PDF: PKD wykluczone, warunki
            └─ storage.py  SQLite: historia zmian, nowe/zmienione/usunięte, profile, wysłane alerty
                 └─ matching.py  punktacja 0–100 + powody („✓ Twoje województwo”, „? do sprawdzenia”)
                      └─ pipeline.digest  codzienne alerty dla planu miesięcznego
```

| Plik | Co robi |
|---|---|
| `dotacjomat/taxonomy.py` | Słowniki wspólne ze stroną: województwa, formy, wielkości, sekcje PKD, cele, status osoby |
| `dotacjomat/models.py` | `Program` (nabór) i `CompanyProfile` (firma lub osoba zakładająca firmę) |
| `dotacjomat/matching.py` | Dopasowanie i ranking |
| `dotacjomat/classify.py` | Tekst naboru → kryteria |
| `dotacjomat/ai_extract.py` | Ekstrakcja kryteriów modelem Claude (structured output) |
| `dotacjomat/sources/` | Adaptery źródeł, klient HTTP (robots.txt, limit tempa, ponowienia) |
| `dotacjomat/storage.py` | Baza SQLite |
| `dotacjomat/pipeline.py` | Aktualizacja, alerty e-mail |
| `dotacjomat/company.py` | NIP: suma kontrolna, Biała Lista MF, województwo z kodu pocztowego |
| `data/programs_seed.json` | 24 programy wpisane ręcznie (19 ze strony + 5 na założenie firmy) |

## Dopasowanie

Punktacja jest zgodna z tą na stronie: region 25, wielkość 25, branża 15, cel 35 (albo 20 przy
„dowolnym celu”). Silnik dodaje do tego:

- **Kryteria nieustalone** (np. opis nie mówi, dla jakiej wielkości firm) nie odrzucają naboru. Dostaje
  połowę punktów i oznaczenie „do sprawdzenia”.
- **Wykluczenia PKD** z regulaminu (np. `46.1`) odrzucają firmę o takim kodzie.
- **Podsekcje**: program dla sekcji C obejmuje firmę spożywczą C10.
- **Wiele celów naraz**, dopasowanie kwoty, ostrzeżenie o bliskim terminie.

### Osoba, która dopiero zakłada firmę

Profil z `form="none"` (wielkość automatycznie `start`, bez NIP). Widzi tylko programy otwarte dla osób
bez firmy: urząd pracy, PFRON (art. 12a), LGD, regionalne projekty FSE+, BGK „Wsparcie w starcie”.
Status osoby (`person`) decyduje o kolejności:

`bezrobotny`, `poszukujacy`, `bierny`, `do30`, `pow50`, `kobieta`, `niepelnosprawnosc`, `student`,
`absolwent`, `obszar_wiejski`, `bez_dg_12m`

Gdy brakuje wymaganego statusu, program nie znika, tylko dostaje wskazówkę, np. „zarejestruj się w urzędzie
pracy jako osoba bezrobotna przed złożeniem wniosku”.

## Źródła

| Źródło | Adapter | Stan (sprawdzone na żywo 2026-10-30) |
|---|---|---|
| Portal Funduszy Europejskich: wszystkie programy unijne 2021-2027, krajowe (FENG z naborami PARP i NCBR, FERS, FEnIKS, FEPW, FERC, rybactwo), 16 regionalnych i Interreg | `portal_fe` | działa, ok. 250 planowanych i trwających naborów |
| NFOŚiGW, harmonogram (gov.pl) | `govpl` | działa, ok. 50 pozycji |
| ARiMR, NCBR: aktualności o naborach (gov.pl) | `govpl_news` | działa; harmonogram ARiMR jest tylko w PDF |
| Programy redakcyjne | `seed` | działa, do weryfikacji |
| PARP, harmonogram | `parp` | wyłączone: strona wpuszcza tylko przeglądarki po captchy; nabory PARP są w `portal_fe` |
| Serwisy regionalne FE (RSS) | `rss` | wyłączone, niepotrzebne obok `portal_fe` |
| BGK | brak | strona blokuje roboty (403) |

Nowe źródło dodaje się wpisem w `config/sources.json`, bez zmian w kodzie (o ile pasuje istniejący adapter).

## Ekstrakcja AI (`update --ai`)

Wymaga `pip install anthropic` i klucza API (`ANTHROPIC_API_KEY`). Model ustawia `DOTACJOMAT_MODEL`
(domyślnie `claude-opus-5-5`, na niskim nakładzie rozumowania). Każdy nabór jest czytany tylko raz:
kolejne uruchomienia używają wyniku z bazy, dopóki treść u źródła się nie zmieni.

## Alerty

`digest` wybiera dla każdego aktywnego profilu z planem miesięcznym nabory nowe lub zmienione od
ostatniego alertu (próg dopasowania 50%). Plan tygodniowy (jednorazowy dostęp) nie dostaje alertów.
Wysyłka przez SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`), bez tych zmiennych
listy trafiają do katalogu `outbox/`.

## Do zrobienia

- Uruchomić scrapery na serwerze z dostępem do gov.pl i dopracować parsery na prawdziwych stronach.
- Portal FE: zapisać ruch XHR (`dump_dir`) i przepisać adapter na bezpośrednie zapytania do API strony.
- GUS BIR1.1 (klucz z api.stat.gov.pl): PKD i forma prawna z NIP.
- Programy w `programs_seed.json` są przykładowe. Przed startem kwoty i terminy musi zweryfikować redakcja.
