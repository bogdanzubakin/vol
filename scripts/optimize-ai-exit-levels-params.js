#!/usr/bin/env node
/**
 * Train AI SL/TP levels + sweep modes on cached backtest data.
 *
 *   node scripts/optimize-ai-exit-levels-params.js --days 10 --cache-only
 *   node scripts/optimize-ai-exit-levels-params.js --days 10 --cache-only --quick
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
} = require("../lib/ai-exit-levels");

const RESULTS_FILE = () => dataPath("ai-exit-levels-optimization-results.json");
const TRAINED_FILE = () => dataPath("ai-exit-levels-trained.json");

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
  return { days: Math.max(1, Math.min(21, Math.round(days) || 10)), quick };
}

function loadBotConfig() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiLevelBreakRegimeEnabled: false,
    aiSfpRegimeEnabled: true,
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
  const exits = {};
  let aiLevelTrades = 0;
  for (const t of result.closedTrades ?? []) {
    const r = t.exitReason ?? "unknown";
    exits[r] = (exits[r] ?? 0) + 1;
    if (t.exitMethod === "ai_levels" || t.aiSlPct != null) aiLevelTrades++;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    regimeSkips: s.sfpRegimeSkips ?? 0,
    aiLevelTrades,
    exits,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols }) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers();
  log(`\n=== RUN: ${label} ===`);
  log(
    `AI levels ${botConfig.aiExitLevelsEnabled ? "ON" : "OFF"} · mode ${botConfig.aiExitLevelsMode} · smart ${botConfig.smartExitLevelsEnabled ? "ON" : "OFF"}`
  );
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
    saveKlineCache: false,
    saveLastResult: label === "baseline_legacy",
    runMeta: { optimize: "ai-exit-levels", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });
  const summary = summarizeRun(result);
  log(`→ ${label}: PnL $${summary.pnl} · ${summary.trades} tr · ${summary.elapsedSec}s`);
  return {
    label,
    days,
    botPatch: {
      aiExitLevelsEnabled: botConfig.aiExitLevelsEnabled,
      aiExitLevelsLegacyDisabled: botConfig.aiExitLevelsLegacyDisabled,
      aiExitLevelsMode: botConfig.aiExitLevelsMode,
      aiExitLevelsSlScale: botConfig.aiExitLevelsSlScale,
      aiExitLevelsTpScale: botConfig.aiExitLevelsTpScale,
      smartExitLevelsEnabled: botConfig.smartExitLevelsEnabled,
    },
    ...summary,
    elapsedTotalSec: Math.round((Date.now() - started) / 1000),
  };
}

async function trainModel(baseBot) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 20) {
    throw new Error(`Need >=20 SFP trades for training (got ${trades.length})`);
  }
  log(`\n=== TRAIN AI exit-levels (${trades.length} trades) ===`);

  function fetchBars(symbol, openedAt, closedAt) {
    const sym = String(symbol).toUpperCase();
    const bars = readSymbolBars("mover", sym) ?? [];
    if (!bars.length) return [];
    const from = openedAt - 120_000;
    const to = closedAt + 120_000;
    return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
  }

  await trainFromTrades(trades, fetchBars, {
    botConfig: baseBot,
    scope: "paper",
    source: "optimize:backtest",
  });
  reloadModel("paper");
  const st = getModelStatus("paper");
  log(`Model saved · bull slMAE ${st.bull.slMae} tpMAE ${st.bull.tpMae}`);
  return st;
}

const SCALE_SWEEPS_FULL = [
  { sl: 0.85, tp: 0.85 },
  { sl: 1, tp: 1 },
  { sl: 1.15, tp: 1.15 },
  { sl: 0.9, tp: 1.1 },
  { sl: 1.1, tp: 0.9 },
];
const SCALE_SWEEPS_QUICK = [
  { sl: 0.9, tp: 1.1 },
  { sl: 1.15, tp: 1.15 },
];

async function main() {
  const args = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();

  const baseBot = loadBotConfig();
  const signalCfg = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  log(`AI exit-levels optimization · ${args.days}d · ${symbols.length} symbols`);
  const store = { runs: [], days: args.days, symbolCount: symbols.length };

  const runAndStore = async (label, botPatch = {}) => {
    const botConfig = normalizeConfig({ ...baseBot, ...botPatch });
    const row = await runBacktest({
      label,
      botConfig,
      signalCfg,
      days: args.days,
      symbols,
    });
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(row);
    writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });
    return row;
  };

  const baseline = await runAndStore("baseline_legacy", {
    aiExitLevelsEnabled: false,
    smartExitLevelsEnabled: true,
  });

  await trainModel(baseBot);

  const aiBase = {
    aiExitLevelsEnabled: true,
    aiExitLevelsLegacyDisabled: true,
    smartExitLevelsEnabled: false,
    aiExitLevelsMode: "predict",
  };

  const trainedPredict = await runAndStore("ai_predict_trained", aiBase);

  const scales = args.quick ? SCALE_SWEEPS_QUICK : SCALE_SWEEPS_FULL;
  for (const sc of scales) {
    await runAndStore(`ai_scale_sl${sc.sl}_tp${sc.tp}`, {
      ...aiBase,
      aiExitLevelsMode: "legacy_scale",
      aiExitLevelsSlScale: sc.sl,
      aiExitLevelsTpScale: sc.tp,
      smartExitLevelsEnabled: true,
    });
  }

  await runAndStore("ai_predict_smart_off", {
    ...aiBase,
    smartExitLevelsEnabled: false,
  });

  await runAndStore("ai_predict_tight_clamp", {
    ...aiBase,
    aiExitLevelsSlClampMax: 5,
    aiExitLevelsTpClampMax: 10,
  });

  await runAndStore("ai_predict_wide_clamp", {
    ...aiBase,
    aiExitLevelsSlClampMax: 10,
    aiExitLevelsTpClampMax: 18,
  });

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const best = ranked[0];
  const trained = {
    trainedAt: new Date().toISOString(),
    baselinePnl: baseline.pnl,
    bestLabel: best?.label,
    bestPnl: best?.pnl,
    bestDelta: +((best?.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
    aiPredictPnl: trainedPredict.pnl,
    aiPredictDelta: +(trainedPredict.pnl - baseline.pnl).toFixed(2),
    beatsBaseline: (trainedPredict.pnl ?? 0) > (baseline.pnl ?? 0),
    recommend: best?.botPatch ?? aiBase,
  };
  writeJsonFile(TRAINED_FILE(), trained);

  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    deltaVsBaseline: +((r.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
    botPatch: r.botPatch,
  }));
  store.baseline = baseline;
  store.trained = trained;
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });

  log("\n=== TOP RUNS ===");
  for (const r of store.ranking.slice(0, 12)) {
    log(`${r.label}: $${r.pnl} (Δ ${r.deltaVsBaseline >= 0 ? "+" : ""}${r.deltaVsBaseline})`);
  }
  log(`\nBaseline legacy: $${baseline.pnl}`);
  log(`AI predict trained: $${trainedPredict.pnl} (Δ ${trained.aiPredictDelta >= 0 ? "+" : ""}${trained.aiPredictDelta})`);
  log(`Best: ${best?.label} $${best?.pnl}`);
  log(`Results: ${RESULTS_FILE()}`);
  log(`Trained: ${TRAINED_FILE()}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
