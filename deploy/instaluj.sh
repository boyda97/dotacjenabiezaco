#!/usr/bin/env bash
# Instalacja Dotacjo na czystym serwerze Ubuntu (22.04/24.04). Uruchom jako root:
#   curl -fsSLo instaluj.sh https://raw.githubusercontent.com/boyda97/dotacjenabiezaco/main/deploy/instaluj.sh && sudo bash instaluj.sh
# (z pliku, nie przez "curl | bash": docker compose czytałby wtedy resztę skryptu ze standardowego wejścia)
# Ponowne uruchomienie jest bezpieczne. Z opcją --nowe-klucze pyta od nowa o klucze Stripe i Resend
# (np. przy przejściu z trybu testowego na prawdziwe płatności).
set -euo pipefail

REPO=https://github.com/boyda97/dotacjenabiezaco.git
KATALOG=/opt/dotacjo
DOMENA=dotacjo.pl

[ "$(id -u)" = 0 ] || { echo "Uruchom przez sudo."; exit 1; }
NOWE_KLUCZE=0; [ "${1:-}" = "--nowe-klucze" ] && NOWE_KLUCZE=1

echo "== 1/6 Pakiety systemowe i Docker"
apt-get update -qq
apt-get install -y -qq git curl ufw >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

echo "== 2/6 Zapora: SSH, HTTP, HTTPS"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
ufw --force enable >/dev/null

echo "== 3/6 Kod serwisu w $KATALOG"
if [ -d "$KATALOG/.git" ]; then git -C "$KATALOG" pull -q --ff-only; else git clone -q "$REPO" "$KATALOG"; fi
cd "$KATALOG/deploy"
mkdir -p /var/backups/dotacjo && chown 1000:1000 /var/backups/dotacjo

echo "== 4/6 Klucze"
ENV=.env
if [ ! -f "$ENV" ] || [ "$NOWE_KLUCZE" = 1 ]; then
  # Przy uruchomieniu przez "curl | bash" czytamy odpowiedzi z klawiatury, nie z potoku.
  exec 3</dev/tty
  # -s: klucze nie pokazują się na ekranie (ani na zrzutach)
  read -rs -u 3 -p "Klucz tajny Stripe (sk_test_... albo sk_live_..., nie będzie widoczny): " STRIPE_KEY; echo
  read -rs -u 3 -p "Klucz API Resend (re_..., Enter = pomiń, nie będzie widoczny): " RESEND_KEY; echo
  [[ "$STRIPE_KEY" == sk_* ]] || { echo "To nie wygląda na klucz Stripe (sk_...)."; exit 1; }
  umask 077
  cat > "$ENV" <<CFG
NODE_ENV=production
APP_URL=https://$DOMENA
MAIL_FROM=Dotacjo <logowanie@$DOMENA>
RESEND_API_KEY=$RESEND_KEY
STRIPE_SECRET_KEY=$STRIPE_KEY
STRIPE_AUTOMATIC_TAX=0
INVOICE_FOOTER=Sprzedawca zwolniony z VAT na podstawie art. 113 ust. 1 ustawy o VAT.
WEEK_PASS_PLAN=pro
WEEK_PASS_DAYS=7
PAST_DUE_GRACE_DAYS=3
# Alerty silnika przez SMTP Resend
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASSWORD=$RESEND_KEY
SMTP_FROM=Dotacjo <alerty@$DOMENA>
CFG
fi
# Ceny i webhook zakładamy osobno, gdy ich brakuje w .env, więc przerwaną instalację wystarczy uruchomić ponownie.
STRIPE_KEY=$(grep '^STRIPE_SECRET_KEY=' "$ENV" | cut -d= -f2-)
if ! grep -q '^STRIPE_PRICE_START=price_' "$ENV" || ! grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' "$ENV"; then
  echo "   Buduję aplikację (pierwszy raz trwa kilka minut)..."
  docker compose build -q app
fi
if ! grep -q '^STRIPE_PRICE_START=price_' "$ENV"; then
  echo "   Zakładam ceny w Stripe..."
  CENY=$(docker compose run --rm -T -e STRIPE_SECRET_KEY="$STRIPE_KEY" -e WEEK_PRICE_PLN=39 app node scripts/setup-stripe.js </dev/null) \
    || { echo "BŁĄD: nie udało się założyć cen w Stripe (komunikat wyżej)."; exit 1; }
  sed -i '/^STRIPE_PRICE_/d' "$ENV"
  grep '^STRIPE_PRICE_' <<<"$CENY" >> "$ENV"
fi
if ! grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' "$ENV"; then
  echo "   Zakładam webhook Stripe na https://$DOMENA/api/stripe/webhook..."
  WEBHOOK=$(docker compose run --rm -T -e STRIPE_SECRET_KEY="$STRIPE_KEY" -e APP_URL="https://$DOMENA" app node scripts/stripe-webhook.mjs </dev/null) \
    || { echo "BŁĄD: nie udało się założyć webhooka Stripe (komunikat wyżej)."; exit 1; }
  grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' <<<"$WEBHOOK" \
    || { echo "BŁĄD: Stripe nie zwrócił sekretu webhooka."; exit 1; }
  sed -i '/^STRIPE_WEBHOOK_SECRET=/d' "$ENV"
  grep '^STRIPE_WEBHOOK_SECRET=' <<<"$WEBHOOK" >> "$ENV"
fi

echo "== 5/6 Uruchamiam serwis"
docker compose up -d --build </dev/null

echo "== 6/6 Zadania automatyczne"
ln -sf "$KATALOG/deploy/aktualizuj.sh" /usr/local/bin/dotacjo-aktualizuj
for u in "$KATALOG"/deploy/systemd/*; do install -m 644 "$u" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable --now dotacjo-wdrozenie.timer dotacjo-silnik.timer dotacjo-kopia.timer >/dev/null

echo
echo "Gotowe. Za 1-2 minuty strona powinna działać pod https://$DOMENA"
echo "(o ile rekordy DNS w OVH wskazują już na ten serwer: $(curl -fsS4 https://ifconfig.me || echo 'adres IP z panelu OVH'))."
