#!/usr/bin/env node
/**
 * Early-abort + runner parameter sweep with SFP regime ON (cache-first).
 *
 *   node scripts/optimize-early-abort-runner-params.js --days 10 --cache-only
 *   node scripts/optimize-early-abort-runner-params.js --days 10 --cache-only --train
 *   node scripts/optimize-early-abort-runner-params.js --days 10 --cache-only --train --apply
 */

const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { ensureAllDefaultModelsOnDisk, reloadModel } = require("../lib/sfp-regime-model");
const { POSITION_EXIT_DEFAULTS } = require("../lib/paper-bot-position-exits");

const RESULTS_FILE = () => dataPath("early-abort-runner-optimization-results.json");
const TRAINED_FILE = () => dataPath("early-abort-runner-trained.json");

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  let cacheOnly = true;
  let quick = false;
  let train = false;
  let apply = false;
  let resume = false;
  let finalizeOnly = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--cache-only") cacheOnly = true;
    else if (argv[i] === "--fetch") cacheOnly = false;
    else if (argv[i] === "--quick") quick = true;
    else if (argv[i] === "--train") train = true;
    else if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--resume") resume = true;
    else if (argv[i] === "--finalize-only") finalizeOnly = true;
  }
  return {
    days: Math.max(1, Math.min(21, Math.round(days) || 10)),
    cacheOnly,
    quick,
    train,
    apply,
    resume,
    finalizeOnly,
  };
}

function loadBotConfig() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    aiEarlyExitEnabled: false,
    aiLevelBreakRegimeEnabled: false,
    aiSfpRegimeEnabled: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
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

function createFetchers(cacheOnly) {
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "signal", barCount);
      if (cached?.length >= barCount) return cached;
      if (cacheOnly && cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "mover", barCount);
      if (cached?.length >= barCount) return cached;
      if (cacheOnly && cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
}

function summarizeRun(result) {
  const s = result.summary ?? {};
  const exits = {};
  for (const t of result.closedTrades ?? []) {
    const r = t.exitReason ?? "unknown";
    exits[r] = (exits[r] ?? 0) + 1;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    regimeSkips: s.sfpRegimeSkips ?? 0,
    exits,
    symbolsProcessed: result.symbolsProcessed ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, cacheOnly }) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers(cacheOnly);
  log(`\n=== RUN: ${label} ===`);
  log(
    `abort ${botConfig.earlyAbortEnabled ? "ON" : "OFF"} · runner ${botConfig.runnerEnabled ? "ON" : "OFF"} · regime ON`
  );
  const started = Date.now();
  let lastProgressKey = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol,
    fetchKlines1mForSymbol: signalCfg.interval !== "1m" ? fetchKlines1mForSymbol : null,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: false,
    runMeta: { optimize: "early-abort-runner", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol) {
        const done = (p.done ?? 0) + 1;
        const total = p.total ?? symbols.length;
        const key = `${done}:${p.symbol}`;
        if (key !== lastProgressKey && (done === 1 || done % 100 === 0 || done >= total)) {
          lastProgressKey = key;
          log(`[${label}] ${done}/${total} · ${p.symbol}`);
        }
      } else if (p.phase === "saving") {
        log(`[${label}] ${p.message}`);
      }
    },
  });
  const summary = summarizeRun(result);
  log(
    `→ ${label}: PnL $${summary.pnl} · ${summary.trades} trades · skips ${summary.regimeSkips} · ${summary.elapsedSec}s`
  );
  return {
    label,
    days,
    botPatch: {
      earlyAbortEnabled: botConfig.earlyAbortEnabled,
      runnerEnabled: botConfig.runnerEnabled,
      earlyAbortBars: botConfig.earlyAbortBars,
      earlyAbortInvalidateBars: botConfig.earlyAbortInvalidateBars,
      earlyAbortMinProgressPct: botConfig.earlyAbortMinProgressPct,
      earlyAbortMaxAdversePct: botConfig.earlyAbortMaxAdversePct,
      runnerActivatePct: botConfig.runnerActivatePct,
      runnerActivateTpFraction: botConfig.runnerActivateTpFraction,
      runnerGivebackPct: botConfig.runnerGivebackPct,
      runnerStructureBars: botConfig.runnerStructureBars,
      runnerReversalSignals: botConfig.runnerReversalSignals,
    },
    ...summary,
    elapsedTotalSec: Math.round((Date.now() - started) / 1000),
  };
}

