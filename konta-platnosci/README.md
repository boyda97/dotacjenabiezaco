# Dotacje na Bieżąco – konta i płatności

Backend (Node.js 22 + Express + SQLite) obsługujący:

- **Konto bez hasła**: użytkownik wpisuje e-mail, dostaje link, klik loguje go (pierwszy raz zakłada konto). Sesja w ciasteczku `httpOnly` na 30 dni.
- **Subskrypcja miesięczna** 49 zł (plan `start`; plany Pro 149 zł i Biuro 399 zł są przygotowane na później), odnawiana automatycznie kartą, Apple Pay lub Google Pay.
- **Dostęp tygodniowy jednorazowy** (39 zł, zakres funkcji Pro), płatny **BLIK-iem, Przelewy24 lub kartą**. Dokupienie kolejnego tygodnia przedłuża dostęp.
- **Blokada treści na serwerze**: bez opłaconego dostępu `/api/programs` zwraca pierwszy program w całości, a resztę bez nazwy, opisu i linku (zostaje typ, kwota i termin, do paska „N programów, łącznie X zł”). Szczegóły programu (`/api/programs/:id`) zwracają `402`.
- **Panel klienta Stripe**: faktury, zmiana karty, zmiana planu, anulowanie (podpięte pod przyciski z zakładki „Abonament”).
- Ceny są końcowe: sprzedawca jest zwolniony z VAT (art. 113 ust. 1), więc VAT nie jest doliczany, a faktura ma w stopce podstawę zwolnienia (`INVOICE_FOOTER`). Stripe zbiera NIP kupującego na fakturę. Po przekroczeniu limitu zwolnienia wystarczy włączyć Stripe Tax (`STRIPE_AUTOMATIC_TAX=1`) i wyczyścić stopkę.
- Zgody wymagane prawem przy treściach cyfrowych (regulamin + rezygnacja z prawa odstąpienia przy natychmiastowym dostępie) zapisywane w bazie z datą i IP.
- Zwrot pieniędzy za tydzień w Stripe automatycznie odbiera dostęp (pod „gwarancję zwrotu” z cennika).
- Gdy odnowienie subskrypcji się nie uda, klient ma 3 dni karencji, a Stripe w tym czasie ponawia płatność.

## Dlaczego Stripe

| | Stripe | PayU / Tpay / Przelewy24 bezpośrednio |
|---|---|---|
| Subskrypcje z gotowym panelem klienta i fakturami | tak, wbudowane | trzeba dopisać samemu |
| BLIK i P24 | tak, ale **tylko płatności jednorazowe** | tak, część operatorów ma też BLIK cykliczny |
| Uruchomienie | konto online, od ręki | umowa, weryfikacja, zwykle kilka dni |
| Prowizja (orientacyjnie, sprawdź aktualny cennik) | karty EU ok. 1,5% + 1 zł | zwykle niższa przy negocjacji |

Na start Stripe daje najmniej kodu i najszybsze uruchomienie. Jeśli okaże się, że klienci chcą płacić subskrypcję BLIK-iem, można później dodać operatora z BLIK-iem cyklicznym, bez zmian w reszcie aplikacji (dostęp liczy jeden moduł: `src/entitlements.js`).

## Nazwa na fakturach i wyciągach

Nazwa „Dotacje na Bieżąco” w mailach, produktach i na stronie logowania jest już w kodzie. Na fakturach i wyciągach bankowych klientów Stripe bierze ją z ustawień konta: *Settings → Business → Public details* (nazwa publiczna „Dotacje na Bieżąco”, strona dotacjenabiezaco.pl) oraz *Statement descriptor* `DOTACJENABIEZACO` (maks. 22 znaki, bez polskich liter). Dane sprzedawcy na fakturze (firma, NIP, adres) uzupełnij w *Settings → Billing → Invoices*.

## Uruchomienie (ok. 30 min)

