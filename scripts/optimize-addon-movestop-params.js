#!/usr/bin/env node
/**
 * Add-on + move-stop parameter sweep with SFP regime ON (cache-first).
 *
 *   node scripts/optimize-addon-movestop-params.js --days 10 --cache-only
 *   node scripts/optimize-addon-movestop-params.js --days 10 --cache-only --train
 *   node scripts/optimize-addon-movestop-params.js --days 10 --cache-only --train --apply
 */

const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { DEFAULT_CONFIG, normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { ensureAllDefaultModelsOnDisk, reloadModel } = require("../lib/sfp-regime-model");

const RESULTS_FILE = () => dataPath("addon-movestop-optimization-results.json");
const TRAINED_FILE = () => dataPath("addon-movestop-trained.json");

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
  let addOnTrades = 0;
  let moveStopRaisedTrades = 0;
  for (const t of result.closedTrades ?? []) {
    const r = t.exitReason ?? "unknown";
    exits[r] = (exits[r] ?? 0) + 1;
    if ((t.addCount ?? 0) > 0) addOnTrades++;
    if (t.stopMoved) moveStopRaisedTrades++;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    regimeSkips: s.sfpRegimeSkips ?? 0,
    addOnTrades,
    moveStopRaisedTrades,
    exits,
    symbolsProcessed: result.symbolsProcessed ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, cacheOnly }) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers(cacheOnly);
  log(`\n=== RUN: ${label} ===`);
  log(
    `moveStop ${botConfig.moveStopEnabled ? "ON" : "OFF"} · addOn ${botConfig.addOnEnabled ? "ON" : "OFF"} · regime ON`
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
    runMeta: { optimize: "addon-movestop", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol) {
        const done = (p.done ?? 0) + 1;
        const total = p.total ?? symbols.length;
        const key = `${done}:${p.symbol}`;
        if (key !== lastProgressKey && (done === 1 || done % 100 === 0 || done >= total)) {
          lastProgressKey = key;
          log(`[${label}] ${done}/${total} · ${p.symbol}`);
        }
      }
    },
  });
  const summary = summarizeRun(result);
  log(
    `→ ${label}: PnL $${summary.pnl} · ${summary.trades} trades · adds ${summary.addOnTrades} · moveStop raised ${summary.moveStopRaisedTrades} · ${summary.elapsedSec}s`
  );
  return {
    label,
    days,
    botPatch: {
      moveStopEnabled: botConfig.moveStopEnabled,
      moveStopAfterMovePct: botConfig.moveStopAfterMovePct,
      moveStopOffsetPct: botConfig.moveStopOffsetPct,
      addOnEnabled: botConfig.addOnEnabled,
      addOnMarginUsdt: botConfig.addOnMarginUsdt,
      addOnMovePct: botConfig.addOnMovePct,
      addOnLeverageBoost: botConfig.addOnLeverageBoost,
      addOnMinPeakPct: botConfig.addOnMinPeakPct,
      addOnOnlyAfterMoveStop: botConfig.addOnOnlyAfterMoveStop,
    },
    ...summary,
    elapsedTotalSec: Math.round((Date.now() - started) / 1000),
  };
}

const MOVE_STOP_SWEEPS_FULL = [
  { key: "moveStopAfterMovePct", values: [0.8, 1.2, 1.5, 2.0, 3.0] },
  { key: "moveStopOffsetPct", values: [-0.5, 0, 0.5, 1.0] },
];

const MOVE_STOP_SWEEPS_TRAIN = [
  { key: "moveStopAfterMovePct", values: [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0] },
  { key: "moveStopOffsetPct", values: [-1, -0.5, 0, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0] },
];

const MOVE_STOP_SWEEPS_QUICK = [
  { key: "moveStopAfterMovePct", values: [1.0, 2.0] },
  { key: "moveStopOffsetPct", values: [0, 1.0] },
];

const ADDON_SWEEPS_FULL = [
  { key: "addOnMarginUsdt", values: [4, 6, 10, 15] },
  { key: "addOnMovePct", values: [3, 5, 7, 10] },
  { key: "addOnLeverageBoost", values: [0, 1, 2] },
  { key: "addOnMinPeakPct", values: [0, 2, 5] },
];