const ABORT_SWEEPS_FULL = [
  { key: "earlyAbortBars", values: [5, 8, 12] },
  { key: "earlyAbortInvalidateBars", values: [3, 5, 7] },
  { key: "earlyAbortMinProgressPct", values: [0.3, 0.5, 0.7] },
  { key: "earlyAbortMaxAdversePct", values: [0.8, 1.1, 1.4] },
];

const ABORT_SWEEPS_TRAIN = [
  { key: "earlyAbortBars", values: [3, 4, 5, 6, 8, 10, 12, 16, 20] },
  { key: "earlyAbortInvalidateBars", values: [2, 3, 4, 5, 7, 10, 15] },
  { key: "earlyAbortMinProgressPct", values: [0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0] },
  { key: "earlyAbortMaxAdversePct", values: [0.5, 0.6, 0.8, 1.0, 1.1, 1.3, 1.5, 1.8, 2.0] },
];

const ABORT_SWEEPS_QUICK = [
  { key: "earlyAbortBars", values: [5, 12] },
  { key: "earlyAbortMaxAdversePct", values: [0.8, 1.4] },
];

const RUNNER_SWEEPS_FULL = [
  { key: "runnerGivebackPct", values: [0.3, 0.5, 0.7] },
  { key: "runnerActivateTpFraction", values: [0.85, 0.95, 1.0] },
  { key: "runnerStructureBars", values: [3, 4, 6] },
  { key: "runnerReversalSignals", values: [1, 2, 3] },
];

const RUNNER_SWEEPS_TRAIN = [
  { key: "runnerGivebackPct", values: [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0] },
  { key: "runnerActivateTpFraction", values: [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0] },
  { key: "runnerActivatePct", values: [0, 1.5, 2, 2.5, 3, 4, 5, 6] },
  { key: "runnerStructureBars", values: [2, 3, 4, 5, 6, 8, 10, 12] },
  { key: "runnerReversalSignals", values: [1, 2, 3] },
];

const RUNNER_SWEEPS_QUICK = [
  { key: "runnerGivebackPct", values: [0.3, 0.7] },
  { key: "runnerActivateTpFraction", values: [0.85, 1.0] },
];

function pickSweeps(args) {
  if (args.train) {
    return { abort: ABORT_SWEEPS_TRAIN, runner: RUNNER_SWEEPS_TRAIN };
  }
  if (args.quick) {
    return { abort: ABORT_SWEEPS_QUICK, runner: RUNNER_SWEEPS_QUICK };
  }
  return { abort: ABORT_SWEEPS_FULL, runner: RUNNER_SWEEPS_FULL };
}

function exitPatch(row) {
  return row?.botPatch ?? {};
}

function pickAbortParams(patch = {}) {
  const d = POSITION_EXIT_DEFAULTS;
  return {
    earlyAbortBars: patch.earlyAbortBars ?? d.earlyAbortBars,
    earlyAbortInvalidateBars: patch.earlyAbortInvalidateBars ?? d.earlyAbortInvalidateBars,
    earlyAbortMinProgressPct: patch.earlyAbortMinProgressPct ?? d.earlyAbortMinProgressPct,
    earlyAbortMaxAdversePct: patch.earlyAbortMaxAdversePct ?? d.earlyAbortMaxAdversePct,
  };
}

