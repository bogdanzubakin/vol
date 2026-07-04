#!/usr/bin/env node
/**
 * Cache-only train-bot backtest (saves paper-bot-backtest-last.json for regime training).
 *
 *   node scripts/run-cached-train-backtest.js --days 10 --cache-only
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

function loadBotConfig() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiPullbackSignalEnabled: false,
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

async function main() {
  const { days } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  const botConfig = loadBotConfig();
  const signalCfg = loadSignalConfig();
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers();

  console.error(
    `Cached backtest: ${symbols.length} symbols × ${days}d · SFP ${botConfig.tradeSfpSignals ? "on" : "off"} (regime ${botConfig.aiSfpRegimeEnabled ? "on" : "off"}) · PB ${botConfig.tradePullbackSignals ? "on" : "off"} (regime ${botConfig.aiPullbackRegimeEnabled ? "on" : "off"})`
  );

  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol,
    fetchKlines1mForSymbol: signalCfg.interval !== "1m" ? fetchKlines1mForSymbol : null,
    restGapMs: 0,
    runMeta: {
      cli: "cached-train",
      sfpRegime: botConfig.aiSfpRegimeEnabled,
      pullbackRegime: botConfig.aiPullbackRegimeEnabled,
    },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          console.error(`[backtest] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });

  const s = result.summary ?? {};
  console.error(
    `\nPnL $${(s.realizedPnl ?? 0).toFixed(2)} · ${s.closedCount ?? 0} trades · ${result.elapsedSec}s`
  );
  console.error(
    `SFP regime skips ${s.sfpRegimeSkips ?? 0} · PB regime skips ${s.pullbackRegimeSkips ?? 0}`
  );
  console.error(
    `Signals: SFP ${s.sfpSignals ?? 0}+${s.sfpBearSignals ?? 0} · PB ${s.pullbackSignals ?? 0}+${s.pullbackBearSignals ?? 0}`
  );
  console.error(`Saved ${dataPath("paper-bot-backtest-last.json")}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
