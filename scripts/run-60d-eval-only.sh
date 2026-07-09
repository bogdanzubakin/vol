#!/usr/bin/env bash
# Resume 60d pipeline: eval only (klines already downloaded).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG="$ROOT/.cache/60d-pipeline.log"
REPORT="$ROOT/.cache/live-strategy-eval-60d-report.json"
export NODE_OPTIONS="--max-old-space-size=12288"
export VOL_NODE_HEAP_MB=12288

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

log "=== 60d eval resume (phase 2 only) ==="
node scripts/run-live-strategy-eval.js --days 60 --skip-refresh --report "$REPORT" 2>&1 | tee -a "$LOG"
log "=== 60d eval done ==="
