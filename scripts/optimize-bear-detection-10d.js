#!/usr/bin/env node
/**
 * Short 10d sweep of *Bear detection geometry only (shared bull frozen).
 * Starts from best live + existing bear exit overrides + bearish ON.
 *
 *   node scripts/optimize-bear-detection-10d.js --days 10 --reset
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(8192);

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { DETECTION_OVERRIDE_BASE_KEYS } = require("../lib/side-config");

const OUT_FILE = () => dataPath("bear-detection-optimize-10d.json");

function parseArgs(argv) {
  let days = 10;
  let reset = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--reset") reset = true;
  }
  return { days: Math.max(1, Math.min(30, Math.round(days) || 10)), reset };
}

function log(msg) {
  console.error(String(msg));
}

function loadBotConfig() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    tradeSfpSignals: true,
    tradeBearishSfpSignals: true,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    armed: false,
    drawdownStopEnabled: false,
    aiRegimeBtcFastLookbackHours: local.aiRegimeBtcFastLookbackHours ?? 2,
    aiPullbackSignalBtcFastLookbackHours:
      local.aiPullbackSignalBtcFastLookbackHours ?? 2,
  });
}

function loadSignalConfig() {
  const scanner = readJsonFile(dataPath("scanner-config.json"), {}) ?? {};
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
  };
  for (const base of DETECTION_OVERRIDE_BASE_KEYS) {
    cfg[`${base}Bear`] = null;
    cfg[`${base}Bull`] = null;
  }
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

function summarize(result) {
  const trades = result.closedTrades ?? [];
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const bySignal = {};
  for (const k of ["sfp", "sfp_bear", "pullback", "pullback_bear"]) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    bySignal[k] = {
      trades: rows.length,
      pnl: +rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2),
    };
  }
  const bearPnl =
    (bySignal.sfp_bear?.pnl ?? 0) + (bySignal.pullback_bear?.pnl ?? 0);
  const bullPnl = (bySignal.sfp?.pnl ?? 0) + (bySignal.pullback?.pnl ?? 0);
  return {
    trades: trades.length,
    pnl: +pnl.toFixed(2),
    bullPnl: +bullPnl.toFixed(2),
    bearPnl: +bearPnl.toFixed(2),
    winRate: trades.length
      ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
      : 0,
    bySignal,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, fetchers }) {
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: false,
    modelScope: "paper",
    runMeta: { optimize: "bear-detection-10d", label },
  });
  return { label, ...summarize(result), elapsedSec: result.elapsedSec ?? 0 };
}

/** Short coordinate descent — ~12 runs. */
function phases() {
  return [
    {
      name: "bear_sfp_detection",
      sweeps: [
        {},
        { sfpMinSweepPctBear: 0.12 },
        { sfpMinSweepPctBear: 0.15, sfpReclaimBarsBear: 3 },
        { sfpMinSweepPctBear: 0.2, sfpReclaimBarsBear: 4 },
        { sfpMinSweepPctBear: 0.05, sfpReclaimBarsBear: 7 },
        { sfpReclaimBarsBear: 8 },
      ],
    },
    {
      name: "bear_pb_detection",
      sweeps: [
        {},
        { pullbackMaBarsBear: 5 },
        { pullbackMaBarsBear: 9, pullbackMaxDistancePctBear: 0.25 },
        { pullbackMaBarsBear: 11, pullbackMaxDistancePctBear: 0.45 },
        {
          pullbackMaBarsBear: 14,
          pullbackMaxDistancePctBear: 0.55,
          pullbackMaxBelowMaPctBear: 2,
        },
        {
          pullbackMaBarsBear: 7,
          pullbackMaxDistancePctBear: 0.25,
          pullbackMaxBelowMaPctBear: 1,
        },
      ],
    },
  ];
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch).map(([k, v]) => `${k}=${v}`);
  return `${phase}_${idx}_${parts.join("_") || "inherit"}`.slice(0, 110);
}

function pickBest(rows) {
  return [...rows].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    if (b.bearPnl !== a.bearPnl) return b.bearPnl - a.bearPnl;
    return b.trades - a.trades;
  })[0];
}

function mergeSignal(base, patch) {
  const next = { ...base, ...patch };
  applyBarConfig(next);
  return next;
}

function clearDetectionOverrides(cfg) {
  const next = { ...cfg };
  for (const base of DETECTION_OVERRIDE_BASE_KEYS) {
    next[`${base}Bear`] = null;
    next[`${base}Bull`] = null;
  }
  return next;
}

function diffDetectionPatch(base, tuned) {
  const patch = {};
  for (const baseKey of DETECTION_OVERRIDE_BASE_KEYS) {
    for (const suffix of ["Bear", "Bull"]) {
      const k = `${baseKey}${suffix}`;
      const a = base[k] ?? null;
      const b = tuned[k] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b) && b != null) patch[k] = b;
    }
  }
  return patch;
}