function pickRunnerParams(patch = {}) {
  const d = POSITION_EXIT_DEFAULTS;
  return {
    runnerActivatePct: patch.runnerActivatePct ?? d.runnerActivatePct,
    runnerActivateTpFraction: patch.runnerActivateTpFraction ?? d.runnerActivateTpFraction,
    runnerGivebackPct: patch.runnerGivebackPct ?? d.runnerGivebackPct,
    runnerStructureBars: patch.runnerStructureBars ?? d.runnerStructureBars,
    runnerReversalSignals: patch.runnerReversalSignals ?? d.runnerReversalSignals,
  };
}

function mergeSectionParams(bestAbort, bestRunner) {
  return {
    ...pickAbortParams(exitPatch(bestAbort)),
    ...pickRunnerParams(exitPatch(bestRunner)),
  };
}

function isAbortOnlyRun(r) {
  return r.botPatch?.earlyAbortEnabled && !r.botPatch?.runnerEnabled;
}

function isRunnerOnlyRun(r) {
  return r.botPatch?.runnerEnabled && !r.botPatch?.earlyAbortEnabled;
}

function hasRun(store, label) {
  return store.runs?.some((r) => r.label === label);
}

function bestRunFor(store, pred) {
  return [...(store.runs ?? [])].filter(pred).sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))[0];
}

