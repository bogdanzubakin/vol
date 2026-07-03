#!/usr/bin/env bash
# Push local .cache settings and AI models to Railway.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node "$ROOT/scripts/push-railway-data.js" "$@"
