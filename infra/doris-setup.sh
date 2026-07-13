#!/bin/sh
# One-shot Doris root-password bootstrap (the image boots with root/empty).
# Uses the MySQL protocol, whose auth semantics are strict and unambiguous —
# the FE HTTP API's basic-auth behaves inconsistently (e.g. while the password
# is empty it accepts arbitrary credentials), so it is not used here.
# Runs inside the FE image, which ships a mysql client.
#
# NOTE: DORIS_PASSWORD must not contain single quotes or backslashes.
set -eu

FE_HOST="${FE_HOST:-doris-fe}"

if mysql -h "$FE_HOST" -P 9030 -uroot -p"${DORIS_PASSWORD}" -e "SELECT 1" >/dev/null 2>&1; then
  echo "doris root password already set"
  exit 0
fi

# Empty-password login only succeeds while no password has been set.
if mysql -h "$FE_HOST" -P 9030 -uroot -e "SET PASSWORD FOR 'root' = PASSWORD('${DORIS_PASSWORD}')" 2>/dev/null; then
  echo "doris root password set"
  exit 0
fi

echo "doris root has a password that does not match DORIS_PASSWORD — refusing to guess" >&2
exit 1
