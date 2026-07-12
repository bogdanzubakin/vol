#!/usr/bin/env node
/**
 * Start from best live setup with bearish signals ON, then coordinate-descent
 * over signal-related settings on 10d cache.
 *
 *   node scripts/optimize-live-signals-bearish-10d.js --days 10 --reset
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

const ROOT = path.join(__dirname, "..");
const OUT_FILE = () => dataPath("live-signals-bearish-optimize-10d.json");

const FROZEN = new Set([
  "leverage",
  "positionSizeUsdt",
  "maxOpenPositions",
  "initialDeposit",
  "armed",
  "enabled",
  "blockedSymbols",
  // non-signal exits / size kept from best setup
  "stopLossBelowCorridorPct",
  "stopLossFallbackPnlPct",
  "takeProfitPct",
  "takeProfitMinPct",
  "minSmartStopDistancePct",
  "maxSfpCorridorWidthPct",
  "sfpTakeProfitPct",
  "maxPullbackCorridorWidthPct",
  "smartExitLevelsEnabled",
  "aiExitLevelsEnabled",
  "aiExitLevelsMode",
  "aiExitLevelsSlScale",
  "aiExitLevelsTpScale",
  "aiExitLevelsSlClampMin",
  "aiExitLevelsSlClampMax",
  "aiExitLevelsTpClampMin",
  "aiExitLevelsTpClampMax",
  "aiExitLevelsMinTpToSlRatio",
  "aiExitLevelsSkipUnfixable",
  "aiExitLevelsLegacyDisabled",
  "addOnEnabled",
  "addOnMarginUsdt",
  "addOnMovePct",
  "addOnLeverageBoost",
  "addOnMinPeakPct",
  "addOnOnlyAfterMoveStop",
  "moveStopEnabled",
  "moveStopAfterMovePct",
  "moveStopOffsetPct",
  "earlyAbortEnabled",
  "earlyAbortBars",
  "earlyAbortInvalidateBars",
  "earlyAbortMinProgressPct",
  "earlyAbortMaxAdversePct",
  "runnerEnabled",
  "runnerActivatePct",
  "runnerActivateTpFraction",
  "runnerGivebackPct",
  "runnerStructureBars",
  "runnerReversalSignals",
  "aiEarlyExitEnabled",
  "aiEarlyExitThreshold",
  "aiEarlyExitHardThreshold",
  "aiEarlyExitSoftThreshold",
  "aiEarlyExitMinBars",
  "aiEarlyExitBarCloseOnly",
  "autoBlockAfterConsecutiveSl",
  "drawdownStopEnabled",
  "drawdownStopPct",
]);

function parseArgs(argv) {
  let days = 10;
  let reset = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--reset") reset = true;
  }
  return {
    days: Math.max(1, Math.min(30, Math.round(days) || 10)),
    reset,
  };
}

function log(msg) {
  console.error(String(msg));
}

function loadBestBase() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  const merged = {
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    // force bearish ON as requested
    tradeSfpSignals: true,
    tradeBearishSfpSignals: true,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    armed: false,
    drawdownStopEnabled: false,
    aiRegimeBtcFastLookbackHours: local.aiRegimeBtcFastLookbackHours ?? 2,
    aiPullbackSignalBtcFastLookbackHours:
      local.aiPullbackSignalBtcFastLookbackHours ?? 2,
  };
  return normalizeLiveConfig(merged);
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
  return {
    trades: trades.length,
    pnl: +pnl.toFixed(2),
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
    runMeta: { optimize: "live-signals-bearish-10d", label },
  });
  return { label, ...summarize(result), elapsedSec: result.elapsedSec ?? 0 };
}

function phases() {
  return [
    {
      name: "signal_mix",
      sweeps: [
        // all four (forced baseline)
        {
          tradeSfpSignals: true,
          tradeBearishSfpSignals: true,
          tradePullbackSignals: true,
          tradeBearishPullbackSignals: true,
          extremalSpikeGateEnabled: false,
        },
        {
          tradeSfpSignals: true,
          tradeBearishSfpSignals: true,
          tradePullbackSignals: true,
          tradeBearishPullbackSignals: true,
          extremalSpikeGateEnabled: true,
        },
        // drop bull PB
        {
          tradeSfpSignals: true,
          tradeBearishSfpSignals: true,
          tradePullbackSignals: false,
          tradeBearishPullbackSignals: true,
          extremalSpikeGateEnabled: false,
        },
        // drop bull SFP
        {
          tradeSfpSignals: false,
          tradeBearishSfpSignals: true,
          tradePullbackSignals: true,
          tradeBearishPullbackSignals: true,
          extremalSpikeGateEnabled: false,
        },
        // SFP both only
        {
          tradeSfpSignals: true,
          tradeBearishSfpSignals: true,
          tradePullbackSignals: false,
          tradeBearishPullbackSignals: false,
          extremalSpikeGateEnabled: false,
        },
        // PB both only
        {
          tradeSfpSignals: false,
          tradeBearishSfpSignals: false,
          tradePullbackSignals: true,
          tradeBearishPullbackSignals: true,
          extremalSpikeGateEnabled: false,
        },
        // bear-only both kinds
        {
          tradeSfpSignals: false,
          tradeBearishSfpSignals: true,
          tradePullbackSignals: false,
          tradeBearishPullbackSignals: true,
          extremalSpikeGateEnabled: false,
        },
      ],
    },
    {
      name: "ai_sfp_regime",
      sweeps: [
        { aiSfpRegimeEnabled: false },
        {
          aiSfpRegimeEnabled: true,
          aiSfpRegimeFundingOiGbmEnabled: true,
          aiSfpRegimeBullThreshold: 0.78,
          aiSfpRegimeBearThreshold: 0.72,
          aiSfpRegimeGbmBullThreshold: 0.72,
          aiSfpRegimeGbmBearThreshold: 0.7,
        },
        {
          aiSfpRegimeEnabled: true,
          aiSfpRegimeFundingOiGbmEnabled: true,
          aiSfpRegimeBullThreshold: 0.84,
          aiSfpRegimeBearThreshold: 0.78,
          aiSfpRegimeGbmBullThreshold: 0.78,
          aiSfpRegimeGbmBearThreshold: 0.76,
        },
        {
          aiSfpRegimeEnabled: true,
          aiSfpRegimeFundingOiGbmEnabled: true,
          aiSfpRegimeBullThreshold: 0.84,
          aiSfpRegimeBearThreshold: 0.84,
          aiSfpRegimeGbmBullThreshold: 0.78,
          aiSfpRegimeGbmBearThreshold: 0.82,
        },
        {
          aiSfpRegimeEnabled: true,
          aiSfpRegimeFundingOiGbmEnabled: true,
          aiSfpRegimeBullThreshold: 0.88,
          aiSfpRegimeBearThreshold: 0.86,
          aiSfpRegimeGbmBullThreshold: 0.82,
          aiSfpRegimeGbmBearThreshold: 0.84,
        },
        {
          aiSfpRegimeEnabled: true,
          aiSfpRegimeFundingOiGbmEnabled: false,
          aiSfpRegimeBullThreshold: 0.84,
          aiSfpRegimeBearThreshold: 0.84,
        },
      ],
    },
    {
      name: "ai_pb_signal",
      sweeps: [
        { aiPullbackSignalEnabled: false },
        {
          aiPullbackSignalEnabled: true,
          aiPullbackSignalFundingOiGbmEnabled: true,
          aiPullbackSignalBullThreshold: 0.5,
          aiPullbackSignalBearThreshold: 0.52,
          aiPullbackSignalGbmBullThreshold: 0.48,
          aiPullbackSignalGbmBearThreshold: 0.5,
        },
        {
          aiPullbackSignalEnabled: true,
          aiPullbackSignalFundingOiGbmEnabled: true,
          aiPullbackSignalBullThreshold: 0.54,
          aiPullbackSignalBearThreshold: 0.56,
          aiPullbackSignalGbmBullThreshold: 0.5,
          aiPullbackSignalGbmBearThreshold: 0.52,
        },
        {
          aiPullbackSignalEnabled: true,
          aiPullbackSignalFundingOiGbmEnabled: true,
          aiPullbackSignalBullThreshold: 0.58,
          aiPullbackSignalBearThreshold: 0.62,
          aiPullbackSignalGbmBullThreshold: 0.54,
          aiPullbackSignalGbmBearThreshold: 0.58,
        },
        {
          aiPullbackSignalEnabled: true,
          aiPullbackSignalFundingOiGbmEnabled: true,
          aiPullbackSignalBullThreshold: 0.54,
          aiPullbackSignalBearThreshold: 0.66,
          aiPullbackSignalGbmBullThreshold: 0.5,
          aiPullbackSignalGbmBearThreshold: 0.62,
        },
      ],
    },
    {
      name: "ai_pb_regime",
      sweeps: [
        { aiPullbackRegimeEnabled: false },
        {
          aiPullbackRegimeEnabled: true,
          aiPullbackRegimeBullThreshold: 0.76,
          aiPullbackRegimeBearThreshold: 0.74,
        },
        {
          aiPullbackRegimeEnabled: true,
          aiPullbackRegimeBullThreshold: 0.84,
          aiPullbackRegimeBearThreshold: 0.82,
        },
        {
          aiPullbackRegimeEnabled: true,
          aiPullbackRegimeBullThreshold: 0.84,
          aiPullbackRegimeBearThreshold: 0.88,
        },
      ],
    },
    {
      name: "ai_pb_pattern_break",
      sweeps: [
        { aiPullbackPatternBreakEnabled: false },
        {
          aiPullbackPatternBreakEnabled: true,
          aiPullbackPatternBreakBullThreshold: 0.72,
          aiPullbackPatternBreakBearThreshold: 0.7,
        },
        {
          aiPullbackPatternBreakEnabled: true,
          aiPullbackPatternBreakBullThreshold: 0.78,
          aiPullbackPatternBreakBearThreshold: 0.8,
        },
      ],
    },
    {
      name: "pb_early_invalidation",
      sweeps: [
        { pbEarlyInvalidationEnabled: false },
        {
          pbEarlyInvalidationEnabled: true,
          pbEarlyInvalidationBars: 8,
          pbEarlyInvalidationInvalidateBars: 3,
          pbEarlyInvalidationMinProgressPct: 0.4,
          pbEarlyInvalidationMaxAdversePct: 0.75,
        },
        {
          pbEarlyInvalidationEnabled: true,
          pbEarlyInvalidationBars: 10,
          pbEarlyInvalidationInvalidateBars: 4,
          pbEarlyInvalidationMinProgressPct: 0.35,
          pbEarlyInvalidationMaxAdversePct: 0.9,
        },
        {
          pbEarlyInvalidationEnabled: true,
          pbEarlyInvalidationBars: 6,
          pbEarlyInvalidationInvalidateBars: 2,
          pbEarlyInvalidationMinProgressPct: 0.45,
          pbEarlyInvalidationMaxAdversePct: 0.6,
        },
      ],
    },
    {
      name: "extremal_gate",
      sweeps: [
        { extremalSpikeGateEnabled: false },
        { extremalSpikeGateEnabled: true },
      ],
    },
  ];
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch)
    .slice(0, 6)
    .map(([k, v]) => `${k.replace(/^ai|^trade|^pb/, "").slice(0, 14)}=${v}`);
  return `${phase}_${idx}_${parts.join("_")}`.slice(0, 110);
}

function pickBest(rows) {
  return [...rows].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    return b.trades - a.trades;
  })[0];
}

function mergeConfig(base, patch) {
  const next = { ...base, ...patch };
  for (const k of FROZEN) {
    if (k in base) next[k] = base[k];
  }
  next.enabled = true;
  next.armed = false;
  next.drawdownStopEnabled = false;
  next.blockedSymbols = base.blockedSymbols;
  return normalizeLiveConfig(next);
}

function diffPatch(base, tuned) {
  const patch = {};
  for (const k of Object.keys(tuned)) {
    if (FROZEN.has(k)) continue;
    if (JSON.stringify(base[k]) !== JSON.stringify(tuned[k])) patch[k] = tuned[k];
  }
  return patch;
}

function logEnabled(cfg) {
  log(
    `Signals: SFP ${cfg.tradeSfpSignals}/${cfg.tradeBearishSfpSignals} · PB ${cfg.tradePullbackSignals}/${cfg.tradeBearishPullbackSignals} · extremal ${cfg.extremalSpikeGateEnabled}`
  );
  log(
    `AI: sfpReg ${cfg.aiSfpRegimeEnabled} (${cfg.aiSfpRegimeGbmBullThreshold}/${cfg.aiSfpRegimeGbmBearThreshold}) · pbSig ${cfg.aiPullbackSignalEnabled} (${cfg.aiPullbackSignalBullThreshold}/${cfg.aiPullbackSignalBearThreshold}) · pbReg ${cfg.aiPullbackRegimeEnabled} · pbBreak ${cfg.aiPullbackPatternBreakEnabled} · pbEarlyInv ${cfg.pbEarlyInvalidationEnabled}`
  );
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

  const liveBase = loadBestBase();
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
    `Bearish signals 10d tune · ${days}d · ${symbols.length} symbols · ${phaseList.length} phases · ~${totalSweeps} runs`
  );
  logEnabled(anchor);

  if (!store.baseline) {
    log("\n=== BASELINE (best + bearish ON) ===");
    const row = await runBacktest({
      label: "baseline_bearish",
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
    log(`→ $${row.pnl} · ${row.trades} tr · WR ${row.winRate}%`);
    if (row.bySignal) log(`  bySignal ${JSON.stringify(row.bySignal)}`);
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
      log(`→ $${row.pnl} · ${row.trades} tr · WR ${row.winRate}%`);
      if (row.bySignal) log(`  bySignal ${JSON.stringify(row.bySignal)}`);
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
    log(`Phase best: $${phaseBest.pnl} (${phaseBest.label})${improved ? " ↑" : ""}`);
    logEnabled(anchor);
  }

  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    note:
      "Best live setup + bearish ON, then coordinate descent over signal mix + AI signal filters on 10d.",
    baseline: store.baseline,
    best: store.best,
    bestConfig: store.bestConfig,
    bestPatch: diffPatch(baselineSnapshot, store.bestConfig),
    working: (store.best?.pnl ?? 0) > 0,
    beatsBullOnly: (store.best?.pnl ?? 0) > 288.78,
    runs: store.runs,
    phasesDone: store.phasesDone,
  };
  writeJsonFile(OUT_FILE(), payload);

  log("\n=== BASELINE (best + bearish) ===");
  log(`$${store.baseline.pnl} · ${store.baseline.trades} · WR ${store.baseline.winRate}%`);
  log("\n=== BEST ===");
  const b = store.best;
  log(
    `$${b.pnl} · ${b.trades} · WR ${b.winRate}% (${b.label}) · working=${payload.working} · beatsBullOnly=${payload.beatsBullOnly}`
  );
  log("Recommended patch:");
  for (const [k, v] of Object.entries(payload.bestPatch)) {
    log(`  ${k}: ${JSON.stringify(v)}`);
  }
  log(`Saved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
