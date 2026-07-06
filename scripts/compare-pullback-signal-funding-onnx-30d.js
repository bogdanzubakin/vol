#!/usr/bin/env node
/**
 * Compare pullback signal variants over 30d:
 *   1) baseline logistic (14 features)
 *   2) funding/OI logistic (17 features)
 *   3) funding/OI GBM/ONNX (non-linear, sync GBM JSON in backtest)
 *
 *   node scripts/compare-pullback-signal-funding-onnx-30d.js --days 30
 *   node scripts/compare-pullback-signal-funding-onnx-30d.js --days 30 --skip-prefetch
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { normalizeConfig } = require("../lib/paper-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const {
  trainFromTrades,
  reloadModel,
  saveModel,
  MODEL_FILE,
  buildTrainingSamples,
  FEATURE_NAMES,
  FEATURE_NAMES_WITH_FUNDING_OI,
} = require("../lib/pullback-signal-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const {
  prefetchFundingOiCache,
  loadFundingOiCache,
} = require("../lib/funding-oi-cache");
const { onnxDir, clearOnnxSessionCache } = require("../lib/pullback-signal-onnx");

const MIRROR = path.join(".cache", "railway-mirror");
const OUT_FILE = () => dataPath("pullback-signal-funding-onnx-compare.json");
const PROGRESS_FILE = () => dataPath("pullback-signal-funding-onnx-progress.json");
const BASELINE_MODEL = () => dataPath("pullback-signal-model-baseline.json");
const FUNDING_MODEL = () => dataPath("pullback-signal-model-funding.json");
const SAMPLES_FILE = () => dataPath("pullback-signal-onnx-samples.json");

const SIGNAL_THRESHOLDS = [
  { bull: 0.48, bear: 0.5 },
  { bull: 0.52, bear: 0.54 },
  { bull: 0.55, bear: 0.56 },
  { bull: 0.58, bear: 0.6 },
];

const STALE_MS = {
  funding_oi: 20 * 60 * 1000,
  collect: 90 * 60 * 1000,
  train: 30 * 60 * 1000,
  simulate: 90 * 60 * 1000,
  default: 45 * 60 * 1000,
};

let lastProgressAt = Date.now();
let lastProgressPhase = "init";
let staleTimer = null;

function touchProgress(phase, extra = {}) {
  lastProgressAt = Date.now();
  lastProgressPhase = phase;
  writeJsonFile(PROGRESS_FILE(), {
    updatedAt: new Date().toISOString(),
    phase,
    pid: process.pid,
    ...extra,
  });
}

function staleLimitMs(phase) {
  return STALE_MS[phase] ?? STALE_MS.default;
}

function startStaleWatchdog() {
  if (staleTimer) return;
  staleTimer = setInterval(() => {
    const idle = Date.now() - lastProgressAt;
    const limit = staleLimitMs(lastProgressPhase);
    if (idle > limit) {
      const msg = `Compare stalled: no progress for ${Math.round(idle / 60_000)}m in phase "${lastProgressPhase}" (limit ${Math.round(limit / 60_000)}m)`;
      log(msg);
      writeJsonFile(PROGRESS_FILE(), {
        updatedAt: new Date().toISOString(),
        phase: "stalled",
        stalledPhase: lastProgressPhase,
        idleMs: idle,
        error: msg,
        pid: process.pid,
      });
      process.exit(1);
    }
  }, 60_000);
  staleTimer.unref?.();
}

function saveCheckpoint(partial) {
  writeJsonFile(OUT_FILE(), {
    ...partial,
    checkpoint: true,
    checkpointAt: new Date().toISOString(),
  });
}

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 30;
  let skipPrefetch = false;
  let restGapMs = 120;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--skip-prefetch") skipPrefetch = true;
    else if (argv[i] === "--rest-gap" && argv[i + 1]) restGapMs = Number(argv[++i]);
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 30)),
    skipPrefetch,
    restGapMs,
  };
}

function copyLiveModels() {
  function copy(name, dest) {
    const src = path.join(MIRROR, `${name}-live.json`);
    if (!fs.existsSync(src)) return;
    writeJsonFile(dataPath(dest || `${name}.json`), readJsonFile(src, {}));
  }
  copy("ai-exit-levels");
  copy("early-exit-model", "early-exit-sfp.json");
  reloadSfp("paper");
  reloadExitLevels("paper");
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
  let tp = 0;
  for (const t of pb) {
    pbPnl += Number(t.pnl) || 0;
    if (t.exitReason === "take_profit") tp++;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    pbTrades: pb.length,
    pbPnl: +pbPnl.toFixed(2),
    tpRate: pb.length ? +((100 * tp) / pb.length).toFixed(1) : 0,
    winRate: s.closedCount
      ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
      : 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({
  label,
  botConfig,
  signalCfg,
  days,
  symbols,
  fetchers,
  getFundingOiAt,
}) {
  log(`\n=== ${label} ===`);
  touchProgress("simulate", { label });
  let last = "";
  let lastBarLog = 0;
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: false,
    getFundingOiAt,
    runMeta: { compare: "pullback-signal-funding-onnx", label },
    onProgress: (p) => {
      touchProgress("simulate", { label, subPhase: p.phase, symbol: p.symbol, done: p.done, total: p.total });
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 120 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      } else if (p.phase === "loading" && Date.now() - lastBarLog > 30_000) {
        lastBarLog = Date.now();
        log(`[${label}] loading ${p.done + 1}/${symbols.length} ${p.symbol || ""}`);
      }
    },
  });
  const row = { label, ...summarize(result) };
  log(
    `→ $${row.pnl} · ${row.trades} tr · PB ${row.pbTrades} ($${row.pbPnl}) · TP ${row.tpRate}% · sig skip ${row.pbSignalSkips}`
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
    aiPullbackPatternBreakEnabled: false,
    aiPullbackSignalEnabled: false,
    aiExitLevelsEnabled: false,
  });
}

async function collectPbTrades({ days, symbols, signalCfg, fetchers, getFundingOiAt }) {
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
    getFundingOiAt,
    runMeta: { compare: "pullback-signal-funding-onnx", label: "pb_train_collect" },
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

function installSignalModel(file, onnx = false) {
  const model = readJsonFile(file, null);
  if (!model) throw new Error(`Missing model: ${file}`);
  if (onnx) {
    model.backend = "onnx";
    model.featureNames = FEATURE_NAMES_WITH_FUNDING_OI;
    model.onnxBullPath = path.join(onnxDir("paper"), "pullback-signal-bull.onnx");
    model.onnxBearPath = path.join(onnxDir("paper"), "pullback-signal-bear.onnx");
  }
  writeJsonFile(MODEL_FILE("paper"), model);
  reloadModel("paper");
  clearOnnxSessionCache();
}

async function trainVariant({ trades, featureNames, fundingOi, source, outFile, trainOpts = {} }) {
  log(`\nTraining ${source} (${featureNames.length} features, ${trades.length} trades)…`);
  const model = await trainFromTrades(trades, fetchBars, {
    scope: "paper",
    modelScope: "paper",
    source,
    featureNames,
    getFundingOiAt: fundingOi,
    aiPullbackSignalFundingOiEnabled: featureNames.length > FEATURE_NAMES.length,
    aiPullbackSignalBullThreshold: 0.52,
    aiPullbackSignalBearThreshold: 0.54,
    ...trainOpts,
  });
  writeJsonFile(outFile, { ...model, scope: "paper" });
  return model;
}

async function exportFundingSamples(trades, getFundingOiAt) {
  const samples = await buildTrainingSamples(trades, fetchBars, {
    featureNames: FEATURE_NAMES_WITH_FUNDING_OI,
    getFundingOiAt,
    aiPullbackSignalFundingOiEnabled: true,
    aiPullbackSignalBtcLookbackHours: 12,
  });
  const payload = {
    featureNames: FEATURE_NAMES_WITH_FUNDING_OI,
    samples,
    exportedAt: new Date().toISOString(),
  };
  writeJsonFile(SAMPLES_FILE(), payload);
  return payload;
}

function trainOnnxModels(samplesPath, outDir) {
  const py = process.env.PYTHON || "python3";
  const script = path.join(__dirname, "train-pullback-signal-onnx.py");
  if (!fs.existsSync(script)) {
    return { ok: false, error: "train script missing" };
  }
  touchProgress("train", { subPhase: "onnx_python" });
  const res = spawnSync(
    py,
    [script, samplesPath, outDir, "--feature-count", String(FEATURE_NAMES_WITH_FUNDING_OI.length)],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 15 * 60 * 1000 }
  );
  if (res.status !== 0) {
    return {
      ok: false,
      error: (res.stderr || res.stdout || "python failed").trim(),
      status: res.status,
    };
  }
  let meta = null;
  try {
    meta = JSON.parse(res.stdout);
  } catch {
    meta = readJsonFile(path.join(outDir, "meta.json"), null);
  }
  return { ok: true, meta, stdout: res.stdout?.trim() };
}

async function sweepBest({
  variant,
  botBase,
  signalCfg,
  days,
  symbols,
  fetchers,
  getFundingOiAt,
  modelFile,
  onnx = false,
  extraPatch = {},
}) {
  installSignalModel(modelFile, onnx);
  let best = null;
  const runs = [];
  for (const th of SIGNAL_THRESHOLDS) {
    const botConfig = {
      ...botBase,
      aiPullbackSignalEnabled: true,
      aiPullbackSignalBullThreshold: th.bull,
      aiPullbackSignalBearThreshold: th.bear,
      aiPullbackSignalFundingOiEnabled: onnx || variant.includes("funding"),
      aiPullbackSignalOnnxEnabled: onnx,
      ...extraPatch,
    };
    const label = `${variant}_${th.bull}_${th.bear}`;
    const row = await runBacktest({
      label,
      botConfig,
      signalCfg,
      days,
      symbols,
      fetchers,
      getFundingOiAt,
    });
    runs.push({ thresholds: th, ...row });
    if (!best || row.pnl > best.pnl) best = { thresholds: th, ...row };
  }
  return { best, runs };
}

async function main() {
  const { days, skipPrefetch, restGapMs } = parseArgs(process.argv);
  startStaleWatchdog();
  touchProgress("init", { days, skipPrefetch });
  copyLiveModels();
  const railway = loadRailwayConfig();
  const signalCfg = loadSignalConfig();
  const symbols = cachedSymbolList();
  const fetchers = createFetchers();

  if (!symbols.length) {
    console.error("No cached symbols — run a kline backtest first.");
    process.exit(1);
  }

  log(`PB signal funding/OI vs ONNX · ${days}d · ${symbols.length} symbols`);

  if (!skipPrefetch) {
    log("Prefetching funding + OI history…");
    touchProgress("funding_oi", { done: 0, total: symbols.length });
    const manifest = await prefetchFundingOiCache({
      symbols,
      days,
      restGapMs,
      onProgress: (p) => {
        touchProgress("funding_oi", {
          done: p.done,
          total: p.total,
          symbol: p.symbol,
          error: p.error,
          fail: p.fail,
        });
        if (p.phase === "funding_oi" && (p.done % 40 === 0 || p.error)) {
          log(p.message || `Funding/OI fail #${p.fail}: ${p.symbol} — ${p.error || ""}`);
        }
      },
    });
    log(`Funding/OI cache: ok=${manifest.ok} fail=${manifest.fail}`);
  }

  touchProgress("collect");
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);

  const trades = await collectPbTrades({
    days,
    symbols,
    signalCfg,
    fetchers,
    getFundingOiAt,
  });
  if (trades.length < 30) {
    throw new Error(`Need >=30 PB trades (got ${trades.length})`);
  }

  saveCheckpoint({ phase: "collected", days, symbols: symbols.length, trainTrades: trades.length });

  touchProgress("train", { subPhase: "baseline" });
  const baselineModel = await trainVariant({
    trades,
    featureNames: FEATURE_NAMES,
    fundingOi: null,
    source: "compare:signal-baseline",
    outFile: BASELINE_MODEL(),
  });

  const fundingModel = await trainVariant({
    trades,
    featureNames: FEATURE_NAMES_WITH_FUNDING_OI,
    fundingOi: getFundingOiAt,
    source: "compare:signal-funding-oi",
    outFile: FUNDING_MODEL(),
  });

  touchProgress("train", { subPhase: "export_samples" });
  const samplePayload = await exportFundingSamples(trades, getFundingOiAt);
  const onnxOut = onnxDir("paper");
  fs.mkdirSync(onnxOut, { recursive: true });
  const onnxTrain = trainOnnxModels(SAMPLES_FILE(), onnxOut);

  saveCheckpoint({
    phase: "trained",
    days,
    symbols: symbols.length,
    trainTrades: trades.length,
    onnxTrain,
  });

  const botStack = {
    ...railway,
    aiPullbackRegimeEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    aiSfpRegimeEnabled: false,
  };
  log(
    `Eval stack: exit levels ${botStack.aiExitLevelsEnabled} · early exit ${botStack.aiEarlyExitEnabled}`
  );

  const baselineSweep = await sweepBest({
    variant: "baseline_logistic",
    botBase: botStack,
    signalCfg,
    days,
    symbols,
    fetchers,
    getFundingOiAt: null,
    modelFile: BASELINE_MODEL(),
    extraPatch: { aiPullbackSignalFundingOiEnabled: false },
  });
  saveCheckpoint({ phase: "baseline_sweep_done", baselineSweep: baselineSweep.best });

  const fundingSweep = await sweepBest({
    variant: "funding_oi_logistic",
    botBase: botStack,
    signalCfg,
    days,
    symbols,
    fetchers,
    getFundingOiAt,
    modelFile: FUNDING_MODEL(),
    extraPatch: { aiPullbackSignalFundingOiEnabled: true },
  });
  saveCheckpoint({ phase: "funding_sweep_done", fundingSweep: fundingSweep.best });

  let onnxSweep = null;
  if (onnxTrain.ok && fs.existsSync(path.join(onnxOut, "pullback-signal-bull.gbm.json"))) {
    const onnxModel = {
      ...fundingModel,
      backend: "onnx",
      featureNames: FEATURE_NAMES_WITH_FUNDING_OI,
      source: "compare:signal-onnx-gbm",
      trainedAt: Date.now(),
    };
    writeJsonFile(dataPath("pullback-signal-model-onnx.json"), onnxModel);
    onnxSweep = await sweepBest({
      variant: "funding_oi_gbm",
      botBase: botStack,
      signalCfg,
      days,
      symbols,
      fetchers,
      getFundingOiAt,
      modelFile: dataPath("pullback-signal-model-onnx.json"),
      onnx: true,
      extraPatch: {
        aiPullbackSignalFundingOiEnabled: true,
        aiPullbackSignalOnnxEnabled: true,
      },
    });
  } else {
    log(`ONNX/GBM training skipped: ${onnxTrain.error || "no gbm output"}`);
  }

  const ranking = [
    { variant: "baseline_logistic", ...baselineSweep.best },
    { variant: "funding_oi_logistic", ...fundingSweep.best },
    ...(onnxSweep ? [{ variant: "funding_oi_gbm", ...onnxSweep.best }] : []),
  ].sort((a, b) => b.pnl - a.pnl);

  const out = {
    ranAt: new Date().toISOString(),
    days,
    symbols: symbols.length,
    trainTrades: trades.length,
    featureSets: {
      baseline: FEATURE_NAMES.length,
      fundingOi: FEATURE_NAMES_WITH_FUNDING_OI.length,
    },
    training: {
      baseline: {
        bullAcc: baselineModel.bull.metrics?.accuracy,
        bearAcc: baselineModel.bear.metrics?.accuracy,
        bullSamples: baselineModel.bull.metrics?.samples,
        bearSamples: baselineModel.bear.metrics?.samples,
      },
      fundingOi: {
        bullAcc: fundingModel.bull.metrics?.accuracy,
        bearAcc: fundingModel.bear.metrics?.accuracy,
        bullSamples: fundingModel.bull.metrics?.samples,
        bearSamples: fundingModel.bear.metrics?.samples,
      },
      onnx: onnxTrain,
      onnxSamples: samplePayload.samples.length,
    },
    baseline_logistic: baselineSweep,
    funding_oi_logistic: fundingSweep,
    funding_oi_gbm: onnxSweep,
    ranking,
    integration: {
      features: "lib/pullback-signal-features.js → extractPullbackSignalFeatures(extras.fundingOi)",
      cache: "lib/funding-oi-cache.js → getFundingOiAt(symbol, asOfMs)",
      onnx: "lib/pullback-signal-onnx.js → GBM JSON (backtest) + .onnx (live)",
    },
  };

  writeJsonFile(OUT_FILE(), out);
  touchProgress("done", { ranking: out.ranking });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  touchProgress("error", { error: e.message || String(e) });
  console.error(e.stack || e.message || e);
  process.exit(1);
});
