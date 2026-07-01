#!/usr/bin/env node
/**
 * Train early-exit logistic model from paper bot history and/or last train-bot results.
 *
 *   node scripts/train-early-exit-model.js
 *   node scripts/train-early-exit-model.js --source backtest
 *   node scripts/train-early-exit-model.js --source paper
 */

const path = require("path");
const { readJsonFile } = require("../lib/data-dir");
const { dataPath } = require("../lib/data-dir");
const { createKlineCacheStore } = require("../lib/kline-cache");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const {
  ensureDefaultModelOnDisk,
  trainFromTrades,
  getModelStatus,
} = require("../lib/early-exit-model");

const PRIMARY_INTERVAL = "1m";

function parseArgs(argv) {
  let source = "auto";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) {
      source = argv[++i];
    }
  }
  return { source };
}

function loadPaperTrades() {
  const raw = readJsonFile(dataPath("paper-bot-state.json"), null);
  return raw?.closedTrades ?? [];
}

function collectTrades(source) {
  const paper = loadPaperTrades();
  const backtest = loadLastBacktestResult()?.closedTrades ?? [];
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
    console.error("No closed trades found. Run train bot or paper bot first.");
    process.exit(1);
  }

  const cacheDir = path.join(dataPath(), "klines");
  const klineCache = createKlineCacheStore({
    cacheDir,
    interval: PRIMARY_INTERVAL,
    cacheMaxBars: 5000,
  });

  function fetchBars(symbol, openedAt, closedAt) {
    const sym = String(symbol).toUpperCase();
    const bars = klineCache.read(sym) ?? [];
    const from = openedAt - 120_000;
    const to = closedAt + 120_000;
    return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
  }

  console.error(`Training from ${trades.length} trades (source=${source})…`);
  const model = trainFromTrades(trades, fetchBars, { source: `cli:${source}` });
  const status = getModelStatus();
  console.error(
    `Saved ${status.path} · acc ${(model.metrics.accuracy * 100).toFixed(1)}% · ${model.metrics.samples} samples`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
