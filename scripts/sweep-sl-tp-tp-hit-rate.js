#!/usr/bin/env node
/**
 * Sweep TP bot settings; rank by take-profit hit rate (30d cached backtest).
 *
 * AI ON: SFP regime, PB signal, AI exit levels (SL/TP).
 * AI OFF: early exit, PB regime, pattern break, early invalidation, early abort, runner.
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
const TP_MIN_PCT_FULL = [0.8, 1, 1.5, 2, 2.5, 3];
const SFP_TP_PCT_FULL = [3, 3.5, 4, 4.5, 5, 5.5, 6];
const AI_TP_SCALE_FULL = [1, 1.05, 1.1, 1.15, 1.2, 1.3];

const TP_PCT_QUICK = [3, 4, 5, 6, 8];
const TP_MIN_PCT_QUICK = [1, 1.5, 2, 2.5];
const SFP_TP_PCT_QUICK = [3.5, 4.5, 5.5];
const AI_TP_SCALE_QUICK = [1.1, 1.15, 1.2];

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

/** AI stack: SFP regime + PB signal + AI SL/TP only. */
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
    aiPullbackRegimeEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    aiSfpRegimeEnabled: true,
    aiSfpRegimeBullThreshold: 0.78,
    aiSfpRegimeBearThreshold: 0.72,
    aiRegimeBtcLookbackHours: 24,
    aiPullbackSignalEnabled: true,
    aiPullbackSignalBullThreshold: 0.52,
    aiPullbackSignalBearThreshold: 0.54,
    aiExitLevelsEnabled: true,
    aiExitLevelsLegacyDisabled: true,
    aiExitLevelsMode: "legacy_scale",
    aiExitLevelsSlScale: 1.15,
    aiExitLevelsTpScale: 1.15,
    smartExitLevelsEnabled: true,
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
    takeProfitMinPct: botConfig.takeProfitMinPct,
    sfpTakeProfitPct: botConfig.sfpTakeProfitPct,
    aiExitLevelsTpScale: botConfig.aiExitLevelsTpScale,
    stopLossBelowCorridorPct: botConfig.stopLossBelowCorridorPct,
    stopLossFallbackPnlPct: botConfig.stopLossFallbackPnlPct,
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
  const tpMinVals = quick ? TP_MIN_PCT_QUICK : TP_MIN_PCT_FULL;
  const sfpTpVals = quick ? SFP_TP_PCT_QUICK : SFP_TP_PCT_FULL;
  const aiTpScaleVals = quick ? AI_TP_SCALE_QUICK : AI_TP_SCALE_FULL;

  log(
    `TP sweep · ${days}d · ${symbols.length} symbols · rank=TP hit rate · AI: SFP regime + PB signal + AI SL/TP`
  );

  const store = readJsonFile(OUT_FILE(), { grid: [], fine: [] });
  const grid = [...(store.grid ?? [])];
  const doneLabels = new Set(grid.map((r) => r.label));

  if (phase === "all" || phase === "grid") {
    let n = 0;
    const total = tpVals.length * tpMinVals.length;
    for (const tp of tpVals) {
      for (const tmin of tpMinVals) {
        n++;
        const label = `tp${tp}_tmin${tmin}`;
        if (doneLabels.has(label)) {
          log(`\n[grid ${n}/${total}] ${label} — skip (cached)`);
          continue;
        }
        log(`\n[grid ${n}/${total}] ${label}`);
        const row = await runOne({
          label,
          botConfig: normalizeConfig({
            ...base,
            takeProfitPct: tp,
            takeProfitMinPct: Math.min(tmin, tp),
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
      `TP ${r.takeProfitPct}% min ${r.takeProfitMinPct}% → ${r.tpRate}% TP (${r.tpHits}/${r.trades}) · SL ${r.slRate}% · $${r.pnl}`
    );
  }

  const fine = [...(store.fine ?? [])];
  const fineDone = new Set(fine.map((r) => r.label));
  if (phase === "all" || phase === "fine") {
    const anchor = normalizeConfig({
      ...base,
      takeProfitPct: best.takeProfitPct,
      takeProfitMinPct: best.takeProfitMinPct,
    });

    log(
      `\n=== FINE SWEEP @ TP ${best.takeProfitPct}% min ${best.takeProfitMinPct}% ===`
    );

    for (const sfpTp of sfpTpVals) {
      if (sfpTp === anchor.sfpTakeProfitPct) continue;
      const label = `fine_sfptp${sfpTp}`;
      if (fineDone.has(label)) {
        log(`\n[fine] ${label} — skip (cached)`);
        continue;
      }
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({ ...anchor, sfpTakeProfitPct: sfpTp }),
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

    for (const aiScale of aiTpScaleVals) {
      if (aiScale === anchor.aiExitLevelsTpScale) continue;
      const label = `fine_aiscale${String(aiScale).replace(".", "_")}`;
      if (fineDone.has(label)) {
        log(`\n[fine] ${label} — skip (cached)`);
        continue;
      }
      log(`\n[fine] ${label}`);
      const row = await runOne({
        label,
        botConfig: normalizeConfig({ ...anchor, aiExitLevelsTpScale: aiScale }),
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

  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    quick,
    aiStack:
      "SFP regime + PB signal + AI exit levels ON; early exit, PB regime, pattern break OFF",
    note: "Ranked by take_profit hit rate.",
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
    `TP ${overallBest.takeProfitPct}% · TP min ${overallBest.takeProfitMinPct}% · SFP TP ${overallBest.sfpTakeProfitPct}% · AI TP scale ${overallBest.aiExitLevelsTpScale}`
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
