#!/usr/bin/env node
/**
 * Tune live-bot enabled features + common settings for best PnL (10d cache).
 * Coordinate-descent phases; resumes from .cache/live-pnl-optimize-10d.json
 *
 *   node scripts/optimize-live-pnl-10d.js
 *   node scripts/optimize-live-pnl-10d.js --days 10 --quick
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

const OUT_FILE = () => dataPath("live-pnl-optimize-10d.json");

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  let quick = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 10)), quick };
}

function loadLiveBase() {
  const saved = readJsonFile(dataPath("live-bot-state.json"), {})?.config ?? {};
  const { armed: _a, maxOpenPositions: _m, ...rest } = saved;
  return normalizeConfig({
    enabled: true,
    ...rest,
    drawdownStopEnabled: false,
  });
}

function loadSignalConfig() {
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
  };
  scannerConfig.loadInto(cfg);
  applyBarConfig(cfg);
  return cfg;
}

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((sym) => readSymbolBars("mover", sym)?.length)
    .sort();
}

function createFetchers(signalCfg) {
  const interval = signalCfg?.interval ?? "1m";
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const kind = interval === "1m" ? "mover" : "signal";
      const cached = readCached(symbol, kind, barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no ${interval} cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      if (interval === "1m") return null;
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "mover", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
}

function summarize(result) {
  const trades = result.closedTrades ?? [];
  const tp = trades.filter((t) => t.exitReason === "take_profit").length;
  const sl = trades.filter((t) => t.exitReason === "stop_loss").length;
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  return {
    trades: trades.length,
    tpHits: tp,
    tpRate: trades.length ? +((100 * tp) / trades.length).toFixed(2) : 0,
    slHits: sl,
    slRate: trades.length ? +((100 * sl) / trades.length).toFixed(2) : 0,
    pnl: +pnl.toFixed(2),
    winRate: trades.length
      ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
      : 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, fetchers }) {
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol:
      signalCfg.interval !== "1m" ? fetchers.fetchKlines1mForSymbol : null,
    restGapMs: 0,
    saveLastResult: false,
    runMeta: { optimize: "live-pnl-10d", label },
  });
  const stats = summarize(result);
  return {
    label,
    ...stats,
    elapsedSec: result.elapsedSec ?? 0,
    patch: null,
  };
}

function phases(quick) {
  if (quick) {
    return [
      {
        name: "pb_signal",
        sweeps: [
          { aiPullbackSignalBullThreshold: 0.48, aiPullbackSignalBearThreshold: 0.52 },
          { aiPullbackSignalBullThreshold: 0.52, aiPullbackSignalBearThreshold: 0.54 },
          { aiPullbackSignalBullThreshold: 0.56, aiPullbackSignalBearThreshold: 0.56 },
        ],
      },
      {
        name: "tp_sl",
        sweeps: [
          { takeProfitPct: 2, stopLossBelowCorridorPct: 2 },
          { takeProfitPct: 3, stopLossBelowCorridorPct: 2.5 },
          { takeProfitPct: 4, stopLossBelowCorridorPct: 2 },
        ],
      },
      {
        name: "ai_exits",
        sweeps: [
          { aiExitLevelsSlScale: 1, aiExitLevelsTpScale: 1 },
          { aiExitLevelsSlScale: 1.15, aiExitLevelsTpScale: 1.15 },
          { aiExitLevelsSlScale: 1.2, aiExitLevelsTpScale: 1.5 },
        ],
      },
    ];
  }
  return [
    {
      name: "pb_signal",
      sweeps: [
        { aiPullbackSignalBullThreshold: 0.46, aiPullbackSignalBearThreshold: 0.5 },
        { aiPullbackSignalBullThreshold: 0.48, aiPullbackSignalBearThreshold: 0.52 },
        { aiPullbackSignalBullThreshold: 0.5, aiPullbackSignalBearThreshold: 0.52 },
        { aiPullbackSignalBullThreshold: 0.52, aiPullbackSignalBearThreshold: 0.54 },
        { aiPullbackSignalBullThreshold: 0.54, aiPullbackSignalBearThreshold: 0.56 },
        { aiPullbackSignalBullThreshold: 0.56, aiPullbackSignalBearThreshold: 0.58 },
        { aiPullbackSignalBullThreshold: 0.58, aiPullbackSignalBearThreshold: 0.6 },
      ],
    },
    {
      name: "pb_regime",
      sweeps: [
        { aiPullbackRegimeEnabled: false },
        {
          aiPullbackRegimeEnabled: true,
          aiPullbackRegimeBullThreshold: 0.72,
          aiPullbackRegimeBearThreshold: 0.7,
        },
        {
          aiPullbackRegimeEnabled: true,
          aiPullbackRegimeBullThreshold: 0.76,
          aiPullbackRegimeBearThreshold: 0.74,
        },
        {
          aiPullbackRegimeEnabled: true,
          aiPullbackRegimeBullThreshold: 0.8,
          aiPullbackRegimeBearThreshold: 0.78,
        },
      ],
    },
    {
      name: "tp",
      sweeps: [1.5, 2, 2.5, 3, 4, 5, 6].map((takeProfitPct) => ({ takeProfitPct })),
    },
    {
      name: "sl",
      sweeps: [1.5, 2, 2.5, 3, 3.5].map((stopLossBelowCorridorPct) => ({
        stopLossBelowCorridorPct,
      })),
    },
    {
      name: "tp_min",
      sweeps: [0.6, 0.8, 1, 1.5, 2].map((takeProfitMinPct) => ({ takeProfitMinPct })),
    },
    {
      name: "ai_exit_scales",
      sweeps: [
        { aiExitLevelsSlScale: 1, aiExitLevelsTpScale: 1 },
        { aiExitLevelsSlScale: 1.05, aiExitLevelsTpScale: 1.1 },
        { aiExitLevelsSlScale: 1.1, aiExitLevelsTpScale: 1.15 },
        { aiExitLevelsSlScale: 1.15, aiExitLevelsTpScale: 1.2 },
        { aiExitLevelsSlScale: 1.2, aiExitLevelsTpScale: 1.3 },
        { aiExitLevelsSlScale: 1.2, aiExitLevelsTpScale: 1.5 },
        { aiExitLevelsSlScale: 1.3, aiExitLevelsTpScale: 1.5 },
      ],
    },
    {
      name: "move_stop",
      sweeps: [
        { moveStopEnabled: false },
        { moveStopEnabled: true, moveStopAfterMovePct: 0.8, moveStopOffsetPct: 0 },
        { moveStopEnabled: true, moveStopAfterMovePct: 1.2, moveStopOffsetPct: 0 },
        { moveStopEnabled: true, moveStopAfterMovePct: 1.2, moveStopOffsetPct: 1 },
        { moveStopEnabled: true, moveStopAfterMovePct: 1.5, moveStopOffsetPct: 0 },
        { moveStopEnabled: true, moveStopAfterMovePct: 2, moveStopOffsetPct: 2 },
      ],
    },
    {
      name: "addon",
      sweeps: [
        { addOnEnabled: false },
        { addOnEnabled: true, addOnMovePct: 1.5 },
        { addOnEnabled: true, addOnMovePct: 2 },
        { addOnEnabled: true, addOnMovePct: 3 },
        { addOnEnabled: true, addOnMovePct: 4, addOnOnlyAfterMoveStop: true },
      ],
    },
    {
      name: "corridor",
      sweeps: [10, 13, 16, 20].map((maxPullbackCorridorWidthPct) => ({
        maxPullbackCorridorWidthPct,
      })),
    },
    {
      name: "signal_types",
      sweeps: [
        { tradePullbackSignals: true, tradeBearishPullbackSignals: true },
        { tradePullbackSignals: true, tradeBearishPullbackSignals: false },
        { tradePullbackSignals: false, tradeBearishPullbackSignals: true },
      ],
    },
  ];
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch).map(([k, v]) => {
    const short = k
      .replace("aiPullbackSignal", "pbs")
      .replace("aiPullbackRegime", "pbr")
      .replace("aiExitLevels", "ai")
      .replace("takeProfit", "tp")
      .replace("stopLossBelowCorridorPct", "sl")
      .replace("maxPullbackCorridorWidthPct", "corr")
      .replace("moveStop", "ms")
      .replace("addOn", "ao")
      .replace("trade", "t");
    return `${short}=${v}`;
  });
  return `${phase}_${idx}_${parts.join("_")}`.slice(0, 80);
}

function pickBest(rows) {
  return [...rows].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    return b.trades - a.trades;
  })[0];
}

async function main() {
  const { days, quick } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers(signalCfg);
  const store = readJsonFile(OUT_FILE(), {
    runs: [],
    phasesDone: [],
    bestConfig: null,
    best: null,
    baseline: null,
  });

  let anchor = store.bestConfig
    ? normalizeConfig({ ...store.bestConfig })
    : loadLiveBase();

  log(`Live PnL tune · ${days}d · ${symbols.length} symbols · drawdown OFF for search`);
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
    log(`→ $${row.pnl} · ${row.trades} tr · TP ${row.tpRate}%`);
  }

  for (const phase of phases(quick)) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip (done) ===`);
      anchor = normalizeConfig({ ...store.bestConfig });
      continue;
    }

    log(`\n=== PHASE ${phase.name} (${phase.sweeps.length} variants) ===`);
    const phaseRows = [];

    for (let i = 0; i < phase.sweeps.length; i++) {
      const patch = phase.sweeps[i];
      const label = patchLabel(phase.name, patch, i);
      const botConfig = normalizeConfig({ ...anchor, ...patch });
      if (patch.takeProfitPct != null && botConfig.takeProfitMinPct > patch.takeProfitPct) {
        botConfig.takeProfitMinPct = patch.takeProfitPct;
      }
      if (patch.takeProfitMinPct != null && botConfig.takeProfitPct < patch.takeProfitMinPct) {
        botConfig.takeProfitMinPct = Math.min(patch.takeProfitMinPct, botConfig.takeProfitPct);
      }

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
      log(`→ $${row.pnl} · ${row.trades} tr · TP ${row.tpRate}% · WR ${row.winRate}%`);
    }

    const phaseBest = pickBest(phaseRows);
    const improved = phaseBest.pnl > (store.best?.pnl ?? -Infinity);
    anchor = normalizeConfig({ ...anchor, ...phaseBest.patch });
    store.bestConfig = { ...anchor };
    if (improved || !store.best || phaseBest.pnl >= store.best.pnl) {
      store.best = { ...phaseBest, phase: phase.name };
    }
    store.phasesDone.push(phase.name);
    writeJsonFile(OUT_FILE(), store);

    log(
      `Phase best: $${phaseBest.pnl} (${phaseBest.label})${improved ? " ↑" : ""}`
    );
  }

  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    quick,
    note: "Coordinate descent on live enabled features; drawdown OFF during search.",
    baseline: store.baseline,
    best: store.best,
    bestConfig: store.bestConfig,
    bestPatch: diffPatch(loadLiveBase(), store.bestConfig),
    runs: store.runs,
  };
  writeJsonFile(OUT_FILE(), payload);

  log("\n=== BASELINE ===");
  log(`$${store.baseline.pnl} · ${store.baseline.trades} trades · TP ${store.baseline.tpRate}%`);

  log("\n=== BEST PnL ===");
  const b = store.best;
  log(`$${b.pnl} · ${b.trades} trades · TP ${b.tpRate}% · WR ${b.winRate}% (${b.label})`);
  log("Recommended patch:");
  for (const [k, v] of Object.entries(payload.bestPatch)) {
    log(`  ${k}: ${JSON.stringify(v)}`);
  }
  log(`Saved ${OUT_FILE()}`);
}

function logEnabled(cfg) {
  log(
    `Signals: PB ${cfg.tradePullbackSignals}/${cfg.tradeBearishPullbackSignals} · SFP ${cfg.tradeSfpSignals}/${cfg.tradeBearishSfpSignals}`
  );
  log(
    `AI: PB sig ${cfg.aiPullbackSignalEnabled} · PB regime ${cfg.aiPullbackRegimeEnabled} · exits ${cfg.aiExitLevelsEnabled} · early ${cfg.aiEarlyExitEnabled}`
  );
  log(
    `TP ${cfg.takeProfitPct}% min ${cfg.takeProfitMinPct}% · SL ${cfg.stopLossBelowCorridorPct}% · AI SL/TP ${cfg.aiExitLevelsSlScale}/${cfg.aiExitLevelsTpScale}`
  );
  log(
    `Move-stop ${cfg.moveStopEnabled} · Add-on ${cfg.addOnEnabled} · margin $${cfg.positionSizeUsdt}`
  );
}

function diffPatch(base, tuned) {
  const patch = {};
  for (const k of Object.keys(tuned)) {
    if (JSON.stringify(base[k]) !== JSON.stringify(tuned[k])) {
      patch[k] = tuned[k];
    }
  }
  return patch;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
