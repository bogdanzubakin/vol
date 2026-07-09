#!/usr/bin/env bash
# Download 60d backtest klines (extend cache) then run live-config strategy eval.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="$ROOT/.cache/60d-pipeline.log"
REPORT="$ROOT/.cache/live-strategy-eval-60d-report.json"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

: >"$LOG"
log "=== 60d pipeline start ==="

log "Phase 1/2: extend backtest klines to 60 days (529 symbols)…"
if ! node scripts/extend-backtest-klines.js --to-days 60 --rest-gap-ms 400 --batch-pause-ms 300 --symbol-pause-ms 500 2>&1 | tee -a "$LOG"; then
  log "ERROR: extend-backtest-klines failed"
  exit 1
fi
log "Phase 1/2 complete"

log "Phase 2/2: live strategy eval on 60d (skip refresh)…"
export VOL_NODE_HEAP_MB=12288
if ! node scripts/run-live-strategy-eval.js --days 60 --skip-refresh --report "$REPORT" 2>&1 | tee -a "$LOG"; then
  log "ERROR: strategy eval failed"
  exit 1
fi

if [[ -f "$ROOT/.cache/live-strategy-eval-report.json" ]]; then
  cp "$ROOT/.cache/live-strategy-eval-report.json" "$REPORT"
  log "Report copied to $REPORT"
fi
log "=== 60d pipeline done ==="
