#!/usr/bin/env node
/**
 * Sweep SL/TP bot settings; rank by take-profit hit rate (30d cached backtest).
 *
 *   node scripts/sweep-sl-tp-tp-hit-rate.js --days 30
 *   node scripts/sweep-sl-tp-tp-hit-rate.js --days 30 --quick
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

const OUT_FILE = () => dataPath("sl-tp-tp-hit-rate-sweep.json");

const TP_PCT_FULL = [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12];
const SL_CORRIDOR_FULL = [1, 1.5, 2, 2.5, 3, 3.5, 4];
const TP_PCT_QUICK = [3, 4, 5, 6, 8];
const SL_CORRIDOR_QUICK = [1.5, 2, 2.5, 3];

const FALLBACK_PCT = [1.5, 2, 2.5, 3];
const TP_MIN_PCT = [0.8, 1, 1.5, 2, 2.5];
const SFP_TP_PCT = [0, 3, 3.5, 4, 4.5, 5];

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 30;
  let quick = false;
  let phase = "all";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
    else if (argv[i] === "--phase" && argv[i + 1]) phase = argv[++i];
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 30)),
    quick,
    phase,
  };
}

function sweepBase(saved) {
  return normalizeConfig({
    enabled: true,
    ...saved,
    tradeSfpSignals: true,
    tradeBearishSfpSignals: true,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    pbEarlyInvalidationEnabled: false,
    aiEarlyExitEnabled: false,
    aiExitLevelsEnabled: false,
    smartExitLevelsEnabled: true,
    aiSfpRegimeEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    stopLossFallbackPnlPct: 2,
    takeProfitMinPct: 1.5,
    sfpTakeProfitPct: 4.5,
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
  const other = trades.length - tp.length - sl.length;
  const sfp = trades.filter((t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear");
  const pb = trades.filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  const tpSfp = sfp.filter((t) => t.exitReason === "take_profit").length;
  const tpPb = pb.filter((t) => t.exitReason === "take_profit").length;
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  return {
    trades: trades.length,
    tpHits: tp.length,
    slHits: sl.length,
    otherExits: other,
    tpRate: trades.length ? +((100 * tp.length) / trades.length).toFixed(2) : 0,
    slRate: trades.length ? +((100 * sl.length) / trades.length).toFixed(2) : 0,
    sfpTrades: sfp.length,
    pbTrades: pb.length,
    sfpTpRate: sfp.length ? +((100 * tpSfp) / sfp.length).toFixed(2) : 0,
    pbTpRate: pb.length ? +((100 * tpPb) / pb.length).toFixed(2) : 0,
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
    runMeta: { sweep: "sl-tp-tp-hit-rate", label },
  });
  const stats = exitStats(result);
  return {
    label,
    takeProfitPct: botConfig.takeProfitPct,
    stopLossBelowCorridorPct: botConfig.stopLossBelowCorridorPct,
    stopLossFallbackPnlPct: botConfig.stopLossFallbackPnlPct,
    takeProfitMinPct: botConfig.takeProfitMinPct,
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

  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  const base = sweepBase(saved);
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();

  const tpVals = quick ? TP_PCT_QUICK : TP_PCT_FULL;
  const slVals = quick ? SL_CORRIDOR_QUICK : SL_CORRIDOR_FULL;

  log(
    `SL/TP sweep · ${days}d · ${symbols.length} symbols · rank=TP hit rate · AI exits OFF`
  );

  const store = readJsonFile(OUT_FILE(), { grid: [], fine: [] });
  const grid = [];

  if (phase === "all" || phase === "grid") {
    let n = 0;
    const total = tpVals.length * slVals.length;
    for (const tp of tpVals) {
      for (const sl of slVals) {
        n++;
        const label = `tp${tp}_sl${sl}`;
        log(`\n[grid ${n}/${total}] ${label}`);
        const row = await runOne({
          label,
          botConfig: normalizeConfig({
            ...base,
            takeProfitPct: tp,
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
        store.grid = grid;
        writeJsonFile(OUT_FILE(), store);
      }
    }
  } else {
    grid.push(...(store.grid ?? []));
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

  const fine = [];
  if (phase === "all" || phase === "fine") {
    const anchor = normalizeConfig({
      ...base,
      takeProfitPct: best.takeProfitPct,
      stopLossBelowCorridorPct: best.stopLossBelowCorridorPct,
    });

    log(
      `\n=== FINE SWEEP @ TP ${best.takeProfitPct}% SL ${best.stopLossBelowCorridorPct}% ===`
    );

    for (const fb of FALLBACK_PCT) {
      if (fb === anchor.stopLossFallbackPnlPct) continue;
      const label = `fine_fb${fb}`;
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
      log(`→ TP ${row.tpRate}% · $${row.pnl}`);
    }

    for (const tmin of TP_MIN_PCT) {
      if (tmin === anchor.takeProfitMinPct) continue;
      const label = `fine_tmin${tmin}`;
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({ ...anchor, takeProfitMinPct: tmin }),
        signalCfg,
        days,
        symbols,
        fetchers,
      });
      fine.push(row);
      log(`→ TP ${row.tpRate}% · $${row.pnl}`);
    }

    for (const sfpTp of SFP_TP_PCT) {
      if (sfpTp === anchor.sfpTakeProfitPct) continue;
      const label = `fine_sfptp${sfpTp}`;
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({
          ...anchor,
          sfpTakeProfitPct: sfpTp > 0 ? sfpTp : anchor.takeProfitPct,
        }),
        signalCfg,
        days,
        symbols,
        fetchers,
      });
      fine.push(row);
      log(`→ TP ${row.tpRate}% · $${row.pnl}`);
    }
  }

  const allRanked = rankByTpRate([...grid, ...fine]);
  const overallBest = allRanked[0];

  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    quick,
    note: "Fixed smart SL/TP (aiExitLevels OFF). Ranked by take_profit hit rate.",
    gridCount: grid.length,
    fineCount: fine.length,
    top10: allRanked.slice(0, 10),
    best: overallBest,
    bestByPnl: [...allRanked].sort((a, b) => b.pnl - a.pnl)[0],
    grid,
    fine,
  };

  writeJsonFile(OUT_FILE(), payload);

  log("\n=== BEST BY TP HIT RATE ===");
  log(
    `TP ${overallBest.takeProfitPct}% · SL corridor ${overallBest.stopLossBelowCorridorPct}% · fallback ${overallBest.stopLossFallbackPnlPct}% · TP min ${overallBest.takeProfitMinPct}% · SFP TP ${overallBest.sfpTakeProfitPct}%`
  );
  log(
    `→ ${overallBest.tpRate}% TP hits (${overallBest.tpHits}/${overallBest.trades}) · SL ${overallBest.slRate}% · PnL $${overallBest.pnl} · WR ${overallBest.winRate}%`
  );
  log(
    `SFP TP ${overallBest.sfpTpRate}% · PB TP ${overallBest.pbTpRate}%`
  );
  log(`Saved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
