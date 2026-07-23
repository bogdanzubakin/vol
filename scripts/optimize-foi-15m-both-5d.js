#!/usr/bin/env node
/**
 * FOI-only on 15m: both long+short enabled.
 * 1) Train AI exit-levels on 30d FOI trades
 * 2) Coordinate-descent over FOI + exit settings on 5d (parallel workers)
 *
 *   node scripts/optimize-foi-15m-both-5d.js --reset
 *   node scripts/optimize-foi-15m-both-5d.js --concurrency 4
 *   node scripts/optimize-foi-15m-both-5d.js --worker-train
 *   node scripts/optimize-foi-15m-both-5d.js --worker-eval
 */
const { ensureMinHeapMb } = require("../lib/node-mem");

const mode = process.argv.includes("--worker-train")
  ? "train"
  : process.argv.includes("--worker-eval")
    ? "eval"
    : "main";
if (mode === "main") ensureMinHeapMb(12288);

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const {
  loadFundingOiCache,
  prefetchFundingOiCache,
} = require("../lib/funding-oi-cache");
const {
  trainFromTrades: trainExitLevels,
  reloadModel: reloadExitLevels,
  getModel: getExitLevels,
} = require("../lib/ai-exit-levels-model");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");

const INTERVAL = "15m";
const BATCH = 50;
const OUT_FILE = () => dataPath("foi-15m-both-5d-optimize.json");
const BEST_FILE = () => dataPath("foi-15m-both-5d-best.json");
const MODEL_DIR = () => path.join(dataPath(), "foi-15m-both-models");
const MODEL_FILE = () => path.join(MODEL_DIR(), "ai-exit-levels.json");

function log(msg) {
  console.error(String(msg));
}

function parseArgs(argv) {
  let trainDays = 30;
  let evalDays = 5;
  let reset = false;
  let maxSymbols = 0;
  let minTrades = 15;
  let concurrency = Math.max(2, Math.min(4, (os.cpus()?.length || 4) - 1));
  let prefetchFunding = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--train-days" && argv[i + 1]) trainDays = Number(argv[++i]);
    else if (argv[i] === "--eval-days" && argv[i + 1]) evalDays = Number(argv[++i]);
    else if (argv[i] === "--reset") reset = true;
    else if (argv[i] === "--max-symbols" && argv[i + 1]) maxSymbols = Number(argv[++i]);
    else if (argv[i] === "--min-trades" && argv[i + 1]) minTrades = Number(argv[++i]);
    else if (argv[i] === "--concurrency" && argv[i + 1]) concurrency = Number(argv[++i]);
    else if (argv[i] === "--skip-funding-prefetch") prefetchFunding = false;
  }
  return {
    trainDays: Math.max(5, Math.min(60, Math.round(trainDays) || 30)),
    evalDays: Math.max(1, Math.min(30, Math.round(evalDays) || 5)),
    reset,
    maxSymbols: Math.max(0, Math.round(maxSymbols) || 0),
    minTrades: Math.max(1, Math.round(minTrades) || 15),
    concurrency: Math.max(1, Math.min(8, Math.round(concurrency) || 4)),
    prefetchFunding,
  };
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

function bars1m(sym) {
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym);
}

