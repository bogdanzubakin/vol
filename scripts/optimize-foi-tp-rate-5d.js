#!/usr/bin/env node
/**
 * FOI-only settings search on N-day cache, ranked by take-profit hit rate.
 * Runs config evaluations in parallel worker processes.
 *
 *   node scripts/optimize-foi-tp-rate-5d.js --days 5 --reset
 *   node scripts/optimize-foi-tp-rate-5d.js --days 5 --concurrency 8
 *   node scripts/optimize-foi-tp-rate-5d.js --worker   # internal
 */
const { ensureMinHeapMb } = require("../lib/node-mem");

const isWorker = process.argv.includes("--worker");
if (!isWorker) ensureMinHeapMb(12288);

const fs = require("fs");
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const {
  loadFundingOiCache,
  prefetchFundingOiCache,
} = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

const OUT_FILE = () => dataPath("foi-tp-rate-optimize-5d.json");
const BEST_FILE = () => dataPath("foi-tp-rate-best-5d.json");
const BATCH = 50;

function parseArgs(argv) {
  let days = 5;
  let reset = false;
  let maxSymbols = 0;
  let minTrades = 25;
    let concurrency = Math.max(2, Math.min(4, (os.cpus()?.length || 4) - 2));
  let prefetchFunding = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--reset") reset = true;
    else if (argv[i] === "--max-symbols" && argv[i + 1]) {
      maxSymbols = Number(argv[++i]);
    } else if (argv[i] === "--min-trades" && argv[i + 1]) {
      minTrades = Number(argv[++i]);
    } else if (argv[i] === "--concurrency" && argv[i + 1]) {
      concurrency = Number(argv[++i]);
    } else if (argv[i] === "--skip-funding-prefetch") prefetchFunding = false;
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 5)),
    reset,
    maxSymbols: Math.max(0, Math.round(maxSymbols) || 0),
    minTrades: Math.max(1, Math.round(minTrades) || 25),
    concurrency: Math.max(1, Math.min(16, Math.round(concurrency) || 4)),
    prefetchFunding,
  };
}

