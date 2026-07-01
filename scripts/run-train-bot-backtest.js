#!/usr/bin/env node
/**
 * Run train-bot (paper backtest) locally.
 *
 *   node scripts/run-train-bot-backtest.js --days 5
 *   node scripts/run-train-bot-backtest.js --days 5 --max-symbols 50
 */

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig, pickLiveConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { mergeBarsByOpenTime, createKlineCacheStore } = require("../lib/kline-cache");
const {
  runPaperBotBacktest,
  resolveBacktestSymbols,
} = require("../lib/paper-bot-backtest");

const REST_BASE = "https://fapi.binance.com";
const KLINE_MAX = 1500;
const EXCHANGE_INFO_CACHE = dataPath("futures-exchangeInfo.json");

const { createRestQueue, sleep } = require("../lib/rest-queue");

function parseArgs(argv) {
  let days = 5;
  let maxSymbols = 0;
  let restGapMs = 120;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--max-symbols" && argv[i + 1]) {
      maxSymbols = Number(argv[++i]);
    } else if (argv[i] === "--rest-gap-ms" && argv[i + 1]) {
      restGapMs = Number(argv[++i]);
    }
  }
  return {
    days: Math.max(1, Math.min(21, Math.round(days) || 5)),
    maxSymbols: Math.max(0, Math.round(maxSymbols) || 0),
    restGapMs: Math.max(50, restGapMs),
  };
}

function intervalBarMs(interval) {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) return 60_000;
  const n = Number(m[1]);
  const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 24 * 60;
  return minutes * 60 * 1000;
}

function parseKlines(rows) {
  return rows.map((r) => ({
    openTime: r[0],
    open: +r[1],
    high: +r[2],
    low: +r[3],
    close: +r[4],
    volume: +r[5],
    closeTime: r[6],
  }));
}

