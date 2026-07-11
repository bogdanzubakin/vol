#!/usr/bin/env node
/**
 * Coordinate-descent tune of live-enabled AI blocks + signal toggles on 50d cache.
 * Uses remote live config + already-trained models (2h BTC fast).
 *
 *   node scripts/optimize-live-enabled-50d.js --days 50
 *   node scripts/optimize-live-enabled-50d.js --days 50 --quick
 *   node scripts/optimize-live-enabled-50d.js --days 50 --reset
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(12288);

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

const ROOT = path.join(__dirname, "..");
const OUT_FILE = () => dataPath("live-enabled-optimize-50d.json");

function parseArgs(argv) {
  let days = 50;
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
    days: Math.max(1, Math.min(60, Math.round(days) || 50)),
    liveDbDir,
    quick,
    reset,
  };
}

function log(msg) {
  console.error(String(msg));
}

function loadLiveConfig(liveDbDir) {
  const dbFile = path.join(liveDbDir, "vol.db");
  if (!fs.existsSync(dbFile)) throw new Error(`Missing ${dbFile}`);
  const Database = require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true });
  try {
    const { loadBotRuntime } = require("../lib/db/repos/bot-state");
    const { getScannerConfig } = require("../lib/db/repos/settings");
    const runtime = loadBotRuntime(db, "live");
    if (!runtime?.config) throw new Error("No live bot config in DB");
    return {
      config: normalizeLiveConfig({
        enabled: true,
        ...runtime.config,
        armed: false,
        drawdownStopEnabled: false,
        aiRegimeBtcFastLookbackHours: 2,
        aiPullbackSignalBtcFastLookbackHours: 2,
      }),
      scanner: getScannerConfig(db),
    };
  } finally {
    db.close();
  }
}

function loadSignalConfig(scannerRaw = {}) {
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
    ...scannerRaw,
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
    sfpRegimeSkips: result.summary?.sfpRegimeSkips ?? 0,
    pullbackSignalSkips: result.summary?.pullbackSignalSkips ?? 0,
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
    runMeta: { optimize: "live-enabled-50d", label },
  });
  return { label, ...summarize(result), elapsedSec: result.elapsedSec ?? 0 };
}

function phases(quick) {
  // Lean grid: ~16 full 50d runs after baseline (~9h). Highest-impact first.
  const signalTypes = {
    name: "signal_types",
    sweeps: [
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: false,
        tradePullbackSignals: true,
        tradeBearishPullbackSignals: true,
      },
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: false,
        tradePullbackSignals: true,
        tradeBearishPullbackSignals: false,
      },
      {
        tradeSfpSignals: true,
        tradeBearishSfpSignals: false,
        tradePullbackSignals: false,
        tradeBearishPullbackSignals: false,
      },
    ],
  };
  if (quick) {
    return [
      signalTypes,
      {
        name: "sfp_regime",
        sweeps: [
          {
            aiSfpRegimeBullThreshold: 0.72,
            aiSfpRegimeBearThreshold: 0.7,
            aiSfpRegimeGbmBullThreshold: 0.72,
            aiSfpRegimeGbmBearThreshold: 0.7,
          },
          {
            aiSfpRegimeBullThreshold: 0.78,
            aiSfpRegimeBearThreshold: 0.72,
            aiSfpRegimeGbmBullThreshold: 0.72,
            aiSfpRegimeGbmBearThreshold: 0.7,
          },
          {
            aiSfpRegimeBullThreshold: 0.84,
            aiSfpRegimeBearThreshold: 0.78,
            aiSfpRegimeGbmBullThreshold: 0.78,
            aiSfpRegimeGbmBearThreshold: 0.76,
          },
        ],
      },
      {
        name: "pb_signal",
        sweeps: [
          { aiPullbackSignalBullThreshold: 0.5, aiPullbackSignalBearThreshold: 0.52 },
          { aiPullbackSignalBullThreshold: 0.54, aiPullbackSignalBearThreshold: 0.56 },
          { aiPullbackSignalBullThreshold: 0.58, aiPullbackSignalBearThreshold: 0.6 },
        ],
      },
      {
        name: "early_exit",
        sweeps: [
          { aiEarlyExitHardThreshold: 0.72, aiEarlyExitSoftThreshold: 0.86, aiEarlyExitMinBars: 3 },
          { aiEarlyExitHardThreshold: 0.76, aiEarlyExitSoftThreshold: 0.9, aiEarlyExitMinBars: 3 },
          { aiEarlyExitHardThreshold: 0.8, aiEarlyExitSoftThreshold: 0.92, aiEarlyExitMinBars: 5 },
        ],
      },
      {
        name: "exit_levels",
        sweeps: [
          { aiExitLevelsSlScale: 1.15, aiExitLevelsTpScale: 1.15 },
          { aiExitLevelsSlScale: 1.4, aiExitLevelsTpScale: 1.3 },
          { aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.5 },
        ],
      },
    ];
  }
  return [
    signalTypes,
    {
      name: "sfp_regime",
      sweeps: [
        {
          aiSfpRegimeBullThreshold: 0.72,
          aiSfpRegimeBearThreshold: 0.7,
          aiSfpRegimeGbmBullThreshold: 0.72,
          aiSfpRegimeGbmBearThreshold: 0.7,
        },
        {
          aiSfpRegimeBullThreshold: 0.78,
          aiSfpRegimeBearThreshold: 0.72,
          aiSfpRegimeGbmBullThreshold: 0.72,
          aiSfpRegimeGbmBearThreshold: 0.7,
        },
        {
          aiSfpRegimeBullThreshold: 0.82,
          aiSfpRegimeBearThreshold: 0.76,
          aiSfpRegimeGbmBullThreshold: 0.76,
          aiSfpRegimeGbmBearThreshold: 0.74,
        },
        {
          aiSfpRegimeBullThreshold: 0.84,
          aiSfpRegimeBearThreshold: 0.78,
          aiSfpRegimeGbmBullThreshold: 0.78,
          aiSfpRegimeGbmBearThreshold: 0.76,
        },
      ],
    },
    {
      name: "pb_signal",
      sweeps: [
        { aiPullbackSignalBullThreshold: 0.5, aiPullbackSignalBearThreshold: 0.52 },
        { aiPullbackSignalBullThreshold: 0.54, aiPullbackSignalBearThreshold: 0.56 },
        { aiPullbackSignalBullThreshold: 0.58, aiPullbackSignalBearThreshold: 0.6 },
        { aiPullbackSignalBullThreshold: 0.62, aiPullbackSignalBearThreshold: 0.64 },
      ],
    },
    {
      name: "early_exit",
      sweeps: [
        { aiEarlyExitHardThreshold: 0.72, aiEarlyExitSoftThreshold: 0.86, aiEarlyExitMinBars: 3 },
        { aiEarlyExitHardThreshold: 0.76, aiEarlyExitSoftThreshold: 0.9, aiEarlyExitMinBars: 3 },
        { aiEarlyExitHardThreshold: 0.8, aiEarlyExitSoftThreshold: 0.92, aiEarlyExitMinBars: 5 },
        { aiEarlyExitHardThreshold: 0.84, aiEarlyExitSoftThreshold: 0.94, aiEarlyExitMinBars: 7 },
      ],
    },
    {
      name: "exit_levels",
      sweeps: [
        { aiExitLevelsSlScale: 1.15, aiExitLevelsTpScale: 1.15 },
        { aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.3 },
        { aiExitLevelsSlScale: 1.4, aiExitLevelsTpScale: 1.3 },
        { aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.5 },
        { aiExitLevelsSlScale: 1.5, aiExitLevelsTpScale: 1.6 },
      ],
    },
  ];
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch).map(([k, v]) => `${k.replace(/^ai/, "").slice(0, 18)}=${v}`);
  return `${phase}_${idx}_${parts.join("_") || "baseline"}`.slice(0, 100);
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
    if (JSON.stringify(base[k]) !== JSON.stringify(tuned[k])) patch[k] = tuned[k];
  }
  return patch;
}

function logEnabled(cfg) {
  log(
    `Signals: SFP ${cfg.tradeSfpSignals}/${cfg.tradeBearishSfpSignals} · PB ${cfg.tradePullbackSignals}/${cfg.tradeBearishPullbackSignals}`
  );
  log(
    `AI: sfpRegime ${cfg.aiSfpRegimeEnabled} (${cfg.aiSfpRegimeBullThreshold}/${cfg.aiSfpRegimeBearThreshold}) · pbSignal ${cfg.aiPullbackSignalEnabled} (${cfg.aiPullbackSignalBullThreshold}/${cfg.aiPullbackSignalBearThreshold})`
  );
  log(
    `AI: earlyExit ${cfg.aiEarlyExitEnabled} (${cfg.aiEarlyExitHardThreshold}/${cfg.aiEarlyExitSoftThreshold} minBars=${cfg.aiEarlyExitMinBars}) · exitLevels ${cfg.aiExitLevelsEnabled} (${cfg.aiExitLevelsSlScale}/${cfg.aiExitLevelsTpScale})`
  );
  log(
    `BTC lookback slow/fast: regime ${cfg.aiRegimeBtcLookbackHours}/${cfg.aiRegimeBtcFastLookbackHours} · pb ${cfg.aiPullbackSignalBtcLookbackHours}/${cfg.aiPullbackSignalBtcFastLookbackHours}`
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
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }

  const { config: liveBase, scanner } = loadLiveConfig(liveDbDir);
  const signalCfg = loadSignalConfig(scanner);
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
    ? normalizeLiveConfig({ ...store.bestConfig, enabled: true, armed: false, drawdownStopEnabled: false })
    : liveBase;

  log(`Live-enabled 50d tune · ${days}d · ${symbols.length} symbols · quick=${quick}`);
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
    log(`  bySignal ${JSON.stringify(row.bySignal)}`);
  }

  for (const phase of phases(quick)) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip (done) ===`);
      anchor = normalizeLiveConfig({
        ...store.bestConfig,
        enabled: true,
        armed: false,
        drawdownStopEnabled: false,
      });
      continue;
    }

    log(`\n=== PHASE ${phase.name} (${phase.sweeps.length} variants) ===`);
    const phaseRows = [];

    for (let i = 0; i < phase.sweeps.length; i++) {
      const patch = phase.sweeps[i];
      const label = patchLabel(phase.name, patch, i);
      const botConfig = normalizeLiveConfig({
        ...anchor,
        ...patch,
        enabled: true,
        armed: false,
        drawdownStopEnabled: false,
      });

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
      writeJsonFile(OUT_FILE(), {
        ...store,
        phasesDone: store.phasesDone,
        bestConfig: store.bestConfig,
        best: store.best,
      });
    }

    const phaseBest = pickBest(phaseRows);
    const improved = phaseBest.pnl > (store.best?.pnl ?? -Infinity);
    anchor = normalizeLiveConfig({
      ...anchor,
      ...phaseBest.patch,
      enabled: true,
      armed: false,
      drawdownStopEnabled: false,
    });
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
      "Coordinate descent on live-enabled AI blocks (sfp regime, pb signal, early exit, exit levels) + signal toggles; BTC fast=2h; drawdown OFF.",
    baseline: store.baseline,
    best: store.best,
    bestConfig: store.bestConfig,
    bestPatch: diffPatch(baselineSnapshot, store.bestConfig),
    runs: store.runs,
    phasesDone: store.phasesDone,
  };
  writeJsonFile(OUT_FILE(), payload);

  log("\n=== BASELINE ===");
  log(`$${store.baseline.pnl} · ${store.baseline.trades} trades · WR ${store.baseline.winRate}%`);
  log("\n=== BEST PnL ===");
  const b = store.best;
  log(`$${b.pnl} · ${b.trades} trades · WR ${b.winRate}% (${b.label})`);
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
