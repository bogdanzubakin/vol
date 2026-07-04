#!/usr/bin/env node
/**
 * Compare old vs new AI SL/TP ratio rules on cached backtest data.
 *
 *   node scripts/compare-ai-exit-rr-backtest.js --days 30
 *   node scripts/compare-ai-exit-rr-backtest.js --days 10 --quick
 */

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars, loadManifest } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");

const OUT_FILE = () => dataPath("ai-exit-rr-compare.json");

function parseArgs(argv) {
  let days = loadManifest()?.days ?? 10;
  let quick = false;
  let mode = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
    else if (argv[i] === "--mode" && argv[i + 1]) mode = argv[++i];
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 10)),
    quick,
    mode: mode === "predict" || mode === "legacy_scale" ? mode : null,
  };
}

function loadBotConfig(extra = {}) {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiPullbackSignalEnabled: false,
    aiExitLevelsEnabled: true,
    ...extra,
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
  };
  applyBarConfig(cfg);
  scannerConfig.loadInto(cfg);
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

function absPct(entry, price) {
  if (!entry || !price) return null;
  return Math.abs(((price - entry) / entry) * 100);
}

function analyzeRun(label, result) {
  const s = result.summary ?? {};
  const trades = result.closedTrades ?? [];
  const aiTrades = trades.filter(
    (t) => t.exitMethod === "ai_levels" || t.aiSlPct != null || t.aiTpPct != null
  );

  const ratios = aiTrades
    .map((t) => {
      const sl =
        t.aiSlPct ??
        absPct(t.entryPrice, t.stopLoss ?? t.initialStopLoss);
      const tp = t.aiTpPct ?? absPct(t.entryPrice, t.takeProfit);
      if (!sl || !tp) return null;
      return { sl, tp, rr: tp / sl };
    })
    .filter(Boolean);

  const rrValues = ratios.map((r) => r.rr);
  const badLt1 = rrValues.filter((r) => r < 1).length;
  const badLt15 = rrValues.filter((r) => r < 1.5).length;
  const avgRr =
    rrValues.length > 0
      ? rrValues.reduce((a, b) => a + b, 0) / rrValues.length
      : null;
  const medianRr =
    rrValues.length > 0
      ? [...rrValues].sort((a, b) => a - b)[Math.floor(rrValues.length / 2)]
      : null;

  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;

  return {
    label,
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? trades.length,
    wins,
    losses,
    winRate:
      trades.length > 0 ? +((wins / trades.length) * 100).toFixed(1) : null,
    skippedOpen: s.skippedOpen ?? 0,
    aiExitRejects: s.aiExitLevelsRejects ?? 0,
    aiTrades: aiTrades.length,
    avgTpSlRatio: avgRr != null ? +avgRr.toFixed(3) : null,
    medianTpSlRatio: medianRr != null ? +medianRr.toFixed(3) : null,
    badRrBelow1: badLt1,
    badRrBelow1_5: badLt15,
    badRrBelow1_5Pct:
      rrValues.length > 0 ? +((badLt15 / rrValues.length) * 100).toFixed(1) : null,
    elapsedSec: result.elapsedSec ?? null,
  };
}

async function runVariant(label, symbols, signalCfg, botConfig, fetchers, days) {
  console.error(`\n=== ${label} ===`);
  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol:
      signalCfg.interval !== "1m" ? fetchers.fetchKlines1mForSymbol : null,
    restGapMs: 0,
    runMeta: { cli: "compare-ai-exit-rr", variant: label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          console.error(`[${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });
  return analyzeRun(label, result);
}

function printRow(row) {
  console.error(
    `${row.label}: PnL $${row.pnl} · ${row.trades} trades (${row.winRate}% win) · skipped ${row.skippedOpen}` +
      (row.aiExitRejects ? ` · AI rejects ${row.aiExitRejects}` : "") +
      ` · AI entries ${row.aiTrades} · median TP/SL ${row.medianTpSlRatio ?? "—"} · bad R:R<1.5 ${row.badRrBelow1_5} (${row.badRrBelow1_5Pct ?? 0}%)`
  );
}

async function main() {
  const { days, quick, mode } = parseArgs(process.argv);
  let symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }
  if (quick) symbols = symbols.slice(0, 80);

  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const base = loadBotConfig();
  const exitMode = mode ?? base.aiExitLevelsMode ?? "legacy_scale";

  const oldCfg = loadBotConfig({
    aiExitLevelsMode: exitMode,
    aiExitLevelsMinTpToSlRatio: 0,
    aiExitLevelsSkipUnfixable: false,
  });
  const newCfg = loadBotConfig({
    aiExitLevelsMode: exitMode,
    aiExitLevelsMinTpToSlRatio: 1.5,
    aiExitLevelsSkipUnfixable: true,
  });

  console.error(
    `AI exit R:R compare · ${symbols.length} symbols × ${days}d · mode ${exitMode}`
  );

  const oldRow = await runVariant("OLD (no min TP/SL)", symbols, signalCfg, oldCfg, fetchers, days);
  const newRow = await runVariant("NEW (TP ≥ 1.5× SL)", symbols, signalCfg, newCfg, fetchers, days);

  const delta = {
    pnl: +(newRow.pnl - oldRow.pnl).toFixed(2),
    trades: newRow.trades - oldRow.trades,
    badRrBelow1_5: newRow.badRrBelow1_5 - oldRow.badRrBelow1_5,
    aiExitRejects: newRow.aiExitRejects - oldRow.aiExitRejects,
  };

  console.error("\n--- Summary ---");
  printRow(oldRow);
  printRow(newRow);
  console.error(
    `Δ PnL $${delta.pnl} · Δ trades ${delta.trades} · Δ bad R:R<1.5 ${delta.badRrBelow1_5} · Δ AI rejects +${delta.aiExitRejects}`
  );

  const payload = {
    savedAt: Date.now(),
    days,
    symbolCount: symbols.length,
    quick,
    mode: exitMode,
    old: oldRow,
    new: newRow,
    delta,
  };
  writeJsonFile(OUT_FILE(), payload);
  console.error(`\nSaved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