const ADDON_SWEEPS_TRAIN = [
  { key: "addOnMarginUsdt", values: [4, 6, 8, 10, 15, 20, 25, 35] },
  { key: "addOnMovePct", values: [2, 3, 4, 5, 6, 7, 8, 10, 12] },
  { key: "addOnLeverageBoost", values: [0, 1, 2, 3, 5] },
  { key: "addOnMinPeakPct", values: [0, 1, 2, 3, 4, 5, 7] },
];

const ADDON_SWEEPS_QUICK = [
  { key: "addOnMarginUsdt", values: [6, 15] },
  { key: "addOnMovePct", values: [4, 8] },
];

function pickSweeps(args) {
  if (args.train) {
    return { moveStop: MOVE_STOP_SWEEPS_TRAIN, addOn: ADDON_SWEEPS_TRAIN };
  }
  if (args.quick) {
    return { moveStop: MOVE_STOP_SWEEPS_QUICK, addOn: ADDON_SWEEPS_QUICK };
  }
  return { moveStop: MOVE_STOP_SWEEPS_FULL, addOn: ADDON_SWEEPS_FULL };
}

function exitPatch(row) {
  return row?.botPatch ?? {};
}

function pickMoveStopParams(patch = {}) {
  return {
    moveStopAfterMovePct: patch.moveStopAfterMovePct ?? DEFAULT_CONFIG.moveStopAfterMovePct,
    moveStopOffsetPct: patch.moveStopOffsetPct ?? DEFAULT_CONFIG.moveStopOffsetPct,
  };
}

function pickAddOnParams(patch = {}) {
  return {
    addOnMarginUsdt: patch.addOnMarginUsdt ?? DEFAULT_CONFIG.addOnMarginUsdt,
    addOnMovePct: patch.addOnMovePct ?? DEFAULT_CONFIG.addOnMovePct,
    addOnLeverageBoost: patch.addOnLeverageBoost ?? DEFAULT_CONFIG.addOnLeverageBoost,
    addOnMinPeakPct: patch.addOnMinPeakPct ?? DEFAULT_CONFIG.addOnMinPeakPct,
    addOnOnlyAfterMoveStop: patch.addOnOnlyAfterMoveStop ?? DEFAULT_CONFIG.addOnOnlyAfterMoveStop,
  };
}

function pickAddOnOnlyParams(patch = {}) {
  return pickAddOnParams(patch);
}

function pickMoveStopOnlyParams(patch = {}) {
  return pickMoveStopParams(patch);
}

function mergeSectionParams(bestMoveStop, bestAddOn) {
  return {
    ...pickMoveStopParams(exitPatch(bestMoveStop)),
    ...pickAddOnParams(exitPatch(bestAddOn)),
  };
}

function isMoveStopOnlyRun(r) {
  return r.botPatch?.moveStopEnabled && !r.botPatch?.addOnEnabled;
}

function isAddOnOnlyRun(r) {
  return r.botPatch?.addOnEnabled && !r.label?.includes("combo") && !r.label?.includes("joint");
}

function hasRun(store, label) {
  return store.runs?.some((r) => r.label === label);
}

function bestRunFor(store, pred) {
  return [...(store.runs ?? [])].filter(pred).sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))[0];
}