function log(msg) {
  console.error(String(msg));
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
    ...scanner,
    ...(detection?.patch ?? {}),
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
    .filter((sym) => (readSymbolBars("signal", sym)?.length ?? 0) >= 200)
    .sort();
  if (maxSymbols > 0) list = list.slice(0, maxSymbols);
  return list;
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
      const cached =
        readCached(sym, "mover", barCount) ?? readCached(sym, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${sym}`);
    },
  };
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

function summarize(trades) {
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const tpHits = trades.filter((t) => t.exitReason === "take_profit").length;
  const slHits = trades.filter((t) => t.exitReason === "stop_loss").length;
  const bySignal = {};
  for (const k of ["foi", "foi_bear"]) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    const tp = rows.filter((t) => t.exitReason === "take_profit").length;
    const sl = rows.filter((t) => t.exitReason === "stop_loss").length;
    bySignal[k] = {
      trades: rows.length,
      pnl: +rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2),
      winRate: +(
        (100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) /
        rows.length
      ).toFixed(1),
      tpRate: +((100 * tp) / rows.length).toFixed(1),
      slRate: +((100 * sl) / rows.length).toFixed(1),
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
    tpHits,
    slHits,
    tpRate: trades.length ? +((100 * tpHits) / trades.length).toFixed(2) : 0,
    slRate: trades.length ? +((100 * slHits) / trades.length).toFixed(2) : 0,
    bySignal,
    foiPnl: bySignal.foi?.pnl ?? 0,
    foiBearPnl: bySignal.foi_bear?.pnl ?? 0,
  };
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

async function evaluateConfig({ label, botConfig, signalCfg, days, symbols }) {
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  const trades = [];
  // Inside a forked worker keep symbol batches modest to avoid CPU oversubscribe
  const batchConcurrency = process.argv.includes("--worker")
    ? 2
    : Math.max(2, Math.min(4, Math.ceil(symbols.length / BATCH)));
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
          modelScope: "live",
          runMeta: { optimize: "foi-tp-rate-5d", label },
        })
      )
    );
    for (const { result } of results) {
      for (const t of result.closedTrades ?? []) {
        trades.push({
          symbol: t.symbol,
          signalKind: t.signalKind,
          pnl: t.pnl,
          exitReason: t.exitReason,
        });
      }
      result.closedTrades = null;
    }
    if (global.gc) global.gc();
  }
  return { label, ...summarize(trades) };
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
          foiMinAbsFundingRate: 0.0001,
          foiMinAbsFundingRateBull: 0.00018,
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
        { takeProfitPct: 1.5, sfpTakeProfitPct: 1.5, takeProfitMinPct: 0.8 },
        { takeProfitPct: 2, sfpTakeProfitPct: 2, takeProfitMinPct: 0.8 },
        { takeProfitPct: 2.5, sfpTakeProfitPct: 2.5, takeProfitMinPct: 1 },
        { takeProfitPct: 3, sfpTakeProfitPct: 3, takeProfitMinPct: 1 },
        { takeProfitPct: 3.5, sfpTakeProfitPct: 3.5, takeProfitMinPct: 1 },
        { takeProfitPct: 4, sfpTakeProfitPct: 4, takeProfitMinPct: 1 },
        { takeProfitPct: 5, sfpTakeProfitPct: 5, takeProfitMinPct: 1.5 },
        {
          takeProfitPct: 2,
          sfpTakeProfitPct: 2,
          takeProfitMinPct: 0.8,
          aiExitLevelsEnabled: false,
        },
        {
          takeProfitPct: 3,
          sfpTakeProfitPct: 3,
          takeProfitMinPct: 1,
          aiExitLevelsEnabled: true,
          aiExitLevelsTpScale: 0.9,
        },
        {
          takeProfitPct: 3,
          sfpTakeProfitPct: 3,
          takeProfitMinPct: 1,
          aiExitLevelsEnabled: true,
          aiExitLevelsTpScale: 1.15,
        },
      ],
    },
  ];
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch).map(([k, v]) => `${k}=${v}`);
  return `${phase}_${idx}_${parts.join("_") || "inherit"}`.slice(0, 140);
}

function pickBest(rows, minTrades) {
  const eligible = rows.filter((r) => (r.trades ?? 0) >= minTrades);
  const pool = eligible.length ? eligible : rows;
  return [...pool].sort((a, b) => {
    if (b.tpRate !== a.tpRate) return b.tpRate - a.tpRate;
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
    "aiExitLevelsTpScale",
  ];
  const patch = {};
  for (const k of keys) {
    if (JSON.stringify(base[k] ?? null) !== JSON.stringify(tuned[k] ?? null)) {
      patch[k] = tuned[k];
    }
  }
  return patch;
}

/** Run jobs in parallel via forked worker processes. */
function runJobsParallel(jobs, concurrency) {
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
        log(`  ▶ start [${idx + 1}/${jobs.length}] ${job.label}`);
        const child = fork(__filename, ["--worker"], {
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
        }, 120 * 60 * 1000);

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
          log(
            `  ✓ [${idx + 1}/${jobs.length}] TP ${msg.result.tpRate}% · $${msg.result.pnl} · ${msg.result.trades} tr · ${job.label}`
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

async function workerMain() {
  reloadModels();
  process.on("message", async (job) => {
    try {
      const row = await evaluateConfig({
        label: job.label,
        botConfig: mergeBot(job.baseBot, job.patch || {}),
        signalCfg: job.signalCfg,
        days: job.days,
        symbols: job.symbols,
      });
      row.patch = job.patch || {};
      process.send({ ok: true, result: row });
    } catch (e) {
      process.send({ ok: false, error: e.stack || e.message || String(e) });
    } finally {
      process.exit(0);
    }
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const { days, reset, maxSymbols, minTrades, concurrency, prefetchFunding } =
    opts;

  const symbols = cachedSymbolList(maxSymbols);
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  reloadModels();
  if (prefetchFunding) {
    log(`Prefetch funding/OI · ${days}d · ${symbols.length} symbols…`);
    await prefetchFundingOiCache({
      symbols,
      days: Math.max(days, 10),
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
  const signalCfg = loadSignalConfig();
  const baselineSnapshot = { ...baseBot };

  let store = reset
    ? {
        objective: "tpRate",
        minTrades,
        concurrency,
        runs: [],
        phasesDone: [],
        bestConfig: null,
        best: null,
        baseline: null,
      }
    : readJsonFile(OUT_FILE(), {
        objective: "tpRate",
        minTrades,
        concurrency,
        runs: [],
        phasesDone: [],
        bestConfig: null,
        best: null,
        baseline: null,
      });
  store.objective = "tpRate";
  store.minTrades = minTrades;
  store.concurrency = concurrency;

  let anchor = store.bestConfig ? mergeBot(baseBot, store.bestConfig) : baseBot;
  const phaseList = phases();
  const totalSweeps = phaseList.reduce((s, p) => s + p.sweeps.length, 0);

  log(
    `FOI TP-rate optimize · ${days}d · ${symbols.length} symbols · concurrency=${concurrency} · minTrades=${minTrades} · ~${totalSweeps} runs`
  );

  async function runPhaseJobs(jobs) {
    return runJobsParallel(
      jobs.map((j) => ({
        ...j,
        baseBot: { ...anchor },
        signalCfg,
        days,
        symbols,
      })),
      concurrency
    );
  }

  if (!store.baseline) {
    log("\n=== BASELINE (parallel batches) ===");
    const [row] = await runPhaseJobs([
      { label: "baseline", patch: {} },
    ]);
    store.baseline = row;
    store.runs.push(row);
    store.best = row;
    store.bestConfig = { ...anchor };
    writeJsonFile(OUT_FILE(), store);
    log(
      `→ TP ${row.tpRate}% · $${row.pnl} · ${row.trades} tr · WR ${row.winRate}%`
    );
    log(`  bySignal ${JSON.stringify(row.bySignal)}`);
  }

  for (const phase of phaseList) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip (done) ===`);
      anchor = mergeBot(baseBot, store.bestConfig);
      continue;
    }

    log(
      `\n=== PHASE ${phase.name} · ${phase.sweeps.length} variants · parallel ×${concurrency} ===`
    );
    const jobs = phase.sweeps.map((patch, i) => ({
      label: patchLabel(phase.name, patch, i),
      patch,
    }));
    const phaseRows = await runPhaseJobs(jobs);
    for (const row of phaseRows) store.runs.push(row);
    writeJsonFile(OUT_FILE(), store);

    const phaseBest = pickBest(phaseRows, minTrades);
    const improved = (phaseBest?.tpRate ?? -1) > (store.best?.tpRate ?? -1);
    if (phaseBest && Object.keys(phaseBest.patch || {}).length) {
      anchor = mergeBot(anchor, phaseBest.patch);
    }
    store.bestConfig = { ...anchor };
    if (
      phaseBest &&
      (improved || !store.best || phaseBest.tpRate >= store.best.tpRate)
    ) {
      store.best = { ...phaseBest, phase: phase.name };
    }
    store.phasesDone.push(phase.name);
    writeJsonFile(OUT_FILE(), store);
    log(
      `Phase best: TP ${phaseBest?.tpRate}% · $${phaseBest?.pnl} (${phaseBest?.label})${improved ? " ↑" : ""}`
    );
  }

  const globalBest = pickBest(store.runs, minTrades);
  const bestPatch = foiPatchDiff(baselineSnapshot, store.bestConfig);
  const payload = {
    comparedAt: new Date().toISOString(),
    objective: "tpRate",
    days,
    symbolCount: symbols.length,
    maxSymbols: maxSymbols || null,
    minTrades,
    concurrency,
    baseline: store.baseline,
    best: store.best,
    globalBestByTpRate: globalBest,
    bestConfig: store.bestConfig,
    patch: bestPatch,
    topByTpRate: [...store.runs]
      .filter((r) => r.trades >= minTrades)
      .sort((a, b) => b.tpRate - a.tpRate || b.pnl - a.pnl)
      .slice(0, 15)
      .map((r) => ({
        label: r.label,
        tpRate: r.tpRate,
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
    days,
    symbolCount: symbols.length,
    minTrades,
    concurrency,
    objective: "tpRate",
    bestTpRate: store.best?.tpRate,
    bestPnl: store.best?.pnl,
    bestLabel: store.best?.label,
    patch: bestPatch,
    bySignal: store.best?.bySignal,
    globalBestByTpRate: {
      label: globalBest?.label,
      tpRate: globalBest?.tpRate,
      pnl: globalBest?.pnl,
      trades: globalBest?.trades,
      patch: globalBest?.patch,
    },
  });

  console.log(JSON.stringify(payload, null, 2));
  log(`\nBest TP ${store.best?.tpRate}% · $${store.best?.pnl} · ${store.best?.label}`);
  log(`Patch: ${JSON.stringify(bestPatch)}`);
  log(`Report: ${OUT_FILE()}`);
  log(`Best: ${BEST_FILE()}`);
}

if (isWorker) {
  workerMain().catch((e) => {
    console.error(e.stack || e.message || e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error(e.stack || e.message || e);
    process.exit(1);
  });
}