1. Załóż konto na [stripe.com](https://dashboard.stripe.com/register) (firma w Polsce, waluta PLN). Wszystko poniżej da się najpierw zrobić w **trybie testowym**.
2. W panelu Stripe: *Settings → Payment methods* włącz **BLIK** i **Przelewy24** (karty są domyślnie). *Settings → Billing → Customer portal* włącz anulowanie, zmianę planu (Start/Pro/Biuro) i faktury.
3. Na serwerze:
   ```bash
   npm install
   cp .env.example .env              # uzupełnij STRIPE_SECRET_KEY
   STRIPE_SECRET_KEY=sk_test_... npm run setup:stripe   # wypisze 4 linie STRIPE_PRICE_... do .env
   ```
   Cenę tygodnia ustawisz zmienną `WEEK_PRICE_PLN=39` przy `setup:stripe`.
4. Webhook: w Stripe *Developers → Webhooks → Add endpoint* `https://twoja-domena/api/stripe/webhook` ze zdarzeniami:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`. Sekret `whsec_...` wpisz do `.env`.
   Lokalnie: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
5. E-mail: załóż konto w [Resend](https://resend.com), zweryfikuj domenę, dodaj domenę dotacjenabiezaco.pl, wpisz `RESEND_API_KEY`. Bez klucza link logowania jest wypisywany w logach serwera (wygodne do testów).
6. `npm start`. Stronę główną wrzuć do `public/index.html` i dodaj przed `</body>`:
   ```html
   <script src="/konto.js"></script>
   ```
   Skrypt zastępuje demo-logowanie prawdziwym (okno z e-mailem, okno zgód, przejście do płatności, panel klienta).
7. Test: karta `4242 4242 4242 4242`; kody testowe BLIK i P24 są w dokumentacji Stripe (Testing → BLIK).

Hosting: wystarczy jeden mały serwer z Node 22 (np. Mikrus, OVH VPS, Railway, Render), z dyskiem na plik bazy `data/`.

## API

| Metoda | Ścieżka | Opis |
|---|---|---|
| POST | `/api/auth/request` | `{email, next?}` wysyła link logowania |
| GET/POST | `/api/auth/verify` | strona z linku / zużycie tokenu, ustawia sesję |
| POST | `/api/auth/logout` | wylogowanie |
| GET | `/api/me` | `{user, access:{active, kind:"subscription"\|"week", plan, until, cancelAtPeriodEnd}}` |
| POST | `/api/billing/checkout` | `{product:"start"\|"pro"\|"biuro"\|"week", acceptTerms:true, immediateAccess:true}` → `{url}` do Stripe |
| POST | `/api/billing/portal` | → `{url}` panelu klienta Stripe |
| POST | `/api/stripe/webhook` | zdarzenia Stripe (podpis weryfikowany) |
| GET | `/api/programs` | wyniki dopasowania, przycięte dla nieopłaconych |
| GET | `/api/programs/:id` | pełna karta programu, `402` bez dostępu |

**Silnik dopasowania** (Python, katalog `silnik/`) podpina się zmienną `SILNIK_DIR=../silnik` (katalog obok w tym repozytorium). Strona woła wtedy `/api/programs?region=dolnoslaskie&form=jdg&size=micro&goals=sprzet,marketing`, a serwer uruchamia `python -m dotacjomat match --json` i przycina wynik dla nieopłaconych. Inny silnik podłącza się przez `createApp({ loadPrograms })`, a każdy inny płatny endpoint zabezpiecza się middleware `app.locals.requireAccess`.

## Testy

`npm test` – 9 testów: logowanie (link jednorazowy, odporny na skanery poczty), ochrona CSRF, blokada treści, checkout (zgody, BLIK/P24 dla tygodnia), webhooki (podpis, idempotencja, P24 z opóźnieniem, przedłużanie tygodnia, zwrot, karencja, anulowanie), most do silnika dopasowania.

## Do zrobienia przed startem

- Regulamin i polityka prywatności pod `/regulamin` i `/prywatnosc` (linkowane w oknie zgód). Warto dać prawnikowi: prawa konsumenta przy treściach cyfrowych, RODO, ochrona JDG jak konsumenta.
- **Gwarancja zwrotu 14 dni** (z regulaminu): w panelu Stripe przy płatności klienta kliknij *Refund*, a potem *Cancel subscription → immediately*. Serwer sam odbierze dostęp (zdarzenia `charge.refunded` i `customer.subscription.deleted`). Pilnowanie „tylko pierwszy zakup na NIP” jest na razie ręczne.
- Treść drugiego checkboxa (utrata prawa odstąpienia) może się zmienić po opinii prawnika, bo dla abonamentu z alertami to może być usługa cyfrowa. Tekst jest w `public/konto.js`.
- Zakres funkcji tygodnia (`WEEK_PASS_PLAN`, domyślnie pro). Strona pokazuje tylko tydzień i abonament 49 zł (produkt "start"); Pro i Biuro są w Stripe jako opcja na później.
- Przy rozliczeniach z klientami w PL: KSeF (e-faktury, obowiązkowe dla firm od 2026). Faktury Stripe nie trafiają do KSeF same, trzeba to połączyć z programem księgowym (np. Fakturownia, inFakt) albo integracją. To temat na osobny krok.