function finalizeTraining(store, baseline, apply) {
  const bestMoveStop =
    bestRunFor(store, isMoveStopOnlyRun) ?? store.runs.find((r) => r.label === "move_stop_on");

  const bestAddOn =
    bestRunFor(
      store,
      (r) =>
        r.botPatch?.addOnEnabled &&
        !r.label?.includes("combo") &&
        !r.label?.includes("joint") &&
        r.label !== "add_on_on"
    ) ?? store.runs.find((r) => r.label === "add_on_on");

  const bestCombo =
    bestRunFor(
      store,
      (r) =>
        r.botPatch?.moveStopEnabled &&
        r.botPatch?.addOnEnabled &&
        (r.label === "best_combo" || r.label === "move_stop_and_add_on")
    ) ??
    bestRunFor(
      store,
      (r) => r.botPatch?.moveStopEnabled && r.botPatch?.addOnEnabled
    ) ??
    store.runs.find((r) => r.label === "best_combo");

  const moveStopBeatsBaseline = (bestMoveStop?.pnl ?? 0) > (baseline.pnl ?? 0);
  const addOnBeatsBaseline = (bestAddOn?.pnl ?? 0) > (baseline.pnl ?? 0);
  const comboBeatsBaseline = (bestCombo?.pnl ?? 0) > (baseline.pnl ?? 0);
  const sectionParams = mergeSectionParams(bestMoveStop, bestAddOn);

  const trained = {
    trainedAt: new Date().toISOString(),
    days: store.days,
    symbolCount: store.symbolCount,
    baselinePnl: baseline.pnl,
    moveStopSection: {
      enabled: moveStopBeatsBaseline,
      ...pickMoveStopParams(exitPatch(bestMoveStop)),
    },
    addOnSection: {
      enabled: addOnBeatsBaseline,
      ...pickAddOnParams(exitPatch(bestAddOn)),
    },
    moveStop: {
      label: bestMoveStop?.label,
      pnl: bestMoveStop?.pnl,
      deltaVsBaseline: +((bestMoveStop?.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
      moveStopRaisedTrades: bestMoveStop?.moveStopRaisedTrades,
      params: exitPatch(bestMoveStop),
      beatsBaseline: moveStopBeatsBaseline,
    },
    addOn: {
      label: bestAddOn?.label,
      pnl: bestAddOn?.pnl,
      deltaVsBaseline: +((bestAddOn?.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
      addOnTrades: bestAddOn?.addOnTrades,
      params: exitPatch(bestAddOn),
      beatsBaseline: addOnBeatsBaseline,
    },
    combo: {
      label: bestCombo?.label,
      pnl: bestCombo?.pnl,
      deltaVsBaseline: +((bestCombo?.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
      addOnTrades: bestCombo?.addOnTrades,
      moveStopRaisedTrades: bestCombo?.moveStopRaisedTrades,
      params: exitPatch(bestCombo),
      beatsBaseline: comboBeatsBaseline,
    },
    moveStopEnabled: moveStopBeatsBaseline,
    addOnEnabled: addOnBeatsBaseline,
    params: {
      moveStopEnabled: moveStopBeatsBaseline,
      addOnEnabled: addOnBeatsBaseline,
      ...sectionParams,
    },
  };
  writeJsonFile(TRAINED_FILE(), trained);

  store.recommendation = {
    moveStopEnabled: moveStopBeatsBaseline,
    addOnEnabled: addOnBeatsBaseline,
    bestMoveStopLabel: bestMoveStop?.label,
    bestAddOnLabel: bestAddOn?.label,
    bestComboLabel: bestCombo?.label,
    bestComboPnl: bestCombo?.pnl,
    trainedFile: TRAINED_FILE(),
    applyPatch: {
      ...trained.params,
      moveStopEnabled: trained.moveStopEnabled,
      addOnEnabled: trained.addOnEnabled,
    },
  };

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    addOnTrades: r.addOnTrades,
    moveStopRaisedTrades: r.moveStopRaisedTrades,
    regimeSkips: r.regimeSkips,
    deltaVsBaseline: +((r.pnl ?? 0) - (baseline.pnl ?? 0)).toFixed(2),
    botPatch: r.botPatch,
  }));
  store.baseline = baseline;
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });

  if (apply) {
    applyTrainedToState(trained);
    log(`Applied trained section params to paper + live`);
  }

  log("\n=== TOP RUNS ===");
  for (const r of store.ranking.slice(0, 15)) {
    log(
      `${r.label}: $${r.pnl} (${r.deltaVsBaseline >= 0 ? "+" : ""}${r.deltaVsBaseline}) · ${r.trades} tr · adds ${r.addOnTrades ?? 0}`
    );
  }
  log(`\nBaseline: $${baseline.pnl}`);
  log(
    `Best move-stop: ${bestMoveStop?.label} $${bestMoveStop?.pnl} (${trained.moveStop.deltaVsBaseline >= 0 ? "+" : ""}${trained.moveStop.deltaVsBaseline})`
  );
  log(
    `Best add-on: ${bestAddOn?.label} $${bestAddOn?.pnl} (${trained.addOn.deltaVsBaseline >= 0 ? "+" : ""}${trained.addOn.deltaVsBaseline})`
  );
  log(
    `Best combo: ${bestCombo?.label} $${bestCombo?.pnl} (${trained.combo.deltaVsBaseline >= 0 ? "+" : ""}${trained.combo.deltaVsBaseline})`
  );
  log(`Trained: ${TRAINED_FILE()}`);
  log(`Results: ${RESULTS_FILE()}`);
  return trained;
}

function applyTrainedToState(trained) {
  const patch = {
    ...trained.moveStopSection,
    ...trained.addOnSection,
    moveStopEnabled: trained.moveStopEnabled,
    addOnEnabled: trained.addOnEnabled,
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
    `Add-on / move-stop ${args.train ? "TRAIN" : "sweep"} · ${args.days}d · ${symbols.length} symbols · regime ON · ${args.cacheOnly ? "cache-only" : "fetch"}${args.resume ? " · resume" : ""}`
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
    const bestMoveStop = bestRunFor(store, isMoveStopOnlyRun) ?? store.runs.find((r) => r.label === "move_stop_on");
    const bestAddOn =
      bestRunFor(
        store,
        (r) => r.botPatch?.addOnEnabled && !r.label?.includes("combo")
      ) ?? store.runs.find((r) => r.label === "add_on_on");
    const moveStopPatch = pickMoveStopParams(exitPatch(bestMoveStop));
    const addOnPatch = pickAddOnParams(exitPatch(bestAddOn));
    await runAndStore("best_combo", {
      moveStopEnabled: true,
      addOnEnabled: true,
      ...moveStopPatch,
      ...addOnPatch,
    });
    finalizeTraining(store, baseline, args.apply);
    return;
  }

  const baseline =
    (args.resume && store.runs.find((r) => r.label === "baseline")) ||
    (await runAndStore("baseline", {
      moveStopEnabled: baseBot.moveStopEnabled,
      addOnEnabled: false,
    }));

  const moveStopOn = await runAndStore("move_stop_on", {
    moveStopEnabled: true,
    addOnEnabled: false,
  });

  await runAndStore("move_stop_off", {
    moveStopEnabled: false,
    addOnEnabled: false,
  });

  const addOnOn = await runAndStore("add_on_on", {
    moveStopEnabled: true,
    addOnEnabled: true,
  });

  await runAndStore("addon_only_after_movestop", {
    moveStopEnabled: true,
    addOnEnabled: true,
    addOnOnlyAfterMoveStop: true,
  });

  await runAndStore("move_stop_and_add_on", {
    moveStopEnabled: true,
    addOnEnabled: true,
  });

  const { moveStop: MOVE_STOP_SWEEPS, addOn: ADDON_SWEEPS } = pickSweeps(args);
  const alwaysSweep = args.train;

  let bestMoveStop = { ...moveStopOn };
  if (alwaysSweep || (moveStopOn.pnl ?? 0) > (baseline.pnl ?? 0)) {
    for (const sweep of MOVE_STOP_SWEEPS) {
      for (const v of sweep.values) {
        const label = `movestop_${sweep.key}_${v}`;
        const row = await runAndStore(label, {
          moveStopEnabled: true,
          addOnEnabled: false,
          [sweep.key]: v,
        });
        if ((row.pnl ?? 0) > (bestMoveStop.pnl ?? 0)) bestMoveStop = row;
      }
    }
  }

  let bestAddOn = { ...addOnOn };
  if (alwaysSweep || (addOnOn.pnl ?? 0) > (baseline.pnl ?? 0)) {
    for (const sweep of ADDON_SWEEPS) {
      for (const v of sweep.values) {
        const label = `addon_${sweep.key}_${v}`;
        const row = await runAndStore(label, {
          moveStopEnabled: true,
          addOnEnabled: true,
          [sweep.key]: v,
        });
        if ((row.pnl ?? 0) > (bestAddOn.pnl ?? 0)) bestAddOn = row;
      }
    }
    for (const onlyAfter of [false, true]) {
      const label = `addon_onlyAfterMoveStop_${onlyAfter}`;
      const row = await runAndStore(label, {
        moveStopEnabled: true,
        addOnEnabled: true,
        addOnOnlyAfterMoveStop: onlyAfter,
        ...pickAddOnParams(exitPatch(bestAddOn)),
      });
      if ((row.pnl ?? 0) > (bestAddOn.pnl ?? 0)) bestAddOn = row;
    }
  }

  const moveStopPatch = pickMoveStopOnlyParams(exitPatch(bestMoveStop));
  const addOnPatch = pickAddOnOnlyParams(exitPatch(bestAddOn));
  await runAndStore("best_combo", {
    moveStopEnabled: true,
    addOnEnabled: true,
    ...moveStopPatch,
    ...addOnPatch,
  });

  finalizeTraining(store, baseline, args.apply);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
