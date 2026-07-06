#!/usr/bin/env node
/**
 * Sweep TP + SL settings on 10d cache using production live-bot config as base.
 * Rank by take-profit hit rate.
 *
 *   node scripts/sweep-live-tp-sl-10d.js
 *   node scripts/sweep-live-tp-sl-10d.js --days 10 --quick
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

const OUT_FILE = () => dataPath("live-tp-sl-10d-sweep.json");

const TP_PCT_FULL = [1.5, 2, 2.5, 3, 4, 5, 6, 8];
const SL_CORRIDOR_FULL = [1, 1.5, 2, 2.5, 3];
const TP_MIN_FINE = [0.8, 1, 1.5, 2, 2.5];
const SL_FALLBACK_FINE = [1.5, 2, 2.5, 3];
const AI_SL_SCALE_FINE = [1, 1.05, 1.1, 1.15, 1.2];
const AI_TP_SCALE_FINE = [1, 1.05, 1.1, 1.15];

const TP_PCT_QUICK = [2, 2.5, 3, 4, 5];
const SL_CORRIDOR_QUICK = [1.5, 2, 2.5, 3];

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  let quick = false;
  let phase = "all";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
    else if (argv[i] === "--phase" && argv[i + 1]) phase = argv[++i];
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 10)),
    quick,
    phase,
  };
}

function loadLiveBase() {
  const saved = readJsonFile(dataPath("live-bot-state.json"), {})?.config ?? {};
  const { armed: _a, maxOpenPositions: _m, ...rest } = saved;
  return normalizeConfig({ enabled: true, ...rest });
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

function createFetchers() {
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "mover", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
}

function exitStats(result) {
  const trades = result.closedTrades ?? [];
  const tp = trades.filter((t) => t.exitReason === "take_profit");
  const sl = trades.filter((t) => t.exitReason === "stop_loss");
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  return {
    trades: trades.length,
    tpHits: tp.length,
    slHits: sl.length,
    tpRate: trades.length ? +((100 * tp.length) / trades.length).toFixed(2) : 0,
    slRate: trades.length ? +((100 * sl.length) / trades.length).toFixed(2) : 0,
    pnl: +pnl.toFixed(2),
    winRate: trades.length
      ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
      : 0,
  };
}

async function runOne({ label, botConfig, signalCfg, days, symbols, fetchers }) {
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: false,
    runMeta: { sweep: "live-tp-sl-10d", label },
  });
  const stats = exitStats(result);
  return {
    label,
    takeProfitPct: botConfig.takeProfitPct,
    takeProfitMinPct: botConfig.takeProfitMinPct,
    stopLossBelowCorridorPct: botConfig.stopLossBelowCorridorPct,
    stopLossFallbackPnlPct: botConfig.stopLossFallbackPnlPct,
    aiExitLevelsSlScale: botConfig.aiExitLevelsSlScale,
    aiExitLevelsTpScale: botConfig.aiExitLevelsTpScale,
    sfpTakeProfitPct: botConfig.sfpTakeProfitPct,
    ...stats,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

function rankByTpRate(rows) {
  return [...rows].sort((a, b) => {
    if (b.tpRate !== a.tpRate) return b.tpRate - a.tpRate;
    if (b.trades !== a.trades) return b.trades - a.trades;
    return b.pnl - a.pnl;
  });
}

async function main() {
  const { days, quick, phase } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  const base = loadLiveBase();
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();

  const tpVals = quick ? TP_PCT_QUICK : TP_PCT_FULL;
  const slVals = quick ? SL_CORRIDOR_QUICK : SL_CORRIDOR_FULL;
  const anchorTpMin = base.takeProfitMinPct;

  log(
    `Live TP/SL sweep · ${days}d · ${symbols.length} symbols · rank=TP hit rate`
  );
  log(
    `Base: lev ${base.leverage} · margin $${base.positionSizeUsdt} · TP ${base.takeProfitPct}% · SL ${base.stopLossBelowCorridorPct}% · AI SL ${base.aiExitLevelsSlScale} TP ${base.aiExitLevelsTpScale}`
  );
  log(
    `AI: SFP regime ${base.aiSfpRegimeEnabled} · PB signal ${base.aiPullbackSignalEnabled} · PB regime ${base.aiPullbackRegimeEnabled} · exit levels ${base.aiExitLevelsEnabled} · early exit ${base.aiEarlyExitEnabled}`
  );

  const store = readJsonFile(OUT_FILE(), { grid: [], fine: [] });
  const grid = [...(store.grid ?? [])];
  const doneLabels = new Set(grid.map((r) => r.label));

  if (phase === "all" || phase === "grid") {
    let n = 0;
    const total = tpVals.length * slVals.length;
    for (const tp of tpVals) {
      for (const sl of slVals) {
        n++;
        const label = `tp${tp}_sl${sl}`;
        if (doneLabels.has(label)) {
          log(`\n[grid ${n}/${total}] ${label} — skip (cached)`);
          continue;
        }
        log(`\n[grid ${n}/${total}] ${label} (tpMin ${anchorTpMin})`);
        const row = await runOne({
          label,
          botConfig: normalizeConfig({
            ...base,
            takeProfitPct: tp,
            takeProfitMinPct: Math.min(anchorTpMin, tp),
            stopLossBelowCorridorPct: sl,
          }),
          signalCfg,
          days,
          symbols,
          fetchers,
        });
        log(
          `→ TP ${row.tpRate}% (${row.tpHits}/${row.trades}) · SL ${row.slRate}% · PnL $${row.pnl}`
        );
        grid.push(row);
        doneLabels.add(label);
        store.grid = grid;
        writeJsonFile(OUT_FILE(), store);
      }
    }
  }

  const ranked = rankByTpRate(grid);
  const best = ranked[0];
  if (!best) {
    console.error("No grid results.");
    process.exit(1);
  }

  log("\n=== TOP 10 BY TP HIT RATE (grid) ===");
  for (const r of ranked.slice(0, 10)) {
    log(
      `TP ${r.takeProfitPct}% SL ${r.stopLossBelowCorridorPct}% → ${r.tpRate}% TP (${r.tpHits}/${r.trades}) · SL ${r.slRate}% · $${r.pnl}`
    );
  }

  const fine = [...(store.fine ?? [])];
  const fineDone = new Set(fine.map((r) => r.label));

  if (phase === "all" || phase === "fine") {
    const anchor = normalizeConfig({
      ...base,
      takeProfitPct: best.takeProfitPct,
      takeProfitMinPct: best.takeProfitMinPct,
      stopLossBelowCorridorPct: best.stopLossBelowCorridorPct,
    });

    log(
      `\n=== FINE @ TP ${best.takeProfitPct}% SL ${best.stopLossBelowCorridorPct}% ===`
    );

    for (const tmin of TP_MIN_FINE) {
      if (tmin === anchor.takeProfitMinPct) continue;
      const label = `fine_tmin${tmin}`;
      if (fineDone.has(label)) continue;
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({
          ...anchor,
          takeProfitMinPct: Math.min(tmin, anchor.takeProfitPct),
        }),
        signalCfg,
        days,
        symbols,
        fetchers,
      });
      fine.push(row);
      fineDone.add(label);
      store.fine = fine;
      writeJsonFile(OUT_FILE(), store);
      log(`→ TP ${row.tpRate}% · $${row.pnl}`);
    }

    for (const fb of SL_FALLBACK_FINE) {
      if (fb === anchor.stopLossFallbackPnlPct) continue;
      const label = `fine_slfb${fb}`;
      if (fineDone.has(label)) continue;
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({ ...anchor, stopLossFallbackPnlPct: fb }),
        signalCfg,
        days,
        symbols,
        fetchers,
      });
      fine.push(row);
      fineDone.add(label);
      store.fine = fine;
      writeJsonFile(OUT_FILE(), store);
      log(`→ TP ${row.tpRate}% · $${row.pnl}`);
    }

    for (const slScale of AI_SL_SCALE_FINE) {
      if (slScale === anchor.aiExitLevelsSlScale) continue;
      const label = `fine_aisl${String(slScale).replace(".", "_")}`;
      if (fineDone.has(label)) continue;
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({ ...anchor, aiExitLevelsSlScale: slScale }),
        signalCfg,
        days,
        symbols,
        fetchers,
      });
      fine.push(row);
      fineDone.add(label);
      store.fine = fine;
      writeJsonFile(OUT_FILE(), store);
      log(`→ TP ${row.tpRate}% · $${row.pnl}`);
    }

    for (const tpScale of AI_TP_SCALE_FINE) {
      if (tpScale === anchor.aiExitLevelsTpScale) continue;
      const label = `fine_aitp${String(tpScale).replace(".", "_")}`;
      if (fineDone.has(label)) continue;
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({ ...anchor, aiExitLevelsTpScale: tpScale }),
        signalCfg,
        days,
        symbols,
        fetchers,
      });
      fine.push(row);
      fineDone.add(label);
      store.fine = fine;
      writeJsonFile(OUT_FILE(), store);
      log(`→ TP ${row.tpRate}% · $${row.pnl}`);
    }
  }

  const allRanked = rankByTpRate([...grid, ...fine]);
  const overallBest = allRanked[0];
  const baseline = grid.find(
    (r) =>
      r.takeProfitPct === base.takeProfitPct &&
      r.stopLossBelowCorridorPct === base.stopLossBelowCorridorPct
  );

  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    quick,
    baseConfig: {
      takeProfitPct: base.takeProfitPct,
      takeProfitMinPct: base.takeProfitMinPct,
      stopLossBelowCorridorPct: base.stopLossBelowCorridorPct,
      stopLossFallbackPnlPct: base.stopLossFallbackPnlPct,
      aiExitLevelsSlScale: base.aiExitLevelsSlScale,
      aiExitLevelsTpScale: base.aiExitLevelsTpScale,
      leverage: base.leverage,
      positionSizeUsdt: base.positionSizeUsdt,
    },
    baseline,
    top10: allRanked.slice(0, 10),
    best: overallBest,
    bestByPnl: [...allRanked].sort((a, b) => b.pnl - a.pnl)[0],
    grid,
    fine,
  };

  writeJsonFile(OUT_FILE(), payload);

  log("\n=== CURRENT LIVE (baseline) ===");
  if (baseline) {
    log(
      `TP ${baseline.takeProfitPct}% SL ${baseline.stopLossBelowCorridorPct}% → ${baseline.tpRate}% TP · $${baseline.pnl}`
    );
  }

  log("\n=== BEST BY TP HIT RATE ===");
  log(
    `TP ${overallBest.takeProfitPct}% · min ${overallBest.takeProfitMinPct}% · SL corridor ${overallBest.stopLossBelowCorridorPct}% · SL fallback ${overallBest.stopLossFallbackPnlPct}%`
  );
  log(
    `AI SL scale ${overallBest.aiExitLevelsSlScale} · AI TP scale ${overallBest.aiExitLevelsTpScale}`
  );
  log(
    `→ ${overallBest.tpRate}% TP (${overallBest.tpHits}/${overallBest.trades}) · SL ${overallBest.slRate}% · PnL $${overallBest.pnl} · WR ${overallBest.winRate}%`
  );
  log(`Saved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
