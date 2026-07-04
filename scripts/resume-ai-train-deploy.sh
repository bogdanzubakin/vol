#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
LOG=".cache/ai-train-deploy.log"
NODE="node --max-old-space-size=12288"
DAYS=30

log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

log "=== RESUME pipeline (SFP compare already done) ==="

log "▶ early-exit optimize"
$NODE scripts/optimize-early-exit-params.js --days "$DAYS" --cache-only

log "▶ pullback optimize"
$NODE scripts/optimize-pullback-params.js --days "$DAYS"

log "▶ ai-exit-levels optimize"
$NODE scripts/optimize-ai-exit-levels-params.js --days "$DAYS" --cache-only

log "▶ apply + train + push"
$NODE scripts/train-all-ai-and-deploy.js --days "$DAYS" --skip-probe --skip-optimize --skip-backtest --push

log "=== PIPELINE COMPLETE ==="
