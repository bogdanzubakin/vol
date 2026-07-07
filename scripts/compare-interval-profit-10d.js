#!/usr/bin/env node
/**
 * 10d interval profitability compare — retrain all live AI models per timeframe.
 *
 *   node scripts/compare-interval-profit-10d.js --days 10
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const {
  trainFromTrades: trainSfpRegime,
  reloadModel: reloadSfpRegime,
  saveModel: saveSfpRegime,
  getModel: getSfpRegime,
  MODEL_FILE: SFP_MODEL_FILE,
  buildTrainingSamples: buildSfpSamples,
  FEATURE_NAMES: SFP_FEATURES,
  FEATURE_NAMES_WITH_FUNDING_OI: SFP_FEATURES_FOI,
} = require("../lib/sfp-regime-model");
const {
  trainFromTrades: trainPbSignal,
  reloadModel: reloadPbSignal,
  saveModel: savePbSignal,
  getModel: getPbSignal,
  MODEL_FILE: PB_MODEL_FILE,
  buildTrainingSamples: buildPbSamples,
  FEATURE_NAMES: PB_FEATURES,
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
  saveModel: saveExitLevels,
  getModel: getExitLevels,
} = require("../lib/ai-exit-levels-model");
const { onnxDir: sfpOnnxDir, clearOnnxSessionCache: clearSfpOnnx } = require("../lib/sfp-regime-onnx");
const { onnxDir: pbOnnxDir, clearOnnxSessionCache: clearPbOnnx } = require("../lib/pullback-signal-onnx");

const MIRROR = path.join(".cache", "railway-mirror");
const OUT_FILE = () => dataPath("interval-profit-10d-compare.json");
const MODEL_ROOT = () => path.join(".cache", "interval-10d-models");
const INTERVALS = ["1m", "5m", "15m"];

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  return { days: Math.max(1, Math.min(30, Math.round(days) || 10)) };
}

function parseIntervalMinutes(interval) {
  const m = /^(\d+)m$/.exec(interval);
  if (!m) throw new Error(`Unsupported interval: ${interval}`);
  return Number(m[1]);
}

function aggregateBars(bars, minutes) {
  const ms = minutes * 60 * 1000;
  const out = [];
  let bucket = null;
  for (const b of bars ?? []) {
    const bucketStart = Math.floor(b.openTime / ms) * ms;
    if (!bucket || bucket.openTime !== bucketStart) {
      if (bucket) out.push(bucket);
      bucket = {
        openTime: bucketStart,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: Number(b.volume) || 0,
        closeTime: bucketStart + ms - 1,
      };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume += Number(b.volume) || 0;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function sliceTail(bars, barCount) {
  if (!bars?.length) return null;
  return bars.length > barCount ? bars.slice(-barCount) : bars;
}

function createIntervalFetchers(interval) {
  const aggCache = new Map();
  function signalBars(sym, barCount) {
    const symbol = String(sym).toUpperCase();
    if (interval === "5m") {
      return sliceTail(readSymbolBars("signal", symbol), barCount);
    }
    const bars1m = readSymbolBars("mover", symbol);
    if (!bars1m?.length) return null;
    if (interval === "1m") return sliceTail(bars1m, barCount);
    const key = `${symbol}:15m`;
    if (!aggCache.has(key)) {
      aggCache.set(key, aggregateBars(bars1m, 15));
    }
    return sliceTail(aggCache.get(key), barCount);
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const cached = signalBars(sym, barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no ${interval} cache for ${sym}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      if (interval === "1m") return null;
      const symbol = String(sym).toUpperCase();
      const cached = sliceTail(readSymbolBars("mover", symbol), barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
}

function loadLiveConfig() {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {}).config || {};
  return normalizeLiveConfig({ enabled: true, ...raw });
}

function loadSignalConfig(interval) {
  const scannerRaw = readJsonFile(path.join(MIRROR, "scanner-config.json"), {});
  const cfg = {
    interval,
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
    interval,
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
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
}

function fetchBarsTradeWindow(symbol, openedAt, closedAt) {
  const bars = fetchBarsAll(symbol);
  if (!bars.length) return [];
  const from = openedAt - 120_000;
  const to = closedAt + 120_000;
  return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
}

function summarize(result) {
  const s = result.summary ?? {};
  const closed = result.closedTrades ?? [];
  const byKind = {};
  for (const k of ["sfp", "sfp_bear", "pullback", "pullback_bear"]) {
    const rows = closed.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    byKind[k] = {
      trades: rows.length,
      pnl: +rows.reduce((a, t) => a + (Number(t.pnl) || 0), 0).toFixed(2),
    };
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    winRate: s.closedCount
      ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
      : 0,
    sfpRegimeSkips: s.sfpRegimeSkips ?? 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    aiExits: s.aiExits ?? 0,
    byKind,
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
  saveLastResult = false,
}) {
  log(`\n=== ${label} ===`);
  let last = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol:
      signalCfg.interval !== "1m" ? fetchers.fetchKlines1mForSymbol : null,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult,
    getFundingOiAt,
    runMeta: { compare: "interval-profit", label, interval: signalCfg.interval },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      }
    },
  });
  const row = summarize(result);
  log(`→ $${row.pnl} · ${row.trades} tr · win ${row.winRate}% · ${row.elapsedSec}s`);
  return { label, closedTrades: result.closedTrades ?? [], ...row };
}

function intervalModelDir(interval) {
  const dir = path.join(MODEL_ROOT(), interval);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function installModelFile(src, destRel) {
  const dest = typeof destRel === "string" && destRel.includes("/")
    ? destRel
    : dataPath(destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function trainOnnx(samplesPath, outDir, opts) {
  const py = process.env.PYTHON || "python3";
  const script = path.join(__dirname, "train-pullback-signal-onnx.py");
  if (!fs.existsSync(script)) return { ok: false, error: "train script missing" };
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
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "python failed").trim() };
  }
  return { ok: true };
}

async function trainAllModels({
  interval,
  trades,
  botConfig,
  getFundingOiAt,
}) {
  const dir = intervalModelDir(interval);
  const tag = `interval:${interval}:10d`;
  const sfpTrades = trades.filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  const pbTrades = trades.filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  const earlyTrades = sfpTrades.filter((t) => !isAiEarlyExitReason(t.exitReason));

  log(`\n--- Train models @ ${interval} (SFP ${sfpTrades.length} · PB ${pbTrades.length}) ---`);

  if (sfpTrades.length < 20) {
    throw new Error(`${interval}: need >=20 SFP trades (got ${sfpTrades.length})`);
  }

  const sfpModel = await trainSfpRegime(sfpTrades, fetchBarsAll, {
    modelScope: "paper",
    source: tag,
    featureNames: SFP_FEATURES_FOI,
    getFundingOiAt,
    aiSfpRegimeFundingOiEnabled: true,
    aiRegimeBtcLookbackHours: botConfig.aiRegimeBtcLookbackHours ?? 24,
  });
  reloadSfpRegime("paper");
  const sfpPath = path.join(dir, "sfp-regime-funding.json");
  writeJsonFile(sfpPath, { ...getSfpRegime("paper"), scope: "paper" });

  const sfpSamplesPath = path.join(dir, "sfp-regime-samples.json");
  const sfpSamples = await buildSfpSamples(sfpTrades, fetchBarsAll, {
    featureNames: SFP_FEATURES_FOI,
    getFundingOiAt,
    aiSfpRegimeFundingOiEnabled: true,
    aiRegimeBtcLookbackHours: botConfig.aiRegimeBtcLookbackHours ?? 24,
  });
  writeJsonFile(sfpSamplesPath, {
    featureNames: SFP_FEATURES_FOI,
    samples: sfpSamples,
    interval,
    exportedAt: new Date().toISOString(),
  });
  const sfpOnnxOut = path.join(dir, "sfp-regime-onnx");
  fs.mkdirSync(sfpOnnxOut, { recursive: true });
  const sfpOnnxTrain = trainOnnx(sfpSamplesPath, sfpOnnxOut, {
    featureCount: SFP_FEATURES_FOI.length,
    prefix: "sfp-regime",
    bullKind: "sfp",
    bearKind: "sfp_bear",
  });
  let sfpUseGbm = false;
  if (sfpOnnxTrain.ok && fs.existsSync(path.join(sfpOnnxOut, "sfp-regime-bull.gbm.json"))) {
    const onnxModel = {
      ...sfpModel,
      backend: "onnx",
      featureNames: SFP_FEATURES_FOI,
      source: `${tag}:gbm`,
      trainedAt: Date.now(),
    };
    writeJsonFile(path.join(dir, "sfp-regime-onnx.json"), onnxModel);
    installModelFile(path.join(dir, "sfp-regime-onnx.json"), SFP_MODEL_FILE("paper"));
    fs.mkdirSync(sfpOnnxDir("paper"), { recursive: true });
    for (const name of fs.readdirSync(sfpOnnxOut)) {
      if (fs.statSync(path.join(sfpOnnxOut, name)).isFile()) {
        fs.copyFileSync(path.join(sfpOnnxOut, name), path.join(sfpOnnxDir("paper"), name));
      }
    }
    reloadSfpRegime("paper");
    clearSfpOnnx();
    sfpUseGbm = true;
  } else {
    installModelFile(sfpPath, SFP_MODEL_FILE("paper"));
    reloadSfpRegime("paper");
  }

  if (earlyTrades.length < 20) {
    throw new Error(`${interval}: need >=20 SFP trades for early exit (got ${earlyTrades.length})`);
  }
  await trainEarlyExit(earlyTrades, fetchBarsTradeWindow, {
    modelScope: "paper",
    source: tag,
  });
  reloadEarlyExit("paper");
  const earlySt = getEarlyExitStatus("paper");
  installModelFile(dataPath("early-exit-sfp.json"), path.join(dir, "early-exit-sfp.json"));

  let pbUseGbm = false;
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
    const pbPath = path.join(dir, "pullback-signal-funding.json");
    writeJsonFile(pbPath, { ...getPbSignal("paper"), scope: "paper" });

    const pbSamplesPath = path.join(dir, "pullback-signal-samples.json");
    const pbSamples = await buildPbSamples(pbTrades, fetchBarsAll, {
      featureNames: PB_FEATURES_FOI,
      getFundingOiAt,
      aiPullbackSignalFundingOiEnabled: true,
      aiPullbackSignalBtcLookbackHours: botConfig.aiPullbackSignalBtcLookbackHours ?? 12,
    });
    writeJsonFile(pbSamplesPath, {
      featureNames: PB_FEATURES_FOI,
      samples: pbSamples,
      interval,
      exportedAt: new Date().toISOString(),
    });
    const pbOnnxOut = path.join(dir, "pullback-signal-onnx");
    fs.mkdirSync(pbOnnxOut, { recursive: true });
    const pbOnnxTrain = trainOnnx(pbSamplesPath, pbOnnxOut, {
      featureCount: PB_FEATURES_FOI.length,
      prefix: "pullback-signal",
      bullKind: "pullback",
      bearKind: "pullback_bear",
    });
    if (pbOnnxTrain.ok && fs.existsSync(path.join(pbOnnxOut, "pullback-signal-bull.gbm.json"))) {
      const onnxModel = {
        ...pbModel,
        backend: "onnx",
        featureNames: PB_FEATURES_FOI,
        source: `${tag}:gbm`,
        trainedAt: Date.now(),
      };
      writeJsonFile(path.join(dir, "pullback-signal-onnx.json"), onnxModel);
      installModelFile(path.join(dir, "pullback-signal-onnx.json"), PB_MODEL_FILE("paper"));
      fs.mkdirSync(pbOnnxDir("paper"), { recursive: true });
      for (const name of fs.readdirSync(pbOnnxOut)) {
        if (fs.statSync(path.join(pbOnnxOut, name)).isFile()) {
          fs.copyFileSync(path.join(pbOnnxOut, name), path.join(pbOnnxDir("paper"), name));
        }
      }
      reloadPbSignal("paper");
      clearPbOnnx();
      pbUseGbm = true;
    } else {
      installModelFile(pbPath, PB_MODEL_FILE("paper"));
      reloadPbSignal("paper");
    }
  } else {
    log(`  skip PB signal train: ${pbTrades.length} trades`);
  }

  await trainExitLevels(sfpTrades, fetchBarsTradeWindow, {
    botConfig,
    scope: "paper",
    source: tag,
  });
  reloadExitLevels("paper");
  const exitPath = path.join(dir, "ai-exit-levels.json");
  writeJsonFile(exitPath, { ...getExitLevels("paper"), scope: "paper" });
  installModelFile(exitPath, modelFileFor("ai-exit-levels", "paper"));
  reloadExitLevels("paper");

  return {
    sfpTrades: sfpTrades.length,
    pbTrades: pbTrades.length,
    sfpUseGbm,
    pbUseGbm,
    sfpOnnxTrain,
    earlyExit: {
      hard: earlySt.hardThreshold,
      soft: earlySt.softThreshold,
    },
    modelDir: dir,
  };
}

function evalBotConfig(liveConfig, trainMeta) {
  return normalizeLiveConfig({
    ...liveConfig,
    aiSfpRegimeEnabled: true,
    aiSfpRegimeFundingOiGbmEnabled: trainMeta.sfpUseGbm,
    aiSfpRegimeFundingOiEnabled: !trainMeta.sfpUseGbm,
    aiPullbackSignalEnabled: true,
    aiPullbackSignalFundingOiGbmEnabled: trainMeta.pbUseGbm,
    aiPullbackSignalFundingOiEnabled: !trainMeta.pbUseGbm,
    aiEarlyExitEnabled: true,
    aiExitLevelsEnabled: true,
  });
}

async function runInterval({
  interval,
  days,
  symbols,
  liveConfig,
  getFundingOiAt,
  store,
}) {
  const existing = store.intervals?.[interval];
  if (existing?.eval?.pnl != null) {
    log(`[skip] ${interval} cached $${existing.eval.pnl}`);
    return existing;
  }

  const signalCfg = loadSignalConfig(interval);
  const fetchers = createIntervalFetchers(interval);
  const collectBot = normalizeLiveConfig({
    ...liveConfig,
    aiSfpRegimeEnabled: false,
    aiSfpRegimeFundingOiGbmEnabled: false,
    aiSfpRegimeFundingOiEnabled: false,
    aiPullbackSignalEnabled: false,
    aiPullbackSignalFundingOiGbmEnabled: false,
    aiPullbackSignalFundingOiEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiEarlyExitEnabled: false,
    aiExitLevelsEnabled: false,
    smartExitLevelsEnabled: true,
  });

  const collect = await runBacktest({
    label: `${interval}_collect`,
    botConfig: collectBot,
    signalCfg,
    days,
    symbols,
    fetchers,
    getFundingOiAt,
    saveLastResult: true,
  });

  const trainMeta = await trainAllModels({
    interval,
    trades: collect.closedTrades,
    botConfig: liveConfig,
    getFundingOiAt,
  });

  const evalBot = evalBotConfig(liveConfig, trainMeta);
  const evalRow = await runBacktest({
    label: `${interval}_eval`,
    botConfig: evalBot,
    signalCfg,
    days,
    symbols,
    fetchers,
    getFundingOiAt,
  });

  const row = {
    interval,
    signalBarMinutes: parseIntervalMinutes(interval),
    collect: {
      pnl: collect.pnl,
      trades: collect.trades,
      sfpTrades:
        (collect.byKind.sfp?.trades ?? 0) + (collect.byKind.sfp_bear?.trades ?? 0),
      pbTrades:
        (collect.byKind.pullback?.trades ?? 0) + (collect.byKind.pullback_bear?.trades ?? 0),
    },
    training: trainMeta,
    eval: {
      pnl: evalRow.pnl,
      trades: evalRow.trades,
      winRate: evalRow.winRate,
      sfpRegimeSkips: evalRow.sfpRegimeSkips,
      pbSignalSkips: evalRow.pbSignalSkips,
      aiExits: evalRow.aiExits,
      byKind: evalRow.byKind,
      elapsedSec: evalRow.elapsedSec,
    },
    deltaVsCollect: +(evalRow.pnl - collect.pnl).toFixed(2),
  };

  store.intervals = store.intervals || {};
  store.intervals[interval] = row;
  writeJsonFile(OUT_FILE(), store);
  return row;
}

async function main() {
  const { days } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }
  const liveConfig = loadLiveConfig();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);

  let store = readJsonFile(OUT_FILE(), {
    days,
    symbolCount: symbols.length,
    intervals: {},
    ranked: [],
    winner: null,
  });
  store.days = days;
  store.symbolCount = symbols.length;
  store.liveInterval = readJsonFile(path.join(MIRROR, "scanner-config.json"), {}).interval ?? "5m";

  log(`Interval profit compare · ${days}d · ${symbols.length} symbols · train AI per interval`);
  log(`Live interval: ${store.liveInterval}`);

  const results = [];
  for (const interval of INTERVALS) {
    const row = await runInterval({
      interval,
      days,
      symbols,
      liveConfig,
      getFundingOiAt,
      store,
    });
    results.push(row);
  }

  const ranked = [...results].sort((a, b) => (b.eval?.pnl ?? 0) - (a.eval?.pnl ?? 0));
  store.ranked = ranked.map((r) => ({
    interval: r.interval,
    pnl: r.eval.pnl,
    trades: r.eval.trades,
    winRate: r.eval.winRate,
    sfpGbm: r.training.sfpUseGbm,
    pbGbm: r.training.pbUseGbm,
  }));
  store.winner = ranked[0]
    ? {
        interval: ranked[0].interval,
        pnl: ranked[0].eval.pnl,
        vsLive:
          store.liveInterval === ranked[0].interval
            ? 0
            : +(ranked[0].eval.pnl - (store.intervals[store.liveInterval]?.eval?.pnl ?? 0)).toFixed(2),
      }
    : null;
  store.updatedAt = new Date().toISOString();
  writeJsonFile(OUT_FILE(), store);

  log("\n=== INTERVAL RANKING (10d · retrained AI) ===");
  for (const r of ranked) {
    log(
      `${r.interval}: $${r.eval.pnl} · ${r.eval.trades} tr · win ${r.eval.winRate}% · SFP GBM ${r.training.sfpUseGbm} · PB GBM ${r.training.pbUseGbm}`
    );
  }
  if (store.winner) {
    log(`\nWinner: ${store.winner.interval} → $${store.winner.pnl}`);
  }
  log(`Results: ${OUT_FILE()}`);
  console.log(JSON.stringify({ ranked: store.ranked, winner: store.winner }, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