function createFetchers() {
  const aggCache = new Map();
  function signalBars(sym, barCount) {
    const symbol = String(sym).toUpperCase();
    const raw = bars1m(symbol);
    if (!raw?.length) return null;
    const key = `${symbol}:15m`;
    if (!aggCache.has(key)) aggCache.set(key, aggregateBars(raw, 15));
    return sliceTail(aggCache.get(key), barCount);
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const cached = signalBars(sym, barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 15m cache for ${sym}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const cached = sliceTail(bars1m(sym), barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${sym}`);
    },
  };
}

function loadBaseBot() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    // FOI-only · both sides
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    foiMinAbsFundingRate: 0.00012,
    foiMinAbsFundingRateBull: null,
    foiMinAbsFundingRateBear: null,
    foiRequireOiConfirm: true,
    foiConfirmSfp: true,
    foiConfirmPullback: true,
    armed: false,
    drawdownStopEnabled: false,
    aiRegimeBtcFastLookbackHours: local.aiRegimeBtcFastLookbackHours ?? 2,
    aiPullbackSignalBtcFastLookbackHours:
      local.aiPullbackSignalBtcFastLookbackHours ?? 2,
  });
}

function loadSignalConfig() {
  const scanner = readJsonFile(dataPath("scanner-config.json"), {}) ?? {};
  const detection = readJsonFile(dataPath("bear-detection-best-10d.json"), null);
  const cfg = {
    interval: INTERVAL,
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
    ...scanner,
    ...(detection?.patch ?? {}),
    interval: INTERVAL,
  };
  applyBarConfig(cfg);
  return cfg;
}

function cachedSymbolList(maxSymbols) {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  if (!fs.existsSync(root)) return [];
  let list = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((s) => (bars1m(s)?.length ?? 0) >= 200)
    .sort();
  if (maxSymbols > 0) list = list.slice(0, maxSymbols);
  return list;
}

function fetchBarsTradeWindow(symbol, openedAt, closedAt) {
  const bars = bars1m(symbol) ?? [];
  if (!bars.length) return [];
  return bars.filter(
    (b) => b.closeTime >= openedAt - 120_000 && b.closeTime <= closedAt + 120_000
  );
}

function reloadModels() {
  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }
}

function installModel(scope = "paper") {
  if (!fs.existsSync(MODEL_FILE())) {
    throw new Error(`Missing trained model: ${MODEL_FILE()}`);
  }
  const dest = modelFileFor("ai-exit-levels", scope);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(MODEL_FILE(), dest);
  reloadExitLevels(scope);
}

function foiCollectBot(baseBot) {
  return normalizeLiveConfig({
    ...baseBot,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    aiSfpRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    aiEarlyExitEnabled: false,
    aiExitLevelsEnabled: false,
    smartExitLevelsEnabled: true,
  });
}

function foiEvalBot(baseBot) {
  return normalizeLiveConfig({
    ...baseBot,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    aiSfpRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    aiEarlyExitEnabled: false,
    aiExitLevelsEnabled: true,
    smartExitLevelsEnabled: true,
  });
}

function summarize(trades) {
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const bySignal = {};
  for (const k of ["foi", "foi_bear"]) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    bySignal[k] = {
      trades: rows.length,
      pnl: +rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2),
      winRate: +(
        (100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) /
        rows.length
      ).toFixed(1),
    };
  }
  return {
    trades: trades.length,
    pnl: +pnl.toFixed(2),
    winRate: trades.length
      ? +(
          (100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) /
          trades.length
        ).toFixed(1)
      : 0,
    bySignal,
    foiPnl: bySignal.foi?.pnl ?? 0,
    foiBearPnl: bySignal.foi_bear?.pnl ?? 0,
  };
}

async function runFoiBacktest({
  label,
  botConfig,
  signalCfg,
  days,
  symbols,
  getFundingOiAt,
}) {
  const fetchers = createFetchers();
  const trades = [];
  const batchConcurrency = Math.max(2, Math.min(4, Math.ceil(symbols.length / BATCH)));
  const batches = [];
  for (let offset = 0; offset < symbols.length; offset += BATCH) {
    batches.push(symbols.slice(offset, offset + BATCH));
  }
  for (let i = 0; i < batches.length; i += batchConcurrency) {
    const wave = batches.slice(i, i + batchConcurrency);
    const results = await Promise.all(
      wave.map((batch) =>
        runPaperBotBacktest({
          symbols: batch,
          signalCfg,
          botConfig,
          days,
          fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
          fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
          getFundingOiAt,
          restGapMs: 0,
          saveLastResult: false,
          saveKlineCache: false,
          modelScope: "paper",
          runMeta: { optimize: "foi-15m-both-5d", label },
        })
      )
    );
    for (const { result } of results) {
      for (const t of result.closedTrades ?? []) {
        if (t.signalKind === "foi" || t.signalKind === "foi_bear") trades.push(t);
      }
      result.closedTrades = null;
    }
    if (global.gc) global.gc();
  }
  return { label, closedTrades: trades, ...summarize(trades) };
}

/** Full settings search — both FOI sides always locked ON. */
function phases() {
  return [
    {
      name: "funding_threshold",
      sweeps: [
        {
          foiMinAbsFundingRate: 0.00005,
          foiMinAbsFundingRateBull: null,
          foiMinAbsFundingRateBear: null,
        },
        {
          foiMinAbsFundingRate: 0.00008,
          foiMinAbsFundingRateBull: null,
          foiMinAbsFundingRateBear: null,
        },
        {
          foiMinAbsFundingRate: 0.00012,
          foiMinAbsFundingRateBull: null,
          foiMinAbsFundingRateBear: null,
        },
        {
          foiMinAbsFundingRate: 0.00018,
          foiMinAbsFundingRateBull: null,
          foiMinAbsFundingRateBear: null,
        },
        {
          foiMinAbsFundingRate: 0.00025,
          foiMinAbsFundingRateBull: null,
          foiMinAbsFundingRateBear: null,
        },
        {
          foiMinAbsFundingRate: 0.00035,
          foiMinAbsFundingRateBull: null,
          foiMinAbsFundingRateBear: null,
        },
        {
          foiMinAbsFundingRate: 0.00012,
          foiMinAbsFundingRateBull: 0.00025,
          foiMinAbsFundingRateBear: 0.00008,
        },
        {
          foiMinAbsFundingRate: 0.00012,
          foiMinAbsFundingRateBull: 0.00018,
          foiMinAbsFundingRateBear: 0.0001,
        },
        {
          foiMinAbsFundingRate: 0.00018,
          foiMinAbsFundingRateBull: 0.00025,
          foiMinAbsFundingRateBear: 0.00012,
        },
      ],
    },
    {
      name: "oi_confirm",
      sweeps: [{ foiRequireOiConfirm: true }, { foiRequireOiConfirm: false }],
    },
    {
      name: "price_confirm",
      sweeps: [
        { foiConfirmSfp: true, foiConfirmPullback: true },
        { foiConfirmSfp: true, foiConfirmPullback: false },
        { foiConfirmSfp: false, foiConfirmPullback: true },
      ],
    },
    {
      name: "exit_tp",
      sweeps: [
        {},
        { takeProfitPct: 1.5, sfpTakeProfitPct: 1.5, takeProfitMinPct: 0.8 },
        { takeProfitPct: 2, sfpTakeProfitPct: 2, takeProfitMinPct: 0.8 },
        { takeProfitPct: 2.5, sfpTakeProfitPct: 2.5, takeProfitMinPct: 1 },
        { takeProfitPct: 3, sfpTakeProfitPct: 3, takeProfitMinPct: 1 },
        { takeProfitPct: 3.5, sfpTakeProfitPct: 3.5 },
        { takeProfitPct: 4, sfpTakeProfitPct: 4 },
        { takeProfitPct: 5, sfpTakeProfitPct: 5 },
        {
          takeProfitPct: 2,
          sfpTakeProfitPct: 2,
          takeProfitMinPct: 0.8,
          aiExitLevelsEnabled: false,
        },
        {
          takeProfitPct: 3,
          sfpTakeProfitPct: 3,
          aiExitLevelsEnabled: false,
        },
        {
          takeProfitPct: 3,
          aiExitLevelsEnabled: true,
          aiExitLevelsTpScale: 0.9,
          aiExitLevelsSlScale: 1.1,
        },
        {
          takeProfitPct: 3,
          aiExitLevelsEnabled: true,
          aiExitLevelsTpScale: 1.2,
          aiExitLevelsSlScale: 1.3,
        },
        {
          takeProfitPctBull: 2.5,
          takeProfitPctBear: 3.5,
          aiExitLevelsEnabled: true,
        },
      ],
    },
    {
      name: "early_abort",
      sweeps: [
        {},
        { earlyAbortEnabled: false },
        { earlyAbortEnabledBear: false, earlyAbortEnabledBull: false },
        { earlyAbortEnabledBear: false },
        { earlyAbortEnabledBull: false },
        { earlyAbortMaxAdversePct: 2.0, earlyAbortBars: 12 },
        { earlyAbortMaxAdversePct: 2.5, earlyAbortBars: 20 },
        { earlyAbortMaxAdversePctBear: 2.5, earlyAbortBarsBear: 20 },
        { earlyAbortMaxAdversePctBear: 3.0, earlyAbortBarsBear: 30 },
        {
          earlyAbortMaxAdversePctBull: 2.5,
          earlyAbortMaxAdversePctBear: 3.0,
          earlyAbortBarsBull: 20,
          earlyAbortBarsBear: 30,
        },
        {
          earlyAbortMinProgressPct: 0.25,
          earlyAbortMaxAdversePct: 2.5,
        },
      ],
    },
    {
      name: "stop_geometry",
      sweeps: [
        {},
        { stopLossBelowCorridorPct: 1.5 },
        { stopLossBelowCorridorPct: 2 },
        { stopLossBelowCorridorPct: 2.5 },
        { stopLossBelowCorridorPct: 3 },
        { minSmartStopDistancePct: 0.6 },
        { minSmartStopDistancePct: 1.0 },
        { minSmartStopDistancePct: 1.5 },
        {
          stopLossBelowCorridorPct: 2.5,
          minSmartStopDistancePct: 1.0,
          smartExitLevelsEnabled: true,
        },
        {
          smartExitLevelsEnabled: false,
          stopLossFallbackPnlPct: 2,
        },
      ],
    },
  ];
}

function mergeBot(base, patch) {
  return normalizeLiveConfig({
    ...base,
    ...patch,
    enabled: true,
    armed: false,
    drawdownStopEnabled: false,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    // lock both FOI sides
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
  });
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch).map(([k, v]) => `${k}=${v}`);
  return `${phase}_${idx}_${parts.join("_") || "inherit"}`.slice(0, 140);
}

function pickBest(rows, minTrades) {
  const eligible = rows.filter((r) => (r.trades ?? 0) >= minTrades);
  const pool = eligible.length ? eligible : rows;
  return [...pool].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.trades - a.trades;
  })[0];
}

function foiPatchDiff(base, tuned) {
  const keys = [
    "tradeFoiSignals",
    "tradeBearishFoiSignals",
    "foiMinAbsFundingRate",
    "foiMinAbsFundingRateBull",
    "foiMinAbsFundingRateBear",
    "foiRequireOiConfirm",
    "foiConfirmSfp",
    "foiConfirmPullback",
    "takeProfitPct",
    "sfpTakeProfitPct",
    "takeProfitMinPct",
    "takeProfitPctBull",
    "takeProfitPctBear",
    "aiExitLevelsEnabled",
    "aiExitLevelsTpScale",
    "aiExitLevelsSlScale",
    "earlyAbortEnabled",
    "earlyAbortEnabledBull",
    "earlyAbortEnabledBear",
    "earlyAbortBars",
    "earlyAbortBarsBull",
    "earlyAbortBarsBear",
    "earlyAbortMaxAdversePct",
    "earlyAbortMaxAdversePctBull",
    "earlyAbortMaxAdversePctBear",
    "earlyAbortMinProgressPct",
    "stopLossBelowCorridorPct",
    "minSmartStopDistancePct",
    "smartExitLevelsEnabled",
    "stopLossFallbackPnlPct",
  ];
  const patch = {};
  for (const k of keys) {
    if (JSON.stringify(base[k] ?? null) !== JSON.stringify(tuned[k] ?? null)) {
      patch[k] = tuned[k];
    }
  }
  return patch;
}

function sendAndExit(payload) {
  try {
    if (typeof process.send === "function") {
      process.send(payload, () => process.exit(payload.ok ? 0 : 1));
      setTimeout(() => process.exit(payload.ok ? 0 : 1), 30_000).unref();
      return;
    }
  } catch (e) {
    console.error(e.stack || e);
  }
  process.exit(payload.ok ? 0 : 1);
}

function runJobsParallel(jobs, concurrency, workerFlag) {
  const timeoutMs =
    workerFlag === "--worker-train" ? 6 * 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const results = new Array(jobs.length);
    let next = 0;
    let active = 0;
    let failed = null;

    function launch() {
      if (failed) return;
      while (active < concurrency && next < jobs.length) {
        const idx = next++;
        const job = jobs[idx];
        active++;
        log(`  ▶ [${idx + 1}/${jobs.length}] ${job.label}`);
        const child = fork(__filename, [workerFlag], {
          env: {
            ...process.env,
            VOL_NODE_HEAP_ENSURED: "1",
            NODE_OPTIONS: `--max-old-space-size=6144`,
          },
          stdio: ["inherit", "inherit", "inherit", "ipc"],
        });
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          failed = new Error(`timeout: ${job.label}`);
          reject(failed);
        }, timeoutMs);

        child.on("message", (msg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          active--;
          if (!msg?.ok) {
            failed = new Error(msg?.error || `worker failed: ${job.label}`);
            reject(failed);
            return;
          }
          results[idx] = msg.result;
          const r = msg.result;
          const pnl = r.pnl ?? r.collect?.pnl;
          const trades = r.trades ?? r.collect?.trades;
          log(`  ✓ [${idx + 1}/${jobs.length}] $${pnl} · ${trades} tr · ${job.label}`);
          if (next >= jobs.length && active === 0) resolve(results);
          else launch();
        });
        child.on("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          active--;
          failed = new Error(`worker exit ${code}: ${job.label}`);
          reject(failed);
        });
        child.send(job);
      }
    }

    if (!jobs.length) resolve([]);
    else launch();
  });
}

async function trainWorker(job) {
  reloadModels();
  const { trainDays, symbols, baseBot } = job;
  const signalCfg = loadSignalConfig();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  const collect = await runFoiBacktest({
    label: `15m_train_collect_${trainDays}d`,
    botConfig: foiCollectBot(baseBot),
    signalCfg,
    days: trainDays,
    symbols,
    getFundingOiAt,
  });
  const model = await trainExitLevels(collect.closedTrades, fetchBarsTradeWindow, {
    botConfig: baseBot,
    scope: "paper",
    source: `foi-15m-both:${trainDays}d`,
    signalKinds: ["foi", "foi_bear"],
  });
  fs.mkdirSync(MODEL_DIR(), { recursive: true });
  writeJsonFile(MODEL_FILE(), {
    ...getExitLevels("paper"),
    ...model,
    scope: "paper",
    interval: INTERVAL,
    trainedAt: Date.now(),
    trainTrades: collect.trades,
    bySignal: collect.bySignal,
  });
  installModel("paper");
  return {
    interval: INTERVAL,
    trainDays,
    collect: {
      pnl: collect.pnl,
      trades: collect.trades,
      winRate: collect.winRate,
      bySignal: collect.bySignal,
    },
    modelFile: MODEL_FILE(),
  };
}

async function evalWorker(job) {
  reloadModels();
  installModel("paper");
  const botConfig = mergeBot(foiEvalBot(job.baseBot), job.patch || {});
  const signalCfg = loadSignalConfig();
  const { lookup: getFundingOiAt } = loadFundingOiCache(job.symbols);
  const row = await runFoiBacktest({
    label: job.label,
    botConfig,
    signalCfg,
    days: job.evalDays,
    symbols: job.symbols,
    getFundingOiAt,
  });
  const { closedTrades, ...summary } = row;
  summary.patch = job.patch || {};
  summary.interval = INTERVAL;
  return summary;
}

async function workerTrainMain() {
  process.on("message", async (job) => {
    try {
      sendAndExit({ ok: true, result: await trainWorker(job) });
    } catch (e) {
      sendAndExit({ ok: false, error: e.stack || e.message || String(e) });
    }
  });
}

async function workerEvalMain() {
  process.on("message", async (job) => {
    try {
      sendAndExit({ ok: true, result: await evalWorker(job) });
    } catch (e) {
      sendAndExit({ ok: false, error: e.stack || e.message || String(e) });
    }
  });
}

function applyLocalSwitch() {
  const scanner = readJsonFile(dataPath("scanner-config.json"), {}) ?? {};
  scanner.interval = INTERVAL;
  applyBarConfig(scanner);
  writeJsonFile(dataPath("scanner-config.json"), scanner);
  log(`Scanner interval → ${INTERVAL}`);

  for (const name of ["paper-bot-state.json", "live-bot-state.json"]) {
    const state = readJsonFile(dataPath(name), null);
    if (!state?.config) continue;
    state.config.tradeFoiSignals = true;
    state.config.tradeBearishFoiSignals = true;
    writeJsonFile(dataPath(name), state);
    log(`${name}: both FOI enabled`);
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const { trainDays, evalDays, reset, maxSymbols, minTrades, concurrency, prefetchFunding } =
    opts;

  applyLocalSwitch();

  const symbols = cachedSymbolList(maxSymbols);
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  reloadModels();
  if (prefetchFunding) {
    log(`Prefetch funding/OI · ${Math.max(trainDays, evalDays)}d · ${symbols.length} symbols…`);
    await prefetchFundingOiCache({
      symbols,
      days: Math.max(trainDays, evalDays) + 2,
      restGapMs: 60,
      onProgress: (p) => {
        if (p.error) log(`  funding fail ${p.symbol}: ${p.error}`);
        else if ((p.done + 1) % 50 === 0 || p.done + 1 >= symbols.length) {
          log(`  funding ${p.done + 1}/${p.total}`);
        }
      },
    });
  }

  const baseBot = loadBaseBot();
  let store = reset
    ? {
        interval: INTERVAL,
        bothFoi: true,
        trainDays,
        evalDays,
        symbolCount: symbols.length,
        runs: [],
        phasesDone: [],
        bestConfig: null,
        best: null,
        baseline: null,
        training: null,
      }
    : readJsonFile(OUT_FILE(), {
        interval: INTERVAL,
        bothFoi: true,
        trainDays,
        evalDays,
        symbolCount: symbols.length,
        runs: [],
        phasesDone: [],
        bestConfig: null,
        best: null,
        baseline: null,
        training: null,
      });

  if (reset) {
    try {
      fs.rmSync(MODEL_DIR(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  log(
    `FOI 15m BOTH · train ${trainDays}d · eval ${evalDays}d · ${symbols.length} symbols · concurrency=${concurrency}`
  );

  if (reset || !fs.existsSync(MODEL_FILE())) {
    log(`\n=== TRAIN AI exit-levels · ${trainDays}d · both FOI ===`);
    const [trainRow] = await runJobsParallel(
      [
        {
          label: "15m_train",
          trainDays,
          symbols,
          baseBot,
        },
      ],
      1,
      "--worker-train"
    );
    store.training = trainRow;
    writeJsonFile(OUT_FILE(), store);
  } else {
    log(`Train model exists — skip (${MODEL_FILE()})`);
    installModel("paper");
  }

  let anchor = store.bestConfig
    ? mergeBot(foiEvalBot(baseBot), store.bestConfig)
    : foiEvalBot(baseBot);
  const phaseList = phases();
  const baselineSnapshot = { ...baseBot };

  if (!store.baseline) {
    log("\n=== BASELINE (both FOI · AI exits on) ===");
    const [row] = await runJobsParallel(
      [
        {
          label: "15m_baseline",
          evalDays,
          symbols,
          baseBot,
          patch: {},
        },
      ],
      1,
      "--worker-eval"
    );
    store.baseline = row;
    store.runs.push(row);
    store.best = row;
    store.bestConfig = {};
    writeJsonFile(OUT_FILE(), store);
    log(`Baseline: $${row.pnl} · ${row.trades} tr · WR ${row.winRate}% · ${JSON.stringify(row.bySignal)}`);
  }

  for (const phase of phaseList) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip (done) ===`);
      anchor = mergeBot(foiEvalBot(baseBot), store.bestConfig);
      continue;
    }
    log(
      `\n=== PHASE ${phase.name} · ${phase.sweeps.length} variants · parallel ×${concurrency} ===`
    );
    const jobs = phase.sweeps.map((patch, i) => ({
      label: patchLabel(phase.name, patch, i),
      evalDays,
      symbols,
      baseBot: { ...anchor },
      patch,
    }));
    const phaseRows = await runJobsParallel(jobs, concurrency, "--worker-eval");
    for (const row of phaseRows) store.runs.push(row);
    const phaseBest = pickBest(phaseRows, minTrades);
    if (phaseBest?.patch && Object.keys(phaseBest.patch).length) {
      anchor = mergeBot(anchor, phaseBest.patch);
    }
    store.bestConfig = foiPatchDiff(baselineSnapshot, anchor);
    if (phaseBest && (!store.best || phaseBest.pnl >= store.best.pnl)) {
      store.best = { ...phaseBest, phase: phase.name };
    }
    store.phasesDone.push(phase.name);
    store.updatedAt = new Date().toISOString();
    writeJsonFile(OUT_FILE(), store);
    log(`Phase best: $${phaseBest?.pnl} · ${phaseBest?.label}`);
  }

  const globalBest = pickBest(store.runs, minTrades);
  const bestPatch = {
    ...foiPatchDiff(baselineSnapshot, store.bestConfig ? mergeBot(foiEvalBot(baseBot), store.bestConfig) : foiEvalBot(baseBot)),
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
  };
  // Ensure FOI flags always in patch for apply
  bestPatch.tradeFoiSignals = true;
  bestPatch.tradeBearishFoiSignals = true;

  const payload = {
    comparedAt: new Date().toISOString(),
    interval: INTERVAL,
    bothFoi: true,
    trainDays,
    evalDays,
    symbolCount: symbols.length,
    concurrency,
    training: store.training,
    baseline: store.baseline,
    best: store.best,
    globalBestByPnl: globalBest,
    bestConfig: store.bestConfig,
    patch: bestPatch,
    topByPnl: [...store.runs]
      .filter((r) => (r.trades ?? 0) >= minTrades)
      .sort((a, b) => b.pnl - a.pnl || b.winRate - a.winRate)
      .slice(0, 20)
      .map((r) => ({
        label: r.label,
        pnl: r.pnl,
        trades: r.trades,
        winRate: r.winRate,
        bySignal: r.bySignal,
        patch: r.patch,
      })),
  };
  writeJsonFile(OUT_FILE(), { ...store, ...payload });
  writeJsonFile(BEST_FILE(), {
    appliedAt: new Date().toISOString(),
    interval: INTERVAL,
    bothFoi: true,
    trainDays,
    evalDays,
    symbolCount: symbols.length,
    bestPnl: store.best?.pnl,
    bestLabel: store.best?.label,
    patch: bestPatch,
    bySignal: store.best?.bySignal,
    topByPnl: payload.topByPnl,
  });

  // Apply best FOI patch to local paper/live
  for (const name of ["paper-bot-state.json", "live-bot-state.json"]) {
    const state = readJsonFile(dataPath(name), null);
    if (!state?.config) continue;
    Object.assign(state.config, bestPatch);
    state.config.tradeFoiSignals = true;
    state.config.tradeBearishFoiSignals = true;
    writeJsonFile(dataPath(name), state);
  }
  installModel("paper");
  installModel("live");

  log("\n=== WINNER (15m · both FOI) ===");
  log(`$${store.best?.pnl} · ${store.best?.trades} tr · WR ${store.best?.winRate}% · ${store.best?.label}`);
  log(`Patch: ${JSON.stringify(bestPatch)}`);
  log(`Report: ${OUT_FILE()}`);
  log(`Best: ${BEST_FILE()}`);
  console.log(JSON.stringify({ winner: store.best, patch: bestPatch, topByPnl: payload.topByPnl.slice(0, 5) }, null, 2));
}

if (mode === "train") {
  workerTrainMain().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
} else if (mode === "eval") {
  workerEvalMain().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}
