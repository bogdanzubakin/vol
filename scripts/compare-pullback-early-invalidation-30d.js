#!/usr/bin/env node
/**
 * 30d PB + signal AI baseline vs PB early invalidation (in-trade exit).
 *
 *   node scripts/compare-pullback-early-invalidation-30d.js --days 30
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { reloadModel: reloadPullbackSignal } = require("../lib/pullback-signal-model");

const OUT_FILE = () => dataPath("pullback-early-invalidation-30d-compare.json");

const VARIANTS = [
  { label: "inv_5_3_085", invalidateBars: 5, bars: 10, maxAdverse: 0.85, maBreak: 0.12 },
  { label: "inv_5_5_085", invalidateBars: 5, bars: 10, maxAdverse: 0.85, maBreak: 0.15 },
  { label: "inv_3_8_070", invalidateBars: 3, bars: 8, maxAdverse: 0.7, maBreak: 0.1 },
  { label: "inv_7_12_100", invalidateBars: 7, bars: 12, maxAdverse: 1.0, maBreak: 0.12 },
  { label: "inv_5_10_085", invalidateBars: 5, bars: 10, maxAdverse: 0.85, maBreak: 0.08 },
];

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 30;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 30)) };
}

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
    aiPullbackPatternBreakEnabled: false,
    pbEarlyInvalidationEnabled: false,
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
  let sl = 0;
  let earlyInv = 0;
  let earlyAdv = 0;
  let earlyStall = 0;
  for (const t of pb) {
    pbPnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) pbWins++;
    if (t.exitReason === "stop_loss") sl++;
    if (t.exitReason === "early_invalidation") earlyInv++;
    if (t.exitReason === "early_adverse") earlyAdv++;
    if (t.exitReason === "early_stall") earlyStall++;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    pbTrades: pb.length,
    pbPnl: +pbPnl.toFixed(2),
    pbWinRate: pb.length ? +((100 * pbWins) / pb.length).toFixed(1) : 0,
    slCount: sl,
    slRate: pb.length ? +((100 * sl) / pb.length).toFixed(1) : 0,
    earlyInv,
    earlyAdv,
    earlyStall,
    pbEarlyInvExits: s.pbEarlyInvalidationExits ?? 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
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
    runMeta: { compare: "pb-early-invalidation-30d", label },
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
    `→ $${row.pnl} · PB ${row.pbTrades} · WR ${row.pbWinRate}% · SL ${row.slCount} (${row.slRate}%) · early inv ${row.earlyInv} adv ${row.earlyAdv} stall ${row.earlyStall}`
  );
  return row;
}

async function main() {
  const { days } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  reloadPullbackSignal("paper");
  const saved = require("../lib/data-dir").readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const base = pbTestBase(saved);

  log(`PB early invalidation ${days}d · ${symbols.length} symbols · baseline = signal AI`);

  const baseline = await runBacktest({
    label: "baseline_signal_only",
    botConfig: base,
    signalCfg,
    days,
    symbols,
    fetchers,
  });

  const sweep = [];
  for (const v of VARIANTS) {
    const row = await runBacktest({
      label: v.label,
      botConfig: {
        ...base,
        pbEarlyInvalidationEnabled: true,
        pbEarlyInvalidationInvalidateBars: v.invalidateBars,
        pbEarlyInvalidationBars: v.bars,
        pbEarlyInvalidationMaxAdversePct: v.maxAdverse,
        pbEarlyInvalidationMaBreakPct: v.maBreak,
        pbEarlyInvalidationMinProgressPct: 0.35,
      },
      signalCfg,
      days,
      symbols,
      fetchers,
    });
    sweep.push({ params: v, ...row });
  }

  const best = [...sweep].sort((a, b) => b.pnl - a.pnl)[0];
  const payload = {
    comparedAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    baseline,
    sweep,
    best: best
      ? {
          label: best.label,
          params: best.params,
          pnl: best.pnl,
          deltaVsBaseline: +(best.pnl - baseline.pnl).toFixed(2),
          slCount: best.slCount,
          slDelta: best.slCount - baseline.slCount,
          earlyInv: best.earlyInv,
        }
      : null,
  };

  writeJsonFile(OUT_FILE(), payload);

  log("\n=== SUMMARY ===");
  log(
    `Baseline: $${baseline.pnl} · SL ${baseline.slCount}/${baseline.pbTrades} (${baseline.slRate}%)`
  );
  if (best) {
    log(
      `Best: ${best.label} → $${best.pnl} (Δ $${(best.pnl - baseline.pnl).toFixed(2)}) · SL ${best.slCount} (Δ ${best.slCount - baseline.slCount}) · early inv ${best.earlyInv}`
    );
  }
  log(`Saved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
