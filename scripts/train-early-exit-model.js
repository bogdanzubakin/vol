#!/usr/bin/env node
/**
 * Train SFP early-exit logistic model from SFP closed trades.
 *
 *   node scripts/train-early-exit-model.js
 *   node scripts/train-early-exit-model.js --source backtest
 *   node scripts/train-early-exit-model.js --source paper
 *   node scripts/train-early-exit-model.js --scope live
 */

const path = require("path");
const { readJsonFile } = require("../lib/data-dir");
const { dataPath } = require("../lib/data-dir");
const { normalizeAiModelScope } = require("../lib/ai-model-scope");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { createKlineCacheStore } = require("../lib/kline-cache");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk,
  trainFromTrades,
  getModelStatus,
  isAiEarlyExitReason,
} = require("../lib/early-exit-model");

const PRIMARY_INTERVAL = "1m";

function parseArgs(argv) {
  let source = "auto";
  let scope = "paper";
  let exportPath = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) {
      source = argv[++i];
    } else if (argv[i] === "--scope" && argv[i + 1]) {
      scope = argv[++i];
    } else if (argv[i] === "--export" && argv[i + 1]) {
      exportPath = argv[++i];
    }
  }
  return { source, scope: normalizeAiModelScope(scope), exportPath };
}

function loadExportTrades(exportPath) {
  const raw = readJsonFile(exportPath, null);
  if (!raw) throw new Error(`Export not found: ${exportPath}`);
  const trades = raw?.backtest?.closedTrades ?? raw?.closedTrades ?? [];
  if (!trades.length) throw new Error(`No closedTrades in export: ${exportPath}`);
  return trades;
}

function loadPaperTrades() {
  const raw = readJsonFile(dataPath("paper-bot-state.json"), null);
  return raw?.closedTrades ?? [];
}

function loadLiveTrades() {
  const raw = readJsonFile(dataPath("live-bot-state.json"), null);
  return raw?.closedTrades ?? [];
}

function collectTrades(source, scope) {
  const filterSfp = (list) =>
    (list ?? []).filter(
      (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
    );
  if (scope === "live") return filterSfp(loadLiveTrades());
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
  const { source, scope, exportPath } = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();

  let trades;
  if (exportPath) {
    trades = loadExportTrades(exportPath).filter(
      (t) =>
        !isAiEarlyExitReason(t.exitReason) &&
        (t.signalKind === "sfp" || t.signalKind === "sfp_bear")
    );
    console.error(
      `Loaded ${trades.length} trades from export (excluded AI exit labels).`
    );
  } else {
    trades = collectTrades(source, scope);
  }
  if (!trades.length) {
    console.error(
      scope === "live"
        ? "No live bot closed trades found."
        : "No closed trades found. Run train bot or paper bot first."
    );
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
    let bars = klineCache.read(sym) ?? [];
    if (!bars.length) {
      bars = readSymbolBars("signal", sym) ?? [];
    }
    if (!bars.length) return [];
    const from = openedAt - 120_000;
    const to = closedAt + 120_000;
    return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
  }

  console.error(`Training SFP early-exit from ${trades.length} trades (scope=${scope} source=${source})…`);
  const model = await trainFromTrades(trades, fetchBars, {
    modelScope: scope,
    source: exportPath
      ? `export:${path.basename(exportPath)}`
      : `cli:${scope}:${source}`,
    minThreshold: 0.78,
    onProgress: (p) => {
      if (p?.message) console.error(p.message);
    },
  });
  const status = getModelStatus(scope);
  const hm = status.hardMetrics ?? status.metrics ?? {};
  const sm = status.softMetrics ?? {};
  console.error(
    `Saved ${status.path} · hard ${status.hardThreshold} acc ${((hm.accuracy ?? 0) * 100).toFixed(1)}% · soft ${status.softThreshold} acc ${((sm.accuracy ?? 0) * 100).toFixed(1)}%`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
