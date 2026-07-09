#!/usr/bin/env bash
# Download production SQLite DB from Railway volume (/app/data → volume root).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/.cache/remote-db"
VOLUME_ID="${RAILWAY_VOLUME_ID:-4f54416e-e5eb-403d-b959-111f160eb531}"

mkdir -p "$OUT"
RAILWAY="${RAILWAY_CLI:-npx @railway/cli}"

for f in vol.db vol.db-wal vol.db-shm; do
  echo "Downloading /$f ..."
  "$RAILWAY" volume files --volume "$VOLUME_ID" download "/$f" "$OUT/$f" --overwrite
done

echo ""
echo "Remote DB synced to: $OUT/vol.db"
ls -lh "$OUT"/vol.db*
