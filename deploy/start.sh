#!/bin/sh
# Start kontenera: przy pierwszym uruchomieniu wypełnia bazę silnika, potem startuje serwer.
set -e
if [ ! -s "$DOTACJOMAT_DB" ]; then
  echo "Pierwsze uruchomienie: pobieram nabory do $DOTACJOMAT_DB"
  (cd "$SILNIK_DIR" && python3 -m dotacjomat update) || echo "Uwaga: pierwsze pobranie naborów nie powiodło się"
fi
exec npm start
