#!/usr/bin/env bash
# Open local copy of remote SQLite (sync first with npm run db:remote:sync).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="${ROOT}/.cache/remote-db/vol.db"

if [[ ! -f "$DB" ]]; then
  echo "Missing $DB — run: npm run db:remote:sync" >&2
  exit 1
fi

exec sqlite3 "$DB" "$@"