async function main() {
  const { days, reset } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }

  const botConfig = loadBotConfig();
  const signalBase = clearDetectionOverrides(loadSignalConfig());
  const fetchers = createFetchers();
  const baselineSnapshot = { ...signalBase };

  let store = reset
    ? { runs: [], phasesDone: [], bestSignal: null, best: null, baseline: null }
    : readJsonFile(OUT_FILE(), {
        runs: [],
        phasesDone: [],
        bestSignal: null,
        best: null,
        baseline: null,
      });

  let anchor = store.bestSignal
    ? mergeSignal(signalBase, store.bestSignal)
    : signalBase;
  const phaseList = phases();
  const totalSweeps = phaseList.reduce((s, p) => s + p.sweeps.length, 0);

  log(
    `Bear detection 10d · ${days}d · ${symbols.length} symbols · ${phaseList.length} phases · ~${totalSweeps} runs`
  );
  log(
    `Keys: ${DETECTION_OVERRIDE_BASE_KEYS.map((k) => k + "Bear").join(", ")}`
  );

  if (!store.baseline) {
    log("\n=== BASELINE (exit overrides on, detection inherit) ===");
    const row = await runBacktest({
      label: "baseline",
      botConfig,
      signalCfg: anchor,
      days,
      symbols,
      fetchers,
    });
    row.patch = {};
    store.baseline = row;
    store.runs.push(row);
    store.best = row;
    store.bestSignal = { ...anchor };
    writeJsonFile(OUT_FILE(), store);
    log(
      `→ $${row.pnl} (bull $${row.bullPnl} / bear $${row.bearPnl}) · ${row.trades} tr · WR ${row.winRate}%`
    );
    log(`  bySignal ${JSON.stringify(row.bySignal)}`);
  }

  for (const phase of phaseList) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip (done) ===`);
      anchor = mergeSignal(signalBase, store.bestSignal);
      continue;
    }

    log(`\n=== PHASE ${phase.name} (${phase.sweeps.length} variants) ===`);
    const phaseRows = [];

    for (let i = 0; i < phase.sweeps.length; i++) {
      const patch = phase.sweeps[i];
      const label = patchLabel(phase.name, patch, i);
      const cfg = Object.keys(patch).length
        ? mergeSignal(anchor, patch)
        : { ...anchor };
      applyBarConfig(cfg);

      log(`[${phase.name} ${i + 1}/${phase.sweeps.length}] ${label}`);
      const row = await runBacktest({
        label,
        botConfig,
        signalCfg: cfg,
        days,
        symbols,
        fetchers,
      });
      row.patch = patch;
      phaseRows.push(row);
      store.runs.push(row);
      log(
        `→ $${row.pnl} (bull $${row.bullPnl} / bear $${row.bearPnl}) · ${row.trades} tr · WR ${row.winRate}%`
      );
      log(`  bySignal ${JSON.stringify(row.bySignal)}`);
      writeJsonFile(OUT_FILE(), store);
    }

    const phaseBest = pickBest(phaseRows);
    const improved = phaseBest.pnl > (store.best?.pnl ?? -Infinity);
    if (Object.keys(phaseBest.patch || {}).length) {
      anchor = mergeSignal(anchor, phaseBest.patch);
    }
    store.bestSignal = { ...anchor };
    if (improved || !store.best || phaseBest.pnl >= store.best.pnl) {
      store.best = { ...phaseBest, phase: phase.name };
    }
    store.phasesDone.push(phase.name);
    writeJsonFile(OUT_FILE(), store);
    log(
      `Phase best: $${phaseBest.pnl} bear $${phaseBest.bearPnl} (${phaseBest.label})${improved ? " ↑" : ""}`
    );
  }

  const bestPatch = diffDetectionPatch(baselineSnapshot, store.bestSignal);
  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    design: {
      inherit: "shared detection when *Bear is null",
      overrideKeys: DETECTION_OVERRIDE_BASE_KEYS.map((k) => `${k}Bear`),
    },
    baseline: store.baseline,
    best: store.best,
    bestSignal: store.bestSignal,
    bestPatch,
    working: (store.best?.pnl ?? 0) > 0,
    beatsBaseline: (store.best?.pnl ?? 0) > (store.baseline?.pnl ?? -Infinity),
    beatsBullOnly: (store.best?.pnl ?? 0) > 288.78,
    runs: store.runs,
    phasesDone: store.phasesDone,
  };
  writeJsonFile(OUT_FILE(), payload);

  log("\n=== BASELINE ===");
  log(
    `$${store.baseline.pnl} (bull $${store.baseline.bullPnl} / bear $${store.baseline.bearPnl})`
  );
  log("\n=== BEST ===");
  const b = store.best;
  log(
    `$${b.pnl} (bull $${b.bullPnl} / bear $${b.bearPnl}) · ${b.trades} tr · WR ${b.winRate}%`
  );
  log(`beatsBaseline=${payload.beatsBaseline} beatsBullOnly=${payload.beatsBullOnly}`);
  log("Bear detection patch:");
  for (const [k, v] of Object.entries(bestPatch)) {
    log(`  ${k}: ${JSON.stringify(v)}`);
  }
  log(`Saved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
