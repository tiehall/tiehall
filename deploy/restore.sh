#!/usr/bin/env bash
# Restores Tiehall's database from a dump that backup.sh wrote
# (self-host-install: Backups with the shipped scripts). Run it on the host, in
# the folder that holds compose.yaml and .env:
#   ./restore.sh backups/tiehall-20261001T031500Z.dump
# It stops the app, replaces the bundled Postgres's database with an empty one
# and restores the dump into it, as the database owner, whose credentials
# Compose gives the Postgres container from .env; then it starts the app again,
# whose migrate step first brings a dump from an older release up to the
# running release. Everything written since the dump was taken is lost, so take
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

echo "Stopping the app"
docker compose stop app
docker compose up --detach --wait postgres

echo "Restoring $dump into an empty database"
# The database is dropped and made again from the maintenance database, then the dump goes into it.
in_postgres sh -c 'dropdb --maintenance-db=postgres --if-exists --force "$PGDATABASE" && createdb --maintenance-db=postgres --owner="$PGUSER" "$PGDATABASE"'
# Ownership and rights come from this install, not the dump: the owner owns everything, and the migrate step grants the app role its rights.
in_postgres sh -c 'exec pg_restore --dbname="$PGDATABASE" --no-owner --no-privileges --exit-on-error' < "$dump"

echo "Starting the app: the migrate step runs first"
docker compose up --detach --wait
echo "Restored $dump"
