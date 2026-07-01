#!/usr/bin/env node
/**
 * Train level-break regime filter model from level-break closed trades.
 *
 *   node scripts/train-level-break-regime-model.js
 *   node scripts/train-level-break-regime-model.js --source backtest
 *   node scripts/train-level-break-regime-model.js --scope live
 */

const path = require("path");
const { dataPath, readJsonFile } = require("../lib/data-dir");
const { normalizeAiModelScope } = require("../lib/ai-model-scope");
const { collectAiTrainingTrades } = require("../lib/ai-training-trades");
const { createKlineCacheStore } = require("../lib/kline-cache");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk,
  trainFromTrades,
  getModelStatus,
} = require("../lib/level-break-regime-model");

const PRIMARY_INTERVAL = "1m";

function parseArgs(argv) {
  let source = "auto";
  let scope = "paper";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = argv[++i];
    if (argv[i] === "--scope" && argv[i + 1]) scope = argv[++i];
  }
  return { source, scope: normalizeAiModelScope(scope) };
}

function loadPaperTrades() {
  const raw = readJsonFile(dataPath("paper-bot-state.json"), null);
  return raw?.closedTrades ?? [];
}

function filterLevelBreak(trades) {
  return (trades ?? []).filter(
    (t) => t.signalKind === "level_break" || t.signalKind === "level_break_bear"
  );
}

function loadLiveTrades() {
  const raw = readJsonFile(dataPath("live-bot-state.json"), null);
  return raw?.closedTrades ?? [];
}

function collectTrades(source, scope) {
  return collectAiTrainingTrades(
    source,
    scope,
    {
      backtestTrades: loadLastBacktestResult()?.closedTrades,
      paperTrades: loadPaperTrades(),
      liveTrades: loadLiveTrades(),
    },
    filterLevelBreak
  );
}

async function main() {
  const { source, scope } = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();

  const trades = collectTrades(source, scope);
  if (!trades.length) {
    console.error(
      scope === "live"
        ? "No level-break closed trades found. Run train bot with level-break signals enabled (live fills merged when available)."
        : "No level-break closed trades found — run train bot with level-break signals enabled."
    );
    process.exit(1);
  }

  const klineCache = createKlineCacheStore({
    dir: path.join(dataPath(), "klines"),
    interval: PRIMARY_INTERVAL,
    maxBars: 5000,
    evalLimit: 5000,
  });

  function fetchBars(symbol) {
    const sym = String(symbol).toUpperCase();
    let bars = klineCache.read(sym) ?? [];
    if (!bars.length) {
      bars = readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
    }
    return bars;
  }

  console.error(
    `Training level-break regime from ${trades.length} trades (scope=${scope} source=${source})…`
  );
  await trainFromTrades(trades, fetchBars, {
    modelScope: scope,
    source: `cli:${scope}:${source}`,
    onProgress: (p) => {
      if (p?.message) console.error(p.message);
    },
  });
  const status = getModelStatus(scope);
  const bm = status.bullMetrics ?? status.metrics ?? {};
  const rm = status.bearMetrics ?? {};
  console.error(
    `Saved ${status.path} · bull ${status.bullThreshold} acc ${((bm.accuracy ?? 0) * 100).toFixed(1)}% · bear ${status.bearThreshold} acc ${((rm.accuracy ?? 0) * 100).toFixed(1)}%`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
