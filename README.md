# Dotacjo

Serwis [dotacjo.pl](https://dotacjo.pl): wyszukiwarka dotacji dopasowanych do firmy
(oraz do osób, które dopiero zakładają działalność), w subskrypcji miesięcznej z codziennymi
aktualizacjami albo z jednorazowym dostępem tygodniowym.

| Katalog | Co zawiera |
|---|---|
| `silnik/` | Pobieranie naborów ze źródeł i dopasowanie ich do profilu firmy (Python), instrukcja w [silnik/README.md](silnik/README.md) |
| `konta-platnosci/` | Konta (logowanie linkiem z e-maila), płatności Stripe (abonament 49 zł/mies., tydzień 39 zł z BLIK/P24) i blokada płatnych treści (Node.js), instrukcja w [konta-platnosci/README.md](konta-platnosci/README.md) |
| `strona/` | Strona tytułowa (`index.html`, samodzielny plik HTML/CSS/JS); ładuje `/konto.js` z backendu kont i płatności |
