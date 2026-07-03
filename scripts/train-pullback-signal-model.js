#!/usr/bin/env node
/**
 * Train pullback signal quality model from closed pullback trades.
 *
 *   node scripts/train-pullback-signal-model.js
 *   node scripts/train-pullback-signal-model.js --source backtest
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
} = require("../lib/pullback-signal-model");

function parseArgs(argv) {
  let source = "auto";
  let scope = "paper";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = argv[++i];
    if (argv[i] === "--scope" && argv[i + 1]) scope = argv[++i];
  }
  return { source, scope: normalizeAiModelScope(scope) };
}

function filterPullback(trades) {
  return (trades ?? []).filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
}

function collectTrades(source, scope) {
  return collectAiTrainingTrades(
    source,
    scope,
    {
      backtestTrades: loadLastBacktestResult()?.closedTrades,
      paperTrades: readJsonFile(dataPath("paper-bot-state.json"), {})?.closedTrades ?? [],
      liveTrades: readJsonFile(dataPath("live-bot-state.json"), {})?.closedTrades ?? [],
    },
    filterPullback
  );
}

async function main() {
  const { source, scope } = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();

  const trades = collectTrades(source, scope);
  if (trades.length < 12) {
    console.error(
      `Need >=12 pullback closed trades (got ${trades.length}). Run optimize script or train bot with pullback ON.`
    );
    process.exit(1);
  }

  const klineCache = createKlineCacheStore({
    dir: path.join(dataPath(), "klines"),
    interval: "1m",
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

  console.error(`Training pullback signal model from ${trades.length} trades…`);
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
    `Saved ${status.path} · bull thr ${status.bullThreshold} acc ${((bm.accuracy ?? 0) * 100).toFixed(1)}% · bear thr ${status.bearThreshold} acc ${((rm.accuracy ?? 0) * 100).toFixed(1)}%`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
