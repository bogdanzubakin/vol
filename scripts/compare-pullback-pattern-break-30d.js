#!/usr/bin/env node
/**
 * 30d cached backtest: pullback signals only — baseline vs pattern-break filter.
 *
 *   node scripts/compare-pullback-pattern-break-30d.js
 *   node scripts/compare-pullback-pattern-break-30d.js --days 30
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
const {
  reloadModel: reloadPatternBreak,
  trainFromTrades,
  labelBrokenPattern,
} = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadPullbackSignal } = require("../lib/pullback-signal-model");

const OUT_FILE = () => dataPath("pullback-pattern-break-30d-compare.json");

const THRESHOLDS = [
  { bull: 0.58, bear: 0.58 },
  { bull: 0.62, bear: 0.6 },
  { bull: 0.66, bear: 0.64 },
  { bull: 0.72, bear: 0.7 },
  { bull: 0.76, bear: 0.74 },
  { bull: 0.8, bear: 0.78 },
];

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 30;
  let retrain = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    if (argv[i] === "--retrain") retrain = true;
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 30)), retrain };
}

function pbTrainCollectConfig(saved) {
  return normalizeConfig({
    enabled: true,
    ...saved,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiSfpRegimeEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    aiExitLevelsEnabled: false,
    smartExitLevelsEnabled: false,
  });
}

/** Test stack: PB signal AI on, pattern-break off unless swept. */
function pbTestBase(saved) {
  return normalizeConfig({
    enabled: true,
    ...saved,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiSfpRegimeEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackSignalEnabled: true,
    aiPullbackSignalBullThreshold: 0.52,
    aiPullbackSignalBearThreshold: 0.54,
    aiPullbackSignalBtcLookbackHours: 12,
    aiPullbackPatternBreakEnabled: false,
    aiExitLevelsEnabled: false,
    smartExitLevelsEnabled: false,
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

function summarize(result) {
  const s = result.summary ?? {};
  const closed = result.closedTrades ?? [];
  const pb = closed.filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  let pbPnl = 0;
  let pbWins = 0;
  let pbSl = 0;
  for (const t of pb) {
    pbPnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) pbWins++;
    if (t.exitReason === "stop_loss") pbSl++;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    pbTrades: pb.length,
    pbPnl: +pbPnl.toFixed(2),
    pbWinRate: pb.length ? +((100 * pbWins) / pb.length).toFixed(1) : 0,
    pbSlRate: pb.length ? +((100 * pbSl) / pb.length).toFixed(1) : 0,
    winRate: s.closedCount
      ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
      : 0,
    pbBreakSkips: s.pullbackPatternBreakSkips ?? 0,
    pbBreakSkipsBull: s.pullbackPatternBreakSkipsBull ?? 0,
    pbBreakSkipsBear: s.pullbackPatternBreakSkipsBear ?? 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    pbSignalSkipsBull: s.pullbackSignalSkipsBull ?? 0,
    pbSignalSkipsBear: s.pullbackSignalSkipsBear ?? 0,
    skippedOpen: s.skippedOpen ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, fetchers }) {
  log(`\n=== ${label} ===`);
  let last = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: false,
    runMeta: { compare: "pullback-pattern-break-30d", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 120 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      }
    },
  });
  const row = { label, ...summarize(result) };
  log(
    `→ $${row.pnl} · PB ${row.pbTrades} ($${row.pbPnl}) · WR ${row.pbWinRate}% · SL ${row.pbSlRate}% · sig skip ${row.pbSignalSkips} · break skip ${row.pbBreakSkips} (bull ${row.pbBreakSkipsBull} bear ${row.pbBreakSkipsBear})`
  );
  return row;
}

