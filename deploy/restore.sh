#!/usr/bin/env bash
# Restores Tiehall's database from a dump that backup.sh wrote
# (self-host-install: Backups with the shipped scripts). Run it on the host, in
# the folder that holds compose.yaml and .env:
#   ./restore.sh backups/tiehall-20261001T031500Z.dump
# It checks that the file is a dump, stops the app, and restores the dump into
# a new, empty database beside the bundled Postgres's database, as the database
# owner, whose credentials Compose gives the Postgres container from .env. Only
# once the whole dump is in does that database replace the install's; then it
# starts the app again, whose migrate step first brings a dump from an older
# release up to the running release. A file that is not a whole dump, such as
# a copy that broke off, changes nothing: the app starts again on the database
# it had. The restore needs room on the disk for a second copy of the database
# while it runs. Everything written since the dump was taken is lost, so take
# a backup first if the database still holds anything to keep.
#
# The dump holds the integration secrets Tiehall stores only encrypted with
# TIEHALL_SECRET_KEY, which is not in it: restore with the .env the dump was
# taken with, which you backed up apart from the dumps.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: restore.sh <file>, a dump that backup.sh wrote." >&2
  exit 2
fi
if [ ! -f "$1" ] || [ ! -r "$1" ]; then
  echo "restore.sh: cannot read $1" >&2
  exit 1
fi
dump="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
cd "$(dirname "$0")"

# With an external Postgres there is no bundled one to restore into.
if grep -Eq '^TIEHALL_DATABASE_OWNER_URL(_FILE)?=.+' .env 2>/dev/null; then
  echo "restore.sh: .env names an external Postgres (TIEHALL_DATABASE_OWNER_URL), and restore.sh restores the bundled one. Restore the external Postgres with its own tooling." >&2
  exit 1
fi

# Inside the Postgres container, as the owner, over its own loopback, with the password Compose gave it from .env.
in_postgres() {
  docker compose exec -T postgres sh -c '
    PGPASSWORD="${POSTGRES_PASSWORD:-}"
    if [ -z "$PGPASSWORD" ] && [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; fi
    export PGPASSWORD PGHOST=127.0.0.1 PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB"
    exec "$@"' sh "$@"
}

docker compose up --detach --wait postgres
# A file whose table of contents pg_restore cannot read is no dump, and nothing is stopped for it.
if ! in_postgres pg_restore --list < "$dump" > /dev/null; then
  echo "restore.sh: $1 is not a dump that backup.sh wrote, or it is cut short, so nothing changed." >&2
  exit 1
fi

echo "Stopping the app"
docker compose stop app

echo "Restoring $dump into an empty database"
# The dump goes into a new database beside the install's, made from the maintenance database; one a restore that
# stopped left behind goes first. Ownership and rights come from this install, not the dump: the owner owns
# everything, and the migrate step grants the app role its rights.
in_postgres sh -c 'PGOPTIONS="-c client_min_messages=warning" dropdb --maintenance-db=postgres --if-exists --force "${PGDATABASE}_restore" && createdb --maintenance-db=postgres --owner="$PGUSER" "${PGDATABASE}_restore"'
if ! in_postgres sh -c 'exec pg_restore --dbname="${PGDATABASE}_restore" --no-owner --no-privileges --exit-on-error' < "$dump"; then
  in_postgres sh -c 'dropdb --maintenance-db=postgres --if-exists --force "${PGDATABASE}_restore"'
  echo "restore.sh: $1 could not be restored, for the reason above, so the database is as it was. A dump that is cut short, such as a copy that broke off, cannot be restored." >&2
  echo "Starting the app again on the database it had"
  docker compose up --detach --wait
  exit 1
fi
# The whole dump is in: the restored database replaces the install's.
echo 'DROP DATABASE IF EXISTS :"live" WITH (FORCE); ALTER DATABASE :"restored" RENAME TO :"live";' |
  in_postgres sh -c 'exec psql --dbname=postgres --quiet -v ON_ERROR_STOP=1 -v live="$PGDATABASE" -v restored="${PGDATABASE}_restore"'

echo "Starting the app: the migrate step runs first"
docker compose up --detach --wait
echo "Restored $dump"
