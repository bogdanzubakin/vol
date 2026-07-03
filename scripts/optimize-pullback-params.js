#!/usr/bin/env node
/**
 * Pullback AI: baseline backtest, train signal + regime models, wide sweeps.
 *
 *   node scripts/optimize-pullback-params.js --days 10
 *   node scripts/optimize-pullback-params.js --days 10 --quick
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
  ensureAllDefaultModelsOnDisk: ensureSignalModels,
  trainFromTrades: trainSignalFromTrades,
  reloadModel: reloadSignalModel,
} = require("../lib/pullback-signal-model");
const {
  ensureAllDefaultModelsOnDisk: ensureRegimeModels,
  trainFromTrades: trainRegimeFromTrades,
  reloadModel: reloadRegimeModel,
} = require("../lib/pullback-regime-model");

const RESULTS_FILE = () => dataPath("pullback-optimization-results.json");

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

function pbBotBase(saved = {}) {
  return normalizeConfig({
    enabled: true,
    ...saved,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradeLevelBreakSignals: false,
    tradeLevelBreakBearSignals: false,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiSfpRegimeEnabled: false,
    aiLevelBreakRegimeEnabled: false,
    aiLevelBreakSignalEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
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
    pullbackMaBars: 7,
    pullbackTouchLookback: 12,
    pullbackMaxDistancePct: 0.35,
    pullbackMaxAboveMaPct: 1.5,
    pullbackMaxBelowMaPct: 1.5,
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
  const pb = closed.filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  let pbPnl = 0;
  for (const t of pb) pbPnl += Number(t.pnl) || 0;
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    pbTrades: pb.length,
    pbPnl: +pbPnl.toFixed(2),
    pbSignals: (s.pullbackSignals ?? 0) + (s.pullbackBearSignals ?? 0),
    pbRegimeSkips: s.pullbackRegimeSkips ?? 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, saveResult }) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers();
  log(`\n=== RUN: ${label} ===`);
  log(
    `PB ${botConfig.tradePullbackSignals ? "ON" : "OFF"} / bear ${botConfig.tradeBearishPullbackSignals ? "ON" : "OFF"} · AI sig ${botConfig.aiPullbackSignalEnabled ? "ON" : "OFF"} · AI regime ${botConfig.aiPullbackRegimeEnabled ? "ON" : "OFF"}`
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
    runMeta: { optimize: "pullback", label },
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
    `→ ${label}: PnL $${summary.pnl} · ${summary.trades} tr · PB ${summary.pbTrades} ($${summary.pbPnl}) · regime skips ${summary.pbRegimeSkips} · sig skips ${summary.pbSignalSkips}`
  );
  return { label, days, ...summary };
}

async function trainModels() {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  if (trades.length < 20) {
    throw new Error(`Need >=20 pullback trades for training (got ${trades.length})`);
  }
  function fetchBars(symbol) {
    const sym = String(symbol).toUpperCase();
    return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
  }
  log(`\n=== TRAIN pullback signal (${trades.length} trades) ===`);
  await trainSignalFromTrades(trades, fetchBars, {
    scope: "paper",
    source: "optimize:pullback-signal",
  });
  reloadSignalModel("paper");
  log(`\n=== TRAIN pullback regime (${trades.length} trades) ===`);
  await trainRegimeFromTrades(trades, fetchBars, {
    scope: "paper",
    source: "optimize:pullback-regime",
  });
  reloadRegimeModel("paper");
}

const SIGNAL_THRESHOLDS_FULL = [
  { bull: 0.45, bear: 0.48 },
  { bull: 0.5, bear: 0.52 },
  { bull: 0.52, bear: 0.54 },
  { bull: 0.55, bear: 0.58 },
  { bull: 0.58, bear: 0.62 },
];
const SIGNAL_THRESHOLDS_QUICK = [
  { bull: 0.5, bear: 0.54 },
  { bull: 0.55, bear: 0.58 },
];
const REGIME_THRESHOLDS_FULL = [
  { bull: 0.72, bear: 0.7 },
  { bull: 0.76, bear: 0.74 },
  { bull: 0.8, bear: 0.78 },
  { bull: 0.84, bear: 0.82 },
];
const REGIME_THRESHOLDS_QUICK = [{ bull: 0.76, bear: 0.74 }];

const PARAM_SWEEPS = [
  { key: "pullbackMaBars", values: [5, 7, 9] },
  { key: "pullbackTouchLookback", values: [8, 12, 16] },
  { key: "pullbackMaxDistancePct", values: [0.25, 0.35, 0.5] },
  { key: "minLinearChangePct", values: [0.35, 0.5, 0.65] },
];

async function main() {
  const args = parseArgs(process.argv);
  ensureSignalModels();
  ensureRegimeModels();

  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  const baseBot = pbBotBase(saved);
  const baseSignal = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  log(`Pullback AI optimization · ${args.days}d · ${symbols.length} symbols`);
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

  const baseline = await runAndStore("baseline_pb_legacy", {}, {}, true);
  await trainModels();

  const sigTh = args.quick ? SIGNAL_THRESHOLDS_QUICK : SIGNAL_THRESHOLDS_FULL;
  for (const th of sigTh) {
    await runAndStore(`ai_signal_${th.bull}_${th.bear}`, {
      aiPullbackSignalEnabled: true,
      aiPullbackSignalBullThreshold: th.bull,
      aiPullbackSignalBearThreshold: th.bear,
    });
  }

  const regTh = args.quick ? REGIME_THRESHOLDS_QUICK : REGIME_THRESHOLDS_FULL;
  for (const th of regTh) {
    await runAndStore(`ai_regime_${th.bull}_${th.bear}`, {
      aiPullbackRegimeEnabled: true,
      aiPullbackRegimeBullThreshold: th.bull,
      aiPullbackRegimeBearThreshold: th.bear,
    });
  }

  await runAndStore("ai_signal_plus_regime", {
    aiPullbackSignalEnabled: true,
    aiPullbackSignalBullThreshold: 0.52,
    aiPullbackSignalBearThreshold: 0.54,
    aiPullbackRegimeEnabled: true,
    aiPullbackRegimeBullThreshold: 0.76,
    aiPullbackRegimeBearThreshold: 0.74,
  });

  if (!args.quick) {
    for (const sweep of PARAM_SWEEPS) {
      for (const v of sweep.values) {
        if (v === baseSignal[sweep.key]) continue;
        await runAndStore(`legacy_${sweep.key}_${v}`, {}, { [sweep.key]: v });
        await runAndStore(
          `ai_sig_${sweep.key}_${v}`,
          {
            aiPullbackSignalEnabled: true,
            aiPullbackSignalBullThreshold: 0.52,
            aiPullbackSignalBearThreshold: 0.54,
          },
          { [sweep.key]: v }
        );
        await runAndStore(
          `ai_reg_${sweep.key}_${v}`,
          {
            aiPullbackRegimeEnabled: true,
            aiPullbackRegimeBullThreshold: 0.76,
            aiPullbackRegimeBearThreshold: 0.74,
          },
          { [sweep.key]: v }
        );
      }
    }
  }

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    pbTrades: r.pbTrades,
    pbPnl: r.pbPnl,
    pbRegimeSkips: r.pbRegimeSkips,
    pbSignalSkips: r.pbSignalSkips,
    deltaVsBaseline: +(r.pnl - baseline.pnl).toFixed(2),
  }));
  store.baselinePnl = baseline.pnl;
  store.baselinePbTrades = baseline.pbTrades;
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });

  log("\n=== TOP RUNS ===");
  for (const r of store.ranking.slice(0, 15)) {
    log(
      `${r.label}: $${r.pnl} (Δ $${r.deltaVsBaseline}) · ${r.trades} tr · PB ${r.pbTrades} ($${r.pbPnl}) · skips r${r.pbRegimeSkips}/s${r.pbSignalSkips}`
    );
  }
  log(`\nResults: ${RESULTS_FILE()}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