async function getJson(pathName, params = {}, restQueue) {
  const queue = restQueue ?? restQueueForCli;
  return queue.schedule(async () => {
    const url = new URL(pathName, REST_BASE);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`${pathName} ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  });
}

let restQueueForCli = null;

function readExchangeSymbols() {
  try {
    const data = JSON.parse(fs.readFileSync(EXCHANGE_INFO_CACHE, "utf8"));
    if (Array.isArray(data.symbols) && data.symbols.length) return data.symbols;
  } catch {
    /* fetch below */
  }
  return null;
}

async function listUsdtPerpSymbols() {
  const cached = readExchangeSymbols();
  if (cached?.length) return cached;
  const info = await getJson("/fapi/v1/exchangeInfo");
  const symbols = info.symbols
    .filter(
      (s) =>
        s.status === "TRADING" &&
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT"
    )
    .map((s) => s.symbol);
  fs.mkdirSync(path.dirname(EXCHANGE_INFO_CACHE), { recursive: true });
  fs.writeFileSync(
    EXCHANGE_INFO_CACHE,
    JSON.stringify({ savedAt: Date.now(), symbols })
  );
  return symbols;
}

async function fetchKlinesInterval(symbol, interval, limit, restQueue) {
  let all = [];
  let endTime;
  let remaining = limit;

  while (remaining > 0) {
    const batch = Math.min(remaining, KLINE_MAX);
    const params = { symbol, interval, limit: String(batch) };
    if (endTime !== undefined) params.endTime = String(endTime);
    const rows = await getJson("/fapi/v1/klines", params, restQueue);
    if (!rows.length) break;
    const parsed = parseKlines(rows);
    all = [...parsed, ...all];
    endTime = rows[0][0] - 1;
    remaining -= parsed.length;
    if (parsed.length < batch) break;
    await sleep(30);
  }
  return all.slice(-limit);
}

function loadBotConfig() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    tradeSfpSignals: true,
    tradeBearishSfpSignals: true,
  });
}

function loadSignalConfig() {
  const cfg = {
    interval: "1m",
    corridorDays: 2,
    corridorExcludeMinutes: 40,
    signalCandles: 3,
    fastMoveLookbackCandles: 10,
    minAvgMovePct: 0.5,
    minLinearChangePct: 0.5,
    fastMoveExcludeMult: 3,
    topMoveMinPct: 5,
    sfpLookbackBars: 30,
    sfpRangeBars: 60,
    sfpReclaimBars: 5,
    sfpMinSweepPct: 0.05,
    pullbackMaBars: 7,
    pullbackTouchLookback: 12,
    pullbackMaxDistancePct: 0.35,
    pullbackMaxAboveMaPct: 1.5,
    levelBreakPivotBars: 3,
    levelBreakLookbackBars: 80,
    levelBreakMinTouches: 2,
    levelBreakTouchPct: 0.25,
    levelBreakMinPct: 0.08,
    levelBreakApproachPct: 0.4,
    levelBreakApproachBars: 12,
    cacheMaxBars: 50_000,
  };
  applyBarConfig(cfg);
  scannerConfig.loadInto(cfg);
  applyBarConfig(cfg);
  return cfg;
}

function printSummary(result) {
  const s = result.summary ?? {};
  console.error("\n=== Train bot result ===");
  console.error(`PnL: $${(s.realizedPnl ?? 0).toFixed(2)} · deposit $${(s.deposit ?? 0).toFixed(2)}`);
  console.error(
    `Trades: ${s.closedCount ?? 0} · WR ${s.winCount ?? 0}/${s.lossCount ?? 0} · skipped ${s.skippedOpen ?? 0}`
  );
  console.error(
    `SFP bull/bear: ${s.sfpSignals ?? 0}/${s.sfpBearSignals ?? 0} · regime skips ${s.sfpRegimeSkips ?? 0}`
  );
  console.error(
    `Symbols: ${result.symbolsProcessed}/${result.symbolsTotal} (${result.symbolsSkipped} skipped) · ${result.days}d · ${result.elapsedSec}s`
  );
  if (result.equityCurve?.maxDrawdownPct != null) {
    console.error(`Max equity drawdown: ${result.equityCurve.maxDrawdownPct}%`);
  }
}

async function main() {
  const { days, maxSymbols, restGapMs } = parseArgs(process.argv);
  restQueueForCli = createRestQueue({ label: "backtest-cli", gapMs: restGapMs });
  const signalCfg = loadSignalConfig();
  const botConfig = loadBotConfig();
  const allSymbols = await listUsdtPerpSymbols();
  const { symList } = resolveBacktestSymbols(
    { maxSymbols: maxSymbols || undefined },
    allSymbols
  );
  const list = maxSymbols > 0 ? symList.slice(0, maxSymbols) : symList;

  const klineCache = createKlineCacheStore({
    dir: path.join(dataPath(), "klines"),
    interval: signalCfg.interval,
    maxBars: 50_000,
    evalLimit: 50_000,
  });

  async function fetchKlinesForSymbol(symbol, barCount) {
    const sym = String(symbol).toUpperCase();
    let bars = [...(klineCache.read(sym) ?? [])];
    if (bars.length >= barCount) return bars.slice(-barCount);
    try {
      const fetched = await fetchKlinesInterval(sym, signalCfg.interval, barCount, restQueueForCli);
      bars = mergeBarsByOpenTime(bars, fetched);
      if (bars.length) klineCache.replace(sym, bars);
      return bars.slice(-barCount);
    } catch (e) {
      if (bars.length >= 200) {
        console.error(`Backtest ${sym}: REST failed (${e.message}), using ${bars.length} cached bars`);
        return bars.slice(-barCount);
      }
      throw e;
    }
  }

  console.error(
    `Train bot: ${list.length} symbols × ${days}d · interval ${signalCfg.interval} · SFP ${botConfig.tradeSfpSignals}/${botConfig.tradeBearishSfpSignals}`
  );

  let lastLog = 0;
  const { result } = await runPaperBotBacktest({
    symbols: list,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol,
    restGapMs,
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastLog < 2000 && p.phase !== "done") return;
      lastLog = now;
      const msg = p.message ?? `${p.phase} ${p.done ?? 0}/${p.total ?? "?"}`;
      console.error(`[${p.phase}] ${msg}`);
    },
    runMeta: { cli: true, maxSymbols: maxSymbols || list.length },
  });

  const errors = (result.perSymbol ?? []).filter((r) => r.error);
  if (errors.length) {
    console.error(`\n${errors.length} symbol error(s), e.g. ${errors[0].symbol}: ${errors[0].error}`);
  }

  printSummary(result);

  if (!result.closedTradesTotal && !result.summary?.closedCount) {
    console.error("FAIL: no closed trades");
    process.exit(1);
  }
  if (errors.length > list.length * 0.1) {
    console.error("FAIL: too many symbol errors");
    process.exit(1);
  }
  console.error(`\nOK · saved ${dataPath("paper-bot-backtest-last.json")}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
