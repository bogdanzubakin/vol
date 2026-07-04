#!/usr/bin/env node
/**
 * Train pullback regime v1 (14 feat, aggressive label) vs v2 (17 feat, soft label),
 * sweep thresholds by 30d PnL, compare with signal-only on Railway live stack.
 *
 *   node scripts/compare-pullback-regime-v1-v2.js --days 30
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { normalizeConfig } = require("../lib/paper-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const {
  trainFromTrades,
  reloadModel,
  MODEL_FILE,
  labelBadRegime,
  labelBadRegimeV1,
  FEATURE_NAMES,
  FEATURE_NAMES_V1,
} = require("../lib/pullback-regime-model");
const { reloadModel: reloadSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

const MIRROR = path.join(".cache", "railway-mirror");
const OUT_FILE = () => dataPath("pullback-regime-v1-v2-compare.json");
const V1_MODEL = () => dataPath("pullback-regime-model-v1.json");
const V2_MODEL = () => dataPath("pullback-regime-model-v2.json");

const REGIME_THRESHOLDS = [
  { bull: 0.72, bear: 0.7 },
  { bull: 0.76, bear: 0.74 },
  { bull: 0.8, bear: 0.78 },
  { bull: 0.84, bear: 0.82 },
  { bull: 0.88, bear: 0.86 },
  { bull: 0.92, bear: 0.9 },
];

const SIGNAL_THRESHOLDS = [
  { bull: 0.48, bear: 0.5 },
  { bull: 0.52, bear: 0.54 },
  { bull: 0.55, bear: 0.58 },
  { bull: 0.58, bear: 0.62 },
];

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 30;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 30)) };
}

function copyLiveModels() {
  function copy(name, dest) {
    const src = path.join(MIRROR, `${name}-live.json`);
    if (!fs.existsSync(src)) return;
    writeJsonFile(dataPath(dest || `${name}.json`), readJsonFile(src, {}));
  }
  copy("sfp-regime-model");
  copy("pullback-signal-model");
  copy("ai-exit-levels");
  copy("early-exit-model", "early-exit-sfp.json");
  reloadSfp("paper");
  reloadSignal("paper");
  reloadExitLevels("paper");
}

function installRegimeModel(file) {
  const model = readJsonFile(file, null);
  if (!model) throw new Error(`Missing model: ${file}`);
  writeJsonFile(MODEL_FILE("paper"), model);
  reloadModel("paper");
}

function loadRailwayConfig() {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {}).config || {};
  return normalizeLiveConfig({ enabled: true, ...raw });
}

function loadSignalConfig() {
  const scannerRaw = readJsonFile(path.join(MIRROR, "scanner-config.json"), {});
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
    pullbackMaxBelowMaPct: 1.5,
    ...scannerRaw,
  };
  applyBarConfig(cfg);
  return cfg;
}

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
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

function summarize(result) {
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
    winRate: s.closedCount
      ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
      : 0,
    pbRegimeSkips: s.pullbackRegimeSkips ?? 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    sfpRegimeSkips: s.sfpRegimeSkips ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, fetchers }) {
  log(`\n=== ${label} ===`);
  let last = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: false,
    runMeta: { compare: "pullback-regime-v1-v2", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 120 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      }
    },
  });
  const row = { label, ...summarize(result) };
  log(
    `→ $${row.pnl} · ${row.trades} tr · PB ${row.pbTrades} ($${row.pbPnl}) · regime skip ${row.pbRegimeSkips} · sig skip ${row.pbSignalSkips}`
  );
  return row;
}

function pbTrainBase(saved) {
  return normalizeConfig({
    enabled: true,
    ...saved,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiSfpRegimeEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
    aiExitLevelsEnabled: false,
  });
}

async function collectPbTrades({ days, symbols, signalCfg, fetchers }) {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  const botConfig = pbTrainBase(saved);
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: true,
    runMeta: { compare: "pullback-regime-v1-v2", label: "pb_train_collect" },
  });
  const trades = (result.closedTrades ?? []).filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  log(`Collected ${trades.length} PB trades for training`);
  return trades;
}

function fetchBars(symbol) {
  const sym = String(symbol).toUpperCase();
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
}

async function trainRegimeVariant({ trades, version, labelFn, featureNames, modelVersion, outFile, source }) {
  log(`\nTraining ${source} (${featureNames.length} features, ${trades.length} trades)…`);
  const model = await trainFromTrades(trades, fetchBars, {
    scope: "paper",
    modelScope: "paper",
    source,
    labelFn,
    featureNames,
    modelVersion,
    aiRegimeBtcLookbackHours: 24,
  });
  writeJsonFile(outFile, { ...model, scope: "paper" });
  return model;
}

function labelStats(trades, labelFn) {
  const labels = trades.map(labelFn);
  const pos = labels.filter((x) => x === 1).length;
  return { n: trades.length, badRate: +(pos / Math.max(1, trades.length)).toFixed(3) };
}

async function sweepBest({ variant, botBase, signalCfg, days, symbols, fetchers, thresholds, patchFn }) {
  let best = null;
  const runs = [];
  for (const th of thresholds) {
    const patch = patchFn(th);
    const botConfig = { ...botBase, ...patch };
    const label = `${variant}_${th.bull}_${th.bear}`;
    const row = await runBacktest({
      label,
      botConfig,
      signalCfg,
      days,
      symbols,
      fetchers,
    });
    runs.push({ thresholds: th, ...row });
    if (!best || row.pnl > best.pnl) best = { thresholds: th, ...row };
  }
  return { best, runs };
}

async function main() {
  const { days } = parseArgs(process.argv);
  copyLiveModels();
  const railway = loadRailwayConfig();
  const signalCfg = loadSignalConfig();
  const symbols = cachedSymbolList();
  const fetchers = createFetchers();

  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  log(`Pullback regime v1 vs v2 · ${days}d · ${symbols.length} symbols`);

  const trades = await collectPbTrades({ days, symbols, signalCfg, fetchers });
  if (trades.length < 30) {
    throw new Error(`Need >=30 PB trades (got ${trades.length})`);
  }

  const v1Stats = labelStats(trades, labelBadRegimeV1);
  const v2Stats = labelStats(trades, labelBadRegime);
  log(`Label bad-rate: v1 ${(v1Stats.badRate * 100).toFixed(1)}% · v2 ${(v2Stats.badRate * 100).toFixed(1)}%`);

  const v1Model = await trainRegimeVariant({
    trades,
    labelFn: labelBadRegimeV1,
    featureNames: FEATURE_NAMES_V1,
    modelVersion: 1,
    outFile: V1_MODEL(),
    source: "compare:regime-v1",
  });
  const v2Model = await trainRegimeVariant({
    trades,
    labelFn: labelBadRegime,
    featureNames: FEATURE_NAMES,
    modelVersion: 3,
    outFile: V2_MODEL(),
    source: "compare:regime-v2",
  });

  const botStack = {
    ...railway,
    aiPullbackRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
  };
  log(
    `Eval stack: SFP regime ${botStack.aiSfpRegimeEnabled} · exit levels ${botStack.aiExitLevelsEnabled} · early exit ${botStack.aiEarlyExitEnabled}`
  );

  // Regime v1 sweep
  installRegimeModel(V1_MODEL());
  const v1Sweep = await sweepBest({
    variant: "regime_v1",
    botBase: { ...botStack, aiPullbackRegimeEnabled: true, aiPullbackSignalEnabled: false },
    signalCfg,
    days,
    symbols,
    fetchers,
    thresholds: REGIME_THRESHOLDS,
    patchFn: (th) => ({
      aiPullbackRegimeBullThreshold: th.bull,
      aiPullbackRegimeBearThreshold: th.bear,
    }),
  });

  // Regime v2 sweep
  installRegimeModel(V2_MODEL());
  const v2Sweep = await sweepBest({
    variant: "regime_v2",
    botBase: { ...botStack, aiPullbackRegimeEnabled: true, aiPullbackSignalEnabled: false },
    signalCfg,
    days,
    symbols,
    fetchers,
    thresholds: REGIME_THRESHOLDS,
    patchFn: (th) => ({
      aiPullbackRegimeBullThreshold: th.bull,
      aiPullbackRegimeBearThreshold: th.bear,
    }),
  });

  // Signal-only sweep (Railway signal model already loaded)
  const signalSweep = await sweepBest({
    variant: "signal_only",
    botBase: { ...botStack, aiPullbackRegimeEnabled: false, aiPullbackSignalEnabled: true },
    signalCfg,
    days,
    symbols,
    fetchers,
    thresholds: SIGNAL_THRESHOLDS,
    patchFn: (th) => ({
      aiPullbackSignalBullThreshold: th.bull,
      aiPullbackSignalBearThreshold: th.bear,
    }),
  });

  const out = {
    ranAt: new Date().toISOString(),
    days,
    symbols: symbols.length,
    trainTrades: trades.length,
    labelStats: { v1: v1Stats, v2: v2Stats },
    training: {
      v1: {
        features: FEATURE_NAMES_V1.length,
        bullSamples: v1Model.bull.metrics?.samples,
        bearSamples: v1Model.bear.metrics?.samples,
        bullBadRate: v1Model.bull.metrics?.positiveRate,
        bearBadRate: v1Model.bear.metrics?.positiveRate,
        bullAcc: v1Model.bull.metrics?.accuracy,
        bearAcc: v1Model.bear.metrics?.accuracy,
      },
      v2: {
        features: FEATURE_NAMES.length,
        bullSamples: v2Model.bull.metrics?.samples,
        bearSamples: v2Model.bear.metrics?.samples,
        bullBadRate: v2Model.bull.metrics?.positiveRate,
        bearBadRate: v2Model.bear.metrics?.positiveRate,
        bullAcc: v2Model.bull.metrics?.accuracy,
        bearAcc: v2Model.bear.metrics?.accuracy,
      },
    },
    regime_v1: v1Sweep,
    regime_v2: v2Sweep,
    signal_only: signalSweep,
    ranking: [
      { variant: "regime_v1", ...v1Sweep.best },
      { variant: "regime_v2", ...v2Sweep.best },
      { variant: "signal_only", ...signalSweep.best },
    ].sort((a, b) => b.pnl - a.pnl),
  };

  writeJsonFile(OUT_FILE(), out);
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