function finalizeTraining(store, baseline, apply) {
  const bestAbort =
    bestRunFor(
      store,
      (r) => r.botPatch?.earlyAbortEnabled && !r.botPatch?.runnerEnabled
    ) ?? store.runs.find((r) => r.label === "early_abort_on");

  const bestRunner =
    bestRunFor(
      store,
      (r) => r.botPatch?.runnerEnabled && !r.botPatch?.earlyAbortEnabled && !r.label.includes("joint")
    ) ?? store.runs.find((r) => r.label === "runner_on");

  const bestCombo =
    bestRunFor(
      store,
      (r) =>
        r.botPatch?.earlyAbortEnabled &&
        r.botPatch?.runnerEnabled &&
        (r.label === "best_combo" || r.label === "abort_and_runner_on")
    ) ??
    bestRunFor(store, (r) => r.botPatch?.earlyAbortEnabled && r.botPatch?.runnerEnabled) ??
    store.runs.find((r) => r.label === "best_combo") ??
    bestRunner;

  const abortBeatsBaseline = (bestAbort?.pnl ?? 0) > (baseline.pnl ?? 0);
  const runnerBeatsBaseline = (bestRunner?.pnl ?? 0) > (baseline.pnl ?? 0);
  const comboBeatsBaseline = (bestCombo?.pnl ?? 0) > (baseline.pnl ?? 0);
  const sectionParams = mergeSectionParams(bestAbort, bestRunner);

  const trained = {
    trainedAt: new Date().toISOString(),
    days: store.days,
    symbolCount: store.symbolCount,
    baselinePnl: baseline.pnl,
    earlyAbortSection: {
      enabled: abortBeatsBaseline,
      ...pickAbortParams(exitPatch(bestAbort)),
    },
    runnerSection: {
      enabled: runnerBeatsBaseline,
      ...pickRunnerParams(exitPatch(bestRunner)),
    },
    earlyAbort: {
      label: bestAbort?.label,
      pnl: bestAbort?.pnl,
      deltaVsBaseline: +((bestAbort?.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
      params: exitPatch(bestAbort),
      beatsBaseline: abortBeatsBaseline,
    },
    runner: {
      label: bestRunner?.label,
      pnl: bestRunner?.pnl,
      deltaVsBaseline: +((bestRunner?.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
      params: exitPatch(bestRunner),
      beatsBaseline: runnerBeatsBaseline,
    },
    combo: {
      label: bestCombo?.label,
      pnl: bestCombo?.pnl,
      deltaVsBaseline: +((bestCombo?.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
      params: exitPatch(bestCombo),
      beatsBaseline: comboBeatsBaseline,
    },
    earlyAbortEnabled: abortBeatsBaseline,
    runnerEnabled: runnerBeatsBaseline,
    params: {
      earlyAbortEnabled: abortBeatsBaseline,
      runnerEnabled: runnerBeatsBaseline,
      ...sectionParams,
    },
  };
  writeJsonFile(TRAINED_FILE(), trained);

  store.recommendation = {
    earlyAbortEnabled: abortBeatsBaseline,
    runnerEnabled: runnerBeatsBaseline,
    bestAbortLabel: bestAbort?.label,
    bestRunnerLabel: bestRunner?.label,
    bestComboLabel: bestCombo?.label,
    bestComboPnl: bestCombo?.pnl,
    trainedFile: TRAINED_FILE(),
    applyPatch: {
      ...trained.params,
      earlyAbortEnabled: trained.earlyAbortEnabled,
      runnerEnabled: trained.runnerEnabled,
    },
  };

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    regimeSkips: r.regimeSkips,
    deltaVsBaseline: +((r.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
    botPatch: r.botPatch,
  }));
  store.baseline = baseline;
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });

  if (apply) {
    applyTrainedToState(trained, { keepDisabled: true });
    log(`Applied trained section params to paper + live (abort/runner OFF)`);
  }

  log("\n=== TOP RUNS ===");
  for (const r of store.ranking.slice(0, 12)) {
    log(`${r.label}: $${r.pnl} (${r.deltaVsBaseline >= 0 ? "+" : ""}${r.deltaVsBaseline}) · ${r.trades} trades`);
  }
  log(`\nBaseline: $${baseline.pnl}`);
  log(`Best abort: ${bestAbort?.label} $${bestAbort?.pnl} (${trained.earlyAbort.deltaVsBaseline >= 0 ? "+" : ""}${trained.earlyAbort.deltaVsBaseline})`);
  log(`Best runner: ${bestRunner?.label} $${bestRunner?.pnl} (${trained.runner.deltaVsBaseline >= 0 ? "+" : ""}${trained.runner.deltaVsBaseline})`);
  log(`Trained: ${TRAINED_FILE()}`);
  log(`Results: ${RESULTS_FILE()}`);
  return trained;
}

function applyTrainedToState(trained, { keepDisabled = true } = {}) {
  const patch = {
    ...trained.earlyAbortSection,
    ...trained.runnerSection,
    earlyAbortEnabled: keepDisabled ? false : trained.earlyAbortEnabled,
    runnerEnabled: keepDisabled ? false : trained.runnerEnabled,
  };
  delete patch.enabled;
  for (const file of ["paper-bot-state.json", "live-bot-state.json"]) {
    const state = readJsonFile(dataPath(file), {}) ?? {};
    state.config = normalizeConfig({
      ...(state.config ?? {}),
      ...patch,
    });
    state.savedAt = Date.now();
    writeJsonFile(dataPath(file), state);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();
  reloadModel("paper");

  const baseBot = loadBotConfig();
  const baseSignal = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols — warm backtest klines first.");
    process.exit(1);
  }

  log(
    `Early-abort / runner ${args.train ? "TRAIN" : "sweep"} · ${args.days}d · ${symbols.length} symbols · regime ON · ${args.cacheOnly ? "cache-only" : "fetch"}${args.resume ? " · resume" : ""}`
  );

  const store = readJsonFile(RESULTS_FILE(), { runs: [] });
  store.days = args.days;
  store.symbolCount = symbols.length;
  store.cacheOnly = args.cacheOnly;
  store.regimeEnabled = true;

  const runAndStore = async (label, botPatch = {}) => {
    if (args.resume && hasRun(store, label)) {
      const cached = store.runs.find((r) => r.label === label);
      log(`skip ${label} (cached $${cached?.pnl})`);
      return cached;
    }
    const botConfig = normalizeConfig({ ...baseBot, ...botPatch });
    const row = await runBacktest({
      label,
      botConfig,
      signalCfg: baseSignal,
      days: args.days,
      symbols,
      cacheOnly: args.cacheOnly,
    });
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(row);
    writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });
    return row;
  };

  if (args.finalizeOnly) {
    const baseline = store.runs.find((r) => r.label === "baseline");
    if (!baseline) {
      console.error("No baseline run in results — run training first.");
      process.exit(1);
    }
    const bestAbort = bestRunFor(store, isAbortOnlyRun) ?? store.runs.find((r) => r.label === "early_abort_on");
    const bestRunner = bestRunFor(store, isRunnerOnlyRun) ?? store.runs.find((r) => r.label === "runner_on");
    const abortPatch = pickAbortParams(exitPatch(bestAbort));
    const runnerPatch = pickRunnerParams(exitPatch(bestRunner));
    await runAndStore("best_combo", {
      earlyAbortEnabled: true,
      runnerEnabled: true,
      ...abortPatch,
      ...runnerPatch,
    });
    await runAndStore("best_abort_only", {
      earlyAbortEnabled: true,
      runnerEnabled: false,
      ...abortPatch,
    });
    await runAndStore("best_runner_only", {
      earlyAbortEnabled: false,
      runnerEnabled: true,
      ...runnerPatch,
    });
    finalizeTraining(store, baseline, args.apply);
    return;
  }

  const baseline =
    (args.resume && store.runs.find((r) => r.label === "baseline")) ||
    (await runAndStore("baseline", { earlyAbortEnabled: false, runnerEnabled: false }));

  const abortOn = await runAndStore("early_abort_on", {
    earlyAbortEnabled: true,
    runnerEnabled: false,
  });

  const runnerOn = await runAndStore("runner_on", {
    earlyAbortEnabled: false,
    runnerEnabled: true,
  });

  await runAndStore("abort_and_runner_on", {
    earlyAbortEnabled: true,
    runnerEnabled: true,
  });

  const { abort: ABORT_SWEEPS, runner: RUNNER_SWEEPS } = pickSweeps(args);
  const alwaysSweep = args.train;

  let bestAbort = { ...abortOn };
  if (alwaysSweep || (abortOn.pnl ?? 0) > (baseline.pnl ?? 0)) {
    for (const sweep of ABORT_SWEEPS) {
      for (const v of sweep.values) {
        const label = `abort_${sweep.key}_${v}`;
        const row = await runAndStore(label, {
          earlyAbortEnabled: true,
          runnerEnabled: false,
          [sweep.key]: v,
        });
        if ((row.pnl ?? 0) > (bestAbort.pnl ?? 0)) bestAbort = row;
      }
    }
  }

  let bestRunner = { ...runnerOn };
  if (alwaysSweep || (runnerOn.pnl ?? 0) > (baseline.pnl ?? 0)) {
    for (const sweep of RUNNER_SWEEPS) {
      for (const v of sweep.values) {
        const label = `runner_${sweep.key}_${v}`;
        const row = await runAndStore(label, {
          earlyAbortEnabled: false,
          runnerEnabled: true,
          [sweep.key]: v,
        });
        if ((row.pnl ?? 0) > (bestRunner.pnl ?? 0)) bestRunner = row;
      }
    }
  }

  const abortPatch = exitPatch(bestAbort);
  const runnerPatch = exitPatch(bestRunner);
  await runAndStore("best_combo", {
    earlyAbortEnabled: true,
    runnerEnabled: true,
    ...abortPatch,
    ...runnerPatch,
  });

  const abortOnlyCombo = await runAndStore("best_abort_only", {
    earlyAbortEnabled: true,
    runnerEnabled: false,
    ...abortPatch,
  });
  const runnerOnlyCombo = await runAndStore("best_runner_only", {
    earlyAbortEnabled: false,
    runnerEnabled: true,
    ...runnerPatch,
  });

  if ((abortOnlyCombo.pnl ?? 0) > (bestAbort.pnl ?? 0)) bestAbort = abortOnlyCombo;
  if ((runnerOnlyCombo.pnl ?? 0) > (bestRunner.pnl ?? 0)) bestRunner = runnerOnlyCombo;

  finalizeTraining(store, baseline, args.apply);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
