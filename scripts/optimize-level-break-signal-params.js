#!/usr/bin/env node
/**
 * Level-break signal AI: baseline backtest, train, threshold + combo sweeps.
 *
 *   node scripts/optimize-level-break-signal-params.js --days 10 --cache-only
 *   node scripts/optimize-level-break-signal-params.js --days 10 --cache-only --quick
 */

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const {
  runPaperBotBacktest,
  loadLastBacktestResult,
} = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk,
  trainFromTrades,
  reloadModel,
  getModelStatus,
} = require("../lib/level-break-signal-model");

const RESULTS_FILE = () => dataPath("level-break-signal-optimization-results.json");

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  let quick = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 10)), quick };
}

function lbBotBase(saved = {}) {
  return normalizeConfig({
    enabled: true,
    ...saved,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeLevelBreakSignals: true,
    tradeLevelBreakBearSignals: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiSfpRegimeEnabled: false,
    aiLevelBreakRegimeEnabled: false,
    aiLevelBreakSignalEnabled: false,
    aiExitLevelsEnabled: false,
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
    sfpRangeBars: 45,
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

function createFetchers() {
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "mover", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
}

function summarizeRun(result) {
  const s = result.summary ?? {};
  const closed = result.closedTrades ?? [];
  const lb = closed.filter(
    (t) => t.signalKind === "level_break" || t.signalKind === "level_break_bear"
  );
  let lbPnl = 0;
  for (const t of lb) lbPnl += Number(t.pnl) || 0;
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    lbTrades: lb.length,
    lbPnl: +lbPnl.toFixed(2),
    lbSignals: (s.levelBreakSignals ?? 0) + (s.levelBreakBearSignals ?? 0),
    lbSignalSkips: s.levelBreakSignalSkips ?? 0,
    lbRegimeSkips: s.levelBreakRegimeSkips ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, saveResult }) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers();
  log(`\n=== RUN: ${label} ===`);
  log(
    `LB ${botConfig.tradeLevelBreakSignals ? "ON" : "OFF"} · AI signal ${botConfig.aiLevelBreakSignalEnabled ? "ON" : "OFF"} · AI regime ${botConfig.aiLevelBreakRegimeEnabled ? "ON" : "OFF"}`
  );
  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol,
    fetchKlines1mForSymbol: signalCfg.interval !== "1m" ? fetchKlines1mForSymbol : null,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: Boolean(saveResult),
    runMeta: { optimize: "level-break-signal", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 80 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });
  const summary = summarizeRun(result);
  log(
    `→ ${label}: PnL $${summary.pnl} · ${summary.trades} tr · LB ${summary.lbTrades} ($${summary.lbPnl}) · sig skips ${summary.lbSignalSkips}`
  );
  return { label, days, ...summary };
}

async function trainModel() {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "level_break" || t.signalKind === "level_break_bear"
  );
  if (trades.length < 20) {
    throw new Error(`Need >=20 level-break trades for training (got ${trades.length})`);
  }
  log(`\n=== TRAIN level-break signal (${trades.length} trades) ===`);
  function fetchBars(symbol) {
    const sym = String(symbol).toUpperCase();
    return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
  }
  await trainFromTrades(trades, fetchBars, {
    scope: "paper",
    source: "optimize:lb-signal",
  });
  reloadModel("paper");
  const st = getModelStatus("paper");
  log(
    `Model · bull acc ${((st.bullMetrics?.accuracy ?? 0) * 100).toFixed(1)}% · bear ${((st.bearMetrics?.accuracy ?? 0) * 100).toFixed(1)}%`
  );
  return st;
}

const THRESHOLD_SWEEPS_FULL = [
  { bull: 0.45, bear: 0.48 },
  { bull: 0.5, bear: 0.52 },
  { bull: 0.52, bear: 0.54 },
  { bull: 0.55, bear: 0.58 },
  { bull: 0.58, bear: 0.62 },
  { bull: 0.62, bear: 0.66 },
];
const THRESHOLD_SWEEPS_QUICK = [
  { bull: 0.5, bear: 0.54 },
  { bull: 0.55, bear: 0.58 },
];

const SIGNAL_PARAM_SWEEPS = [
  { key: "levelBreakMinPct", values: [0.08, 0.12, 0.16, 0.2] },
  { key: "levelBreakMinTouches", values: [3, 5, 7] },
  { key: "levelBreakApproachPct", values: [0.3, 0.4, 0.55] },
];

async function main() {
  const args = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();

  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  const baseBot = lbBotBase(saved);
  const baseSignal = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  log(`Level-break signal AI optimization · ${args.days}d · ${symbols.length} symbols`);
  const store = readJsonFile(RESULTS_FILE(), { runs: [] });
  store.days = args.days;
  store.symbolCount = symbols.length;

  const runAndStore = async (label, botPatch = {}, signalPatch = {}, saveResult = false) => {
    const signalCfg = { ...baseSignal, ...signalPatch };
    applyBarConfig(signalCfg);
    const row = await runBacktest({
      label,
      botConfig: normalizeConfig({ ...baseBot, ...botPatch }),
      signalCfg,
      days: args.days,
      symbols,
      saveResult,
    });
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(row);
    writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });
    return row;
  };

  const baseline = await runAndStore("baseline_lb_legacy", {}, {}, true);
  await trainModel();

  const thresholds = args.quick ? THRESHOLD_SWEEPS_QUICK : THRESHOLD_SWEEPS_FULL;
  for (const th of thresholds) {
    await runAndStore(`ai_signal_${th.bull}_${th.bear}`, {
      aiLevelBreakSignalEnabled: true,
      aiLevelBreakSignalBullThreshold: th.bull,
      aiLevelBreakSignalBearThreshold: th.bear,
    });
  }

  await runAndStore("ai_signal_plus_regime", {
    aiLevelBreakSignalEnabled: true,
    aiLevelBreakSignalBullThreshold: 0.52,
    aiLevelBreakSignalBearThreshold: 0.54,
    aiLevelBreakRegimeEnabled: true,
    aiLevelBreakRegimeBullThreshold: 0.76,
    aiLevelBreakRegimeBearThreshold: 0.74,
  });

  if (!args.quick) {
    for (const sweep of SIGNAL_PARAM_SWEEPS) {
      for (const v of sweep.values) {
        if (v === baseSignal[sweep.key]) continue;
        await runAndStore(
          `legacy_sig_${sweep.key}_${v}`,
          {},
          { [sweep.key]: v },
          false
        );
        await runAndStore(
          `ai_sig_${sweep.key}_${v}`,
          {
            aiLevelBreakSignalEnabled: true,
            aiLevelBreakSignalBullThreshold: 0.52,
            aiLevelBreakSignalBearThreshold: 0.54,
          },
          { [sweep.key]: v },
          false
        );
      }
    }
  }

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    lbTrades: r.lbTrades,
    lbPnl: r.lbPnl,
    lbSignalSkips: r.lbSignalSkips,
    deltaVsBaseline: +(r.pnl - baseline.pnl).toFixed(2),
  }));
  store.baselinePnl = baseline.pnl;
  store.baselineLbTrades = baseline.lbTrades;
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });

  log("\n=== TOP RUNS ===");
  for (const r of store.ranking.slice(0, 15)) {
    log(
      `${r.label}: $${r.pnl} (Δ $${r.deltaVsBaseline}) · ${r.trades} tr · LB ${r.lbTrades} ($${r.lbPnl}) · skips ${r.lbSignalSkips}`
    );
  }
  log(`\nResults: ${RESULTS_FILE()}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