async function collectPbTradesForTraining({ trainConfig, signalCfg, days, symbols, fetchers }) {
  log("\n=== collect_pb_trades (no signal filter — train only) ===");
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig: trainConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: true,
    runMeta: { compare: "pullback-pattern-break-30d", label: "train_collect_no_signal" },
  });
  const trades = (result.closedTrades ?? []).filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  const bull = trades.filter((t) => t.signalKind === "pullback").length;
  const bear = trades.filter((t) => t.signalKind === "pullback_bear").length;
  const pos = trades.filter((t) => labelBrokenPattern(t) === 1).length;
  log(
    `Collected ${trades.length} PB trades (bull ${bull} bear ${bear}) · broken labels ${pos} (${((100 * pos) / Math.max(1, trades.length)).toFixed(1)}%)`
  );
  return trades;
}

function fetchBars(symbol) {
  const sym = String(symbol).toUpperCase();
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
}

async function retrainPatternBreak(trades) {
  log(`\n=== retrain pattern-break (tight labels, ${trades.length} trades) ===`);
  await trainFromTrades(trades, fetchBars, {
    modelScope: "paper",
    source: "train:tight-label:no-signal-filter",
    aiPullbackPatternBreakBullThreshold: 0.72,
    aiPullbackPatternBreakBearThreshold: 0.7,
    aiPullbackPatternBreakBtcLookbackHours: 24,
    onProgress: (p) => {
      if (p?.message) log(p.message);
    },
  });
  reloadPatternBreak("paper");
  log("Retrained pattern-break model saved");
}

async function main() {
  const { days, retrain } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  reloadPullbackSignal("paper");
  reloadPatternBreak("paper");
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const trainConfig = pbTrainCollectConfig(saved);
  const base = pbTestBase(saved);

  log(
    `Pullback-only ${days}d compare · ${symbols.length} symbols · train=no signal filter · test baseline=signal AI`
  );

  if (retrain) {
    const trades = await collectPbTradesForTraining({
      trainConfig,
      signalCfg,
      days,
      symbols,
      fetchers,
    });
    if (trades.length < 30) {
      throw new Error(`Need >=30 PB trades to retrain (got ${trades.length})`);
    }
    await retrainPatternBreak(trades);
  }

  const baseline = await runBacktest({
    label: "baseline_signal_only",
    botConfig: base,
    signalCfg,
    days,
    symbols,
    fetchers,
  });

  const sweep = [];
  for (const th of THRESHOLDS) {
    const row = await runBacktest({
      label: `pattern_break_${th.bull}_${th.bear}`,
      botConfig: {
        ...base,
        aiPullbackPatternBreakEnabled: true,
        aiPullbackPatternBreakBullThreshold: th.bull,
        aiPullbackPatternBreakBearThreshold: th.bear,
        aiPullbackPatternBreakBtcLookbackHours: 24,
      },
      signalCfg,
      days,
      symbols,
      fetchers,
    });
    sweep.push({ thresholds: th, ...row });
  }

  const best = [...sweep].sort((a, b) => b.pnl - a.pnl)[0];
  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    trainMode: "no_signal_filter",
    testBaseline: "signal_ai",
    baseline,
    sweep,
    best: best
      ? {
          label: best.label,
          thresholds: best.thresholds,
          pnl: best.pnl,
          deltaVsBaseline: +(best.pnl - baseline.pnl).toFixed(2),
          pbTrades: best.pbTrades,
          pbBreakSkips: best.pbBreakSkips,
        }
      : null,
  };

  writeJsonFile(OUT_FILE(), payload);

  log("\n=== SUMMARY ===");
  log(
    `Baseline (signal AI): $${baseline.pnl} · PB ${baseline.pbTrades} tr · WR ${baseline.pbWinRate}% · sig skip ${baseline.pbSignalSkips}`
  );
  if (best) {
    log(
      `Best pattern-break: ${best.label} → $${best.pnl} (Δ $${(best.pnl - baseline.pnl).toFixed(2)}) · skip ${best.pbBreakSkips}`
    );
  }
  log(`Saved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
