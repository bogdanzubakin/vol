#!/usr/bin/env node
/**
 * Strategy evaluation: refresh recent klines + cached backtest with live bot settings from production DB.
 *
 *   node scripts/run-live-strategy-eval.js --days 10
 *   LIVE_DB_DIR=.cache/remote-db node scripts/run-live-strategy-eval.js --days 10 --skip-refresh
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const {
  readSymbolBars,
  refreshBacktestKlineCacheTail,
  loadManifest,
} = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { buildBacktestExport } = require("../lib/backtest-export");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");

const ROOT = path.join(__dirname, "..");
const REPORT_FILE = () =>
  process.env.STRATEGY_EVAL_REPORT || dataPath("live-strategy-eval-report.json");

function parseArgs(argv) {
  let days = 10;
  let skipRefresh = false;
  let liveDbDir = process.env.LIVE_DB_DIR || path.join(ROOT, ".cache", "remote-db");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--skip-refresh") skipRefresh = true;
    else if (argv[i] === "--live-db" && argv[i + 1]) liveDbDir = argv[++i];
    else if (argv[i] === "--report" && argv[i + 1]) {
      process.env.STRATEGY_EVAL_REPORT = argv[++i];
    }
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 10)),
    skipRefresh,
    liveDbDir,
  };
}

function log(line) {
  console.error(String(line));
}

function loadLiveConfigFromDb(liveDbDir) {
  const dbFile = path.join(liveDbDir, "vol.db");
  if (!fs.existsSync(dbFile)) {
    throw new Error(`Missing ${dbFile} — run scripts/db-remote-sync.sh first`);
  }
  const Database = require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true });
  try {
    const { loadBotRuntime } = require("../lib/db/repos/bot-state");
    const { listConfigVersions } = require("../lib/db/repos/config");
    const { getScannerConfig } = require("../lib/db/repos/settings");
    const runtime = loadBotRuntime(db, "live");
    if (!runtime?.config) throw new Error(`No live bot config in ${liveDbDir}`);
    return {
      config: normalizeLiveConfig({ enabled: true, ...runtime.config }),
      configVersionId: runtime.configVersionId ?? null,
      configVersions: listConfigVersions(db, "live", { limit: 5 }),
      scanner: getScannerConfig(db),
    };
  } finally {
    db.close();
  }
}

function loadSignalConfig(scannerRaw = {}) {
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
    ...scannerRaw,
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

function reloadLiveModels() {
  reloadSfp("live");
  reloadPbSignal("live");
  reloadExitLevels("live");
  reloadEarlyExit("live");
}

function aiFlags(cfg) {
  return {
    sfpRegime: Boolean(cfg.aiSfpRegimeEnabled),
    pbSignal: Boolean(cfg.aiPullbackSignalEnabled),
    pbRegime: Boolean(cfg.aiPullbackRegimeEnabled),
    exitLevels: Boolean(cfg.aiExitLevelsEnabled),
    earlyExit: Boolean(cfg.aiEarlyExitEnabled),
    drawdownStop: Boolean(cfg.drawdownStopEnabled),
  };
}

function breakdownBySignal(trades) {
  const kinds = ["sfp", "sfp_bear", "pullback", "pullback_bear"];
  const out = {};
  for (const k of kinds) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    const pnl = rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const tp = rows.filter((t) => t.exitReason === "take_profit").length;
    const sl = rows.filter((t) => t.exitReason === "stop_loss").length;
    out[k] = {
      trades: rows.length,
      pnl: +pnl.toFixed(2),
      winRate: +((100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) / rows.length).toFixed(1),
      tpRate: +((100 * tp) / rows.length).toFixed(1),
      slRate: +((100 * sl) / rows.length).toFixed(1),
    };
  }
  return out;
}

function breakdownByDay(trades) {
  const map = new Map();
  for (const t of trades) {
    const day = new Date(t.closedAt).toISOString().slice(0, 10);
    if (!map.has(day)) map.set(day, { trades: 0, pnl: 0, wins: 0 });
    const row = map.get(day);
    row.trades++;
    row.pnl += Number(t.pnl) || 0;
    if ((Number(t.pnl) || 0) > 0) row.wins++;
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({
      day,
      trades: v.trades,
      pnl: +v.pnl.toFixed(2),
      winRate: v.trades ? +((100 * v.wins) / v.trades).toFixed(1) : 0,
    }));
}

function cacheWindowSummary() {
  const btc = readSymbolBars("mover", "BTCUSDT");
  if (!btc?.length) return null;
  return {
    bars: btc.length,
    from: new Date(btc[0].openTime).toISOString(),
    to: new Date(btc[btc.length - 1].closeTime).toISOString(),
  };
}

async function main() {
  const { days, skipRefresh, liveDbDir } = parseArgs(process.argv);
  const loaded = loadLiveConfigFromDb(liveDbDir);
  const botConfig = loaded.config;
  const signalCfg = loadSignalConfig(loaded.scanner);
  const symbols = cachedSymbolList();
  if (!symbols.length) throw new Error("No cached symbols — warm backtest klines first");

  reloadLiveModels();

  let refreshStats = null;
  if (!skipRefresh) {
    log(`Refreshing kline tail · ${symbols.length} symbols · ${days}d window…`);
    const manifest = loadManifest();
    refreshStats = await refreshBacktestKlineCacheTail({
      targetDays: days,
      interval: manifest?.interval ?? signalCfg.interval ?? "1m",
      symbols,
      restGapMs: 400,
      symbolPauseMs: 600,
      onProgress: (p) => {
        if (p.phase === "refresh" && p.done % 25 === 0) {
          log(`[refresh] ${p.done}/${p.total} · ${p.symbol}`);
        }
        if (p.phase === "refresh-error") {
          log(`[refresh] ${p.symbol}: ${p.error}`);
        }
      },
      onRateLimit: (info) => {
        const waitSec = Math.ceil((info.waitMs ?? 0) / 1000);
        log(`[rate-limit] ${info.label} wait ${waitSec}s`);
      },
    });
    log(`Refresh done: ${JSON.stringify(refreshStats)}`);
  }

  const window = cacheWindowSummary();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  const fetchers = createFetchers();

  log(`\nStrategy eval · ${days}d · ${symbols.length} symbols`);
  log(`Config v${loaded.configVersionId} · ${liveDbDir}`);
  log(`Leverage ${botConfig.leverage}x · margin $${botConfig.positionSizeUsdt} · max pos ${botConfig.maxOpenPositions}`);
  log(`Data window: ${window ? `${window.from} → ${window.to}` : "unknown"}`);
  log(`AI: ${JSON.stringify(aiFlags(botConfig))}`);

  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol:
      (signalCfg.interval ?? "1m") !== "1m" ? fetchers.fetchKlines1mForSymbol : null,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: true,
    getFundingOiAt,
    modelScope: "live",
    runMeta: {
      report: "live-strategy-eval",
      days,
      configVersionId: loaded.configVersionId,
      liveDbDir,
    },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          log(`[simulate] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });

  const trades = result.closedTrades ?? [];
  const s = result.summary ?? {};
  const exportBundle = buildBacktestExport({
    includeSourceCode: false,
    includeEvents: days <= 30,
    includeEquityCurve: true,
  });

  const report = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    dataWindow: window,
    refresh: refreshStats,
    liveDbDir,
    configVersionId: loaded.configVersionId,
    configVersions: loaded.configVersions,
    liveConfig: botConfig,
    signalConfig: signalCfg,
    aiFlags: aiFlags(botConfig),
    summary: {
      realizedPnl: s.realizedPnl,
      closedCount: s.closedCount,
      winCount: s.winCount,
      lossCount: s.lossCount,
      winRate: s.closedCount
        ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
        : 0,
      sfpSignals: s.sfpSignals,
      sfpBearSignals: s.sfpBearSignals,
      pullbackSignals: s.pullbackSignals,
      pullbackBearSignals: s.pullbackBearSignals,
      sfpRegimeSkips: s.sfpRegimeSkips,
      pullbackRegimeSkips: s.pullbackRegimeSkips,
      pullbackSignalSkips: s.pullbackSignalSkips,
      skippedOpen: s.skippedOpen,
      aiExits: s.aiExits,
      elapsedSec: result.elapsedSec,
      maxDrawdownPct: result.equityCurve?.maxDrawdownPct ?? null,
    },
    bySignal: breakdownBySignal(trades),
    byDay: breakdownByDay(trades),
    topWinners: result.topWinners?.slice(0, 15) ?? [],
    topLosers: result.topLosers?.slice(0, 15) ?? [],
    analytics: exportBundle.analytics ?? null,
    equityCurve: exportBundle.equityCurve ?? null,
    integrity: exportBundle.integrity ?? null,
  };

  writeJsonFile(REPORT_FILE(), report);
  console.log(JSON.stringify(report, null, 2));
  log(`\nReport: ${REPORT_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
