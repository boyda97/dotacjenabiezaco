# Dotacjo – wdrożenie na serwer

Jeden mały serwer VPS (Ubuntu 22.04/24.04, 2 GB RAM wystarczą) z Dockerem:

| Element | Co robi |
|---|---|
| `Dockerfile` (w katalogu głównym) | Obraz z backendem `konta-platnosci/` (Node 22), stroną `strona/index.html` jako `public/index.html` i silnikiem `silnik/` (Python 3) |
| `docker-compose.yml` | Kontener `app` + `caddy` (HTTPS z Let's Encrypt, certyfikat odnawia się sam, `www` przekierowuje na `dotacjo.pl`) |
| `start.sh` | Przy pierwszym starcie wypełnia bazę silnika, potem uruchamia serwer |
| `instaluj.sh` | Instalacja na czystym serwerze: Docker, zapora, kod z GitHuba, pytanie o klucze Stripe i Resend, ceny i webhook w Stripe zakładane automatycznie |
| `stripe-webhook.mjs` | Zakłada webhook `https://dotacjo.pl/api/stripe/webhook` z potrzebnymi zdarzeniami i wypisuje `STRIPE_WEBHOOK_SECRET` |
| `aktualizuj.sh` + `systemd/` | Zadania automatyczne (niżej) |

Dane (konta, subskrypcje, baza naborów) są w wolumenie Dockera `dane` (`/data` w kontenerze), klucze w `deploy/.env` (poza Gitem, uprawnienia 600).

## Instalacja

Po ustawieniu w DNS rekordów `A` dla `dotacjo.pl` i `www.dotacjo.pl` na adres serwera:

```bash
curl -fsSLo instaluj.sh https://raw.githubusercontent.com/boyda97/dotacjenabiezaco/main/deploy/instaluj.sh && sudo bash instaluj.sh
```

Skrypt zapyta o klucz tajny Stripe (`sk_test_...` na próbę, później `sk_live_...`) i klucz API Resend.
Przejście na prawdziwe płatności: `sudo /opt/dotacjo/deploy/instaluj.sh --nowe-klucze` z kluczem `sk_live_...`
(ceny i webhook w trybie live założą się same).

## Zadania automatyczne

| Timer | Kiedy | Co robi |
|---|---|---|
| `dotacjo-wdrozenie` | co 5 min | gdy na `main` jest nowy kod (scalony PR), przebudowuje i restartuje serwis |
| `dotacjo-silnik` | codziennie 6:00 | `python -m dotacjomat update`: pobiera nabory ze źródeł z `silnik/config/sources.json` |
| `dotacjo-kopia` | codziennie 3:30 | kopia obu baz SQLite do `/var/backups/dotacjo`, trzymane 14 dni |

Ręcznie: `sudo dotacjo-aktualizuj wdrozenie|silnik|kopia`. Logi: `journalctl -u dotacjo-silnik`,
`docker compose -f /opt/dotacjo/deploy/docker-compose.yml logs -f app`.

Alerty e-mail silnika (`digest --send`) nie są jeszcze w harmonogramie: profile firm w bazie silnika nie są
połączone z kontami subskrybentów. SMTP Resend (`smtp.resend.com`, użytkownik `resend`, hasło = klucz API)
jest już wpisany do `.env`, więc po tym połączeniu wystarczy dopisać `digest --send` do zadania `silnik`.

## DNS (OVH, strefa dotacjo.pl)

| Typ | Subdomena | Wartość | Po co |
|---|---|---|---|
| A | (puste) | IPv4 serwera | strona |
| A | www | IPv4 serwera | przekierowanie www |
| TXT | resend._domainkey | wartość z panelu Resend | DKIM dla maili logowania |
| CNAME | rsend | wartość z panelu Resend | Resend (wysyłka) |
| CNAME | send | wartość z panelu Resend | SPF dla Resend |
| TXT | _dmarc | `v=DMARC1; p=none; rua=mailto:kontakt@dotacjo.pl` | DMARC |

Istniejące domyślne rekordy `A`/`AAAA` dla `dotacjo.pl` i `www` (strona parkingowa OVH) trzeba usunąć. Rekordy `MX` i SPF
dla poczty Zimbra (`dotacjo.pl`) zostają bez zmian: Resend wysyła z subdomeny `send`, więc nie koliduje.
