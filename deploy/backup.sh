#!/usr/bin/env bash
# Backs up Tiehall's database (self-host-install: Backups with the shipped
# scripts). Run it on the host, in the folder that holds compose.yaml and .env:
#   ./backup.sh              # writes backups/tiehall-<UTC time>.dump
#   ./backup.sh /srv/backups # writes the dump into another folder
# It dumps the bundled Postgres in Postgres's custom format with pg_dump run
# inside the Postgres container, so the dump always matches the server's major
# version, as the database owner, whose credentials Compose gives that
# container from .env. It writes the dump to a timestamped file that only its
# owner can read, in a folder only its owner can open, and then records in the
# database when the backup finished, which the admin page shows.
#
# Run it every day, for example from cron:
#   15 3 * * * cd /srv/tiehall && ./backup.sh >> backups/backup.log 2>&1
# and before every upgrade. Copy the dumps off the host. Back up .env apart from
# the dumps, and keep it secret: a dump alone cannot use the integration secrets
# Tiehall stores, because TIEHALL_SECRET_KEY is not in it.
#
# An external Postgres is backed up with its own tooling instead, such as a
# managed database's backups or pg_dump from a client of the server's major
# version. To restore a dump, run ./restore.sh <file>.
set -euo pipefail

cd "$(dirname "$0")"
folder="${1:-backups}"

# With an external Postgres there is no bundled one to back up.
if grep -Eq '^TIEHALL_DATABASE_OWNER_URL(_FILE)?=.+' .env 2>/dev/null; then
  echo "backup.sh: .env names an external Postgres (TIEHALL_DATABASE_OWNER_URL), and backup.sh backs up the bundled one. Back up the external Postgres with its own tooling." >&2
  exit 1
fi

# Everything this script writes is readable by its owner only.
umask 077
mkdir -p "$folder"
chmod 700 "$folder"
file="tiehall-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$folder/.$file.partial"
trap 'rm -f "$partial"' EXIT

# Inside the Postgres container, as the owner, over its own loopback, with the password Compose gave it from .env.
in_postgres() {
  docker compose exec -T postgres sh -c '
    PGPASSWORD="${POSTGRES_PASSWORD:-}"
    if [ -z "$PGPASSWORD" ] && [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; fi
    export PGPASSWORD PGHOST=127.0.0.1 PGUSER="$POSTGRES_USER" PGDATABASE="$POSTGRES_DB"
    exec "$@"' sh "$@"
}

echo "Backing up the database to $folder/$file"
in_postgres pg_dump --format=custom > "$partial"
mv "$partial" "$folder/$file"
size="$(wc -c < "$folder/$file" | tr -d ' ')"

# The finished backup, for the admin page. A schema from before backups were recorded has nowhere to keep it.
if [ "$(in_postgres psql --tuples-only --no-align --command "SELECT to_regclass('public.backups') IS NOT NULL")" = "t" ]; then
  # psql fills in the variables only in what it reads, not in --command.
  echo "INSERT INTO backups (org_id, finished_at, file, size_bytes) SELECT id, now(), :'file', :size FROM orgs;" |
    in_postgres psql --quiet -v ON_ERROR_STOP=1 -v file="$file" -v size="$size" > /dev/null
else
  echo "backup.sh: this install's schema keeps no record of backups yet, so the admin page does not show this one." >&2
fi
echo "Backed up to $folder/$file ($size bytes)"
