#!/bin/sh
# Udaje `python -m dotacjomat match --profile plik --json` – sprawdza profil i zwraca wynik silnika.
grep -q '"size":"mikro"' "$5" && { echo "ValueError: Nieznana wartość size='mikro'" >&2; exit 1; }
echo '[{"program":{"id":"seed:1","name":"Bon","url":"https://x/1","type":"dotacja","max":45000,"deadline":"2026-11-30","how":"opis"},"score":91,"eligible":true,"urgent":false,"days_left":35,"why":[{"t":"Region","state":"ok","ok":true}]},{"program":{"id":"parp:ab12","name":"Ekspansja","url":"https://x/2","type":"pozyczka","max":300000,"deadline":null,"how":"opis2"},"score":64,"eligible":true,"urgent":false,"days_left":null,"why":[]}]'
