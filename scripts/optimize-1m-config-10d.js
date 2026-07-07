#!/usr/bin/env node
/**
 * 1m default · 10d coordinate-descent on all ENABLED live features.
 * Trains AI models once on 1m collect, then sweeps runtime settings.
 *
 *   node scripts/optimize-1m-config-10d.js --days 10
 *   node scripts/optimize-1m-config-10d.js --days 10 --skip-train --apply
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig, pickLiveConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const {
  trainFromTrades: trainSfpRegime,
  reloadModel: reloadSfpRegime,
  getModel: getSfpRegime,
  MODEL_FILE: SFP_MODEL_FILE,
  buildTrainingSamples: buildSfpSamples,
  FEATURE_NAMES_WITH_FUNDING_OI: SFP_FEATURES_FOI,
} = require("../lib/sfp-regime-model");
const {
  trainFromTrades: trainPbSignal,
  reloadModel: reloadPbSignal,
  getModel: getPbSignal,
  MODEL_FILE: PB_MODEL_FILE,
  buildTrainingSamples: buildPbSamples,
  FEATURE_NAMES_WITH_FUNDING_OI: PB_FEATURES_FOI,
} = require("../lib/pullback-signal-model");
const {
  trainFromTrades: trainEarlyExit,
  reloadModel: reloadEarlyExit,
  getModelStatus: getEarlyExitStatus,
  isAiEarlyExitReason,
} = require("../lib/early-exit-model");
const {
  trainFromTrades: trainExitLevels,
  reloadModel: reloadExitLevels,
  getModel: getExitLevels,
} = require("../lib/ai-exit-levels-model");
const { onnxDir: sfpOnnxDir, clearOnnxSessionCache: clearSfpOnnx } = require("../lib/sfp-regime-onnx");
const { onnxDir: pbOnnxDir, clearOnnxSessionCache: clearPbOnnx } = require("../lib/pullback-signal-onnx");

const MIRROR = path.join(".cache", "railway-mirror");
const MODEL_DIR = path.join(".cache", "interval-10d-models", "1m");
const OUT_FILE = () => dataPath("optimize-1m-config-10d.json");

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  let quick = false;
  let skipTrain = false;
  let apply = false;
  let applyOnly = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
    else if (argv[i] === "--skip-train") skipTrain = true;
    else if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--apply-only") applyOnly = true;
  }
  return {
    days: Math.max(1, Math.min(30, Math.round(days) || 10)),
    quick,
    skipTrain,
    apply,
    applyOnly,
  };
}

function sliceTail(bars, barCount) {
  if (!bars?.length) return null;
  return bars.length > barCount ? bars.slice(-barCount) : bars;
}

function create1mFetchers() {
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = sliceTail(readSymbolBars("mover", symbol), barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol() {
      return null;
    },
  };
}

function loadLiveBase() {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {}).config || {};
  return normalizeLiveConfig({
    enabled: true,
    ...raw,
    drawdownStopEnabled: false,
    aiSfpRegimeEnabled: true,
    aiSfpRegimeFundingOiGbmEnabled: true,
    aiPullbackSignalEnabled: true,
    aiPullbackSignalFundingOiGbmEnabled: true,
    aiEarlyExitEnabled: true,
    aiExitLevelsEnabled: true,
    aiPullbackRegimeEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    addOnEnabled: false,
    moveStopEnabled: false,
  });
}

function loadSignalBase() {
  const scannerRaw = readJsonFile(path.join(MIRROR, "scanner-config.json"), {});
  const cfg = {
    interval: "1m",
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
    pullbackCorridorBars: 120,
    ...scannerRaw,
    interval: "1m",
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

function fetchBarsAll(symbol) {
  const sym = String(symbol).toUpperCase();
  return readSymbolBars("mover", sym) ?? [];
}

function fetchBarsTradeWindow(symbol, openedAt, closedAt) {
  const bars = fetchBarsAll(symbol);
  if (!bars.length) return [];
  const from = openedAt - 120_000;
  const to = closedAt + 120_000;
  return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
}

function installModelFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function installCached1mModels() {
  if (!fs.existsSync(MODEL_DIR)) return false;
  const sfpOnnx = path.join(MODEL_DIR, "sfp-regime-onnx.json");
  const sfpLog = path.join(MODEL_DIR, "sfp-regime-funding.json");
  if (fs.existsSync(sfpOnnx)) {
    installModelFile(sfpOnnx, SFP_MODEL_FILE("paper"));
    const onnxSrc = path.join(MODEL_DIR, "sfp-regime-onnx");
    if (fs.existsSync(onnxSrc)) {
      fs.mkdirSync(sfpOnnxDir("paper"), { recursive: true });
      for (const name of fs.readdirSync(onnxSrc)) {
        const p = path.join(onnxSrc, name);
        if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(sfpOnnxDir("paper"), name));
      }
    }
  } else if (fs.existsSync(sfpLog)) {
    installModelFile(sfpLog, SFP_MODEL_FILE("paper"));
  }
  reloadSfpRegime("paper");
  clearSfpOnnx();

  const pbOnnx = path.join(MODEL_DIR, "pullback-signal-onnx.json");
  const pbLog = path.join(MODEL_DIR, "pullback-signal-funding.json");
  if (fs.existsSync(pbOnnx)) {
    installModelFile(pbOnnx, PB_MODEL_FILE("paper"));
    const onnxSrc = path.join(MODEL_DIR, "pullback-signal-onnx");
    if (fs.existsSync(onnxSrc)) {
      fs.mkdirSync(pbOnnxDir("paper"), { recursive: true });
      for (const name of fs.readdirSync(onnxSrc)) {
        const p = path.join(onnxSrc, name);
        if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(pbOnnxDir("paper"), name));
      }
    }
  } else if (fs.existsSync(pbLog)) {
    installModelFile(pbLog, PB_MODEL_FILE("paper"));
  }
  reloadPbSignal("paper");
  clearPbOnnx();

  const early = path.join(MODEL_DIR, "early-exit-sfp.json");
  if (fs.existsSync(early)) {
    installModelFile(early, dataPath("early-exit-sfp.json"));
    reloadEarlyExit("paper");
  }
  const exits = path.join(MODEL_DIR, "ai-exit-levels.json");
  if (fs.existsSync(exits)) {
    installModelFile(exits, modelFileFor("ai-exit-levels", "paper"));
    reloadExitLevels("paper");
  }
  return true;
}

function trainOnnx(samplesPath, outDir, opts) {
  const py = process.env.PYTHON || "python3";
  const script = path.join(__dirname, "train-pullback-signal-onnx.py");
  if (!fs.existsSync(script)) return { ok: false };
  const res = spawnSync(
    py,
    [
      script,
      samplesPath,
      outDir,
      "--feature-count",
      String(opts.featureCount),
      "--prefix",
      opts.prefix,
      "--bull-kind",
      opts.bullKind,
      "--bear-kind",
      opts.bearKind,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 15 * 60 * 1000 }
  );
  return { ok: res.status === 0 };
}

async function trainAllModels({ trades, botConfig, getFundingOiAt }) {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  const tag = "optimize:1m:10d";
  const sfpTrades = trades.filter((t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear");
  const pbTrades = trades.filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  const earlyTrades = sfpTrades.filter((t) => !isAiEarlyExitReason(t.exitReason));

  log(`Train 1m models · SFP ${sfpTrades.length} · PB ${pbTrades.length}`);

  const sfpModel = await trainSfpRegime(sfpTrades, fetchBarsAll, {
    modelScope: "paper",
    source: tag,
    featureNames: SFP_FEATURES_FOI,
    getFundingOiAt,
    aiSfpRegimeFundingOiEnabled: true,
    aiRegimeBtcLookbackHours: botConfig.aiRegimeBtcLookbackHours ?? 24,
  });
  reloadSfpRegime("paper");
  const sfpSamplesPath = path.join(MODEL_DIR, "sfp-regime-samples.json");
  writeJsonFile(sfpSamplesPath, {
    featureNames: SFP_FEATURES_FOI,
    samples: await buildSfpSamples(sfpTrades, fetchBarsAll, {
      featureNames: SFP_FEATURES_FOI,
      getFundingOiAt,
      aiSfpRegimeFundingOiEnabled: true,
      aiRegimeBtcLookbackHours: botConfig.aiRegimeBtcLookbackHours ?? 24,
    }),
  });
  const sfpOnnxOut = path.join(MODEL_DIR, "sfp-regime-onnx");
  fs.mkdirSync(sfpOnnxOut, { recursive: true });
  if (
    trainOnnx(sfpSamplesPath, sfpOnnxOut, {
      featureCount: SFP_FEATURES_FOI.length,
      prefix: "sfp-regime",
      bullKind: "sfp",
      bearKind: "sfp_bear",
    }).ok &&
    fs.existsSync(path.join(sfpOnnxOut, "sfp-regime-bull.gbm.json"))
  ) {
    writeJsonFile(path.join(MODEL_DIR, "sfp-regime-onnx.json"), {
      ...sfpModel,
      backend: "onnx",
      featureNames: SFP_FEATURES_FOI,
      source: `${tag}:gbm`,
      trainedAt: Date.now(),
    });
  } else {
    writeJsonFile(path.join(MODEL_DIR, "sfp-regime-funding.json"), {
      ...getSfpRegime("paper"),
      scope: "paper",
    });
  }

  await trainEarlyExit(earlyTrades, fetchBarsTradeWindow, {
    modelScope: "paper",
    source: tag,
  });
  reloadEarlyExit("paper");
  installModelFile(dataPath("early-exit-sfp.json"), path.join(MODEL_DIR, "early-exit-sfp.json"));

  if (pbTrades.length >= 20) {
    const pbModel = await trainPbSignal(pbTrades, fetchBarsAll, {
      modelScope: "paper",
      source: tag,
      featureNames: PB_FEATURES_FOI,
      getFundingOiAt,
      aiPullbackSignalFundingOiEnabled: true,
      aiPullbackSignalBtcLookbackHours: botConfig.aiPullbackSignalBtcLookbackHours ?? 12,
    });
    reloadPbSignal("paper");
    const pbSamplesPath = path.join(MODEL_DIR, "pullback-signal-samples.json");
    writeJsonFile(pbSamplesPath, {
      featureNames: PB_FEATURES_FOI,
      samples: await buildPbSamples(pbTrades, fetchBarsAll, {
        featureNames: PB_FEATURES_FOI,
        getFundingOiAt,
        aiPullbackSignalFundingOiEnabled: true,
        aiPullbackSignalBtcLookbackHours: botConfig.aiPullbackSignalBtcLookbackHours ?? 12,
      }),
    });
    const pbOnnxOut = path.join(MODEL_DIR, "pullback-signal-onnx");
    fs.mkdirSync(pbOnnxOut, { recursive: true });
    if (
      trainOnnx(pbSamplesPath, pbOnnxOut, {
        featureCount: PB_FEATURES_FOI.length,
        prefix: "pullback-signal",
        bullKind: "pullback",
        bearKind: "pullback_bear",
      }).ok &&
      fs.existsSync(path.join(pbOnnxOut, "pullback-signal-bull.gbm.json"))
    ) {
      writeJsonFile(path.join(MODEL_DIR, "pullback-signal-onnx.json"), {
        ...pbModel,
        backend: "onnx",
        featureNames: PB_FEATURES_FOI,
        source: `${tag}:gbm`,
        trainedAt: Date.now(),
      });
    } else {
      writeJsonFile(path.join(MODEL_DIR, "pullback-signal-funding.json"), {
        ...getPbSignal("paper"),
        scope: "paper",
      });
    }
  }

  await trainExitLevels(sfpTrades, fetchBarsTradeWindow, {
    botConfig,
    scope: "paper",
    source: tag,
  });
  reloadExitLevels("paper");
  writeJsonFile(path.join(MODEL_DIR, "ai-exit-levels.json"), {
    ...getExitLevels("paper"),
    scope: "paper",
  });
  installCached1mModels();
  return getEarlyExitStatus("paper");
}

function summarize(result) {
  const s = result.summary ?? {};
  const trades = result.closedTrades ?? [];
  const pnl = trades.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
  const tp = trades.filter((t) => t.exitReason === "take_profit").length;
  return {
    pnl: +pnl.toFixed(2),
    trades: trades.length,
    tpRate: trades.length ? +((100 * tp) / trades.length).toFixed(1) : 0,
    winRate: trades.length
      ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
      : 0,
    aiExits: s.aiExits ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, fetchers, getFundingOiAt }) {
  let last = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: null,
    restGapMs: 0,
    saveLastResult: false,
    getFundingOiAt,
    runMeta: { optimize: "1m-config-10d", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 120 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      }
    },
  });
  return { label, ...summarize(result) };
}

function phases(quick) {
  if (quick) {
    return [
      {
        name: "sfp_gbm",
        sweeps: [
          { aiSfpRegimeGbmBullThreshold: 0.7, aiSfpRegimeGbmBearThreshold: 0.68 },
          { aiSfpRegimeGbmBullThreshold: 0.72, aiSfpRegimeGbmBearThreshold: 0.7 },
          { aiSfpRegimeGbmBullThreshold: 0.76, aiSfpRegimeGbmBearThreshold: 0.72 },
        ],
      },
      {
        name: "pb_signal",
        sweeps: [
          { aiPullbackSignalGbmBullThreshold: 0.54, aiPullbackSignalGbmBearThreshold: 0.56 },
          { aiPullbackSignalGbmBullThreshold: 0.58, aiPullbackSignalGbmBearThreshold: 0.6 },
        ],
      },
      {
        name: "tp_sl",
        sweeps: [
          { takeProfitPct: 2.5, stopLossBelowCorridorPct: 1.5 },
          { takeProfitPct: 3, stopLossBelowCorridorPct: 1.5 },
          { takeProfitPct: 3, stopLossBelowCorridorPct: 2 },
        ],
      },
      {
        name: "ai_exits",
        sweeps: [
          { aiExitLevelsSlScale: 1.2, aiExitLevelsTpScale: 1.3 },
          { aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.5 },
        ],
      },
    ];
  }
  return [
    {
      name: "sfp_gbm",
      sweeps: [
        { aiSfpRegimeGbmBullThreshold: 0.68, aiSfpRegimeGbmBearThreshold: 0.66 },
        { aiSfpRegimeGbmBullThreshold: 0.7, aiSfpRegimeGbmBearThreshold: 0.68 },
        { aiSfpRegimeGbmBullThreshold: 0.72, aiSfpRegimeGbmBearThreshold: 0.7 },
        { aiSfpRegimeGbmBullThreshold: 0.74, aiSfpRegimeGbmBearThreshold: 0.7 },
        { aiSfpRegimeGbmBullThreshold: 0.76, aiSfpRegimeGbmBearThreshold: 0.72 },
        { aiSfpRegimeGbmBullThreshold: 0.78, aiSfpRegimeGbmBearThreshold: 0.74 },
        { aiSfpRegimeGbmBullThreshold: 0.8, aiSfpRegimeGbmBearThreshold: 0.76 },
      ],
    },
    {
      name: "pb_signal",
      sweeps: [
        { aiPullbackSignalGbmBullThreshold: 0.5, aiPullbackSignalGbmBearThreshold: 0.52 },
        { aiPullbackSignalGbmBullThreshold: 0.52, aiPullbackSignalGbmBearThreshold: 0.54 },
        { aiPullbackSignalGbmBullThreshold: 0.54, aiPullbackSignalGbmBearThreshold: 0.56 },
        { aiPullbackSignalGbmBullThreshold: 0.56, aiPullbackSignalGbmBearThreshold: 0.58 },
        { aiPullbackSignalGbmBullThreshold: 0.58, aiPullbackSignalGbmBearThreshold: 0.6 },
        { aiPullbackSignalGbmBullThreshold: 0.6, aiPullbackSignalGbmBearThreshold: 0.62 },
        { aiPullbackSignalGbmBullThreshold: 0.62, aiPullbackSignalGbmBearThreshold: 0.64 },
      ],
    },
    {
      name: "early_hard",
      sweeps: [0.68, 0.72, 0.76, 0.8, 0.84, 0.88].map((aiEarlyExitHardThreshold) => ({
        aiEarlyExitHardThreshold,
      })),
    },
    {
      name: "early_soft",
      sweeps: [0.82, 0.86, 0.88, 0.9, 0.92, 0.94].map((aiEarlyExitSoftThreshold) => ({
        aiEarlyExitSoftThreshold,
      })),
    },
    {
      name: "early_minBars",
      sweeps: [3, 6, 9, 12, 15, 20].map((aiEarlyExitMinBars) => ({ aiEarlyExitMinBars })),
    },
    {
      name: "ai_exit_scales",
      sweeps: [
        { aiExitLevelsSlScale: 1, aiExitLevelsTpScale: 1.1 },
        { aiExitLevelsSlScale: 1.1, aiExitLevelsTpScale: 1.2 },
        { aiExitLevelsSlScale: 1.2, aiExitLevelsTpScale: 1.3 },
        { aiExitLevelsSlScale: 1.2, aiExitLevelsTpScale: 1.5 },
        { aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.5 },
        { aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.6 },
        { aiExitLevelsSlScale: 1.4, aiExitLevelsTpScale: 1.7 },
      ],
    },
    {
      name: "tp",
      sweeps: [1.5, 2, 2.5, 3, 3.5, 4, 5].map((takeProfitPct) => ({ takeProfitPct })),
    },
    {
      name: "sl",
      sweeps: [1, 1.5, 2, 2.5, 3].map((stopLossBelowCorridorPct) => ({
        stopLossBelowCorridorPct,
      })),
    },
    {
      name: "tp_min",
      sweeps: [0.5, 0.6, 0.8, 1, 1.2, 1.5].map((takeProfitMinPct) => ({ takeProfitMinPct })),
    },
    {
      name: "sfp_tp",
      sweeps: [3, 3.5, 4, 4.5, 5, 6].map((sfpTakeProfitPct) => ({ sfpTakeProfitPct })),
    },
    {
      name: "pb_corridor",
      sweeps: [
        { maxPullbackCorridorWidthPct: 0 },
        { maxPullbackCorridorWidthPct: 14 },
        { maxPullbackCorridorWidthPct: 18 },
        { maxPullbackCorridorWidthPct: 22 },
        { maxPullbackCorridorWidthPct: 28 },
        { maxPullbackCorridorWidthPct: 32 },
      ],
    },
    {
      name: "pb_corridor_bars",
      signalSweeps: [
        { pullbackCorridorBars: 60 },
        { pullbackCorridorBars: 120 },
        { pullbackCorridorBars: 180 },
        { pullbackCorridorBars: 300 },
        { pullbackCorridorBars: 600 },
      ],
    },
    {
      name: "sfp_corridor",
      sweeps: [8, 10, 13, 16, 20, 24].map((maxSfpCorridorWidthPct) => ({
        maxSfpCorridorWidthPct,
      })),
    },
    {
      name: "size",
      sweeps: [
        { leverage: 1, positionSizeUsdt: 5.97 },
        { leverage: 2, positionSizeUsdt: 5.97 },
        { leverage: 2, positionSizeUsdt: 8 },
        { leverage: 3, positionSizeUsdt: 5.97 },
      ],
    },
    {
      name: "drawdown",
      sweeps: [
        { drawdownStopEnabled: false },
        { drawdownStopEnabled: true, drawdownStopPct: 2 },
        { drawdownStopEnabled: true, drawdownStopPct: 3 },
        { drawdownStopEnabled: true, drawdownStopPct: 4 },
      ],
    },
  ];
}

function pickBest(rows) {
  return [...rows].sort((a, b) => (b.pnl !== a.pnl ? b.pnl - a.pnl : b.trades - a.trades))[0];
}

function applyLocalDefaults(bestBot, bestSignal) {
  const scannerPath = scannerConfig.CONFIG_FILE();
  const mergedSignal = pickLiveConfig({ ...bestSignal, interval: "1m" });
  writeJsonFile(scannerPath, mergedSignal);

  for (const rel of ["paper-bot-state.json", "live-bot-state.json"]) {
    const file = dataPath(rel);
    const raw = readJsonFile(file, { config: {} });
    writeJsonFile(file, {
      ...raw,
      config: normalizeLiveConfig({ ...raw.config, ...bestBot }),
      savedAt: Date.now(),
    });
  }
  installCached1mModels();
  log(`Applied 1m defaults to scanner + paper/live bot state`);
}

async function main() {
  const { days, quick, skipTrain, apply, applyOnly } = parseArgs(process.argv);

  if (applyOnly) {
    const store = readJsonFile(OUT_FILE(), null);
    if (!store?.bestBot || !store?.bestSignal) {
      console.error("No optimization results — run optimize first.");
      process.exit(1);
    }
    applyLocalDefaults(store.bestBot, store.bestSignal);
    console.log(JSON.stringify({ applied: true, best: store.best }, null, 2));
    return;
  }

  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  const fetchers = create1mFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  let store = readJsonFile(OUT_FILE(), {
    runs: [],
    phasesDone: [],
    best: null,
    bestBot: null,
    bestSignal: null,
    baseline: null,
    trained: false,
  });

  let botAnchor = store.bestBot
    ? normalizeLiveConfig({ ...store.bestBot })
    : loadLiveBase();
  let signalAnchor = store.bestSignal
    ? (() => {
        const c = { ...store.bestSignal, interval: "1m" };
        applyBarConfig(c);
        return c;
      })()
    : loadSignalBase();

  log(`1m config optimize · ${days}d · ${symbols.length} symbols · quick=${quick}`);

  if (!store.trained) {
    if (skipTrain && installCached1mModels()) {
      log("Using cached 1m models from interval compare");
      store.trained = true;
    } else {
      const collectBot = normalizeLiveConfig({
        ...loadLiveBase(),
        aiSfpRegimeEnabled: false,
        aiSfpRegimeFundingOiGbmEnabled: false,
        aiPullbackSignalEnabled: false,
        aiPullbackSignalFundingOiGbmEnabled: false,
        aiEarlyExitEnabled: false,
        aiExitLevelsEnabled: false,
      });
      log("\n=== COLLECT trades for 1m training ===");
      const { result } = await runPaperBotBacktest({
        symbols,
        signalCfg: signalAnchor,
        botConfig: collectBot,
        days,
        fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
        restGapMs: 0,
        saveLastResult: true,
        getFundingOiAt,
        runMeta: { optimize: "1m-config-10d", label: "collect_train" },
      });
      store.collect = summarize(result);
      const trades = result.closedTrades ?? [];
      await trainAllModels({ trades, botConfig: botAnchor, getFundingOiAt });
      store.trained = true;
      writeJsonFile(OUT_FILE(), store);
    }
  } else {
    installCached1mModels();
  }

  if (!store.baseline) {
    log("\n=== BASELINE (1m + trained AI) ===");
    const row = await runBacktest({
      label: "baseline",
      botConfig: botAnchor,
      signalCfg: signalAnchor,
      days,
      symbols,
      fetchers,
      getFundingOiAt,
    });
    store.baseline = row;
    store.best = row;
    store.bestBot = { ...botAnchor };
    store.bestSignal = { ...signalAnchor };
    store.runs.push(row);
    writeJsonFile(OUT_FILE(), store);
    log(`→ $${row.pnl} · ${row.trades} tr`);
  }

  for (const phase of phases(quick)) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip ===`);
      botAnchor = normalizeLiveConfig({ ...store.bestBot });
      signalAnchor = { ...store.bestSignal, interval: "1m" };
      applyBarConfig(signalAnchor);
      continue;
    }

    log(`\n=== PHASE ${phase.name} (${(phase.sweeps ?? phase.signalSweeps)?.length} variants) ===`);
    const phaseRows = [];
    const sweeps = phase.sweeps ?? phase.signalSweeps ?? [];

    for (let i = 0; i < sweeps.length; i++) {
      const patch = sweeps[i];
      const botConfig = normalizeLiveConfig({ ...botAnchor, ...patch });
      let signalCfg = { ...signalAnchor, interval: "1m" };
      if (phase.signalSweeps) {
        signalCfg = { ...signalCfg, ...patch };
        applyBarConfig(signalCfg);
      }
      if (patch.takeProfitPct != null && botConfig.takeProfitMinPct > patch.takeProfitPct) {
        botConfig.takeProfitMinPct = patch.takeProfitPct;
      }
      if (patch.aiEarlyExitHardThreshold != null && botConfig.aiEarlyExitSoftThreshold < patch.aiEarlyExitHardThreshold + 0.04) {
        botConfig.aiEarlyExitSoftThreshold = patch.aiEarlyExitHardThreshold + 0.04;
      }

      const label = `${phase.name}_${i}`;
      const row = await runBacktest({
        label,
        botConfig,
        signalCfg,
        days,
        symbols,
        fetchers,
        getFundingOiAt,
      });
      row.patch = patch;
      row.phase = phase.name;
      phaseRows.push(row);
      store.runs.push(row);
      log(`→ $${row.pnl} · ${row.trades} tr · WR ${row.winRate}%`);
    }

    const phaseBest = pickBest(phaseRows);
    if (phase.signalSweeps) {
      signalAnchor = { ...signalAnchor, ...phaseBest.patch, interval: "1m" };
      applyBarConfig(signalAnchor);
    } else {
      botAnchor = normalizeLiveConfig({ ...botAnchor, ...phaseBest.patch });
    }
    store.bestBot = { ...botAnchor };
    store.bestSignal = { ...signalAnchor };
    if (!store.best || phaseBest.pnl >= store.best.pnl) store.best = { ...phaseBest, phase: phase.name };
    store.phasesDone.push(phase.name);
    writeJsonFile(OUT_FILE(), store);
    log(`Phase best: $${phaseBest.pnl} (${phaseBest.label})`);
  }

  const finalRow = await runBacktest({
    label: "final_best",
    botConfig: normalizeLiveConfig({ ...store.bestBot, drawdownStopEnabled: true, drawdownStopPct: 3 }),
    signalCfg: { ...store.bestSignal, interval: "1m" },
    days,
    symbols,
    fetchers,
    getFundingOiAt,
  });

  store.final = finalRow;
  store.best = finalRow.pnl >= (store.best?.pnl ?? -Infinity) ? finalRow : store.best;
  store.updatedAt = new Date().toISOString();
  writeJsonFile(OUT_FILE(), store);

  log("\n=== RESULT ===");
  log(`Baseline: $${store.baseline.pnl}`);
  log(`Best: $${store.best.pnl} · ${store.best.trades} tr · WR ${store.best.winRate}%`);
  log(`Final (drawdown ON): $${finalRow.pnl}`);

  if (apply) {
    applyLocalDefaults(store.bestBot, store.bestSignal);
  }

  console.log(
    JSON.stringify(
      {
        baseline: store.baseline,
        best: store.best,
        bestBot: store.bestBot,
        bestSignal: store.bestSignal,
        final: finalRow,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
