#!/usr/bin/env node
/**
 * 10d FOI-only backtest (Funding–OI Impulse + SFP/PB confirm).
 *
 *   node scripts/report-foi-10d.js --days 10
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(8192);

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
const { formatIsoUtcPlus3 } = require("../lib/time-format");

const OUT_FILE = () => dataPath("foi-10d-report.json");

function parseArgs(argv) {
  let days = 10;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 10)) };
}

function log(msg) {
  console.error(String(msg));
}

function loadBotConfig() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    // FOI-only isolation
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    foiMinAbsFundingRate: 0.00012,
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

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((sym) => (readSymbolBars("signal", sym)?.length ?? 0) >= 200)
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
      const cached =
        readCached(sym, "mover", barCount) ?? readCached(sym, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${sym}`);
    },
  };
}

function dayKey(t) {
  const iso =
    t.closedAtIso ??
    (t.closedAt != null ? formatIsoUtcPlus3(t.closedAt) : null);
  return iso ? iso.slice(0, 10) : "unknown";
}

function breakdownBySignal(trades) {
  const out = {};
  for (const k of ["foi", "foi_bear", "sfp", "sfp_bear", "pullback", "pullback_bear"]) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    const pnl = rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    out[k] = {
      trades: rows.length,
      pnl: +pnl.toFixed(2),
      winRate: +((100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) / rows.length).toFixed(1),
    };
  }
  return out;
}

function breakdownByDay(trades) {
  const map = new Map();
  for (const t of trades) {
    const day = dayKey(t);
    if (!map.has(day)) map.set(day, { day, trades: 0, pnl: 0, wins: 0 });
    const row = map.get(day);
    const pnl = Number(t.pnl) || 0;
    row.trades++;
    row.pnl += pnl;
    if (pnl > 0) row.wins++;
  }
  return [...map.values()]
    .map((r) => ({
      ...r,
      pnl: +r.pnl.toFixed(2),
      winRate: r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function breakdownByPair(trades) {
  const map = new Map();
  for (const t of trades) {
    const sym = t.symbol || "?";
    if (!map.has(sym)) map.set(sym, { symbol: sym, trades: 0, pnl: 0, wins: 0 });
    const row = map.get(sym);
    const pnl = Number(t.pnl) || 0;
    row.trades++;
    row.pnl += pnl;
    if (pnl > 0) row.wins++;
  }
  return [...map.values()]
    .map((r) => ({
      ...r,
      pnl: +r.pnl.toFixed(2),
      winRate: r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl);
}

function confirmMix(trades) {
  const map = new Map();
  for (const t of trades) {
    const c = t.signalSnapshot?.confirmKind || t.confirmKind || "unknown";
    if (!map.has(c)) map.set(c, { confirm: c, trades: 0, pnl: 0 });
    const row = map.get(c);
    row.trades++;
    row.pnl += Number(t.pnl) || 0;
  }
  return [...map.values()]
    .map((r) => ({ ...r, pnl: +r.pnl.toFixed(2) }))
    .sort((a, b) => b.trades - a.trades);
}

async function main() {
  const { days } = parseArgs(process.argv);
  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }

  const symbols = cachedSymbolList();
  if (!symbols.length) throw new Error("No cached symbols");
  const botConfig = loadBotConfig();
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);

  log(`FOI 10d · ${days}d · ${symbols.length} symbols · FOI-only`);
  log(
    `funding≥${botConfig.foiMinAbsFundingRate} · confirm SFP=${botConfig.foiConfirmSfp} PB=${botConfig.foiConfirmPullback}`
  );

  const BATCH = 40;
  const trades = [];
  const started = Date.now();

  for (let offset = 0; offset < symbols.length; offset += BATCH) {
    const batch = symbols.slice(offset, offset + BATCH);
    const batchNo = Math.floor(offset / BATCH) + 1;
    const batchTotal = Math.ceil(symbols.length / BATCH);
    log(`[batch ${batchNo}/${batchTotal}] ${batch[0]}…${batch[batch.length - 1]}`);

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
      runMeta: { report: "foi-10d", days, batch: batchNo },
    });

    for (const t of result.closedTrades ?? []) {
      trades.push({
        symbol: t.symbol,
        signalKind: t.signalKind,
        pnl: t.pnl,
        closedAt: t.closedAt,
        closedAtIso: t.closedAtIso,
        exitReason: t.exitReason,
        confirmKind: t.signalSnapshot?.confirmKind ?? t.confirmKind ?? null,
        fundingRate: t.signalSnapshot?.fundingRate ?? t.fundingRate ?? null,
      });
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
    log(`  → cum ${trades.length} tr · ${Math.round((Date.now() - started) / 1000)}s`);
  }

  const totalPnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const bySignal = breakdownBySignal(trades);
  const byDay = breakdownByDay(trades);
  const byPair = breakdownByPair(trades);
  const report = {
    ranAt: new Date().toISOString(),
    days,
    mode: "foi-only",
    symbolCount: symbols.length,
    botFlags: {
      tradeFoiSignals: botConfig.tradeFoiSignals,
      tradeBearishFoiSignals: botConfig.tradeBearishFoiSignals,
      foiMinAbsFundingRate: botConfig.foiMinAbsFundingRate,
      foiRequireOiConfirm: botConfig.foiRequireOiConfirm,
    },
    summary: {
      trades: trades.length,
      pnl: +totalPnl.toFixed(2),
      winRate: trades.length
        ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
        : 0,
      elapsedSec: +((Date.now() - started) / 1000).toFixed(1),
      pairsTraded: byPair.length,
      profitablePairs: byPair.filter((p) => p.pnl > 0).length,
      losingPairs: byPair.filter((p) => p.pnl < 0).length,
    },
    bySignal,
    byConfirm: confirmMix(trades),
    byDay,
    topPairs: byPair.slice(0, 25),
    bottomPairs: [...byPair].sort((a, b) => a.pnl - b.pnl).slice(0, 25),
  };
  writeJsonFile(OUT_FILE(), report);

  log("\n=== SUMMARY ===");
  log(
    `PnL $${report.summary.pnl} · ${report.summary.trades} tr · WR ${report.summary.winRate}%`
  );
  log(`bySignal ${JSON.stringify(bySignal)}`);
  log(`byConfirm ${JSON.stringify(report.byConfirm)}`);
  log("\n=== BY DAY ===");
  for (const d of byDay) {
    log(`${d.day}  tr=${d.trades}  pnl=${d.pnl}  WR=${d.winRate}%`);
  }
  log("\n=== TOP PAIRS ===");
  for (const p of report.topPairs.slice(0, 15)) {
    log(`${p.symbol}  tr=${p.trades}  pnl=${p.pnl}  WR=${p.winRate}%`);
  }
  log("\n=== BOTTOM PAIRS ===");
  for (const p of report.bottomPairs.slice(0, 15)) {
    log(`${p.symbol}  tr=${p.trades}  pnl=${p.pnl}  WR=${p.winRate}%`);
  }
  log(`\nSaved ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
