#!/usr/bin/env node
/**
 * Train all AI models enabled in live config on N days cached data, then rerun eval.
 *
 *   node scripts/train-live-enabled-eval.js --days 50
 *   LIVE_DB_DIR=.cache/remote-db node scripts/train-live-enabled-eval.js --days 50
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(12288);

const { dataPath, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest, loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const {
  ensureAllDefaultModelsOnDisk: ensureSfpModels,
  trainFromTrades: trainSfpFromTrades,
  reloadModel: reloadSfpModel,
  saveModel: saveSfpModel,
  getModel: getSfpModel,
} = require("../lib/sfp-regime-model");
const {
  ensureAllDefaultModelsOnDisk: ensureEarlyExitModels,
  trainFromTrades: trainEarlyExitFromTrades,
  reloadModel: reloadEarlyExitModel,
  getModelStatus: getEarlyExitStatus,
  isAiEarlyExitReason,
} = require("../lib/early-exit-model");
const {
  ensureAllDefaultModelsOnDisk: ensurePbSignalModels,
  trainFromTrades: trainPbSignalFromTrades,
  reloadModel: reloadPbSignalModel,
} = require("../lib/pullback-signal-model");
const {
  ensureAllDefaultModelsOnDisk: ensureExitLevelsModels,
  trainFromTrades: trainExitLevelsFromTrades,
  reloadModel: reloadExitLevelsModel,
  saveModel: saveExitLevelsModel,
  getModel: getExitLevelsModel,
} = require("../lib/ai-exit-levels-model");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  let days = 50;
  let liveDbDir = process.env.LIVE_DB_DIR || path.join(ROOT, ".cache", "remote-db");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--live-db" && argv[i + 1]) liveDbDir = argv[++i];
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 50)),
    liveDbDir,
  };
}

function log(msg) {
  console.error(String(msg));
}

function loadLiveConfigFromDb(liveDbDir) {
  const dbFile = path.join(liveDbDir, "vol.db");
  if (!fs.existsSync(dbFile)) throw new Error(`Missing ${dbFile}`);
  const Database = require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true });
  try {
    const { loadBotRuntime } = require("../lib/db/repos/bot-state");
    const { getScannerConfig } = require("../lib/db/repos/settings");
    const runtime = loadBotRuntime(db, "live");
    if (!runtime?.config) throw new Error("No live bot config in DB");
    return {
      config: normalizeLiveConfig({ enabled: true, ...runtime.config }),
      scanner: getScannerConfig(db),
      configVersionId: runtime.configVersionId ?? null,
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

function fetchBarsAll(symbol) {
  const sym = String(symbol).toUpperCase();
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
}

function enabledModels(cfg) {
  return {
    sfpRegime: Boolean(cfg.aiSfpRegimeEnabled),
    pbSignal: Boolean(cfg.aiPullbackSignalEnabled),
    pbRegime: Boolean(cfg.aiPullbackRegimeEnabled),
    pbPatternBreak: Boolean(cfg.aiPullbackPatternBreakEnabled),
    earlyExit: Boolean(cfg.aiEarlyExitEnabled),
    exitLevels: Boolean(cfg.aiExitLevelsEnabled),
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

async function runBacktest({ label, botConfig, signalCfg, symbols, days, saveResult }) {
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  log(`\n[backtest] ${label} · ${days}d · ${symbols.length} symbols`);
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
    saveLastResult: Boolean(saveResult),
    modelScope: "live",
    getFundingOiAt,
    runMeta: { trainLiveEnabled: label, days },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          log(`  [${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });
  const s = result.summary ?? {};
  return {
    label,
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    winRate: s.closedCount ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1) : 0,
    elapsedSec: result.elapsedSec ?? 0,
    closedTrades: result.closedTrades ?? [],
    summary: s,
  };
}

async function trainSfpRegime(liveConfig, scope = "live") {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 12) throw new Error(`SFP regime: need >=12 trades (got ${trades.length})`);
  log(`\n[train] sfp_regime · ${trades.length} trades · scope ${scope}`);
  await trainSfpFromTrades(trades, fetchBarsAll, {
    modelScope: scope,
    source: `train:live-enabled:${scope}`,
    btcFeaturesEnabled: true,
    aiRegimeBtcLookbackHours: liveConfig.aiRegimeBtcLookbackHours ?? 24,
    aiRegimeBtcFastLookbackHours: liveConfig.aiRegimeBtcFastLookbackHours ?? 1,
  });
  reloadSfpModel(scope);
  const model = getSfpModel(scope);
  saveSfpModel(
    {
      ...model,
      bull: {
        ...model.bull,
        threshold: liveConfig.aiSfpRegimeGbmBullThreshold ?? liveConfig.aiSfpRegimeBullThreshold,
      },
      bear: {
        ...model.bear,
        threshold: liveConfig.aiSfpRegimeGbmBearThreshold ?? liveConfig.aiSfpRegimeBearThreshold,
      },
    },
    scope
  );
  reloadSfpModel(scope);
}

async function trainEarlyExit(scope = "live") {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) =>
      !isAiEarlyExitReason(t.exitReason) &&
      (t.signalKind === "sfp" || t.signalKind === "sfp_bear")
  );
  if (trades.length < 20) throw new Error(`Early exit: need >=20 trades (got ${trades.length})`);
  log(`\n[train] early_exit · ${trades.length} trades · scope ${scope}`);
  await trainEarlyExitFromTrades(trades, fetchBarsAll, {
    modelScope: scope,
    source: `train:live-enabled:${scope}`,
  });
  reloadEarlyExitModel(scope);
  const st = getEarlyExitStatus(scope);
  log(`  thresholds hard=${st.hardThreshold} soft=${st.softThreshold}`);
}

async function trainPbSignal(liveConfig, scope = "live") {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  if (trades.length < 30) throw new Error(`PB signal: need >=30 trades (got ${trades.length})`);
  log(`\n[train] pullback_signal · ${trades.length} trades · scope ${scope}`);
  await trainPbSignalFromTrades(trades, fetchBarsAll, {
    modelScope: scope,
    source: `train:live-enabled:${scope}`,
    aiPullbackSignalBtcLookbackHours: liveConfig.aiPullbackSignalBtcLookbackHours ?? 24,
    aiPullbackSignalBtcFastLookbackHours: liveConfig.aiPullbackSignalBtcFastLookbackHours ?? 1,
  });
  reloadPbSignalModel(scope);
}

async function trainExitLevels(liveConfig) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 20) throw new Error(`Exit levels: need >=20 trades (got ${trades.length})`);
  log(`\n[train] exit_levels · ${trades.length} trades`);

  function fetchBars(symbol, openedAt, closedAt) {
    const sym = String(symbol).toUpperCase();
    const bars = readSymbolBars("mover", sym) ?? [];
    if (!bars.length) return [];
    const from = openedAt - 120_000;
    const to = closedAt + 120_000;
    return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
  }

  await trainExitLevelsFromTrades(trades, fetchBars, {
    botConfig: liveConfig,
    scope: "paper",
    source: "train:live-enabled",
  });
  reloadExitLevelsModel("paper");
  const paperModel = getExitLevelsModel("paper");
  saveExitLevelsModel({ ...paperModel, source: "train:live-enabled:live" }, "live");
  reloadExitLevelsModel("live");
}

async function main() {
  const { days, liveDbDir } = parseArgs(process.argv);
  const loaded = loadLiveConfigFromDb(liveDbDir);
  const liveConfig = loaded.config;
  const signalCfg = loadSignalConfig(loaded.scanner);
  const symbols = cachedSymbolList();
  if (!symbols.length) throw new Error("No cached symbols — extend backtest klines first");

  const enabled = enabledModels(liveConfig);
  log(`Train live-enabled AI · ${days}d · ${symbols.length} symbols`);
  log(`Enabled: ${JSON.stringify(enabled)}`);
  log(`Config v${loaded.configVersionId}`);

  ensureSfpModels();
  ensureEarlyExitModels();
  ensurePbSignalModels();
  ensureExitLevelsModels();

  const trained = [];

  if (enabled.sfpRegime) {
    await runBacktest({
      label: "train_sfp_regime",
      botConfig: { ...liveConfig, aiSfpRegimeEnabled: false, aiEarlyExitEnabled: false },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    await trainSfpRegime(liveConfig, "live");
    await trainSfpRegime(liveConfig, "paper");
    trained.push("sfp_regime");
  }

  if (enabled.earlyExit) {
    await runBacktest({
      label: "train_early_exit",
      botConfig: { ...liveConfig, aiEarlyExitEnabled: false },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    await trainEarlyExit("live");
    await trainEarlyExit("paper");
    trained.push("early_exit");
  }

  if (enabled.pbSignal) {
    await runBacktest({
      label: "train_pullback_signal",
      botConfig: { ...liveConfig, aiPullbackSignalEnabled: false },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    await trainPbSignal(liveConfig, "live");
    await trainPbSignal(liveConfig, "paper");
    trained.push("pullback_signal");
  }

  if (enabled.exitLevels) {
    await runBacktest({
      label: "train_exit_levels",
      botConfig: {
        ...liveConfig,
        aiExitLevelsEnabled: false,
        smartExitLevelsEnabled: true,
      },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    await trainExitLevels(liveConfig);
    trained.push("exit_levels");
  }

  log("\n=== EVAL full live config ===");
  const evalResult = await runBacktest({
    label: "eval_full_live",
    botConfig: liveConfig,
    signalCfg,
    symbols,
    days,
    saveResult: false,
  });

  const trades = evalResult.closedTrades;
  const bySignal = breakdownBySignal(trades);
  const byDay = breakdownByDay(trades);

  const report = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    configVersionId: loaded.configVersionId,
    enabled,
    trained,
    summary: {
      realizedPnl: evalResult.pnl,
      closedCount: evalResult.trades,
      winCount: evalResult.wins,
      lossCount: evalResult.losses,
      winRate: evalResult.winRate,
      sfpRegimeSkips: evalResult.summary.sfpRegimeSkips ?? 0,
      pullbackSignalSkips: evalResult.summary.pullbackSignalSkips ?? 0,
      elapsedSec: evalResult.elapsedSec,
      maxDrawdownPct: evalResult.summary.equityCurve?.maxDrawdownPct ?? null,
    },
    bySignal,
    byDay,
  };

  const outFile = dataPath("live-trained-eval-report.json");
  writeJsonFile(outFile, report);

  console.log("\n========== EVAL SUMMARY ==========");
  console.log(`Days: ${days} · symbols: ${symbols.length} · trained: ${trained.join(", ") || "none"}`);
  console.log(
    `PnL: $${report.summary.realizedPnl} · trades: ${report.summary.closedCount} · WR: ${report.summary.winRate}%`
  );
  console.log("\n--- By signal ---");
  console.log(JSON.stringify(bySignal, null, 2));
  console.log("\n--- By day ---");
  console.log(JSON.stringify(byDay, null, 2));
  console.log(`\nSaved: ${outFile}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
