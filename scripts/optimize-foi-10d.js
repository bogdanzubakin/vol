#!/usr/bin/env node
/**
 * Coordinate descent: most profitable FOI config on 10d cache.
 *
 *   node scripts/optimize-foi-10d.js --days 10 --reset
 *   node scripts/optimize-foi-10d.js --days 10 --max-symbols 200
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
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

const OUT_FILE = () => dataPath("foi-optimize-10d.json");
const BEST_FILE = () => dataPath("foi-best-10d.json");
const BATCH = 50;

function parseArgs(argv) {
  let days = 10;
  let reset = false;
  let maxSymbols = 0;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--reset") reset = true;
    else if (argv[i] === "--max-symbols" && argv[i + 1]) {
      maxSymbols = Number(argv[++i]);
    }
  }
  return {
    days: Math.max(1, Math.min(30, Math.round(days) || 10)),
    reset,
    maxSymbols: Math.max(0, Math.round(maxSymbols) || 0),
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

function summarize(trades) {
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const bySignal = {};
  for (const k of ["foi", "foi_bear"]) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    bySignal[k] = {
      trades: rows.length,
      pnl: +rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2),
      winRate: +((100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) / rows.length).toFixed(1),
    };
  }
  return {
    trades: trades.length,
    pnl: +pnl.toFixed(2),
    winRate: trades.length
      ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
      : 0,
    bySignal,
    foiPnl: bySignal.foi?.pnl ?? 0,
    foiBearPnl: bySignal.foi_bear?.pnl ?? 0,
  };
}

async function runConfig({ label, botConfig, signalCfg, days, symbols, fetchers, getFundingOiAt }) {
  const trades = [];
  for (let offset = 0; offset < symbols.length; offset += BATCH) {
    const batch = symbols.slice(offset, offset + BATCH);
    const { result } = await runPaperBotBacktest({
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
      modelScope: "paper",
      runMeta: { optimize: "foi-10d", label },
    });
    for (const t of result.closedTrades ?? []) {
      trades.push({
        symbol: t.symbol,
        signalKind: t.signalKind,
        pnl: t.pnl,
      });
    }
    result.closedTrades = null;
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
        { foiMinAbsFundingRate: 0.00008, foiMinAbsFundingRateBull: null, foiMinAbsFundingRateBear: null },
        { foiMinAbsFundingRate: 0.00012, foiMinAbsFundingRateBull: null, foiMinAbsFundingRateBear: null },
        { foiMinAbsFundingRate: 0.00018, foiMinAbsFundingRateBull: null, foiMinAbsFundingRateBear: null },
        { foiMinAbsFundingRate: 0.00025, foiMinAbsFundingRateBull: null, foiMinAbsFundingRateBear: null },
        { foiMinAbsFundingRate: 0.00035, foiMinAbsFundingRateBull: null, foiMinAbsFundingRateBear: null },
        // asymmetric: stricter long / looser short (short was stronger)
        {
          foiMinAbsFundingRate: 0.00012,
          foiMinAbsFundingRateBull: 0.00025,
          foiMinAbsFundingRateBear: 0.0001,
        },
        {
          foiMinAbsFundingRate: 0.00012,
          foiMinAbsFundingRateBull: 0.00035,
          foiMinAbsFundingRateBear: 0.00008,
        },
      ],
    },
    {
      name: "oi_confirm",
      sweeps: [
        { foiRequireOiConfirm: true },
        { foiRequireOiConfirm: false },
      ],
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
        { takeProfitPct: 2.5, sfpTakeProfitPct: 2.5 },
        { takeProfitPct: 3, sfpTakeProfitPct: 3 },
        { takeProfitPct: 3.5, sfpTakeProfitPct: 3.5 },
        { takeProfitPct: 4, sfpTakeProfitPct: 4 },
        { takeProfitPct: 2, sfpTakeProfitPct: 2, takeProfitMinPct: 0.8 },
      ],
    },
  ];
}

function patchLabel(phase, patch, idx) {
  const parts = Object.entries(patch).map(([k, v]) => `${k}=${v}`);
  return `${phase}_${idx}_${parts.join("_") || "inherit"}`.slice(0, 120);
}

function pickBest(rows) {
  return [...rows].sort((a, b) => {
    if (b.pnl !== a.pnl) return b.pnl - a.pnl;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.trades - a.trades;
  })[0];
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
  ];
  const patch = {};
  for (const k of keys) {
    if (JSON.stringify(base[k] ?? null) !== JSON.stringify(tuned[k] ?? null)) {
      patch[k] = tuned[k];
    }
  }
  return patch;
}

async function main() {
  const { days, reset, maxSymbols } = parseArgs(process.argv);
  const symbols = cachedSymbolList(maxSymbols);
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

  const baseBot = loadBaseBot();
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  const baselineSnapshot = { ...baseBot };

  let store = reset
    ? { runs: [], phasesDone: [], bestConfig: null, best: null, baseline: null }
    : readJsonFile(OUT_FILE(), {
        runs: [],
        phasesDone: [],
        bestConfig: null,
        best: null,
        baseline: null,
      });

  let anchor = store.bestConfig ? mergeBot(baseBot, store.bestConfig) : baseBot;
  const phaseList = phases();
  const totalSweeps = phaseList.reduce((s, p) => s + p.sweeps.length, 0);

  log(
    `FOI optimize 10d · ${days}d · ${symbols.length} symbols · ${phaseList.length} phases · ~${totalSweeps} runs`
  );

  if (!store.baseline) {
    log("\n=== BASELINE ===");
    const row = await runConfig({
      label: "baseline",
      botConfig: anchor,
      signalCfg,
      days,
      symbols,
      fetchers,
      getFundingOiAt,
    });
    row.patch = {};
    store.baseline = row;
    store.runs.push(row);
    store.best = row;
    store.bestConfig = { ...anchor };
    writeJsonFile(OUT_FILE(), store);
    log(
      `→ $${row.pnl} · ${row.trades} tr · WR ${row.winRate}% · foi $${row.foiPnl} / bear $${row.foiBearPnl}`
    );
    log(`  bySignal ${JSON.stringify(row.bySignal)}`);
  }

  for (const phase of phaseList) {
    if (store.phasesDone.includes(phase.name)) {
      log(`\n=== ${phase.name} — skip (done) ===`);
      anchor = mergeBot(baseBot, store.bestConfig);
      continue;
    }

    log(`\n=== PHASE ${phase.name} (${phase.sweeps.length} variants) ===`);
    const phaseRows = [];

    for (let i = 0; i < phase.sweeps.length; i++) {
      const patch = phase.sweeps[i];
      const label = patchLabel(phase.name, patch, i);
      const botConfig = mergeBot(anchor, patch);
      log(`[${phase.name} ${i + 1}/${phase.sweeps.length}] ${label}`);
      const row = await runConfig({
        label,
        botConfig,
        signalCfg,
        days,
        symbols,
        fetchers,
        getFundingOiAt,
      });
      row.patch = patch;
      phaseRows.push(row);
      store.runs.push(row);
      log(
        `→ $${row.pnl} · ${row.trades} tr · WR ${row.winRate}% · foi $${row.foiPnl} / bear $${row.foiBearPnl}`
      );
      log(`  bySignal ${JSON.stringify(row.bySignal)}`);
      writeJsonFile(OUT_FILE(), store);
    }

    const phaseBest = pickBest(phaseRows);
    const improved = phaseBest.pnl > (store.best?.pnl ?? -Infinity);
    if (Object.keys(phaseBest.patch || {}).length) {
      anchor = mergeBot(anchor, phaseBest.patch);
    }
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

  const bestPatch = foiPatchDiff(baselineSnapshot, store.bestConfig);
  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    maxSymbols: maxSymbols || null,
    baseline: store.baseline,
    best: store.best,
    bestConfig: store.bestConfig,
    bestPatch,
    beatsBaseline: (store.best?.pnl ?? 0) > (store.baseline?.pnl ?? -Infinity),
    runs: store.runs,
    phasesDone: store.phasesDone,
  };
  writeJsonFile(OUT_FILE(), payload);
  writeJsonFile(BEST_FILE(), {
    appliedAt: new Date().toISOString(),
    baselinePnl: store.baseline?.pnl,
    bestPnl: store.best?.pnl,
    patch: bestPatch,
    bySignal: store.best?.bySignal,
  });

  log("\n=== BASELINE ===");
  log(`$${store.baseline.pnl} · ${store.baseline.trades} tr · WR ${store.baseline.winRate}%`);
  log("\n=== BEST ===");
  const b = store.best;
  log(`$${b.pnl} · ${b.trades} tr · WR ${b.winRate}%`);
  log(`beatsBaseline=${payload.beatsBaseline}`);
  log("Best FOI patch:");
  for (const [k, v] of Object.entries(bestPatch)) {
    log(`  ${k}: ${JSON.stringify(v)}`);
  }
  log(`Saved ${OUT_FILE()}`);
  log(`Best ${BEST_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
