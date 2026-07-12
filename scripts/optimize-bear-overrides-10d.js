#!/usr/bin/env node
/**
 * With best live setup + bearish ON, sweep only *Bear overrides on 10d cache.
 *
 *   node scripts/optimize-bear-overrides-10d.js --days 10 --reset
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
const { SIDE_OVERRIDE_BASE_KEYS } = require("../lib/side-config");

const OUT_FILE = () => dataPath("bear-overrides-optimize-10d.json");

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

function loadBestWithBearish() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
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
    runMeta: { optimize: "bear-overrides-10d", label },
  });
  return { label, ...summarize(result), elapsedSec: result.elapsedSec ?? 0 };
}

function clearBearOverrides(cfg) {
  const next = { ...cfg };
  for (const base of SIDE_OVERRIDE_BASE_KEYS) {
    next[`${base}Bear`] = null;
  }
  return next;
}

function phases() {
  return [
    {
      name: "bear_tp",
      sweeps: [
        {},
        { sfpTakeProfitPctBear: 2.5, takeProfitPctBear: 2.5 },
        { sfpTakeProfitPctBear: 3, takeProfitPctBear: 3 },
        { sfpTakeProfitPctBear: 4, takeProfitPctBear: 3.5 },
        { sfpTakeProfitPctBear: 5, takeProfitPctBear: 4 },
        { sfpTakeProfitPctBear: 2, takeProfitPctBear: 2, takeProfitMinPctBear: 0.8 },
      ],
    },
    {
      name: "bear_sl",
      sweeps: [
        {},
        { stopLossBelowCorridorPctBear: 1.5, minSmartStopDistancePctBear: 0.6 },
        { stopLossBelowCorridorPctBear: 2, minSmartStopDistancePctBear: 0.8 },
        { stopLossBelowCorridorPctBear: 3, minSmartStopDistancePctBear: 1 },
        { stopLossBelowCorridorPctBear: 3.5, minSmartStopDistancePctBear: 1.2 },
      ],
    },
    {
      name: "bear_ai_exit_scales",
      sweeps: [
        {},
        { aiExitLevelsSlScaleBear: 1.0, aiExitLevelsTpScaleBear: 1.0 },
        { aiExitLevelsSlScaleBear: 1.15, aiExitLevelsTpScaleBear: 1.15 },
        { aiExitLevelsSlScaleBear: 1.3, aiExitLevelsTpScaleBear: 1.5 },
        { aiExitLevelsSlScaleBear: 1.5, aiExitLevelsTpScaleBear: 1.3 },
        { aiExitLevelsSlScaleBear: 1.6, aiExitLevelsTpScaleBear: 1.8 },
      ],
    },
    {
      name: "bear_early_abort",
      sweeps: [
        {},
        { earlyAbortEnabledBear: false },
        {
          earlyAbortEnabledBear: true,
          earlyAbortBarsBear: 12,
          earlyAbortInvalidateBarsBear: 2,
          earlyAbortMinProgressPctBear: 0.5,
          earlyAbortMaxAdversePctBear: 1.2,
        },
        {
          earlyAbortEnabledBear: true,
          earlyAbortBarsBear: 20,
          earlyAbortInvalidateBarsBear: 2,
          earlyAbortMinProgressPctBear: 0.4,
          earlyAbortMaxAdversePctBear: 1.5,
        },
        {
          earlyAbortEnabledBear: true,
          earlyAbortBarsBear: 8,
          earlyAbortInvalidateBarsBear: 3,
          earlyAbortMinProgressPctBear: 0.6,
          earlyAbortMaxAdversePctBear: 0.9,
        },
      ],
    },
    {
      name: "bear_corridor",
      sweeps: [
        {},
        { maxSfpCorridorWidthPctBear: 10, maxPullbackCorridorWidthPctBear: 10 },
        { maxSfpCorridorWidthPctBear: 13, maxPullbackCorridorWidthPctBear: 13 },
        { maxSfpCorridorWidthPctBear: 16, maxPullbackCorridorWidthPctBear: 16 },
        { maxSfpCorridorWidthPctBear: 20, maxPullbackCorridorWidthPctBear: 18 },
      ],
    },
    {
      name: "bear_regime_thresholds",
      // already-split AI thresholds — tune bear side only
      sweeps: [
        {},
        {
          aiSfpRegimeBearThreshold: 0.78,
          aiSfpRegimeGbmBearThreshold: 0.76,
          aiPullbackSignalBearThreshold: 0.56,
          aiPullbackSignalGbmBearThreshold: 0.52,
        },
        {
          aiSfpRegimeBearThreshold: 0.84,
          aiSfpRegimeGbmBearThreshold: 0.82,
          aiPullbackSignalBearThreshold: 0.62,
          aiPullbackSignalGbmBearThreshold: 0.58,
        },
        {
          aiSfpRegimeBearThreshold: 0.88,
          aiSfpRegimeGbmBearThreshold: 0.86,
          aiPullbackSignalBearThreshold: 0.66,
          aiPullbackSignalGbmBearThreshold: 0.62,
        },
        {
          aiSfpRegimeBearThreshold: 0.72,
          aiSfpRegimeGbmBearThreshold: 0.7,
          aiPullbackSignalBearThreshold: 0.52,
          aiPullbackSignalGbmBearThreshold: 0.5,
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
  // Prefer total PnL; tie-break by better bear PnL then more trades
  return [...rows].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    if (b.bearPnl !== a.bearPnl) return b.bearPnl - a.bearPnl;
    return b.trades - a.trades;
  })[0];
}

function mergeConfig(base, patch) {
  return normalizeLiveConfig({
    ...base,
    ...patch,
    enabled: true,
    armed: false,
    drawdownStopEnabled: false,
    blockedSymbols: base.blockedSymbols,
    tradeSfpSignals: true,
    tradeBearishSfpSignals: true,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
  });
}

function diffBearPatch(base, tuned) {
  const patch = {};
  for (const k of Object.keys(tuned)) {
    if (!k.endsWith("Bear") && !/BearThreshold|GbmBear/.test(k)) continue;
    if (JSON.stringify(base[k]) !== JSON.stringify(tuned[k])) patch[k] = tuned[k];
  }
  // also catch ai*BearThreshold style
  for (const k of Object.keys(tuned)) {
    if (/BearThreshold|GbmBearThreshold/.test(k)) {
      if (JSON.stringify(base[k]) !== JSON.stringify(tuned[k])) patch[k] = tuned[k];
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

  const liveBase = clearBearOverrides(loadBestWithBearish());
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const baselineSnapshot = { ...liveBase };

  let store = reset
    ? { runs: [], phasesDone: [], bestConfig: null, best: null, baseline: null }
    : readJsonFile(OUT_FILE(), {
        runs: [],
        phasesDone: [],
        bestConfig: null,
        best: null,
        baseline: null,
      });

  let anchor = store.bestConfig ? mergeConfig(liveBase, store.bestConfig) : liveBase;
  const phaseList = phases();
  const totalSweeps = phaseList.reduce((s, p) => s + p.sweeps.length, 0);

  log(
    `Bear overrides 10d · ${days}d · ${symbols.length} symbols · ${phaseList.length} phases · ~${totalSweeps} runs`
  );
  log(
    `Bull shared frozen · bearish ON · overrides: ${SIDE_OVERRIDE_BASE_KEYS.map((k) => k + "Bear").join(", ")}`
  );

  if (!store.baseline) {
    log("\n=== BASELINE (best + bearish, no bear overrides) ===");
    const row = await runBacktest({
      label: "baseline",
      botConfig: anchor,
      signalCfg,
      days,
      symbols,
      fetchers,
    });
    row.patch = {};
    store.baseline = row;
    store.runs.push(row);
    store.best = row;
    store.bestConfig = { ...anchor };
    writeJsonFile(OUT_FILE(), store);
    log(
      `→ $${row.pnl} (bull $${row.bullPnl} / bear $${row.bearPnl}) · ${row.trades} tr · WR ${row.winRate}%`
    );
    log(`  bySignal ${JSON.stringify(row.bySignal)}`);
  }

  for (const phase of phaseList) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip (done) ===`);
      anchor = mergeConfig(liveBase, store.bestConfig);
      continue;
    }

    log(`\n=== PHASE ${phase.name} (${phase.sweeps.length} variants) ===`);
    const phaseRows = [];

    for (let i = 0; i < phase.sweeps.length; i++) {
      const patch = phase.sweeps[i];
      const label = patchLabel(phase.name, patch, i);
      const botConfig = mergeConfig(anchor, patch);
      log(`[${phase.name} ${i + 1}/${phase.sweeps.length}] ${label}`);
      const row = await runBacktest({
        label,
        botConfig,
        signalCfg,
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
    anchor = mergeConfig(anchor, phaseBest.patch);
    store.bestConfig = { ...anchor };
    if (improved || !store.best || phaseBest.pnl >= store.best.pnl) {
      store.best = { ...phaseBest, phase: phase.name };
    }
    store.phasesDone.push(phase.name);
    writeJsonFile(OUT_FILE(), store);
    log(
      `Phase best: $${phaseBest.pnl} bear $${phaseBest.bearPnl} (${phaseBest.label})${improved ? " ↑" : ""}`
    );
  }

  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    design: {
      inherit: "shared keys when *Bear is null",
      overrideKeys: SIDE_OVERRIDE_BASE_KEYS.map((k) => `${k}Bear`),
      alsoTuned: [
        "aiSfpRegimeBearThreshold",
        "aiSfpRegimeGbmBearThreshold",
        "aiPullbackSignalBearThreshold",
        "aiPullbackSignalGbmBearThreshold",
      ],
    },
    baseline: store.baseline,
    best: store.best,
    bestConfig: store.bestConfig,
    bestPatch: diffBearPatch(baselineSnapshot, store.bestConfig),
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
  log("Bear override patch:");
  for (const [k, v] of Object.entries(payload.bestPatch)) {
    log(`  ${k}: ${JSON.stringify(v)}`);
  }
  log(`Saved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
