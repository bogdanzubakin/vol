#!/usr/bin/env node
/**
 * Tune SFP AI early-exit: compare model sources (train data / 30d local / Railway)
 * and sweep runtime thresholds on 30d full live-stack backtest.
 *
 *   node scripts/tune-sfp-early-exit-30d.js --days 30
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const {
  runPaperBotBacktest,
  loadLastBacktestResult,
} = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const {
  trainFromTrades,
  reloadModel: reloadEarlyExit,
  getModelStatus,
  isAiEarlyExitReason,
} = require("../lib/early-exit-model");
const { collectAiTrainingTrades } = require("../lib/ai-training-trades");
const { onnxDir: pbOnnxDir } = require("../lib/pullback-signal-onnx");
const { onnxDir: sfpOnnxDir } = require("../lib/sfp-regime-onnx");

const MIRROR = path.join(".cache", "railway-mirror");
const OUT_FILE = () => dataPath("sfp-early-exit-30d-tune.json");
const MODEL_CACHE = (name) => path.join(".cache", `early-exit-tuned-${name}.json`);

const HARD_SWEEP = [0.68, 0.72, 0.76, 0.8, 0.84];
const SOFT_SWEEP = [0.82, 0.86, 0.88, 0.9, 0.92];
const MINBARS_SWEEP = [6, 9, 12, 15];

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

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyOnnxDir(fromScope, toScope, onnxDirFn) {
  const src = onnxDirFn(fromScope);
  const dest = onnxDirFn(toScope);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    if (fs.statSync(srcPath).isFile()) fs.copyFileSync(srcPath, path.join(dest, name));
  }
}

function installLiveStack() {
  const pairs = [
    ["sfp-regime-model-live.json", modelFileFor("sfp-regime-model", "paper")],
    ["pullback-signal-model-live.json", modelFileFor("pullback-signal-model", "paper")],
    ["ai-exit-levels-live.json", modelFileFor("ai-exit-levels", "paper")],
  ];
  for (const [srcName, dest] of pairs) {
    copyFile(path.join(MIRROR, srcName), dest);
  }
  copyOnnxDir("live", "paper", pbOnnxDir);
  copyOnnxDir("live", "paper", sfpOnnxDir);
  reloadSfp("paper");
  reloadPbSignal("paper");
  reloadExitLevels("paper");
}

function installEarlyExitModel(srcPath) {
  const dest = dataPath("early-exit-sfp.json");
  if (!copyFile(srcPath, dest)) throw new Error(`Missing early-exit model: ${srcPath}`);
  reloadEarlyExit("paper");
  return getModelStatus("paper");
}

function loadLiveConfig() {
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
      const cached = readCached(sym, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${sym}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const cached = readCached(sym, "mover", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${sym}`);
    },
  };
}

function fetchBarsForTraining(symbol, openedAt, closedAt) {
  const sym = String(symbol).toUpperCase();
  const bars = readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
  if (!bars.length) return [];
  const from = openedAt - 120_000;
  const to = closedAt + 120_000;
  return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
}

function filterSfpTrades(trades) {
  return (trades ?? []).filter(
    (t) =>
      !isAiEarlyExitReason(t.exitReason) &&
      (t.signalKind === "sfp" || t.signalKind === "sfp_bear")
  );
}

function summarize(result) {
  const s = result.summary ?? {};
  const trades = result.closedTrades ?? [];
  let aiExits = 0;
  let aiExitPnl = 0;
  let sfpPnl = 0;
  for (const t of trades) {
    const pnl = Number(t.pnl) || 0;
    if (t.signalKind === "sfp" || t.signalKind === "sfp_bear") sfpPnl += pnl;
    if (!isAiEarlyExitReason(t.exitReason)) continue;
    aiExits++;
    aiExitPnl += pnl;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    sfpPnl: +sfpPnl.toFixed(2),
    trades: s.closedCount ?? 0,
    winRate: s.closedCount
      ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
      : 0,
    aiExits,
    aiExitPnl: +aiExitPnl.toFixed(2),
    elapsedSec: result.elapsedSec ?? 0,
  };
}

function modelMeta(status) {
  return {
    source: status.source,
    trainedAt: status.trainedAt,
    hardThreshold: status.hardThreshold,
    softThreshold: status.softThreshold,
    hardSamples: status.hardMetrics?.samples ?? status.metrics?.samples,
    hardAccuracy: status.hardMetrics?.accuracy ?? status.metrics?.accuracy,
    softSamples: status.softMetrics?.samples,
    softAccuracy: status.softMetrics?.accuracy,
  };
}

async function runEval({
  label,
  botConfig,
  signalCfg,
  days,
  symbols,
  getFundingOiAt,
  fetchers,
}) {
  let last = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: false,
    getFundingOiAt,
    runMeta: { tune: "sfp-early-exit", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 120 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      }
    },
  });
  const row = summarize(result);
  log(
    `→ ${label}: $${row.pnl} · SFP $${row.sfpPnl} · ${row.trades} tr · AI exits ${row.aiExits} ($${row.aiExitPnl})`
  );
  return row;
}

async function trainAndCache(trades, cacheName, sourceTag) {
  log(`\n=== TRAIN ${cacheName} (${trades.length} SFP trades) ===`);
  await trainFromTrades(trades, fetchBarsForTraining, {
    modelScope: "paper",
    source: sourceTag,
    minThreshold: 0.72,
    onProgress: (p) => {
      if (p?.message) log(p.message);
    },
  });
  reloadEarlyExit("paper");
  const st = getModelStatus("paper");
  const cachePath = MODEL_CACHE(cacheName);
  copyFile(dataPath("early-exit-sfp.json"), cachePath);
  log(
    `Saved ${cacheName} · hard ${st.hardThreshold} acc ${((st.hardMetrics?.accuracy ?? 0) * 100).toFixed(1)}% · soft ${st.softThreshold} acc ${((st.softMetrics?.accuracy ?? 0) * 100).toFixed(1)}%`
  );
  return { status: st, path: cachePath, meta: modelMeta(st) };
}

function exitBotPatch(baseBot, params) {
  return normalizeLiveConfig({
    ...baseBot,
    aiEarlyExitEnabled: true,
    aiEarlyExitHardThreshold: params.hard,
    aiEarlyExitSoftThreshold: params.soft,
    aiEarlyExitMinBars: params.minBars,
    aiEarlyExitBarCloseOnly: params.barCloseOnly,
  });
}

function validSoft(hard, soft) {
  return soft >= hard + 0.04;
}

async function greedySweep({
  modelKey,
  modelPath,
  modelInfo,
  baseBot,
  signalCfg,
  days,
  symbols,
  getFundingOiAt,
  fetchers,
  store,
  baselinePnl,
}) {
  installEarlyExitModel(modelPath);
  const trainedHard = modelInfo.hardThreshold ?? 0.76;
  const trainedSoft = modelInfo.softThreshold ?? 0.88;

  let best = {
    hard: trainedHard,
    soft: Math.max(trainedSoft, trainedHard + 0.04),
    minBars: baseBot.aiEarlyExitMinBars ?? 9,
    barCloseOnly: baseBot.aiEarlyExitBarCloseOnly !== false,
  };

  const runSweep = async (label, params) => {
    const fullLabel = `${modelKey}__${label}`;
    const cached = store.runs.find((r) => r.label === fullLabel);
    if (cached) {
      log(`[skip] ${fullLabel} $${cached.pnl}`);
      return cached;
    }
    const row = await runEval({
      label: fullLabel,
      botConfig: exitBotPatch(baseBot, params),
      signalCfg,
      days,
      symbols,
      getFundingOiAt,
      fetchers,
    });
    const out = {
      label: fullLabel,
      modelKey,
      modelSource: modelInfo.source,
      ...params,
      ...row,
      deltaVsBaseline: +(row.pnl - baselinePnl).toFixed(2),
    };
    store.runs.push(out);
    writeJsonFile(OUT_FILE(), store);
    return out;
  };

  const pickBest = (rows, key) => {
    const sorted = [...rows].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
    return sorted[0];
  };

  log(`\n--- Sweep ${modelKey} (hard ${trainedHard} soft ${trainedSoft}) ---`);

  const nativeRow = await runSweep("native", best);
  let bestPnl = nativeRow.pnl;

  const hardRows = [];
  for (const hard of HARD_SWEEP) {
    const soft = Math.max(best.soft, hard + 0.04);
    const r = await runSweep(`hard_${hard}`, { ...best, hard, soft });
    hardRows.push({ ...r, hard, soft });
    if (r.pnl > bestPnl) {
      bestPnl = r.pnl;
      best = { hard, soft, minBars: best.minBars, barCloseOnly: best.barCloseOnly };
    }
  }
  const hardWinner = pickBest(hardRows, "hard");
  if (hardWinner?.pnl >= bestPnl) {
    best.hard = hardWinner.hard;
    best.soft = hardWinner.soft;
    bestPnl = hardWinner.pnl;
  }

  const softRows = [];
  for (const soft of SOFT_SWEEP) {
    if (!validSoft(best.hard, soft)) continue;
    const r = await runSweep(`soft_${soft}`, { ...best, soft });
    softRows.push({ ...r, soft });
    if (r.pnl > bestPnl) {
      bestPnl = r.pnl;
      best.soft = soft;
    }
  }
  const softWinner = pickBest(softRows, "soft");
  if (softWinner?.pnl >= bestPnl) {
    best.soft = softWinner.soft;
    bestPnl = softWinner.pnl;
  }

  const minRows = [];
  for (const minBars of MINBARS_SWEEP) {
    const r = await runSweep(`minBars_${minBars}`, { ...best, minBars });
    minRows.push({ ...r, minBars });
    if (r.pnl > bestPnl) {
      bestPnl = r.pnl;
      best.minBars = minBars;
    }
  }
  const minWinner = pickBest(minRows, "minBars");
  if (minWinner?.pnl >= bestPnl) {
    best.minBars = minWinner.minBars;
    bestPnl = minWinner.pnl;
  }

  const barRows = [];
  for (const barCloseOnly of [true, false]) {
    const r = await runSweep(`barClose_${barCloseOnly}`, { ...best, barCloseOnly });
    barRows.push({ ...r, barCloseOnly });
    if (r.pnl > bestPnl) {
      bestPnl = r.pnl;
      best.barCloseOnly = barCloseOnly;
    }
  }
  const barWinner = pickBest(barRows, "barCloseOnly");
  if (barWinner?.pnl >= bestPnl) {
    best.barCloseOnly = barWinner.barCloseOnly;
    bestPnl = barWinner.pnl;
  }

  const finalRow = await runSweep("best", best);
  return {
    modelKey,
    modelInfo,
    bestParams: best,
    bestPnl: finalRow.pnl,
    bestSfpPnl: finalRow.sfpPnl,
    aiExits: finalRow.aiExits,
    deltaVsBaseline: finalRow.deltaVsBaseline,
  };
}

async function main() {
  const { days } = parseArgs(process.argv);
  installLiveStack();
  const baseBot = loadLiveConfig();
  const signalCfg = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);

  let store = readJsonFile(OUT_FILE(), {
    days,
    symbolCount: symbols.length,
    runs: [],
    models: {},
    recommendations: null,
  });
  store.days = days;
  store.symbolCount = symbols.length;

  log(`SFP early-exit tune · ${days}d · ${symbols.length} symbols · full live stack`);

  const baselineLabel = "baseline_no_early_exit";
  let baseline = store.runs.find((r) => r.label === baselineLabel);
  if (!baseline) {
    log("\n=== Baseline (early exit OFF) ===");
    const row = await runEval({
      label: baselineLabel,
      botConfig: { ...baseBot, aiEarlyExitEnabled: false },
      signalCfg,
      days,
      symbols,
      getFundingOiAt,
      fetchers,
    });
    baseline = { label: baselineLabel, ...row, deltaVsBaseline: 0 };
    store.runs.push(baseline);
    store.baselineSaved = true;
    writeJsonFile(OUT_FILE(), store);
    await runPaperBotBacktest({
      symbols,
      signalCfg,
      botConfig: { ...baseBot, aiEarlyExitEnabled: false },
      days,
      fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
      fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
      restGapMs: 0,
      saveLastResult: true,
      getFundingOiAt,
      runMeta: { tune: "sfp-early-exit", label: "baseline_save" },
    });
  } else {
    log(`[skip] baseline $${baseline.pnl}`);
  }
  const baselinePnl = baseline.pnl;

  const models = {};

  if (!store.models.railway) {
    const railwayPath = path.join(MIRROR, "early-exit-model-live.json");
    const st = installEarlyExitModel(railwayPath);
    copyFile(railwayPath, MODEL_CACHE("railway"));
    models.railway = {
      key: "railway",
      path: MODEL_CACHE("railway"),
      meta: modelMeta(st),
      trainTrades: null,
    };
    store.models.railway = models.railway;
    writeJsonFile(OUT_FILE(), store);
  } else {
    models.railway = store.models.railway;
  }

  if (!store.models.train_data) {
    const trainTrades = collectAiTrainingTrades(
      "backtest",
      "paper",
      { backtestTrades: loadLastBacktestResult()?.closedTrades, paperTrades: [] },
      filterSfpTrades
    );
    if (trainTrades.length < 20) {
      throw new Error(`Need train-data SFP trades (got ${trainTrades.length})`);
    }
    const trained = await trainAndCache(trainTrades, "train_data", "tune:train-bot-backtest");
    models.train_data = {
      key: "train_data",
      path: trained.path,
      meta: trained.meta,
      trainTrades: trainTrades.length,
    };
    store.models.train_data = models.train_data;
    writeJsonFile(OUT_FILE(), store);
  } else {
    models.train_data = store.models.train_data;
    log(`[skip] train_data model (${models.train_data.trainTrades} trades)`);
  }

  if (!store.models.local_30d) {
    if (!store.baselineSaved) {
      log("Saving baseline trades for local_30d training…");
      await runPaperBotBacktest({
        symbols,
        signalCfg,
        botConfig: { ...baseBot, aiEarlyExitEnabled: false },
        days,
        fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
        fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
        restGapMs: 0,
        saveLastResult: true,
        getFundingOiAt,
        runMeta: { tune: "sfp-early-exit", label: "baseline_save" },
      });
      store.baselineSaved = true;
      writeJsonFile(OUT_FILE(), store);
    }
    const localTrades = filterSfpTrades(loadLastBacktestResult()?.closedTrades);
    if (localTrades.length < 20) {
      throw new Error(`Need 30d local SFP trades (got ${localTrades.length})`);
    }
    const trained = await trainAndCache(localTrades, "local_30d", "tune:live-stack-30d");
    models.local_30d = {
      key: "local_30d",
      path: trained.path,
      meta: trained.meta,
      trainTrades: localTrades.length,
    };
    store.models.local_30d = models.local_30d;
    writeJsonFile(OUT_FILE(), store);
  } else {
    models.local_30d = store.models.local_30d;
    log(`[skip] local_30d model (${models.local_30d.trainTrades} trades)`);
  }

  log("\n=== Model comparison ===");
  for (const [key, m] of Object.entries(models)) {
    log(
      `${key}: trades ${m.trainTrades ?? "deployed"} · hard ${m.meta.hardThreshold} · soft ${m.meta.softThreshold} · hard acc ${((m.meta.hardAccuracy ?? 0) * 100).toFixed(1)}% (n=${m.meta.hardSamples ?? "—"})`
    );
  }

  const sweepResults = [];
  for (const key of ["railway", "train_data", "local_30d"]) {
    const m = models[key];
    const res = await greedySweep({
      modelKey: key,
      modelPath: m.path,
      modelInfo: m.meta,
      baseBot,
      signalCfg,
      days,
      symbols,
      getFundingOiAt,
      fetchers,
      store,
      baselinePnl,
    });
    sweepResults.push(res);
  }

  const ranked = [...sweepResults].sort((a, b) => (b.bestPnl ?? 0) - (a.bestPnl ?? 0));
  const winner = ranked[0];
  const liveCurrent = {
    model: "railway",
    hard: baseBot.aiEarlyExitHardThreshold,
    soft: baseBot.aiEarlyExitSoftThreshold,
    minBars: baseBot.aiEarlyExitMinBars,
    barCloseOnly: baseBot.aiEarlyExitBarCloseOnly,
    pnl: store.runs.find((r) => r.label === "railway__native")?.pnl ?? null,
  };

  store.recommendations = {
    baselinePnl,
    liveCurrent,
    ranked: ranked.map((r) => ({
      modelKey: r.modelKey,
      bestPnl: r.bestPnl,
      bestSfpPnl: r.bestSfpPnl,
      deltaVsBaseline: r.deltaVsBaseline,
      aiExits: r.aiExits,
      bestParams: r.bestParams,
      modelMeta: r.modelInfo,
    })),
    winner: {
      modelKey: winner.modelKey,
      ...winner.bestParams,
      pnl: winner.bestPnl,
      deltaVsBaseline: winner.deltaVsBaseline,
      deltaVsLiveNative:
        liveCurrent.pnl != null
          ? +(winner.bestPnl - liveCurrent.pnl).toFixed(2)
          : null,
    },
  };
  store.updatedAt = new Date().toISOString();
  writeJsonFile(OUT_FILE(), store);

  log("\n=== BEST EARLY EXIT CONFIG (30d live stack) ===");
  for (const r of ranked) {
    log(
      `${r.modelKey}: $${r.bestPnl} (Δ baseline $${r.deltaVsBaseline}) · hard ${r.bestParams.hard} soft ${r.bestParams.soft} minBars ${r.bestParams.minBars} barClose ${r.bestParams.barCloseOnly} · AI exits ${r.aiExits}`
    );
  }
  log(`\nWinner: ${winner.modelKey} → $${winner.bestPnl}`);
  log(`Recommended settings: ${JSON.stringify(winner.bestParams)}`);
  log(`Use model: ${models[winner.modelKey].path}`);
  log(`Results: ${OUT_FILE()}`);
  console.log(JSON.stringify(store.recommendations, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
