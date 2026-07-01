#!/usr/bin/env node
/**
 * Train SFP regime filter model from SFP closed trades.
 *
 *   node scripts/train-sfp-regime-model.js
 *   node scripts/train-sfp-regime-model.js --source backtest
 */

const path = require("path");
const { dataPath, readJsonFile } = require("../lib/data-dir");
const { createKlineCacheStore } = require("../lib/kline-cache");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const {
  ensureDefaultModelOnDisk,
  trainFromTrades,
  getModelStatus,
} = require("../lib/sfp-regime-model");

const PRIMARY_INTERVAL = "1m";

function parseArgs(argv) {
  let source = "auto";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) source = argv[++i];
  }
  return { source };
}

function loadPaperTrades() {
  const raw = readJsonFile(dataPath("paper-bot-state.json"), null);
  return raw?.closedTrades ?? [];
}

function filterSfp(trades) {
  return (trades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
}

function collectTrades(source) {
  const paper = filterSfp(loadPaperTrades());
  const backtest = filterSfp(loadLastBacktestResult()?.closedTrades);
  if (source === "paper") return paper;
  if (source === "backtest") return backtest;
  const seen = new Set();
  const out = [];
  for (const t of [...backtest, ...paper]) {
    const key = t.id ?? `${t.symbol}-${t.openedAt}-${t.closedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

async function main() {
  const { source } = parseArgs(process.argv);
  ensureDefaultModelOnDisk();

  const trades = collectTrades(source);
  if (!trades.length) {
    console.error("No SFP closed trades found.");
    process.exit(1);
  }

  const klineCache = createKlineCacheStore({
    cacheDir: path.join(dataPath(), "klines"),
    interval: PRIMARY_INTERVAL,
    cacheMaxBars: 5000,
  });

  function fetchBars(symbol) {
    const sym = String(symbol).toUpperCase();
    let bars = klineCache.read(sym) ?? [];
    if (!bars.length) {
      bars = readSymbolBars("signal", sym) ?? [];
    }
    return bars;
  }

  console.error(`Training SFP regime from ${trades.length} trades (source=${source})…`);
  const model = await trainFromTrades(trades, fetchBars, {
    source: `cli:${source}`,
    onProgress: (p) => {
      if (p?.message) console.error(p.message);
    },
  });
  console.error(
    `Saved ${getModelStatus().path} · acc ${(model.metrics.accuracy * 100).toFixed(1)}%`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
