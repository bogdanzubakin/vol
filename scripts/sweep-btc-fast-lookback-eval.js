#!/usr/bin/env node
/**
 * Sweep fast BTC lookback hours for SFP regime + pullback signal, then 50d eval.
 * Trains early_exit / exit_levels once; retrains BTC models per fast-hours value.
 *
 *   node scripts/sweep-btc-fast-lookback-eval.js --days 50 --fast 1,2,3
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
  let fastHours = [1, 2, 3];
  let skipShared = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--live-db" && argv[i + 1]) liveDbDir = argv[++i];
    else if (argv[i] === "--fast" && argv[i + 1]) {
      fastHours = String(argv[++i])
        .split(",")
        .map((x) => Math.round(Number(x)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 24);
    } else if (argv[i] === "--skip-shared") skipShared = true;
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 50)),
    liveDbDir,
    fastHours: fastHours.length ? fastHours : [1, 2, 3],
    skipShared,
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

const TRAIN_CACHE_FILE = () => dataPath("btc-fast-sweep-train-trades.json");

function saveTrainCaches(sfpTrades, pbTrades) {
  writeJsonFile(TRAIN_CACHE_FILE(), {
    savedAt: new Date().toISOString(),
    sfpTrades,
    pbTrades,
  });
}

function loadTrainCaches() {
  const { readJsonFile } = require("../lib/data-dir");
  const raw = readJsonFile(TRAIN_CACHE_FILE(), null);
  if (!raw?.sfpTrades?.length && !raw?.pbTrades?.length) return null;
  return {
    sfpTrades: raw.sfpTrades ?? [],
    pbTrades: raw.pbTrades ?? [],
  };
}

function withFastBtcHours(baseConfig, fastHours) {
  return {
    ...baseConfig,
    aiRegimeBtcFastLookbackHours: fastHours,
    aiPullbackSignalBtcFastLookbackHours: fastHours,
  };
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
    runMeta: { sweepBtcFast: label, days },
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

async function trainSfpRegime(liveConfig, scope, sfpTrades) {
  if (sfpTrades.length < 12) throw new Error(`SFP regime: need >=12 trades (got ${sfpTrades.length})`);
  log(`\n[train] sfp_regime · fast ${liveConfig.aiRegimeBtcFastLookbackHours}h · scope ${scope}`);
  await trainSfpFromTrades(sfpTrades, fetchBarsAll, {
    modelScope: scope,
    source: `train:btc-fast-${liveConfig.aiRegimeBtcFastLookbackHours}h:${scope}`,
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

async function trainPbSignal(liveConfig, scope, pbTrades) {
  if (pbTrades.length < 30) throw new Error(`PB signal: need >=30 trades (got ${pbTrades.length})`);
  log(`\n[train] pullback_signal · fast ${liveConfig.aiPullbackSignalBtcFastLookbackHours}h · scope ${scope}`);
  await trainPbSignalFromTrades(pbTrades, fetchBarsAll, {
    modelScope: scope,
    source: `train:btc-fast-${liveConfig.aiPullbackSignalBtcFastLookbackHours}h:${scope}`,
    aiPullbackSignalBtcLookbackHours: liveConfig.aiPullbackSignalBtcLookbackHours ?? 24,
    aiPullbackSignalBtcFastLookbackHours: liveConfig.aiPullbackSignalBtcFastLookbackHours ?? 1,
  });
  reloadPbSignalModel(scope);
}

async function trainEarlyExit(scope) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) =>
      !isAiEarlyExitReason(t.exitReason) &&
      (t.signalKind === "sfp" || t.signalKind === "sfp_bear")
  );
  if (trades.length < 20) throw new Error(`Early exit: need >=20 trades (got ${trades.length})`);
  log(`\n[train] early_exit · ${trades.length} trades · scope ${scope}`);
  await trainEarlyExitFromTrades(trades, fetchBarsAll, {
    modelScope: scope,
    source: "train:btc-fast-sweep",
  });
  reloadEarlyExitModel(scope);
  const st = getEarlyExitStatus(scope);
  log(`  thresholds hard=${st.hardThreshold} soft=${st.softThreshold}`);
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
    source: "train:btc-fast-sweep",
  });
  reloadExitLevelsModel("paper");
  const paperModel = getExitLevelsModel("paper");
  saveExitLevelsModel({ ...paperModel, source: "train:btc-fast-sweep:live" }, "live");
  reloadExitLevelsModel("live");
}

async function main() {
  const { days, liveDbDir, fastHours, skipShared } = parseArgs(process.argv);
  const loaded = loadLiveConfigFromDb(liveDbDir);
  const baseConfig = loaded.config;
  const signalCfg = loadSignalConfig(loaded.scanner);
  const symbols = cachedSymbolList();
  if (!symbols.length) throw new Error("No cached symbols");

  const enabled = enabledModels(baseConfig);
  log(`BTC fast lookback sweep · ${days}d · ${symbols.length} symbols · fast=[${fastHours.join(",")}]h`);
  log(`Enabled: ${JSON.stringify(enabled)}`);

  ensureSfpModels();
  ensureEarlyExitModels();
  ensurePbSignalModels();
  ensureExitLevelsModels();

  let sfpTrades = [];
  let pbTrades = [];

  if (skipShared) {
    const cached = loadTrainCaches();
    if (!cached) throw new Error("No train cache — run full sweep first (without --skip-shared)");
    sfpTrades = cached.sfpTrades;
    pbTrades = cached.pbTrades;
    log(`Loaded train cache: ${sfpTrades.length} SFP · ${pbTrades.length} pullback trades`);
  } else if (enabled.sfpRegime) {
    await runBacktest({
      label: "train_sfp_regime",
      botConfig: { ...baseConfig, aiSfpRegimeEnabled: false, aiEarlyExitEnabled: false },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    sfpTrades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
      (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
    );
    log(`Cached ${sfpTrades.length} SFP trades for training`);
  }

  if (!skipShared && enabled.earlyExit) {
    await runBacktest({
      label: "train_early_exit",
      botConfig: { ...baseConfig, aiEarlyExitEnabled: false },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    await trainEarlyExit("live");
    await trainEarlyExit("paper");
  }

  if (!skipShared && enabled.pbSignal) {
    await runBacktest({
      label: "train_pullback_signal",
      botConfig: { ...baseConfig, aiPullbackSignalEnabled: false },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    pbTrades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
      (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
    );
    log(`Cached ${pbTrades.length} pullback trades for training`);
  }

  if (!skipShared && enabled.exitLevels) {
    await runBacktest({
      label: "train_exit_levels",
      botConfig: {
        ...baseConfig,
        aiExitLevelsEnabled: false,
        smartExitLevelsEnabled: true,
      },
      signalCfg,
      symbols,
      days,
      saveResult: true,
    });
    await trainExitLevels(baseConfig);
  }

  if (!skipShared && (sfpTrades.length || pbTrades.length)) {
    saveTrainCaches(sfpTrades, pbTrades);
    log(`Saved train caches to ${TRAIN_CACHE_FILE()}`);
  }

  const runs = [];

  for (const fastH of fastHours) {
    const liveConfig = withFastBtcHours(baseConfig, fastH);
    log(`\n========== FAST BTC ${fastH}h ==========`);

    if (enabled.sfpRegime) {
      await trainSfpRegime(liveConfig, "live", sfpTrades);
      await trainSfpRegime(liveConfig, "paper", sfpTrades);
    }
    if (enabled.pbSignal) {
      await trainPbSignal(liveConfig, "live", pbTrades);
      await trainPbSignal(liveConfig, "paper", pbTrades);
    }

    const evalResult = await runBacktest({
      label: `eval_fast_${fastH}h`,
      botConfig: liveConfig,
      signalCfg,
      symbols,
      days,
      saveResult: false,
    });

    const bySignal = breakdownBySignal(evalResult.closedTrades);
    const row = {
      fastBtcHours: fastH,
      slowBtcHours: liveConfig.aiRegimeBtcLookbackHours ?? 24,
      pnl: evalResult.pnl,
      trades: evalResult.trades,
      winRate: evalResult.winRate,
      sfpRegimeSkips: evalResult.summary.sfpRegimeSkips ?? 0,
      pullbackSignalSkips: evalResult.summary.pullbackSignalSkips ?? 0,
      bySignal,
    };
    runs.push(row);

    log(
      `fast ${fastH}h → PnL $${row.pnl} · ${row.trades} trades · WR ${row.winRate}% · sfp ${bySignal.sfp?.pnl ?? "n/a"} · sfp_bear ${bySignal.sfp_bear?.pnl ?? "n/a"} · pb ${bySignal.pullback?.pnl ?? "n/a"}`
    );
  }

  runs.sort((a, b) => b.pnl - a.pnl);
  const best = runs[0];

  const report = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    configVersionId: loaded.configVersionId,
    slowBtcHours: baseConfig.aiRegimeBtcLookbackHours ?? 24,
    fastHoursTested: fastHours,
    runs,
    best: best
      ? { fastBtcHours: best.fastBtcHours, pnl: best.pnl, trades: best.trades, winRate: best.winRate }
      : null,
  };

  const outFile = dataPath("btc-fast-lookback-sweep.json");
  writeJsonFile(outFile, report);

  console.log("\n========== SWEEP SUMMARY ==========");
  console.log(`Slow BTC: ${report.slowBtcHours}h · days: ${days}`);
  for (const r of [...runs].sort((a, b) => a.fastBtcHours - b.fastBtcHours)) {
    console.log(
      `  fast ${r.fastBtcHours}h: PnL $${r.pnl} · trades ${r.trades} · WR ${r.winRate}% · sfp $${r.bySignal.sfp?.pnl ?? 0} · sfp_bear $${r.bySignal.sfp_bear?.pnl ?? 0} · pb $${r.bySignal.pullback?.pnl ?? 0}`
    );
  }
  if (best) {
    console.log(`\nBest: fast ${best.fastBtcHours}h · PnL $${best.pnl}`);
  }
  console.log(`\nSaved: ${outFile}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
