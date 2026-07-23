#!/usr/bin/env node
/**
 * FOI-only interval compare: train AI exit-levels on 30d per timeframe,
 * then coordinate-descent FOI settings on 5d eval. Parallel workers where safe.
 *
 *   node scripts/optimize-foi-interval-5d.js --train-days 30 --eval-days 5 --reset
 *   node scripts/optimize-foi-interval-5d.js --concurrency 6
 *   node scripts/optimize-foi-interval-5d.js --worker-train   # internal
 *   node scripts/optimize-foi-interval-5d.js --worker-eval    # internal
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

const INTERVALS = ["1m", "5m", "15m"];
const BATCH = 50;
const OUT_FILE = () => dataPath("foi-interval-5d-optimize.json");
const BEST_FILE = () => dataPath("foi-interval-5d-best.json");
const MODEL_ROOT = () => path.join(dataPath(), "foi-interval-models");

function log(msg) {
  console.error(String(msg));
}

function parseArgs(argv) {
  let trainDays = 30;
  let evalDays = 5;
  let reset = false;
  let maxSymbols = 0;
  let minTrades = 20;
  let concurrency = Math.max(2, Math.min(6, (os.cpus()?.length || 4) - 1));
  let trainConcurrency = Math.min(3, INTERVALS.length);
  let prefetchFunding = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--train-days" && argv[i + 1]) trainDays = Number(argv[++i]);
    else if (argv[i] === "--eval-days" && argv[i + 1]) evalDays = Number(argv[++i]);
    else if (argv[i] === "--reset") reset = true;
    else if (argv[i] === "--max-symbols" && argv[i + 1]) maxSymbols = Number(argv[++i]);
    else if (argv[i] === "--min-trades" && argv[i + 1]) minTrades = Number(argv[++i]);
    else if (argv[i] === "--concurrency" && argv[i + 1]) concurrency = Number(argv[++i]);
    else if (argv[i] === "--train-concurrency" && argv[i + 1]) {
      trainConcurrency = Number(argv[++i]);
    } else if (argv[i] === "--skip-funding-prefetch") prefetchFunding = false;
  }
  return {
    trainDays: Math.max(5, Math.min(60, Math.round(trainDays) || 30)),
    evalDays: Math.max(1, Math.min(30, Math.round(evalDays) || 5)),
    reset,
    maxSymbols: Math.max(0, Math.round(maxSymbols) || 0),
    minTrades: Math.max(1, Math.round(minTrades) || 20),
    concurrency: Math.max(1, Math.min(12, Math.round(concurrency) || 4)),
    trainConcurrency: Math.max(1, Math.min(3, Math.round(trainConcurrency) || 3)),
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

function createIntervalFetchers(interval) {
  const aggCache = new Map();
  function signalBars(sym, barCount) {
    const symbol = String(sym).toUpperCase();
    const raw = bars1m(symbol);
    if (!raw?.length) return null;
    if (interval === "1m") return sliceTail(raw, barCount);
    const mins = interval === "5m" ? 5 : 15;
    const key = `${symbol}:${mins}m`;
    if (!aggCache.has(key)) aggCache.set(key, aggregateBars(raw, mins));
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
  const foiBest = readJsonFile(dataPath("foi-best-10d.json"), null)?.patch ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    foiMinAbsFundingRate: 0.00012,
    foiRequireOiConfirm: true,
    foiConfirmSfp: true,
    foiConfirmPullback: true,
    ...foiBest,
    armed: false,
    drawdownStopEnabled: false,
    aiRegimeBtcFastLookbackHours: local.aiRegimeBtcFastLookbackHours ?? 2,
    aiPullbackSignalBtcFastLookbackHours:
      local.aiPullbackSignalBtcFastLookbackHours ?? 2,
  });
}

function loadSignalConfig(interval) {
  const scanner = readJsonFile(dataPath("scanner-config.json"), {}) ?? {};
  const detection = readJsonFile(dataPath("bear-detection-best-10d.json"), null);
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
    ...scanner,
    ...(detection?.patch ?? {}),
    interval,
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

function fetchBarsAll(symbol) {
  return bars1m(symbol) ?? [];
}

function fetchBarsTradeWindow(symbol, openedAt, closedAt) {
  const bars = fetchBarsAll(symbol);
  if (!bars.length) return [];
  const from = openedAt - 120_000;
  const to = closedAt + 120_000;
  return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
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

function intervalModelDir(interval) {
  const dir = path.join(MODEL_ROOT(), interval);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function installIntervalModels(interval, scope = "paper") {
  const dir = intervalModelDir(interval);
  const src = path.join(dir, "ai-exit-levels.json");
  if (!fs.existsSync(src)) throw new Error(`Missing trained model for ${interval}: ${src}`);
  const dest = modelFileFor("ai-exit-levels", scope);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  reloadExitLevels(scope);
}

async function trainFoiExitLevels(trades, botConfig, interval) {
  return trainExitLevels(trades, fetchBarsTradeWindow, {
    botConfig,
    scope: "paper",
    source: `foi-interval:${interval}:train`,
    signalKinds: ["foi", "foi_bear"],
  });
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
  interval,
  days,
  symbols,
  getFundingOiAt,
}) {
  const fetchers = createIntervalFetchers(interval);
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
          fetchKlines1mForSymbol:
            interval !== "1m" ? fetchers.fetchKlines1mForSymbol : null,
          getFundingOiAt,
          restGapMs: 0,
          saveLastResult: false,
          saveKlineCache: false,
          modelScope: "paper",
          runMeta: { optimize: "foi-interval-5d", label, interval },
        })
      )
    );
    for (const { result } of results) {
      for (const t of result.closedTrades ?? []) {
        if (t.signalKind === "foi" || t.signalKind === "foi_bear") {
          trades.push(t);
        }
      }
      result.closedTrades = null;
    }
    if (global.gc) global.gc();
  }
  return { label, closedTrades: trades, ...summarize(trades) };
}

function phases() {
  return [
    {
      name: "side_mix",
      sweeps: [
        { tradeFoiSignals: true, tradeBearishFoiSignals: true },
        { tradeFoiSignals: false, tradeBearishFoiSignals: true },
        { tradeFoiSignals: true, tradeBearishFoiSignals: false },
      ],
    },
    {
      name: "funding_threshold",
      sweeps: [
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
          foiMinAbsFundingRate: 0.00012,
          foiMinAbsFundingRateBull: 0.00025,
          foiMinAbsFundingRateBear: 0.00008,
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
        { takeProfitPct: 2, sfpTakeProfitPct: 2, takeProfitMinPct: 0.8 },
        { takeProfitPct: 2.5, sfpTakeProfitPct: 2.5 },
        { takeProfitPct: 3, sfpTakeProfitPct: 3 },
        { takeProfitPct: 3.5, sfpTakeProfitPct: 3.5 },
        {
          takeProfitPct: 3,
          sfpTakeProfitPct: 3,
          aiExitLevelsEnabled: false,
        },
      ],
    },
    {
      name: "early_abort_bear",
      sweeps: [
        {},
        { earlyAbortEnabledBear: false },
        { earlyAbortMaxAdversePctBear: 2.5 },
        { earlyAbortMaxAdversePctBear: 3.0, earlyAbortBarsBear: 30 },
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
    "aiExitLevelsEnabled",
    "earlyAbortEnabledBear",
    "earlyAbortMaxAdversePctBear",
    "earlyAbortBarsBear",
  ];
  const patch = {};
  for (const k of keys) {
    if (JSON.stringify(base[k] ?? null) !== JSON.stringify(tuned[k] ?? null)) {
      patch[k] = tuned[k];
    }
  }
  return patch;
}

function runJobsParallel(jobs, concurrency, workerFlag) {
  // 1m×5d FOI full-universe eval can exceed 2.5h under load; train needs longer.
  const timeoutMs =
    workerFlag === "--worker-train" ? 8 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
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
            NODE_OPTIONS: `--max-old-space-size=8192`,
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
          log(
            `  ✓ [${idx + 1}/${jobs.length}] $${pnl} · ${trades} tr · ${job.label}`
          );
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

async function trainIntervalWorker(job) {
  reloadModels();
  const { interval, trainDays, symbols, baseBot } = job;
  const signalCfg = loadSignalConfig(interval);
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  const collect = await runFoiBacktest({
    label: `${interval}_train_collect_${trainDays}d`,
    botConfig: foiCollectBot(baseBot),
    signalCfg,
    interval,
    days: trainDays,
    symbols,
    getFundingOiAt,
  });
  const model = await trainFoiExitLevels(collect.closedTrades, baseBot, interval);
  const dir = intervalModelDir(interval);
  writeJsonFile(path.join(dir, "ai-exit-levels.json"), {
    ...getExitLevels("paper"),
    ...model,
    scope: "paper",
    interval,
    trainedAt: Date.now(),
    trainTrades: collect.trades,
  });
  installIntervalModels(interval, "paper");
  return {
    interval,
    trainDays,
    collect: {
      pnl: collect.pnl,
      trades: collect.trades,
      winRate: collect.winRate,
      bySignal: collect.bySignal,
    },
    exitLevels: {
      bullSamples: model.bull?.sl?.metrics?.samples ?? null,
      bearSamples: model.bear?.sl?.metrics?.samples ?? null,
    },
    modelDir: dir,
  };
}

async function evalIntervalWorker(job) {
  reloadModels();
  installIntervalModels(job.interval, "paper");
  const botConfig = mergeBot(foiEvalBot(job.baseBot), job.patch || {});
  const signalCfg = loadSignalConfig(job.interval);
  const { lookup: getFundingOiAt } = loadFundingOiCache(job.symbols);
  const row = await runFoiBacktest({
    label: job.label,
    botConfig,
    signalCfg,
    interval: job.interval,
    days: job.evalDays,
    symbols: job.symbols,
    getFundingOiAt,
  });
  // Drop heavy closedTrades before IPC — parent only needs summary metrics.
  const { closedTrades, ...summary } = row;
  summary.patch = job.patch || {};
  summary.interval = job.interval;
  return summary;
}

function sendAndExit(payload) {
  try {
    if (typeof process.send === "function") {
      process.send(payload, () => process.exit(payload.ok ? 0 : 1));
      // Fallback if IPC ack never fires
      setTimeout(() => process.exit(payload.ok ? 0 : 1), 30_000).unref();
      return;
    }
  } catch (e) {
    console.error(e.stack || e);
  }
  process.exit(payload.ok ? 0 : 1);
}

async function workerTrainMain() {
  process.on("message", async (job) => {
    try {
      const result = await trainIntervalWorker(job);
      // Strip closed trades from collect if present
      if (result?.collect) delete result.collect.closedTrades;
      sendAndExit({ ok: true, result });
    } catch (e) {
      sendAndExit({ ok: false, error: e.stack || e.message || String(e) });
    }
  });
}

async function workerEvalMain() {
  process.on("message", async (job) => {
    try {
      const result = await evalIntervalWorker(job);
      sendAndExit({ ok: true, result });
    } catch (e) {
      sendAndExit({ ok: false, error: e.stack || e.message || String(e) });
    }
  });
}

async function trainAllIntervals({ intervals, trainDays, symbols, baseBot, trainConcurrency }) {
  const pending = intervals.filter(
    (interval) => !fs.existsSync(path.join(intervalModelDir(interval), "ai-exit-levels.json"))
  );
  if (!pending.length) {
    log("All interval models already trained — skip train phase");
    return {};
  }
  log(
    `\n=== TRAIN AI exit-levels · ${trainDays}d · ${pending.length} intervals · parallel ×${trainConcurrency} ===`
  );
  const jobs = pending.map((interval) => ({
    label: `${interval}_train`,
    interval,
    trainDays,
    symbols,
    baseBot,
  }));
  const rows = await runJobsParallel(jobs, trainConcurrency, "--worker-train");
  const out = {};
  for (const r of rows) out[r.interval] = r;
  return out;
}

async function optimizeInterval({
  interval,
  evalDays,
  symbols,
  baseBot,
  concurrency,
  minTrades,
  storeInterval,
  onCheckpoint,
}) {
  installIntervalModels(interval, "paper");
  let anchor = storeInterval.bestConfig
    ? mergeBot(foiEvalBot(baseBot), storeInterval.bestConfig)
    : foiEvalBot(baseBot);
  const phaseList = phases();
  storeInterval.runs = storeInterval.runs ?? [];
  storeInterval.phasesDone = storeInterval.phasesDone ?? [];

  // 1m is much heavier — cap parallelism so workers finish before timeout.
  const phaseConcurrency =
    interval === "1m" ? Math.min(concurrency, 2) : concurrency;

  log(
    `\n=== OPTIMIZE ${interval} · ${evalDays}d eval · concurrency=${phaseConcurrency} ===`
  );

  if (!storeInterval.baseline) {
    const [row] = await runJobsParallel(
      [
        {
          label: `${interval}_baseline`,
          interval,
          evalDays,
          symbols,
          baseBot,
          patch: {},
        },
      ],
      1,
      "--worker-eval"
    );
    storeInterval.baseline = row;
    storeInterval.runs.push(row);
    storeInterval.best = row;
    storeInterval.bestConfig = { ...anchor };
    anchor = mergeBot(foiEvalBot(baseBot), storeInterval.bestConfig);
    log(`Baseline ${interval}: $${row.pnl} · ${row.trades} tr · WR ${row.winRate}%`);
    onCheckpoint?.(storeInterval);
  } else {
    log(
      `Baseline ${interval}: cached $${storeInterval.baseline.pnl} · ${storeInterval.baseline.trades} tr — skip`
    );
    anchor = mergeBot(foiEvalBot(baseBot), storeInterval.bestConfig);
  }

  for (const phase of phaseList) {
    if (storeInterval.phasesDone.includes(phase.name)) {
      log(`  ${interval} phase ${phase.name} — skip (done)`);
      continue;
    }
    log(
      `  ${interval} phase ${phase.name} · ${phase.sweeps.length} variants · parallel ×${phaseConcurrency}`
    );
    const jobs = phase.sweeps.map((patch, i) => ({
      label: `${interval}_${patchLabel(phase.name, patch, i)}`,
      interval,
      evalDays,
      symbols,
      baseBot,
      patch,
    }));
    const phaseRows = await runJobsParallel(jobs, phaseConcurrency, "--worker-eval");
    for (const row of phaseRows) storeInterval.runs.push(row);
    const phaseBest = pickBest(phaseRows, minTrades);
    if (phaseBest?.patch && Object.keys(phaseBest.patch).length) {
      anchor = mergeBot(anchor, phaseBest.patch);
    }
    storeInterval.bestConfig = foiPatchDiff(baseBot, anchor);
    if (
      phaseBest &&
      (!storeInterval.best || phaseBest.pnl >= storeInterval.best.pnl)
    ) {
      storeInterval.best = { ...phaseBest, phase: phase.name };
    }
    storeInterval.phasesDone.push(phase.name);
    log(`  ${interval} phase best: $${phaseBest?.pnl} (${phaseBest?.label})`);
    onCheckpoint?.(storeInterval);
  }

  storeInterval.finalConfig = anchor;
  storeInterval.patch = foiPatchDiff(baseBot, anchor);
  return storeInterval;
}

async function main() {
  const opts = parseArgs(process.argv);
  const { trainDays, evalDays, reset, maxSymbols, minTrades, concurrency, trainConcurrency, prefetchFunding } =
    opts;

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
        trainDays,
        evalDays,
        symbolCount: symbols.length,
        intervals: {},
        ranked: [],
        winner: null,
      }
    : readJsonFile(OUT_FILE(), {
        trainDays,
        evalDays,
        symbolCount: symbols.length,
        intervals: {},
        ranked: [],
        winner: null,
      });
  store.trainDays = trainDays;
  store.evalDays = evalDays;
  store.symbolCount = symbols.length;

  log(
    `FOI interval optimize · train ${trainDays}d · eval ${evalDays}d · ${symbols.length} symbols · ${INTERVALS.join(", ")}`
  );

  if (reset) {
    for (const interval of INTERVALS) {
      const dir = intervalModelDir(interval);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const trainMeta = await trainAllIntervals({
    intervals: reset ? INTERVALS : INTERVALS,
    trainDays,
    symbols,
    baseBot,
    trainConcurrency,
  });
  store.training = { ...(store.training ?? {}), ...trainMeta };
  writeJsonFile(OUT_FILE(), store);

  for (const interval of INTERVALS) {
    store.intervals[interval] = store.intervals[interval] ?? {
      runs: [],
      phasesDone: [],
      bestConfig: null,
      best: null,
      baseline: null,
    };
    store.intervals[interval] = await optimizeInterval({
      interval,
      evalDays,
      symbols,
      baseBot,
      concurrency,
      minTrades,
      storeInterval: store.intervals[interval],
      onCheckpoint: (si) => {
        store.intervals[interval] = si;
        store.updatedAt = new Date().toISOString();
        writeJsonFile(OUT_FILE(), store);
        log(`  checkpoint saved · ${interval} phasesDone=[${(si.phasesDone || []).join(",")}]`);
      },
    });
    writeJsonFile(OUT_FILE(), store);
  }

  const ranked = INTERVALS.map((interval) => {
    const row = store.intervals[interval];
    return {
      interval,
      pnl: row.best?.pnl ?? row.baseline?.pnl ?? null,
      trades: row.best?.trades ?? row.baseline?.trades ?? null,
      winRate: row.best?.winRate ?? row.baseline?.winRate ?? null,
      bySignal: row.best?.bySignal ?? row.baseline?.bySignal ?? null,
      patch: row.patch ?? {},
      trainCollect: store.training?.[interval]?.collect ?? null,
    };
  }).sort((a, b) => (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity));

  store.ranked = ranked;
  store.winner = ranked[0]
    ? {
        interval: ranked[0].interval,
        pnl: ranked[0].pnl,
        trades: ranked[0].trades,
        winRate: ranked[0].winRate,
        patch: ranked[0].patch,
      }
    : null;
  store.updatedAt = new Date().toISOString();
  writeJsonFile(OUT_FILE(), store);

  const bestPayload = {
    appliedAt: new Date().toISOString(),
    trainDays,
    evalDays,
    symbolCount: symbols.length,
    winner: store.winner,
    ranked,
    intervals: store.intervals,
  };
  writeJsonFile(BEST_FILE(), bestPayload);

  log("\n=== INTERVAL RANKING (FOI-only · 5d eval · AI trained on 30d) ===");
  for (const r of ranked) {
    log(
      `${r.interval}: $${r.pnl} · ${r.trades} tr · WR ${r.winRate}% · patch ${JSON.stringify(r.patch)}`
    );
  }
  if (store.winner) {
    log(`\nWinner: ${store.winner.interval} → $${store.winner.pnl}`);
  }
  log(`Report: ${OUT_FILE()}`);
  log(`Best: ${BEST_FILE()}`);
  console.log(JSON.stringify({ ranked, winner: store.winner }, null, 2));
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
