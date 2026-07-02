#!/usr/bin/env node
/**
 * SFP signal-detection parameter sweep (no AI). Cache-first.
 *
 *   node scripts/optimize-sfp-signal-params.js --days 10 --cache-only
 */

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");

const RESULTS_FILE = () => dataPath("sfp-signal-optimization-results.json");

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  let cacheOnly = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--cache-only") cacheOnly = true;
    else if (argv[i] === "--fetch") cacheOnly = false;
  }
  return { days: Math.max(1, Math.min(21, Math.round(days) || 10)), cacheOnly };
}

function loadBotConfig() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiSfpRegimeEnabled: false,
    aiLevelBreakRegimeEnabled: false,
  });
}

function loadSignalConfig() {
  const cfg = {
    interval: "5m",
    corridorDays: 2,
    corridorExcludeMinutes: 40,
    signalCandles: 3,
    fastMoveLookbackCandles: 15,
    minAvgMovePct: 0.4,
    minLinearChangePct: 0.5,
    fastMoveExcludeMult: 3,
    topMoveMinPct: 15,
    sfpLookbackBars: 30,
    sfpRangeBars: 60,
    sfpReclaimBars: 5,
    sfpMinSweepPct: 0.08,
    pullbackMaBars: 7,
    pullbackTouchLookback: 12,
    pullbackMaxDistancePct: 0.35,
    pullbackMaxAboveMaPct: 1.5,
    levelBreakPivotBars: 4,
    levelBreakLookbackBars: 300,
    levelBreakMinTouches: 5,
    levelBreakTouchPct: 0.25,
    levelBreakMinPct: 0.12,
    levelBreakApproachPct: 0.4,
    levelBreakApproachBars: 8,
  };
  applyBarConfig(cfg);
  scannerConfig.loadInto(cfg);
  applyBarConfig(cfg);
  return cfg;
}

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((sym) => readSymbolBars("mover", sym)?.length)
    .sort();
}

function createFetchers(cacheOnly) {
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "signal", barCount);
      if (cached?.length >= barCount) return cached;
      if (cacheOnly && cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "mover", barCount);
      if (cached?.length >= barCount) return cached;
      if (cacheOnly && cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
}

function summarizeRun(result) {
  const s = result.summary ?? {};
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    skippedOpen: s.skippedOpen ?? 0,
    sfpSignals: (s.sfpSignals ?? 0) + (s.sfpBearSignals ?? 0),
    symbolsProcessed: result.symbolsProcessed ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

const SIGNAL_SWEEPS = [
  { key: "sfpMinSweepPct", values: [0.06, 0.08, 0.1, 0.12, 0.15] },
  { key: "sfpLookbackBars", values: [20, 25, 30, 40] },
  { key: "sfpReclaimBars", values: [3, 5, 7, 10] },
  { key: "sfpRangeBars", values: [45, 60, 80, 100] },
  { key: "fastMoveLookbackCandles", values: [10, 15, 20] },
  { key: "minAvgMovePct", values: [0.3, 0.4, 0.5, 0.6] },
  { key: "minLinearChangePct", values: [0.3, 0.5, 0.7] },
];

async function runBacktest({ label, botConfig, signalCfg, days, symbols, cacheOnly }) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers(cacheOnly);
  log(`\n=== RUN: ${label} ===`);
  const started = Date.now();
  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol,
    fetchKlines1mForSymbol: signalCfg.interval !== "1m" ? fetchKlines1mForSymbol : null,
    restGapMs: 0,
    runMeta: { optimize: "sfp-signal", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 50 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      } else if (p.message?.startsWith("Done ")) {
        log(`[${label}] ${p.message}`);
      }
    },
  });
  const summary = summarizeRun(result);
  log(
    `→ ${label}: PnL $${summary.pnl} · ${summary.trades} trades · SFP sig ${summary.sfpSignals} · ${summary.elapsedSec}s`
  );
  return {
    label,
    days,
    ...summary,
    signalConfig: { ...signalCfg },
    elapsedTotalSec: Math.round((Date.now() - started) / 1000),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const baseBot = loadBotConfig();
  const baseSignal = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  log(`SFP signal optimization · ${args.days}d · ${symbols.length} symbols · AI OFF`);
  const store = readJsonFile(RESULTS_FILE(), { runs: [] });
  store.days = args.days;
  store.symbolCount = symbols.length;
  store.cacheOnly = args.cacheOnly;
  store.aiEnabled = false;

  const runAndStore = async (label, signalPatch = {}) => {
    const signalCfg = { ...baseSignal, ...signalPatch };
    applyBarConfig(signalCfg);
    const row = await runBacktest({
      label,
      botConfig: baseBot,
      signalCfg,
      days: args.days,
      symbols,
      cacheOnly: args.cacheOnly,
    });
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(row);
    writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });
    return row;
  };

  const baseline = await runAndStore("baseline");

  for (const sweep of SIGNAL_SWEEPS) {
    for (const v of sweep.values) {
      if (v === baseSignal[sweep.key]) continue;
      await runAndStore(`sig_${sweep.key}_${v}`, { [sweep.key]: v });
    }
  }

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    sfpSignals: r.sfpSignals,
    deltaVsBaseline: +(r.pnl - baseline.pnl).toFixed(2),
  }));
  store.baselinePnl = baseline.pnl;
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });

  log("\n=== TOP RUNS ===");
  for (const r of store.ranking.slice(0, 12)) {
    log(`${r.label}: $${r.pnl} (Δ $${r.deltaVsBaseline}) · ${r.trades} trades`);
  }
  log(`\nResults: ${RESULTS_FILE()}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
