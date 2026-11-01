#!/bin/sh
# Start kontenera: przy pierwszym uruchomieniu wypełnia bazę silnika, potem startuje serwer.
set -e
if [ ! -s "$DOTACJOMAT_DB" ]; then
  echo "Pierwsze uruchomienie: pobieram nabory do $DOTACJOMAT_DB"
  (cd "$SILNIK_DIR" && python3 -m dotacjomat update ${ANTHROPIC_API_KEY:+--ai}) || echo "Uwaga: część źródeł nie odpowiedziała, reszta naborów jest w bazie"
else
  # Po każdym wdrożeniu odśwież od razu szybkie źródła (programy wpisane ręcznie i tabelę NFOŚiGW),
  # żeby poprawki w nich (np. linki do ogłoszeń) były widoczne bez czekania na poranne pobranie.
  # W tle, żeby nie opóźniać startu strony.
  (cd "$SILNIK_DIR" && python3 -m dotacjomat update --only seed,nfosigw >/dev/null 2>&1 || true) &
fi
exec npm start
