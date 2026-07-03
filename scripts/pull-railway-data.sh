#!/usr/bin/env bash
# Pull Railway dashboard data into .cache/railway-mirror/ for local comparison.
#
#   export RAILWAY_URL='https://your-app.up.railway.app'
#   export VOL_SESSION_COOKIE='vol_session=...'   # if DASHBOARD_AUTH=1
#   ./scripts/pull-railway-data.sh
#
# Cookie: browser DevTools → Application → Cookies → vol_session
# Or: echo 'vol_session=...' > ~/.vol-railway-cookie
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node "$ROOT/scripts/pull-railway-data.js" "$@"
