#!/usr/bin/env node
/**
 * Coordinate-descent over all live-bot settings except General (leverage / size / maxOpen)
 * on cached 10d data. Finds a working (best PnL) setup.
 *
 *   node scripts/optimize-live-all-settings-10d.js
 *   node scripts/optimize-live-all-settings-10d.js --days 10 --reset
 *   node scripts/optimize-live-all-settings-10d.js --days 10 --quick
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
const OUT_FILE = () => dataPath("live-all-settings-optimize-10d.json");

const FROZEN_GENERAL = new Set([
  "leverage",
  "positionSizeUsdt",
  "maxOpenPositions",
  "initialDeposit",
  "armed",
  "enabled",
]);

function parseArgs(argv) {
  let days = 10;
  let quick = false;
  let reset = false;
  let liveDbDir = process.env.LIVE_DB_DIR || path.join(ROOT, ".cache", "remote-db");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--live-db" && argv[i + 1]) liveDbDir = argv[++i];
    else if (argv[i] === "--quick") quick = true;
    else if (argv[i] === "--reset") reset = true;
  }
  return {
    days: Math.max(1, Math.min(30, Math.round(days) || 10)),
    liveDbDir,
    quick,
    reset,
  };
}

function log(msg) {
  console.error(String(msg));
}

function loadLiveConfig(liveDbDir) {
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config;
  if (local) {
    return normalizeLiveConfig({
      enabled: true,
      ...local,
      armed: false,
      drawdownStopEnabled: false,
      aiRegimeBtcFastLookbackHours: local.aiRegimeBtcFastLookbackHours ?? 2,
      aiPullbackSignalBtcFastLookbackHours:
        local.aiPullbackSignalBtcFastLookbackHours ?? 2,
    });
  }
  const dbFile = path.join(liveDbDir, "vol.db");
  if (!fs.existsSync(dbFile)) throw new Error("No live-bot-state.json or remote DB");
  const Database = require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true });
  try {
    const { loadBotRuntime } = require("../lib/db/repos/bot-state");
    const runtime = loadBotRuntime(db, "live");
    return normalizeLiveConfig({
      enabled: true,
      ...runtime.config,
      armed: false,
      drawdownStopEnabled: false,
      aiRegimeBtcFastLookbackHours: 2,
      aiPullbackSignalBtcFastLookbackHours: 2,
    });
  } finally {
    db.close();
  }
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
    runMeta: { optimize: "live-all-settings-10d", label },
  });
  return { label, ...summarize(result), elapsedSec: result.elapsedSec ?? 0 };
}

function phases(quick) {
  const signalTypes = {
    name: "signal_types",
    sweeps: [
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: false,
        tradePullbackSignals: true,
        tradeBearishPullbackSignals: false,
        extremalSpikeGateEnabled: false,
      },
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: false,
        tradePullbackSignals: true,
        tradeBearishPullbackSignals: true,
        extremalSpikeGateEnabled: false,
      },
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: true,
        tradePullbackSignals: true,
        tradeBearishPullbackSignals: false,
        extremalSpikeGateEnabled: false,
      },
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: true,
        tradePullbackSignals: true,
        tradeBearishPullbackSignals: true,
        extremalSpikeGateEnabled: false,
      },
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: false,
        tradePullbackSignals: false,
        tradeBearishPullbackSignals: false,
        extremalSpikeGateEnabled: false,
      },
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: false,
        tradePullbackSignals: true,
        tradeBearishPullbackSignals: false,
        extremalSpikeGateEnabled: true,
      },
    ],
  };

  const stopTp = {
    name: "stop_tp",
    sweeps: [
      { smartExitLevelsEnabled: true, takeProfitPct: 3, takeProfitMinPct: 1.5, stopLossBelowCorridorPct: 2.5, sfpTakeProfitPct: 3, maxSfpCorridorWidthPct: 20, maxPullbackCorridorWidthPct: 18 },
      { smartExitLevelsEnabled: true, takeProfitPct: 3, takeProfitMinPct: 1, stopLossBelowCorridorPct: 2, sfpTakeProfitPct: 3.5, maxSfpCorridorWidthPct: 16, maxPullbackCorridorWidthPct: 16 },
      { smartExitLevelsEnabled: true, takeProfitPct: 4, takeProfitMinPct: 1.5, stopLossBelowCorridorPct: 2.5, sfpTakeProfitPct: 4, maxSfpCorridorWidthPct: 20, maxPullbackCorridorWidthPct: 18 },
      { smartExitLevelsEnabled: true, takeProfitPct: 2.5, takeProfitMinPct: 1, stopLossBelowCorridorPct: 2, sfpTakeProfitPct: 2.5, maxSfpCorridorWidthPct: 13, maxPullbackCorridorWidthPct: 13 },
      { smartExitLevelsEnabled: false, takeProfitPct: 3, takeProfitMinPct: 1.5, stopLossBelowCorridorPct: 2.5, sfpTakeProfitPct: 3, maxSfpCorridorWidthPct: 20, maxPullbackCorridorWidthPct: 18 },
      ...(quick
        ? []
        : [
            { smartExitLevelsEnabled: true, takeProfitPct: 3.5, takeProfitMinPct: 1.2, stopLossBelowCorridorPct: 3, sfpTakeProfitPct: 3.5, maxSfpCorridorWidthPct: 18, maxPullbackCorridorWidthPct: 15 },
            { smartExitLevelsEnabled: true, takeProfitPct: 5, takeProfitMinPct: 2, stopLossBelowCorridorPct: 2.5, sfpTakeProfitPct: 4.5, maxSfpCorridorWidthPct: 20, maxPullbackCorridorWidthPct: 20 },
          ]),
    ],
  };

  const aiExitLevels = {
    name: "ai_exit_levels",
    sweeps: [
      { aiExitLevelsEnabled: false },
      { aiExitLevelsEnabled: true, aiExitLevelsMode: "legacy_scale", aiExitLevelsSlScale: 1.15, aiExitLevelsTpScale: 1.15 },
      { aiExitLevelsEnabled: true, aiExitLevelsMode: "legacy_scale", aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.3 },
      { aiExitLevelsEnabled: true, aiExitLevelsMode: "legacy_scale", aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.5 },
      { aiExitLevelsEnabled: true, aiExitLevelsMode: "legacy_scale", aiExitLevelsSlScale: 1.4, aiExitLevelsTpScale: 1.3 },
      { aiExitLevelsEnabled: true, aiExitLevelsMode: "legacy_scale", aiExitLevelsSlScale: 1.5, aiExitLevelsTpScale: 1.6 },
      ...(quick
        ? []
        : [
            { aiExitLevelsEnabled: true, aiExitLevelsMode: "predict", aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.5 },
          ]),
    ],
  };

  const addonMove = {
    name: "addon_movestop",
    sweeps: [
      { addOnEnabled: false, moveStopEnabled: false },
      { addOnEnabled: false, moveStopEnabled: true, moveStopAfterMovePct: 1.2, moveStopOffsetPct: 0 },
      { addOnEnabled: false, moveStopEnabled: true, moveStopAfterMovePct: 1.5, moveStopOffsetPct: 0 },
      { addOnEnabled: true, moveStopEnabled: false, addOnMovePct: 2 },
      { addOnEnabled: true, moveStopEnabled: true, addOnMovePct: 2, moveStopAfterMovePct: 1.2, moveStopOffsetPct: 0, addOnOnlyAfterMoveStop: true },
      ...(quick
        ? []
        : [
            { addOnEnabled: false, moveStopEnabled: true, moveStopAfterMovePct: 2, moveStopOffsetPct: 1 },
            { addOnEnabled: true, moveStopEnabled: true, addOnMovePct: 3, moveStopAfterMovePct: 1.5, addOnOnlyAfterMoveStop: false },
          ]),
    ],
  };

  const earlyAbortRunner = {
    name: "early_abort_runner",
    sweeps: [
      { earlyAbortEnabled: false, runnerEnabled: false },
      {
        earlyAbortEnabled: true,
        runnerEnabled: false,
        earlyAbortBars: 20,
        earlyAbortInvalidateBars: 2,
        earlyAbortMinProgressPct: 0.4,
        earlyAbortMaxAdversePct: 1.5,
      },
      {
        earlyAbortEnabled: false,
        runnerEnabled: true,
        runnerActivateTpFraction: 0.95,
        runnerGivebackPct: 0.15,
      },
      ...(quick
        ? []
        : [
            {
              earlyAbortEnabled: true,
              runnerEnabled: true,
              earlyAbortBars: 15,
              earlyAbortInvalidateBars: 3,
              runnerActivateTpFraction: 0.9,
              runnerGivebackPct: 0.2,
            },
          ]),
    ],
  };

  const aiEarlyExit = {
    name: "ai_early_exit",
    sweeps: [
      { aiEarlyExitEnabled: false },
      { aiEarlyExitEnabled: true, aiEarlyExitHardThreshold: 0.76, aiEarlyExitSoftThreshold: 0.9, aiEarlyExitMinBars: 3 },
      { aiEarlyExitEnabled: true, aiEarlyExitHardThreshold: 0.72, aiEarlyExitSoftThreshold: 0.86, aiEarlyExitMinBars: 3 },
      { aiEarlyExitEnabled: true, aiEarlyExitHardThreshold: 0.8, aiEarlyExitSoftThreshold: 0.92, aiEarlyExitMinBars: 5 },
      ...(quick
        ? []
        : [
            { aiEarlyExitEnabled: true, aiEarlyExitHardThreshold: 0.84, aiEarlyExitSoftThreshold: 0.94, aiEarlyExitMinBars: 7 },
          ]),
    ],
  };

  const aiSfpRegime = {
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
        aiSfpRegimeBullThreshold: 0.72,
        aiSfpRegimeBearThreshold: 0.7,
        aiSfpRegimeGbmBullThreshold: 0.7,
        aiSfpRegimeGbmBearThreshold: 0.68,
      },
      ...(quick
        ? []
        : [
            {
              aiSfpRegimeEnabled: true,
              aiSfpRegimeFundingOiGbmEnabled: false,
              aiSfpRegimeBullThreshold: 0.84,
              aiSfpRegimeBearThreshold: 0.78,
            },
          ]),
    ],
  };

  const aiPbRegime = {
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
      ...(quick
        ? []
        : [
            {
              aiPullbackRegimeEnabled: true,
              aiPullbackRegimeBullThreshold: 0.8,
              aiPullbackRegimeBearThreshold: 0.78,
            },
          ]),
    ],
  };

  const aiPbPattern = {
    name: "ai_pb_pattern_break",
    sweeps: [
      { aiPullbackPatternBreakEnabled: false },
      {
        aiPullbackPatternBreakEnabled: true,
        aiPullbackPatternBreakBullThreshold: 0.72,
        aiPullbackPatternBreakBearThreshold: 0.7,
      },
      ...(quick
        ? []
        : [
            {
              aiPullbackPatternBreakEnabled: true,
              aiPullbackPatternBreakBullThreshold: 0.78,
              aiPullbackPatternBreakBearThreshold: 0.76,
            },
          ]),
    ],
  };

  const aiPbSignal = {
    name: "ai_pb_signal",
    sweeps: [
      { aiPullbackSignalEnabled: false },
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
        aiPullbackSignalBearThreshold: 0.6,
        aiPullbackSignalGbmBullThreshold: 0.54,
        aiPullbackSignalGbmBearThreshold: 0.56,
      },
      {
        aiPullbackSignalEnabled: true,
        aiPullbackSignalFundingOiGbmEnabled: true,
        aiPullbackSignalBullThreshold: 0.5,
        aiPullbackSignalBearThreshold: 0.52,
        aiPullbackSignalGbmBullThreshold: 0.48,
        aiPullbackSignalGbmBearThreshold: 0.5,
      },
    ],
  };

  const pbEarlyInv = {
    name: "pb_early_invalidation",
    sweeps: [
      { pbEarlyInvalidationEnabled: false },
      {
        pbEarlyInvalidationEnabled: true,
        pbEarlyInvalidationBars: 10,
        pbEarlyInvalidationInvalidateBars: 4,
        pbEarlyInvalidationMinProgressPct: 0.35,
        pbEarlyInvalidationMaxAdversePct: 0.9,
      },
      ...(quick
        ? []
        : [
            {
              pbEarlyInvalidationEnabled: true,
              pbEarlyInvalidationBars: 8,
              pbEarlyInvalidationInvalidateBars: 3,
              pbEarlyInvalidationMinProgressPct: 0.4,
              pbEarlyInvalidationMaxAdversePct: 0.75,
            },
          ]),
    ],
  };

  const autoBlock = {
    name: "auto_block",
    sweeps: [
      { autoBlockAfterConsecutiveSl: 0 },
      { autoBlockAfterConsecutiveSl: 2 },
      { autoBlockAfterConsecutiveSl: 3 },
      ...(quick ? [] : [{ autoBlockAfterConsecutiveSl: 1 }]),
    ],
  };

  return [
    signalTypes,
    stopTp,
    aiExitLevels,
    addonMove,
    earlyAbortRunner,
    aiEarlyExit,
    aiSfpRegime,
    aiPbRegime,
    aiPbPattern,
    aiPbSignal,
    pbEarlyInv,
    autoBlock,
  ];
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch)
    .slice(0, 6)
    .map(([k, v]) => `${k.replace(/^ai/, "").slice(0, 16)}=${v}`);
  return `${phase}_${idx}_${parts.join("_")}`.slice(0, 110);
}

function pickBest(rows) {
  return [...rows].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    return b.trades - a.trades;
  })[0];
}

function diffPatch(base, tuned) {
  const patch = {};
  for (const k of Object.keys(tuned)) {
    if (FROZEN_GENERAL.has(k)) continue;
    if (k === "blockedSymbols") continue;
    if (JSON.stringify(base[k]) !== JSON.stringify(tuned[k])) patch[k] = tuned[k];
  }
  return patch;
}

function mergeConfig(base, patch) {
  const next = { ...base, ...patch };
  for (const k of FROZEN_GENERAL) {
    if (k in base) next[k] = base[k];
  }
  next.enabled = true;
  next.armed = false;
  next.drawdownStopEnabled = false;
  next.blockedSymbols = base.blockedSymbols;
  return normalizeLiveConfig(next);
}

function logEnabled(cfg) {
  log(
    `General frozen: lev ${cfg.leverage}× · size $${cfg.positionSizeUsdt} · maxOpen ${cfg.maxOpenPositions}`
  );
  log(
    `Signals: SFP ${cfg.tradeSfpSignals}/${cfg.tradeBearishSfpSignals} · PB ${cfg.tradePullbackSignals}/${cfg.tradeBearishPullbackSignals} · extremal ${cfg.extremalSpikeGateEnabled}`
  );
  log(
    `AI: early ${cfg.aiEarlyExitEnabled} · sfpReg ${cfg.aiSfpRegimeEnabled} · pbSig ${cfg.aiPullbackSignalEnabled} · pbReg ${cfg.aiPullbackRegimeEnabled} · pbBreak ${cfg.aiPullbackPatternBreakEnabled} · exitLv ${cfg.aiExitLevelsEnabled}`
  );
  log(
    `Exits: smart ${cfg.smartExitLevelsEnabled} · TP ${cfg.takeProfitPct}/${cfg.sfpTakeProfitPct} · SL ${cfg.stopLossBelowCorridorPct} · AI scale ${cfg.aiExitLevelsSlScale}/${cfg.aiExitLevelsTpScale}`
  );
  log(
    `Extra: moveStop ${cfg.moveStopEnabled} · addOn ${cfg.addOnEnabled} · earlyAbort ${cfg.earlyAbortEnabled} · runner ${cfg.runnerEnabled} · autoBlock ${cfg.autoBlockAfterConsecutiveSl}`
  );
}

async function main() {
  const { days, liveDbDir, quick, reset } = parseArgs(process.argv);
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

  const liveBase = loadLiveConfig(liveDbDir);
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

  let anchor = store.bestConfig
    ? mergeConfig(liveBase, store.bestConfig)
    : liveBase;

  const phaseList = phases(quick);
  const totalSweeps = phaseList.reduce((s, p) => s + p.sweeps.length, 0);
  log(
    `Live ALL-settings 10d tune · ${days}d · ${symbols.length} symbols · ${phaseList.length} phases · ~${totalSweeps} runs · quick=${quick}`
  );
  logEnabled(anchor);

  if (!store.baseline) {
    log("\n=== BASELINE ===");
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
  }

  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    quick,
    note:
      "Coordinate descent over all live-bot settings except General (leverage/size/maxOpen). Drawdown OFF. Blocklist kept.",
    baseline: store.baseline,
    best: store.best,
    bestConfig: store.bestConfig,
    bestPatch: diffPatch(baselineSnapshot, store.bestConfig),
    working: (store.best?.pnl ?? 0) > 0,
    runs: store.runs,
    phasesDone: store.phasesDone,
  };
  writeJsonFile(OUT_FILE(), payload);

  log("\n=== BASELINE ===");
  log(`$${store.baseline.pnl} · ${store.baseline.trades} trades · WR ${store.baseline.winRate}%`);
  log("\n=== BEST PnL ===");
  const b = store.best;
  log(
    `$${b.pnl} · ${b.trades} trades · WR ${b.winRate}% (${b.label}) · working=${payload.working}`
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
