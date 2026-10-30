#!/usr/bin/env bash
# Zadania okresowe serwera Dotacjo (uruchamiane przez timery systemd).
#   wdrozenie  - gdy na main jest nowy kod (scalony PR), przebudowuje i restartuje serwis
#   silnik     - pobiera nabory ze źródeł do bazy silnika (z ANTHROPIC_API_KEY w .env: AI czyta ogłoszenia)
#   kopia      - kopia baz SQLite do /var/backups/dotacjo (14 dni)
set -euo pipefail
cd /opt/dotacjo
compose() { docker compose -f deploy/docker-compose.yml "$@"; }

case "${1:-}" in
  wdrozenie)
    git fetch -q origin main
    if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
      git reset -q --hard origin/main
      echo "Nowa wersja $(git rev-parse --short HEAD), przebudowuję"
      compose up -d --build
      docker image prune -f >/dev/null
    fi
    ;;
  silnik)
    compose exec -T app sh -c 'cd "$SILNIK_DIR" && python3 -m dotacjomat update ${ANTHROPIC_API_KEY:+--ai}'
    ;;
  kopia)
    dzien=$(date +%F)
    compose exec -T app python3 -c "
import sqlite3, sys
for name in ('dotacjo', 'silnik'):
    src = sqlite3.connect(f'/data/{name}.db')
    dst = sqlite3.connect(f'/kopie/{name}-$dzien.db')
    src.backup(dst); dst.close(); src.close()
"
    find /var/backups/dotacjo -name '*.db' -mtime +14 -delete
    ;;
  *) echo "Użycie: $0 wdrozenie|silnik|kopia"; exit 1 ;;
esac
