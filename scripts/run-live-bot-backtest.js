#!/usr/bin/env node
/**
 * Cached backtest using live-bot-state.json config (production settings).
 *
 *   node scripts/run-live-bot-backtest.js --days 10
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");

function parseArgs(argv) {
  let days = 10;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 10)) };
}

function loadLiveBotConfig() {
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

async function main() {
  const { days } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  const botConfig = loadLiveBotConfig();
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();

  console.error(
    `Live bot backtest · ${days}d · ${symbols.length} symbols · lev ${botConfig.leverage} · margin $${botConfig.positionSizeUsdt}`
  );
  console.error(
    `TP ${botConfig.takeProfitPct}% min ${botConfig.takeProfitMinPct}% · SFP TP ${botConfig.sfpTakeProfitPct}% · AI TP scale ${botConfig.aiExitLevelsTpScale}`
  );
  console.error(
    `AI: SFP regime ${botConfig.aiSfpRegimeEnabled ? "ON" : "OFF"} · PB signal ${botConfig.aiPullbackSignalEnabled ? "ON" : "OFF"} · PB regime ${botConfig.aiPullbackRegimeEnabled ? "ON" : "OFF"} · exit levels ${botConfig.aiExitLevelsEnabled ? "ON" : "OFF"} · early exit ${botConfig.aiEarlyExitEnabled ? "ON" : "OFF"}`
  );

  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: true,
    runMeta: { cli: "live-bot-backtest", days },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          console.error(`[backtest] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });

  const trades = result.closedTrades ?? [];
  const tp = trades.filter((t) => t.exitReason === "take_profit");
  const sl = trades.filter((t) => t.exitReason === "stop_loss");
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const s = result.summary ?? {};

  const out = {
    label: "live-bot-production",
    days,
    symbolCount: symbols.length,
    trades: trades.length,
    tpHits: tp.length,
    tpRate: trades.length ? +((100 * tp.length) / trades.length).toFixed(2) : 0,
    slHits: sl.length,
    slRate: trades.length ? +((100 * sl.length) / trades.length).toFixed(2) : 0,
    pnl: +pnl.toFixed(2),
    winRate: trades.length
      ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
      : 0,
    realizedPnl: s.realizedPnl,
    sfpRegimeSkips: s.sfpRegimeSkips ?? 0,
    pullbackRegimeSkips: s.pullbackRegimeSkips ?? 0,
    pullbackSignalSkips: s.pullbackSignalSkips ?? 0,
    elapsedSec: result.elapsedSec,
    config: {
      takeProfitPct: botConfig.takeProfitPct,
      takeProfitMinPct: botConfig.takeProfitMinPct,
      aiExitLevelsTpScale: botConfig.aiExitLevelsTpScale,
      leverage: botConfig.leverage,
      positionSizeUsdt: botConfig.positionSizeUsdt,
    },
  };

  console.log(JSON.stringify(out, null, 2));
  console.error(`\nSaved ${dataPath("paper-bot-backtest-last.json")}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
