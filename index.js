/**
 * vol-scanner — Binance USDT-M perpetuals (SFP + pullback)
 *
 * node index.js --all
 * node index.js --all --no-prefetch
 * node index.js --symbols VICUSDT --prefetch
 * Dashboard: http://127.0.0.1:3877/  (--no-http to disable)
 *
 * Telegram (optional): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in `.env`
 *   --no-telegram  disable
 *   Notifies on non-SL trade closes (TP, manual) — not on scanner signals
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const {
  applyBarConfig,
  validateLiveConfigPatch,
  fastMoverMetrics,
  minHistoryBars,
  serializeChecks,
  pickLiveConfig,
  parseAtTime,
  barsAtTime,
  analyzeSweepReclaim,
  analyzeSweepReject,
  fastMoverPullbackMetrics,
  fastMoverPullbackBearMetrics,
  analyzePullback,
  fastMoverOptsFromCfg,
  fastMoverLookbackFor1m,
  sfpRangeBars,
} = require("./lib/signal-metrics");
const { evaluateFoiLong, evaluateFoiBear } = require("./lib/foi-signal");
const { evaluateExtremalSpikeGate } = require("./lib/extremal-spike-gate");
const { getChartPayload } = require("./lib/chart-render");
const { formatIsoUtcPlus3 } = require("./lib/time-format");
const {
  startDashboard,
  createDashboardPublisher,
  resolveListenOptions,
} = require("./lib/dashboard-server");
const {
  resolveTelegramConfig,
  createTelegramNotifier,
} = require("./lib/telegram-notify");
const { createPaperBot } = require("./lib/paper-bot");
const {
  ensureAllDefaultModelsOnDisk,
  getModel: getEarlyExitModel,
  getModelStatus,
  trainFromTrades,
  reloadModel,
  saveModel: saveEarlyExitModel,
} = require("./lib/early-exit-model");
const { normalizeAiModelScope } = require("./lib/ai-model-scope");
const { writeGbmBundles } = require("./lib/gbm-model-import");
const { collectAiTrainingTrades } = require("./lib/ai-training-trades");
const {
  ensureAllDefaultModelsOnDisk: ensureAllSfpRegimeModelsOnDisk,
  getModel: getSfpRegimeModel,
  getModelStatus: getSfpRegimeModelStatus,
  trainFromTrades: trainSfpRegimeFromTrades,
  reloadModel: reloadSfpRegimeModel,
  saveModel: saveSfpRegimeModel,
} = require("./lib/sfp-regime-model");
const { createSfpRegimeMonitor } = require("./lib/sfp-regime-monitor");
const {
  ensureAllDefaultModelsOnDisk: ensureAllPullbackRegimeModelsOnDisk,
  getModel: getPullbackRegimeModel,
  getModelStatus: getPullbackRegimeModelStatus,
  trainFromTrades: trainPullbackRegimeFromTrades,
  reloadModel: reloadPullbackRegimeModel,
  saveModel: savePullbackRegimeModel,
} = require("./lib/pullback-regime-model");
const { createPullbackRegimeMonitor } = require("./lib/pullback-regime-monitor");
const {
  ensureAllDefaultModelsOnDisk: ensureAllPullbackPatternBreakModelsOnDisk,
  getModel: getPullbackPatternBreakModel,
  getModelStatus: getPullbackPatternBreakModelStatus,
  trainFromTrades: trainPullbackPatternBreakFromTrades,
  reloadModel: reloadPullbackPatternBreakModel,
  saveModel: savePullbackPatternBreakModel,
} = require("./lib/pullback-pattern-break-model");
const { createPullbackPatternBreakMonitor } = require("./lib/pullback-pattern-break-monitor");
const {
  ensureAllDefaultModelsOnDisk: ensureAllPullbackSignalModelsOnDisk,
  getModel: getPullbackSignalModel,
  getModelStatus: getPullbackSignalModelStatus,
  trainFromTrades: trainPullbackSignalFromTrades,
  reloadModel: reloadPullbackSignalModel,
  saveModel: savePullbackSignalModel,
} = require("./lib/pullback-signal-model");
const { ensureGbmModelsForScope: ensurePullbackGbm } = require("./lib/pullback-signal-onnx");
const { ensureGbmModelsForScope: ensureSfpRegimeGbm } = require("./lib/sfp-regime-onnx");
const { createFundingOiProvider } = require("./lib/funding-oi-provider");
const { createObiLiveRunner } = require("./lib/obi-live-runner");
const { createTapeLiveRunner } = require("./lib/tape-live-runner");
const { fetchDepthSnapshot } = require("./lib/binance-futures-depth");
const { fetchAggTrades } = require("./lib/binance-futures-aggtrade");
const { computeBookTapeCombo } = require("./lib/book-tape-combo");
const {
  ensureAllDefaultModelsOnDisk: ensureAllAiExitLevelsModelsOnDisk,
  getModel: getAiExitLevelsModel,
  getModelStatus: getAiExitLevelsModelStatus,
  reloadModel: reloadAiExitLevelsModel,
  saveModel: saveAiExitLevelsModel,
  trainFromTrades: trainAiExitLevelsFromTrades,
} = require("./lib/ai-exit-levels");
const { BTC_SYMBOL } = require("./lib/btc-regime-context");
const { createLiveBot } = require("./lib/live-bot");
const { formatDrawdownTelegramMessage } = require("./lib/bot-drawdown-guard");
const { createFuturesTrader } = require("./lib/binance-futures-trade");
const { createBinanceUserStream } = require("./lib/binance-user-stream");
const { startPaperBotMorningReports } = require("./lib/paper-bot-report");
const {
  saveTradeSnapshot,
  saveOpenPositionSnapshot,
  cleanOldSnapshots,
  snapshotExists,
  sanitizeSnapshotId,
} = require("./lib/paper-bot-snapshot");
const {
  runPaperBotBacktest,
  loadLastBacktestResult,
  resetBacktestData,
  clearBacktestRunArtifacts,
  resolveBacktestSymbols,
  DEFAULT_DAYS,
  RESULT_FILE,
} = require("./lib/paper-bot-backtest");
const { getBacktestKlineCacheInfo, readSymbolBars } = require("./lib/backtest-kline-cache");
const {
  mergeBarsByOpenTime,
  createKlineCacheStore,
} = require("./lib/kline-cache");
const {
  createPositionsProvider,
  createFuturesBalanceProvider,
  resolveBinanceCredentials,
  snapshotPositionsFromMap,
  rememberPositionOpenTimes,
} = require("./lib/binance-positions");
const { createLiveBotHistoryStore } = require("./lib/live-bot-history");
const { buildLiveBotHistoryExport } = require("./lib/live-bot-history-export");
const { createTelegramAuth } = require("./lib/telegram-auth");
const { migrateLegacyCache, resolveDataDir, formatBytes, dataPath, writeJsonFile } = require("./lib/data-dir");
const { migrate: migrateDb, closeDb, getDb, repos } = require("./lib/db");
const { createKeyedExclusive } = require("./lib/keyed-mutex");
const scannerConfig = require("./lib/scanner-config");
const { buildLiveAiReport } = require("./lib/live-ai-report");

const REST_BASE = "https://fapi.binance.com";
// DO NOT CHANGE BASE wss://stream.binance.com:443
const WS_STREAM_BASE = "wss://stream.binance.com:443/stream";
const KLINE_MAX = 1500;
const SIGNAL_RETENTION_MS = 24 * 60 * 60 * 1000;
migrateLegacyCache();
const dbBoot = migrateDb();
if (dbBoot.importResult && !dbBoot.importResult.skipped) {
  console.error(`SQLite: imported legacy JSON → ${require("./lib/db").dbFilePath()}`);
}
scannerConfig.migrateFromResultsJson();
console.error(`Persistent data: ${resolveDataDir()}`);
console.error(`SQLite database: ${require("./lib/db").dbFilePath()}`);
const EXCHANGE_INFO_CACHE = dataPath("futures-exchangeInfo.json");
const KLINES_CACHE_DIR = dataPath("klines");
console.error(`Kline cache dir: ${KLINES_CACHE_DIR}`);

const { createRestQueue, sleep: restSleep } = require("./lib/rest-queue");
const sleep = restSleep;

const cfg = {
  interval: "5m",
  prefetchDays: 3,
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
  restMinGapMs: 450,
  restRetryMs: 8000,
  exchangeInfoCacheTtlMs: 24 * 60 * 60 * 1000,
  klineCacheExtraMs: 2 * 60 * 1000,
  // Disk history cap. Memory keeps only the live evaluation window.
  cacheMaxBars: 50_000,
  memoryMaxBars: 0,
  klineCacheFlushMs: 60_000,
  klineCacheWriteDebounceMs: 3000,
  prefetchPauseMs: 50,
  prefetchCacheConcurrency: 48,
  streamsPerSocket: 60,
  staleSymbolRefreshMs: 30_000,
  staleSymbolRefreshBatchSize: 30,
  staleSymbolRefreshAfterBars: 3,
  quoteVolRefreshMs: 15 * 60 * 1000,
  minQuoteVolume24h: 0,
  printHitsMinIntervalMs: 2000,
};

/** Primary live pipeline (bots, movers, snapshots) always uses 1m. */
const PRIMARY_INTERVAL = "1m";

applyBarConfig(cfg);
scannerConfig.loadInto(cfg);
applyBarConfig(cfg);

const liveRestQueue = createRestQueue({
  label: "live",
  gapMs: () => cfg.restMinGapMs,
});

const backtestRestQueue = createRestQueue({
  label: "backtest",
  gapMs: () =>
    backtestJob?.running
      ? Math.max(80, Math.floor(cfg.restMinGapMs / 5))
      : cfg.restMinGapMs,
});

let lastHitsPrintAt = 0;
let prefetching = false;
let dashboard = null;
let pushScannerState = null;
let telegram = null;
let paperBot = null;
const symbolEvalLock = createKeyedExclusive();
let sfpRegimeMonitor = null;
let liveSfpRegimeMonitor = null;
let pullbackRegimeMonitor = null;
let livePullbackRegimeMonitor = null;
let pullbackPatternBreakMonitor = null;
let livePullbackPatternBreakMonitor = null;
let liveBot = null;
let fundingOiProvider = null;
let obiLiveRunner = null;
let tapeLiveRunner = null;
let futuresTrader = null;
let dashboardWs = null;
let fetchPositionsPayload = null;
let broadcastAccountState = () => {};
let broadcastPositionsUpdate = () => {};
let exchangeOpenSymbols = new Set();
let stopPaperBotReport = () => {};
const BACKTEST_STALE_MS = 30 * 60 * 1000;
const BACKTEST_STALE_SIMULATE_MS = 120 * 60 * 1000;
const BACKTEST_STALE_RATE_LIMIT_MS = 120 * 60 * 1000;

let backtestJob = {
  running: false,
  cancelled: false,
  progress: null,
  result: null,
  error: null,
  startedAt: null,
  lastProgressAt: null,
  barCache: null,
  chartCfg: null,
};

/** Bumped on stop/start so stale in-flight backtests cannot clobber state or block REST. */
let backtestRunEpoch = 0;

function bumpBacktestRunEpoch() {
  backtestRunEpoch++;
  return backtestRunEpoch;
}

function backtestRunActive(epoch) {
  return !backtestJob.cancelled && backtestRunEpoch === epoch;
}

function throwIfBacktestAborted(shouldAbort) {
  if (shouldAbort?.()) {
    const err = new Error("Backtest cancelled");
    err.code = "BACKTEST_CANCELLED";
    throw err;
  }
}

let backtestSnapshotJob = {
  running: false,
  cancelled: false,
  progress: null,
  error: null,
  lastProgressAt: null,
};

function freshAiTrainJob() {
  return { running: false, progress: null, error: null, result: null };
}

const aiTrainJob = {
  paper: {
    early_exit: freshAiTrainJob(),
    sfp_regime: freshAiTrainJob(),
    pullback_regime: freshAiTrainJob(),
    pullback_pattern_break: freshAiTrainJob(),
    pullback_signal: freshAiTrainJob(),
    ai_exit_levels: freshAiTrainJob(),
  },
  live: {
    early_exit: freshAiTrainJob(),
    sfp_regime: freshAiTrainJob(),
    pullback_regime: freshAiTrainJob(),
    pullback_pattern_break: freshAiTrainJob(),
    pullback_signal: freshAiTrainJob(),
    ai_exit_levels: freshAiTrainJob(),
  },
};

function aiTrainJobFor(model, scope = "paper") {
  const key = normalizeAiModelScope(scope);
  if (model === "sfp_regime") return aiTrainJob[key].sfp_regime;
  if (model === "pullback_regime") return aiTrainJob[key].pullback_regime;
  if (model === "pullback_pattern_break") return aiTrainJob[key].pullback_pattern_break;
  if (model === "pullback_signal") return aiTrainJob[key].pullback_signal;
  if (model === "ai_exit_levels") return aiTrainJob[key].ai_exit_levels;
  return aiTrainJob[key].early_exit;
}

function getEarlyExitModelStatusFull(scope = "paper") {
  return modelStatusWithTraining(
    () => getModelStatus(normalizeAiModelScope(scope)),
    aiTrainJobFor("early_exit", scope)
  );
}

function getSfpRegimeModelStatusFull(scope = "paper") {
  return modelStatusWithTraining(
    () => getSfpRegimeModelStatus(normalizeAiModelScope(scope)),
    aiTrainJobFor("sfp_regime", scope)
  );
}

function getPullbackRegimeModelStatusFull(scope = "paper") {
  return modelStatusWithTraining(
    () => getPullbackRegimeModelStatus(normalizeAiModelScope(scope)),
    aiTrainJobFor("pullback_regime", scope)
  );
}

function getPullbackPatternBreakModelStatusFull(scope = "paper") {
  return modelStatusWithTraining(
    () => getPullbackPatternBreakModelStatus(normalizeAiModelScope(scope)),
    aiTrainJobFor("pullback_pattern_break", scope)
  );
}

function getPullbackSignalModelStatusFull(scope = "paper") {
  return modelStatusWithTraining(
    () => getPullbackSignalModelStatus(normalizeAiModelScope(scope)),
    aiTrainJobFor("pullback_signal", scope)
  );
}

function getAiExitLevelsModelStatusFull(scope = "paper") {
  return modelStatusWithTraining(
    () => getAiExitLevelsModelStatus(normalizeAiModelScope(scope)),
    aiTrainJobFor("ai_exit_levels", scope)
  );
}

function modelStatusWithTraining(getStatus, job) {
  return {
    ...getStatus(),
    training: {
      running: job.running,
      progress: job.progress,
      error: job.error,
      result: job.result,
    },
  };
}

function freshBacktestSnapshotJobState() {
  return {
    running: false,
    cancelled: false,
    progress: null,
    error: null,
    lastProgressAt: null,
  };
}

function cancelBacktestSnapshotJob() {
  backtestSnapshotJob.cancelled = true;
  backtestSnapshotJob.running = false;
  backtestSnapshotJob.progress = null;
  backtestSnapshotJob.error = null;
  backtestSnapshotJob.lastProgressAt = null;
}

function freshBacktestJobState() {
  return {
    running: false,
    cancelled: false,
    progress: null,
    result: null,
    error: null,
    startedAt: null,
    lastProgressAt: null,
  };
}

function touchBacktestProgress(p) {
  backtestJob.progress = p;
  backtestJob.lastProgressAt = Date.now();
  if (
    backtestJob.running &&
    backtestJob.error?.startsWith("Backtest stalled")
  ) {
    backtestJob.error = null;
  }
}

function backtestStaleLimitMs(phase) {
  if (phase === "rate_limit") return BACKTEST_STALE_RATE_LIMIT_MS;
  if (phase === "simulate" || phase === "saving") return BACKTEST_STALE_SIMULATE_MS;
  return BACKTEST_STALE_MS;
}

function reconcileBacktestJob() {
  if (!backtestJob.running || !backtestJob.lastProgressAt) return;
  const idle = Date.now() - backtestJob.lastProgressAt;
  const phase = backtestJob.progress?.phase;
  const limit = backtestStaleLimitMs(phase);
  if (idle <= limit) return;
  const sym = backtestJob.progress?.symbol;
  const detail = backtestJob.progress?.message;
  const mins = Math.round(idle / 60_000);
  const where = sym ? ` (last: ${sym})` : "";
  const hint =
    phase === "rate_limit"
      ? "Binance rate limit cooldown can take a while — wait or retry later."
      : phase === "simulate"
        ? "Simulation on a large history can take several minutes per symbol."
        : "If this persists, try a symbol list or fewer days.";
  backtestJob.error =
    backtestJob.error ||
    `Backtest stalled (no progress for ${mins} min${where}). ${detail ? `${detail} ` : ""}${hint}`;
  console.error(backtestJob.error);
}

async function generateBacktestTradeSnapshot(tradeId) {
  const id = String(tradeId || "").trim();
  if (!id) throw new Error("trade id required");

  const snapshotId = sanitizeSnapshotId(id);
  const result = backtestJob.result || loadLastBacktestResult();
  const trade = result?.closedTrades?.find((t) => t.id === id);

  if (snapshotExists(snapshotId, "backtest")) {
    return { snapshotId, symbol: trade?.symbol, cached: true };
  }
  if (!result?.closedTrades?.length) {
    throw new Error("No backtest results — run a backtest first");
  }
  if (!trade) throw new Error("Trade not found in backtest results");

  const chartCfg = backtestJob.chartCfg ?? {
    interval: cfg.interval,
    corridorDays: cfg.corridorDays,
    corridorExcludeMinutes: cfg.corridorExcludeMinutes,
    signalCandles: cfg.signalCandles,
  };

  let bars = backtestJob.barCache?.get(trade.symbol);
  if (!bars?.length) {
    const days = result.runMeta?.historyDays ?? DEFAULT_DAYS;
    const signalCfg = pickLiveConfig(cfg);
    const barMs = signalCfg.signalBarMs ?? cfg.signalBarMs ?? 60_000;
    const barCount = Math.max(
      Math.ceil((days * 86_400_000) / barMs),
      minHistoryBars(signalCfg) + 10
    );
    bars = await fetchKlinesForBacktest(trade.symbol, barCount);
  }
  if (!bars?.length) throw new Error(`No price bars for ${trade.symbol}`);

  const { snapshotId: savedId } = await saveTradeSnapshot({
    trade,
    bars,
    snapshotKind: "backtest",
    skipCleanup: true,
    ...chartCfg,
  });

  trade.snapshotId = savedId;
  writeJsonFile(RESULT_FILE(), result);
  if (!backtestJob.result) backtestJob.result = result;

  return { snapshotId: savedId, symbol: trade.symbol, cached: false };
}
let klineCache = null;
let signalKlineCache = null;

function intervalBarMs(interval) {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) return 60_000;
  const n = Number(m[1]);
  const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 24 * 60;
  return minutes * 60 * 1000;
}

function signalMemoryMaxBars() {
  if (cfg.memoryMaxBars > 0) {
    return Math.min(cfg.memoryMaxBars, cfg.signalLimit ?? cfg.limit);
  }
  const barMs = cfg.signalBarMs ?? cfg.barMs;
  const dayBars = Math.ceil((24 * 60 * 60 * 1000) / barMs) + 5;
  const liveNeed = Math.max(
    minHistoryBars(cfg),
    cfg.fastMoveLookbackCandles ?? 0,
    dayBars
  );
  return Math.min(cfg.cacheMaxBars, liveNeed + 50);
}

function evalSignalBars(sym, signalBuffers) {
  return signalKlineCache.evalWindow(
    signalBuffers.get(sym) ?? [],
    signalMemoryMaxBars()
  );
}

function minSignalPrefetchBars() {
  return cfg.signalLimit ?? cfg.limit;
}

/** In-memory 1m bars, falling back to disk when WS has not warmed a symbol yet. */
function primaryBarSource(sym, historyBuffers) {
  const mem = historyBuffers.get(sym);
  if (mem?.length) return mem;
  return klineCache?.read(sym) ?? [];
}

function evalBars(sym, historyBuffers) {
  return klineCache.evalWindow(
    primaryBarSource(sym, historyBuffers),
    memoryMaxBars()
  );
}

function loadTrainingBarsForSymbol(sym) {
  const symbol = String(sym || "").toUpperCase();
  let bars = signalKlineCache?.read(symbol) ?? klineCache?.read(symbol) ?? [];
  if (!bars.length) {
    bars =
      readSymbolBars("mover", symbol) ??
      readSymbolBars("signal", symbol) ??
      [];
  }
  return bars;
}

function fetchBarsForEarlyExitTraining(symbol, openedAt, closedAt) {
  const sym = String(symbol || "").toUpperCase();
  const bars = loadTrainingBarsForSymbol(sym);
  if (!bars.length) return [];
  const from = openedAt - 120_000;
  const to = closedAt + 120_000;
  return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
}

function fetchBarsForSfpRegimeTraining(symbol) {
  return loadTrainingBarsForSymbol(symbol);
}

function aiTrainingTradeDeps() {
  const backtest = loadLastBacktestResult();
  return {
    backtestTrades: backtest?.closedTrades,
    paperTrades: paperBot?.getClosedTrades?.() ?? [],
    liveTrades: liveBot?.getClosedTrades?.() ?? [],
  };
}

function collectEarlyExitTrainingTrades(source = "auto", scope = "paper") {
  return collectAiTrainingTrades(source, scope, aiTrainingTradeDeps(), (list) =>
    (list ?? []).filter(
      (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
    )
  );
}

function startEarlyExitTraining(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  const job = aiTrainJobFor("early_exit", scope);
  if (job.running) {
    throw new Error("Early-exit model training already running");
  }
  const trades = collectEarlyExitTrainingTrades(body.source, scope);
  if (!trades.length) {
    const hint =
      scope === "live"
        ? "run train bot first (live fills are merged when available)"
        : "run train bot or accumulate paper bot history";
    throw new Error(`No closed trades for training — ${hint}`);
  }

  job.running = true;
  job.error = null;
  job.result = null;
  job.progress = {
    phase: "starting",
    done: 0,
    total: trades.length,
    message: `Preparing ${trades.length} SFP trades…`,
  };

  void (async () => {
    const cfg =
      scope === "live"
        ? (await liveBot?.getPublicState?.())?.config ?? {}
        : paperBot.getPublicState().config;
    try {
      await trainFromTrades(trades, fetchBarsForEarlyExitTraining, {
        ...cfg,
        modelScope: scope,
        source: `trained:${scope}:${body.source ?? "auto"}`,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      reloadModel(scope);
      job.result = {
        tradesUsed: trades.length,
        model: getModelStatus(scope),
      };
      job.progress = {
        phase: "done",
        done: trades.length,
        total: trades.length,
        message: "Training complete",
      };
    } catch (e) {
      job.error = e.message || String(e);
      console.error(`Early-exit model training failed (${scope}): ${job.error}`);
    } finally {
      job.running = false;
    }
  })();

  return { ok: true, started: true, trades: trades.length, scope };
}

function trainEarlyExitModelFromHistory(body = {}) {
  return startEarlyExitTraining(body);
}

function collectSfpRegimeTrainingTrades(source = "auto", scope = "paper") {
  return collectAiTrainingTrades(source, scope, aiTrainingTradeDeps(), (list) =>
    (list ?? []).filter(
      (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
    )
  );
}

function startSfpRegimeTraining(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  const job = aiTrainJobFor("sfp_regime", scope);
  if (job.running) {
    throw new Error("SFP regime model training already running");
  }
  const trades = collectSfpRegimeTrainingTrades(body.source, scope);
  if (!trades.length) {
    const hint =
      scope === "live"
        ? "accumulate live bot SFP closed trades"
        : "run train bot with SFP signals enabled";
    throw new Error(`No SFP closed trades for training — ${hint}`);
  }

  job.running = true;
  job.error = null;
  job.result = null;
  job.progress = {
    phase: "starting",
    done: 0,
    total: trades.length,
    message: `Preparing ${trades.length} SFP trades…`,
  };

  void (async () => {
    const cfg =
      scope === "live"
        ? (await liveBot?.getPublicState?.())?.config ?? {}
        : paperBot.getPublicState().config;
    try {
      await trainSfpRegimeFromTrades(trades, fetchBarsForSfpRegimeTraining, {
        ...cfg,
        modelScope: scope,
        source: `trained:${scope}:${body.source ?? "auto"}`,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      reloadSfpRegimeModel(scope);
      job.result = {
        tradesUsed: trades.length,
        model: getSfpRegimeModelStatus(scope),
      };
      job.progress = {
        phase: "done",
        done: trades.length,
        total: trades.length,
        message: "Training complete",
      };
    } catch (e) {
      job.error = e.message || String(e);
      console.error(`SFP regime model training failed (${scope}): ${job.error}`);
    } finally {
      job.running = false;
    }
  })();

  return { ok: true, started: true, trades: trades.length, scope };
}

function trainSfpRegimeModelFromHistory(body = {}) {
  return startSfpRegimeTraining(body);
}

function importSfpRegimeModelFromBody(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  if (!body.model || typeof body.model !== "object") {
    throw new Error("model object required");
  }
  const { scope: _ignore, savedAt, savedAtIso, gbmBundles, ...modelPayload } = body.model;
  const model = saveSfpRegimeModel(
    {
      ...modelPayload,
      source: modelPayload.source ?? `import:local:${scope}`,
      trainedAt: modelPayload.trainedAt ?? Date.now(),
    },
    scope
  );
  const bundles = body.gbmBundles ?? gbmBundles;
  if (bundles) {
    writeGbmBundles({
      basename: "sfp-regime-onnx",
      modelPrefix: "sfp-regime",
      scope,
      bundles,
    });
  }
  reloadSfpRegimeModel(scope);
  return {
    scope,
    status: getSfpRegimeModelStatusFull(scope),
    featureCount: model.featureNames?.length ?? null,
  };
}

function importPullbackRegimeModelFromBody(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  if (!body.model || typeof body.model !== "object") {
    throw new Error("model object required");
  }
  const { scope: _ignore, savedAt, savedAtIso, ...modelPayload } = body.model;
  const model = savePullbackRegimeModel(
    {
      ...modelPayload,
      source: modelPayload.source ?? `import:local:${scope}`,
      trainedAt: modelPayload.trainedAt ?? Date.now(),
    },
    scope
  );
  reloadPullbackRegimeModel(scope);
  return {
    scope,
    status: getPullbackRegimeModelStatusFull(scope),
    featureCount: model.featureNames?.length ?? null,
  };
}

function importPullbackPatternBreakModelFromBody(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  if (!body.model || typeof body.model !== "object") {
    throw new Error("model object required");
  }
  const { scope: _ignore, savedAt, savedAtIso, ...modelPayload } = body.model;
  const model = savePullbackPatternBreakModel(
    {
      ...modelPayload,
      source: modelPayload.source ?? `import:local:${scope}`,
      trainedAt: modelPayload.trainedAt ?? Date.now(),
    },
    scope
  );
  reloadPullbackPatternBreakModel(scope);
  return {
    scope,
    status: getPullbackPatternBreakModelStatusFull(scope),
    featureCount: model.featureNames?.length ?? null,
  };
}

function importPullbackSignalModelFromBody(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  if (!body.model || typeof body.model !== "object") {
    throw new Error("model object required");
  }
  const { scope: _ignore, savedAt, savedAtIso, gbmBundles, ...modelPayload } = body.model;
  const model = savePullbackSignalModel(
    {
      ...modelPayload,
      source: modelPayload.source ?? `import:local:${scope}`,
      trainedAt: modelPayload.trainedAt ?? Date.now(),
    },
    scope
  );
  const bundles = body.gbmBundles ?? gbmBundles;
  if (bundles) {
    writeGbmBundles({
      basename: "pullback-signal-onnx",
      modelPrefix: "pullback-signal",
      scope,
      bundles,
    });
  }
  reloadPullbackSignalModel(scope);
  return {
    scope,
    status: getPullbackSignalModelStatusFull(scope),
    featureCount: model.featureNames?.length ?? null,
  };
}

function importEarlyExitModelFromBody(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  if (!body.model || typeof body.model !== "object") {
    throw new Error("model object required");
  }
  const { scope: _ignore, savedAt, savedAtIso, ...modelPayload } = body.model;
  const model = saveEarlyExitModel(
    {
      ...modelPayload,
      source: modelPayload.source ?? `import:local:${scope}`,
      trainedAt: modelPayload.trainedAt ?? Date.now(),
    },
    scope
  );
  reloadModel(scope);
  return {
    scope,
    status: getEarlyExitModelStatusFull(scope),
    featureCount: model.featureNames?.length ?? null,
  };
}

function importAiExitLevelsModelFromBody(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  if (!body.model || typeof body.model !== "object") {
    throw new Error("model object required");
  }
  const { scope: _ignore, savedAt, savedAtIso, ...modelPayload } = body.model;
  const model = saveAiExitLevelsModel(
    {
      ...modelPayload,
      source: modelPayload.source ?? `import:local:${scope}`,
      trainedAt: modelPayload.trainedAt ?? Date.now(),
    },
    scope
  );
  reloadAiExitLevelsModel(scope);
  return {
    scope,
    status: getAiExitLevelsModelStatusFull(scope),
    featureCount: model.featureNames?.length ?? null,
  };
}

function startAiExitLevelsTraining(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  const job = aiTrainJobFor("ai_exit_levels", scope);
  if (job.running) {
    throw new Error("AI exit-levels model training already running");
  }
  const trades = collectEarlyExitTrainingTrades(body.source ?? "auto", scope);
  if (trades.length < 12) {
    throw new Error(
      `Need at least 12 SFP closed trades for training (got ${trades.length}) — run train bot first`
    );
  }

  job.running = true;
  job.error = null;
  job.result = null;
  job.progress = { phase: "starting", message: `Training from ${trades.length} trades…` };

  const botCfg = paperBot?.getPublicState?.()?.config ?? {};
  trainAiExitLevelsFromTrades(trades, fetchBarsForEarlyExitTraining, {
    botConfig: botCfg,
    scope,
    source: body.source ?? "ui:train",
    onProgress: (p) => {
      job.progress = p;
    },
  })
    .then((model) => {
      if (scope === "paper") {
        saveAiExitLevelsModel(
          { ...model, source: "train:cached-backtest:live" },
          "live"
        );
        reloadAiExitLevelsModel("live");
      }
      job.result = {
        tradesUsed: trades.length,
        model,
        status: getAiExitLevelsModelStatusFull(scope),
      };
      job.progress = { phase: "done", message: "Complete" };
    })
    .catch((e) => {
      job.error = e.message || String(e);
      job.progress = { phase: "error", message: job.error };
    })
    .finally(() => {
      job.running = false;
    });

  return { scope, trades: trades.length, training: true };
}

function collectPullbackTrainingTrades(source = "auto", scope = "paper") {
  return collectAiTrainingTrades(source, scope, aiTrainingTradeDeps(), (list) =>
    (list ?? []).filter(
      (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
    )
  );
}

function startPullbackRegimeTraining(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  const job = aiTrainJobFor("pullback_regime", scope);
  if (job.running) {
    throw new Error("Pullback regime model training already running");
  }
  const trades = collectPullbackTrainingTrades(body.source, scope);
  if (trades.length < 12) {
    throw new Error(
      `Need at least 12 pullback closed trades for training (got ${trades.length})`
    );
  }
  job.running = true;
  job.error = null;
  job.result = null;
  job.progress = {
    phase: "starting",
    done: 0,
    total: trades.length,
    message: `Preparing ${trades.length} pullback trades…`,
  };
  void (async () => {
    const cfg =
      scope === "live"
        ? (await liveBot?.getPublicState?.())?.config ?? {}
        : paperBot.getPublicState().config;
    try {
      await trainPullbackRegimeFromTrades(trades, fetchBarsForSfpRegimeTraining, {
        ...cfg,
        modelScope: scope,
        source: `trained:${scope}:${body.source ?? "auto"}`,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      reloadPullbackRegimeModel(scope);
      job.result = {
        tradesUsed: trades.length,
        model: getPullbackRegimeModelStatus(scope),
      };
      job.progress = {
        phase: "done",
        done: trades.length,
        total: trades.length,
        message: "Training complete",
      };
    } catch (e) {
      job.error = e.message || String(e);
      console.error(`Pullback regime model training failed (${scope}): ${job.error}`);
    } finally {
      job.running = false;
    }
  })();
  return { ok: true, started: true, trades: trades.length, scope };
}

function startPullbackSignalTraining(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  const job = aiTrainJobFor("pullback_signal", scope);
  if (job.running) {
    throw new Error("Pullback signal model training already running");
  }
  const trades = collectPullbackTrainingTrades(body.source, scope);
  if (trades.length < 12) {
    throw new Error(
      `Need at least 12 pullback closed trades for training (got ${trades.length})`
    );
  }
  job.running = true;
  job.error = null;
  job.result = null;
  job.progress = {
    phase: "starting",
    done: 0,
    total: trades.length,
    message: `Preparing ${trades.length} pullback trades…`,
  };
  void (async () => {
    const cfg =
      scope === "live"
        ? (await liveBot?.getPublicState?.())?.config ?? {}
        : paperBot.getPublicState().config;
    try {
      await trainPullbackSignalFromTrades(trades, fetchBarsForSfpRegimeTraining, {
        ...cfg,
        modelScope: scope,
        source: `trained:${scope}:${body.source ?? "auto"}`,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      reloadPullbackSignalModel(scope);
      job.result = {
        tradesUsed: trades.length,
        model: getPullbackSignalModelStatus(scope),
      };
      job.progress = {
        phase: "done",
        done: trades.length,
        total: trades.length,
        message: "Training complete",
      };
    } catch (e) {
      job.error = e.message || String(e);
      console.error(`Pullback signal model training failed (${scope}): ${job.error}`);
    } finally {
      job.running = false;
    }
  })();
  return { ok: true, started: true, trades: trades.length, scope };
}

function trainPullbackRegimeModelFromHistory(body = {}) {
  return startPullbackRegimeTraining(body);
}

function startPullbackPatternBreakTraining(body = {}) {
  const scope = normalizeAiModelScope(body.scope);
  const job = aiTrainJobFor("pullback_pattern_break", scope);
  if (job.running) {
    throw new Error("Pullback pattern-break model training already running");
  }
  const trades = collectPullbackTrainingTrades(body.source, scope);
  if (trades.length < 12) {
    throw new Error(
      `Need at least 12 pullback closed trades for training (got ${trades.length})`
    );
  }
  job.running = true;
  job.error = null;
  job.result = null;
  job.progress = {
    phase: "starting",
    done: 0,
    total: trades.length,
    message: `Preparing ${trades.length} pullback trades…`,
  };
  void (async () => {
    const cfg =
      scope === "live"
        ? (await liveBot?.getPublicState?.())?.config ?? {}
        : paperBot.getPublicState().config;
    try {
      await trainPullbackPatternBreakFromTrades(trades, fetchBarsForSfpRegimeTraining, {
        ...cfg,
        modelScope: scope,
        source: `trained:${scope}:${body.source ?? "auto"}`,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      reloadPullbackPatternBreakModel(scope);
      job.result = {
        tradesUsed: trades.length,
        model: getPullbackPatternBreakModelStatus(scope),
      };
      job.progress = {
        phase: "done",
        done: trades.length,
        total: trades.length,
        message: "Training complete",
      };
    } catch (e) {
      job.error = e.message || String(e);
      console.error(`Pullback pattern-break model training failed (${scope}): ${job.error}`);
    } finally {
      job.running = false;
    }
  })();
  return { ok: true, started: true, trades: trades.length, scope };
}

function trainPullbackPatternBreakModelFromHistory(body = {}) {
  return startPullbackPatternBreakTraining(body);
}

function trainPullbackSignalModelFromHistory(body = {}) {
  return startPullbackSignalTraining(body);
}

function refreshPullbackRegimeForSymbol(sym, historyBuffers) {
  if (!pullbackRegimeMonitor || !paperBot) return;
  const cfg = paperBot.getPublicState().config;
  if (!cfg.aiPullbackRegimeEnabled) return;
  const bars = getRecentBarsForBot(sym, historyBuffers, 120);
  if (bars.length < 30) return;
  pullbackRegimeMonitor.refreshSymbol(sym, bars, cfg);
}

function refreshPullbackPatternBreakForSymbol(sym, historyBuffers) {
  if (!pullbackPatternBreakMonitor || !paperBot) return;
  const cfg = paperBot.getPublicState().config;
  if (!cfg.aiPullbackPatternBreakEnabled) return;
  const bars = getRecentBarsForBot(sym, historyBuffers, 120);
  if (bars.length < 30) return;
  pullbackPatternBreakMonitor.refreshSymbol(sym, bars, cfg);
}

function refreshLivePullbackRegimeForSymbol(sym, historyBuffers) {
  if (!livePullbackRegimeMonitor || !liveBot) return;
  const cfg = liveBot.getConfig?.() ?? {};
  if (!cfg?.aiPullbackRegimeEnabled) return;
  const bars = getRecentBarsForBot(sym, historyBuffers, 120);
  if (bars.length < 30) return;
  livePullbackRegimeMonitor.refreshSymbol(sym, bars, cfg);
}

function refreshLivePullbackPatternBreakForSymbol(sym, historyBuffers) {
  if (!livePullbackPatternBreakMonitor || !liveBot) return;
  const cfg = liveBot.getConfig?.() ?? {};
  if (!cfg?.aiPullbackPatternBreakEnabled) return;
  const bars = getRecentBarsForBot(sym, historyBuffers, 120);
  if (bars.length < 30) return;
  livePullbackPatternBreakMonitor.refreshSymbol(sym, bars, cfg);
}

function getPullbackRegimeMonitorSnapshot() {
  if (!pullbackRegimeMonitor || !paperBot) {
    return { ok: false, enabled: false, tracked: 0, badCount: 0, worst: [] };
  }
  return pullbackRegimeMonitor.getSnapshot(paperBot.getPublicState().config);
}

function getLivePullbackRegimeMonitorSnapshot() {
  if (!livePullbackRegimeMonitor || !liveBot) {
    return { ok: false, enabled: false, tracked: 0, badCount: 0, worst: [] };
  }
  return livePullbackRegimeMonitor.getSnapshot(liveBot.getConfig?.() ?? {});
}

function getPullbackPatternBreakMonitorSnapshot() {
  if (!pullbackPatternBreakMonitor || !paperBot) {
    return { ok: false, enabled: false, tracked: 0, badCount: 0, worst: [] };
  }
  return pullbackPatternBreakMonitor.getSnapshot(paperBot.getPublicState().config);
}

function getLivePullbackPatternBreakMonitorSnapshot() {
  if (!livePullbackPatternBreakMonitor || !liveBot) {
    return { ok: false, enabled: false, tracked: 0, badCount: 0, worst: [] };
  }
  return livePullbackPatternBreakMonitor.getSnapshot(liveBot.getConfig?.() ?? {});
}

function refreshSfpRegimeForSymbol(sym, historyBuffers) {
  if (!sfpRegimeMonitor || !paperBot) return;
  const cfg = paperBot.getPublicState().config;
  if (!cfg.aiSfpRegimeEnabled) return;
  const bars = getRecentBarsForBot(sym, historyBuffers, 120);
  if (bars.length < 30) return;
  sfpRegimeMonitor.refreshSymbol(sym, bars, cfg);
}

function refreshLiveSfpRegimeForSymbol(sym, historyBuffers) {
  if (!liveSfpRegimeMonitor || !liveBot) return;
  const cfg = liveBot.getConfig?.();
  if (!cfg?.aiSfpRegimeEnabled) return;
  const bars = getRecentBarsForBot(sym, historyBuffers, 120);
  if (bars.length < 30) return;
  liveSfpRegimeMonitor.refreshSymbol(sym, bars, cfg);
}

function getSfpRegimeMonitorSnapshot() {
  if (!sfpRegimeMonitor || !paperBot) {
    return { ok: true, enabled: false, tracked: 0, badCount: 0, worst: [] };
  }
  return sfpRegimeMonitor.getSnapshot(paperBot.getPublicState().config);
}

function getLiveSfpRegimeMonitorSnapshot() {
  if (!liveSfpRegimeMonitor || !liveBot) {
    return { ok: true, enabled: false, tracked: 0, badCount: 0, worst: [], scope: "live" };
  }
  return liveSfpRegimeMonitor.getSnapshot(liveBot.getConfig?.() ?? {});
}

function getLiveAiReport() {
  return buildLiveAiReport({
    config: liveBot?.getConfig?.() ?? {},
    closedTrades: liveBot?.getClosedTrades?.() ?? [],
    log: liveBot?.getActivityLog?.() ?? [],
    backtest: loadLastBacktestResult(),
    earlyExitStatus: getEarlyExitModelStatusFull("live"),
    sfpRegimeStatus: getSfpRegimeModelStatusFull("live"),
    sfpRegimeMonitor: getLiveSfpRegimeMonitorSnapshot(),
    pullbackRegimeStatus: getPullbackRegimeModelStatusFull("live"),
    pullbackRegimeMonitor: getLivePullbackRegimeMonitorSnapshot(),
    pullbackPatternBreakStatus: getPullbackPatternBreakModelStatusFull("live"),
    pullbackPatternBreakMonitor: getLivePullbackPatternBreakMonitorSnapshot(),
    exitLevelsStatus: getAiExitLevelsModelStatusFull("live"),
  });
}

function getPaperBotBar(sym, historyBuffers) {
  const bars = primaryBarSource(sym, historyBuffers);
  let b = bars?.[bars.length - 1];
  if (!b && klineCache) {
    const cached = klineCache.read(sym);
    b = cached?.[cached.length - 1];
  }
  if (!b) return null;
  return {
    openTime: b.openTime,
    closeTime: b.closeTime,
    open: +b.open,
    high: +(b.high ?? b.close),
    low: +(b.low ?? b.close),
    close: +b.close,
    volume: b.volume != null ? +b.volume : undefined,
  };
}

function getRecentBarsForBot(sym, historyBuffers, limit = 12) {
  let bars = primaryBarSource(sym, historyBuffers);
  if (!bars?.length && klineCache) {
    bars = klineCache.read(sym) ?? [];
  }
  return bars?.slice(-limit) ?? [];
}

function getBtcBarsForRegime(historyBuffers, asOf = null, limit = 800) {
  let bars = primaryBarSource(BTC_SYMBOL, historyBuffers);
  if (!bars?.length && klineCache) {
    bars = klineCache.read(BTC_SYMBOL) ?? [];
  }
  if (!bars?.length) return [];
  if (asOf == null) return bars.slice(-limit);
  const idx = bars.findIndex((b) => b.closeTime > asOf);
  const end = idx >= 0 ? idx : bars.length;
  return bars.slice(Math.max(0, end - limit), end);
}

function refreshBotPrices(historyBuffers, klineSymbol = null, opts = {}) {
  const barClosed = Boolean(opts.barClosed);
  const paperOnly = Boolean(opts.paperOnly);
  const getBar = (s) => getPaperBotBar(s, historyBuffers);

  if (klineSymbol && futuresTrader?.applyMarkPrice) {
    const tickBar = getPaperBotBar(klineSymbol, historyBuffers);
    if (tickBar?.close) futuresTrader.applyMarkPrice(klineSymbol, tickBar.close);
    if (exchangeOpenSymbols.size > 0 && exchangeOpenSymbols.has(klineSymbol)) {
      broadcastPositionsUpdate();
    }
  }

  if (barClosed && klineSymbol) {
    refreshSfpRegimeForSymbol(klineSymbol, historyBuffers);
    refreshLiveSfpRegimeForSymbol(klineSymbol, historyBuffers);
    refreshPullbackRegimeForSymbol(klineSymbol, historyBuffers);
    refreshPullbackPatternBreakForSymbol(klineSymbol, historyBuffers);
    refreshLivePullbackRegimeForSymbol(klineSymbol, historyBuffers);
    refreshLivePullbackPatternBreakForSymbol(klineSymbol, historyBuffers);
  }

  let paperChanged = false;
  if (paperBot?.getPublicState?.().openPositions?.length) {
    paperBot.updatePrices(getBar);
    paperChanged = true;
  }

  if (paperOnly || !liveBot?.hasOpenPositions?.()) {
    if (paperChanged) {
      dashboardWs?.broadcastThrottled(
        "paperBot",
        () => paperBot.getPublicState(),
        500
      );
    }
    return;
  }

  const afterLive = () => {
    if (paperChanged) {
      dashboardWs?.broadcastThrottled(
        "paperBot",
        () => paperBot.getPublicState(),
        500
      );
    }
    dashboardWs?.broadcastThrottled(
      "liveBot",
      () => liveBot.getPublicState(),
      500
    );
  };

  if (klineSymbol) {
    if (!liveBot.hasOpenSymbol?.(klineSymbol)) {
      if (paperChanged) afterLive();
      return;
    }
    void liveBot.updatePrices(getBar, klineSymbol, { barClosed }).then(afterLive);
    return;
  }

  void liveBot.updatePrices(getBar, null, { barClosed: true }).then(afterLive);
}

/** @deprecated use refreshBotPrices */
function refreshAllPaperBotPrices(historyBuffers, klineSymbol = null, opts = {}) {
  refreshBotPrices(historyBuffers, klineSymbol, opts);
}

function memoryMaxBars() {
  if (cfg.memoryMaxBars > 0) return cfg.memoryMaxBars;
  const dayBars = Math.ceil((24 * 60 * 60 * 1000) / cfg.barMs) + 5;
  const liveNeed = Math.max(
    minHistoryBars(cfg),
    cfg.fastMoveLookbackCandles ?? 0,
    dayBars
  );
  return Math.min(
    cfg.cacheMaxBars,
    liveNeed + 50
  );
}

function parseArgs(argv) {
  const flags = new Set();
  const kv = new Map();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) {
        kv.set(k, v);
      } else {
        const next = argv[i + 1];
        if (next != null && !String(next).startsWith("--")) {
          kv.set(k, next);
          i++;
        } else {
          flags.add(k);
        }
      }
    }
  }
  return { flags, kv };
}

function parseBanUntil(text) {
  const m = String(text).match(/banned until (\d+)/i);
  return m ? Number(m[1]) : null;
}

async function waitForBan(banUntil, shouldAbort) {
  while (true) {
    throwIfBacktestAborted(shouldAbort);
    const waitMs = banUntil - Date.now();
    if (waitMs <= 0) return;
    const sec = Math.ceil(waitMs / 1000);
    console.error(`IP banned — waiting ${sec}s before retry...`);
    if (backtestJob.running) {
      touchBacktestProgress({
        ...(backtestJob.progress ?? {}),
        phase: "rate_limit",
        message: `Binance API cooldown — waiting ${sec}s…`,
      });
    }
    const chunk = Math.min(waitMs + 500, 30_000);
    await sleep(chunk);
  }
}

const restLimiter = {};
restLimiter.schedule = function schedule(fn) {
  return liveRestQueue.schedule(fn);
};

async function restJsonFetch(
  pathName,
  params = {},
  attempt = 0,
  restQueue = liveRestQueue,
  shouldAbort = null
) {
  return restQueue.schedule(async () => {
    let currentAttempt = attempt;
    const q = new URLSearchParams(params).toString();
    const url = `${REST_BASE}${pathName}${q ? `?${q}` : ""}`;

    while (true) {
      throwIfBacktestAborted(shouldAbort);

      let res;
      let text;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        text = await res.text();
      } catch (e) {
        if (currentAttempt < 5) {
          currentAttempt++;
          await sleep(cfg.restRetryMs * currentAttempt);
          continue;
        }
        throw e;
      }

      if (res.status === 418 || res.status === 429) {
        const banUntil = parseBanUntil(text);
        if (banUntil && banUntil > Date.now()) {
          await waitForBan(banUntil, shouldAbort);
          continue;
        }
        if (currentAttempt < 5) {
          currentAttempt++;
          await sleep(cfg.restRetryMs * currentAttempt);
          continue;
        }
        throw new Error(`${pathName} ${res.status} ${text}`);
      }

      if (!res.ok) throw new Error(`${pathName} ${res.status} ${text}`);
      return JSON.parse(text);
    }
  });
}

async function getJson(pathName, params = {}, attempt = 0) {
  return restJsonFetch(pathName, params, attempt, liveRestQueue);
}

function readExchangeInfoCache() {
  try {
    const raw = fs.readFileSync(EXCHANGE_INFO_CACHE, "utf8");
    const data = JSON.parse(raw);
    if (Date.now() - data.savedAt < cfg.exchangeInfoCacheTtlMs) return data.symbols;
  } catch {
    /* empty */
  }
  return null;
}

function writeExchangeInfoCache(symbols) {
  fs.mkdirSync(path.dirname(EXCHANGE_INFO_CACHE), { recursive: true });
  fs.writeFileSync(
    EXCHANGE_INFO_CACHE,
    JSON.stringify({ savedAt: Date.now(), symbols })
  );
}

function symbolsFromExchangeInfo(info) {
  return info.symbols
    .filter(
      (s) =>
        s.status === "TRADING" &&
        s.contractType === "PERPETUAL" &&
        s.quoteAsset === "USDT"
    )
    .map((s) => s.symbol);
}

async function listUsdtPerpSymbols() {
  const cached = readExchangeInfoCache();
  if (cached?.length) return cached;

  const info = await getJson("/fapi/v1/exchangeInfo");
  const symbols = symbolsFromExchangeInfo(info);
  writeExchangeInfoCache(symbols);
  return symbols;
}

async function resolveSymbols(flags, kv) {
  const symCsv = kv.get("symbols");
  if (symCsv) {
    return symCsv
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }
  if (flags.has("all")) return listUsdtPerpSymbols();

  throw new Error(
    "Usage: node index.js --all   OR   node index.js --symbols VICUSDT,BTCUSDT"
  );
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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

async function fetchKlines(symbol, limit = cfg.limit) {
  let all = [];
  let endTime;
  let remaining = limit;

  while (remaining > 0) {
    const batch = Math.min(remaining, KLINE_MAX);
    const params = {
      symbol,
      interval: PRIMARY_INTERVAL,
      limit: String(batch),
    };
    if (endTime !== undefined) params.endTime = String(endTime);

    const rows = await getJson("/fapi/v1/klines", params);
    if (!rows.length) break;

    const parsed = parseKlines(rows);
    all = [...parsed, ...all];
    endTime = rows[0][0] - 1;
    remaining -= parsed.length;
    if (parsed.length < batch) break;
  }

  return all.slice(-limit);
}

async function fetchKlinesInterval(
  symbol,
  interval,
  limit,
  onBatch,
  restQueue = liveRestQueue,
  shouldAbort = null
) {
  let all = [];
  let endTime;
  let remaining = limit;

  while (remaining > 0) {
    throwIfBacktestAborted(shouldAbort);
    const batch = Math.min(remaining, KLINE_MAX);
    const params = {
      symbol,
      interval,
      limit: String(batch),
    };
    if (endTime !== undefined) params.endTime = String(endTime);

    const rows = await restJsonFetch(
      "/fapi/v1/klines",
      params,
      0,
      restQueue,
      shouldAbort
    );
    onBatch?.({ symbol, interval, fetched: all.length, target: limit });
    if (!rows.length) break;

    const parsed = parseKlines(rows);
    all = [...parsed, ...all];
    endTime = rows[0][0] - 1;
    remaining -= parsed.length;
    if (parsed.length < batch) break;
  }

  return all.slice(-limit);
}

async function fetchKlinesGap(symbol, startTime, endTime) {
  if (startTime >= endTime) return [];
  let cursor = startTime;
  let merged = [];

  while (cursor < endTime) {
    const params = {
      symbol,
      interval: PRIMARY_INTERVAL,
      limit: String(KLINE_MAX),
      startTime: String(cursor),
      endTime: String(endTime),
    };
    const rows = await getJson("/fapi/v1/klines", params);
    if (!rows.length) break;

    merged = mergeBarsByOpenTime(merged, parseKlines(rows));
    const lastOpen = rows[rows.length - 1][0];
    cursor = lastOpen + cfg.barMs;
    if (rows.length < KLINE_MAX) break;
  }

  return merged;
}

async function fetchKlinesGapForInterval(
  symbol,
  interval,
  startTime,
  endTime,
  onBatch,
  restQueue = liveRestQueue,
  shouldAbort = null
) {
  if (startTime >= endTime) return [];
  const barMs = intervalBarMs(interval);
  let cursor = startTime;
  let merged = [];

  while (cursor < endTime) {
    throwIfBacktestAborted(shouldAbort);
    const params = {
      symbol,
      interval,
      limit: String(KLINE_MAX),
      startTime: String(cursor),
      endTime: String(endTime),
    };
    const rows = await restJsonFetch(
      "/fapi/v1/klines",
      params,
      0,
      restQueue,
      shouldAbort
    );
    onBatch?.();
    if (!rows.length) break;

    merged = mergeBarsByOpenTime(merged, parseKlines(rows));
    const lastOpen = rows[rows.length - 1][0];
    cursor = lastOpen + barMs;
    if (rows.length < KLINE_MAX) break;
  }

  return merged;
}

function minPrefetchBars() {
  return cfg.limit;
}

/** Disk cache is enough for startup prefetch when it has the eval window of bars (age ignored — WS fills the live bar). */
function symbolCacheSufficientFromMeta(meta) {
  return Boolean(meta?.barCount && meta.barCount >= minPrefetchBars());
}

async function runConcurrent(items, limit, fn) {
  if (!items.length) return;
  const n = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const workers = Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function loadSymbolFromCache(symbol) {
  const cached = klineCache.read(symbol) ?? [];
  return klineCache.capBars(cached, memoryMaxBars());
}

async function loadSymbolHistory(symbol) {
  const cached = klineCache.read(symbol) ?? [];
  const fetched = await fetchKlines(symbol, cfg.limit);
  let bars = mergeBarsByOpenTime(cached, fetched);

  if (cached.length && fetched.length) {
    const lastCached = cached[cached.length - 1];
    const firstFetched = fetched[0];
    if (lastCached.closeTime + cfg.barMs < firstFetched.openTime) {
      const gap = await fetchKlinesGap(
        symbol,
        lastCached.closeTime + 1,
        firstFetched.openTime - 1
      );
      bars = mergeBarsByOpenTime(cached, gap, fetched);
    }
  }

  bars = klineCache.capBars(bars, cfg.cacheMaxBars);
  klineCache.replace(symbol, bars);
  return klineCache.capBars(bars, memoryMaxBars());
}

/** Backtest walks signal-timeframe bars; optional interval for 1m fast-mover input. */
async function fetchKlinesForBacktest(
  symbol,
  barCount,
  interval = cfg.interval,
  onHeartbeat,
  shouldAbort = null
) {
  const touch = () => onHeartbeat?.({ symbol, interval });
  const useSignalCache =
    interval === cfg.interval && signalKlineCache != null;
  const cache = useSignalCache ? signalKlineCache : klineCache;
  const cached = cache?.read(symbol) ?? [];

  if (cached.length >= barCount) {
    return cached.length > barCount ? cached.slice(-barCount) : cached;
  }

  let bars = cached.length ? cached.slice() : [];

  const slice = () => (bars.length > barCount ? bars.slice(-barCount) : bars);
  const barMs =
    interval === cfg.interval
      ? cfg.signalBarMs ?? cfg.barMs
      : intervalBarMs(interval);

  try {
    throwIfBacktestAborted(shouldAbort);
    const fetched = await fetchKlinesInterval(
      symbol,
      interval,
      barCount,
      () => touch(),
      backtestRestQueue,
      shouldAbort
    );
    bars = mergeBarsByOpenTime(bars, fetched);

    if (cached.length && fetched.length) {
      const lastCached = cached[cached.length - 1];
      const firstFetched = fetched[0];
      if (lastCached.closeTime + barMs < firstFetched.openTime) {
        const gap = await fetchKlinesGapForInterval(
          symbol,
          interval,
          lastCached.closeTime + 1,
          firstFetched.openTime - 1,
          () => touch(),
          backtestRestQueue,
          shouldAbort
        );
        bars = mergeBarsByOpenTime(cached, gap, fetched);
      }
    }
    return slice();
  } catch (e) {
    if (e.code === "BACKTEST_CANCELLED" || e.code === "QUEUE_RESET") throw e;
    const need = minHistoryBars(cfg);
    if (bars.length >= need) {
      console.error(
        `Backtest ${symbol}: REST failed (${e.message}), using ${bars.length} cached ${interval} bars`
      );
      return slice();
    }
    throw e;
  }
}

function closedCandleFromKline(k) {
  return {
    openTime: k.t,
    open: +k.o,
    high: +k.h,
    low: +k.l,
    close: +k.c,
    volume: +k.v,
    closeTime: k.T,
  };
}

const liveUpdateAt = new Map();
const wsStats = {
  shardCount: 0,
  connectedShards: 0,
  messages: 0,
  klineMessages: 0,
  updates: 0,
  restRepairs: 0,
  lastRestRepairAt: null,
  lastMessageAt: null,
  lastKlineAt: null,
  lastUpdateAt: null,
  lastError: null,
};
const wsShardStats = [];

function formatMaybeIso(ms) {
  return ms != null ? formatIsoUtcPlus3(ms) : null;
}

function wsDiagnostics() {
  const recentSymbols = [...liveUpdateAt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([symbol, at]) => ({ symbol, at: formatMaybeIso(at) }));

  return {
    updatedAt: formatIsoUtcPlus3(Date.now()),
    summary: {
      ...wsStats,
      lastMessageAt: formatMaybeIso(wsStats.lastMessageAt),
      lastKlineAt: formatMaybeIso(wsStats.lastKlineAt),
      lastUpdateAt: formatMaybeIso(wsStats.lastUpdateAt),
      lastRestRepairAt: formatMaybeIso(wsStats.lastRestRepairAt),
    },
    shards: wsShardStats.map((s) => ({
      ...s,
      lastConnectAt: formatMaybeIso(s.lastConnectAt),
      lastCloseAt: formatMaybeIso(s.lastCloseAt),
      lastMessageAt: formatMaybeIso(s.lastMessageAt),
      lastKlineAt: formatMaybeIso(s.lastKlineAt),
      lastUpdateAt: formatMaybeIso(s.lastUpdateAt),
    })),
    recentSymbols,
  };
}

function upsertHistoryCandle(historyBuffers, sym, candle, options = {}) {
  const cache = options.klineCache ?? klineCache;
  const maxBars = options.maxBars ?? memoryMaxBars();
  const buf = historyBuffers.get(sym) ?? [];
  const result = cache.upsertBar(buf, candle, maxBars);
  historyBuffers.set(sym, buf);
  if (result.updated) {
    const now = Date.now();
    if (options.trackLive !== false) {
      liveUpdateAt.set(sym, now);
      wsStats.updates++;
      wsStats.lastUpdateAt = now;
    }
    if (options.persist) cache.schedulePersist(sym, buf);
  }
  return result;
}

function applyRestRepairBars(historyBuffers, sym, bars, options = {}) {
  if (!bars?.length) return false;
  const cache = options.klineCache ?? klineCache;
  const maxBars = options.maxBars ?? memoryMaxBars();
  const existing = historyBuffers.get(sym) ?? [];
  const merged = cache.capBars(
    mergeBarsByOpenTime(existing, bars),
    maxBars
  );
  const beforeLast = existing[existing.length - 1];
  const afterLast = merged[merged.length - 1];
  const changed =
    !beforeLast ||
    !afterLast ||
    beforeLast.openTime !== afterLast.openTime ||
    beforeLast.closeTime !== afterLast.closeTime ||
    beforeLast.open !== afterLast.open ||
    beforeLast.high !== afterLast.high ||
    beforeLast.low !== afterLast.low ||
    beforeLast.close !== afterLast.close ||
    beforeLast.volume !== afterLast.volume ||
    existing.length !== merged.length;

  if (!changed) return false;

  const now = Date.now();
  historyBuffers.set(sym, merged);
  if (options.trackLive !== false) {
    liveUpdateAt.set(sym, now);
    wsStats.restRepairs++;
    wsStats.lastRestRepairAt = now;
    wsStats.lastUpdateAt = now;
  }
  cache.schedulePersist(sym, merged);
  return true;
}

function markKindSignalEnded(sym, activeMap, historyMap, kind, metrics) {
  const live = activeMap.get(sym);
  const rec = historyMap.get(sym);
  if (!live && !rec) return;
  const triggeredAt = rec?.triggeredAt ?? live?.triggeredAt ?? Date.now();
  historyMap.set(sym, {
    ...(rec ?? live ?? {}),
    ...(metrics ?? {}),
    signalKind: kind,
    triggeredAt,
    ended: true,
    endedAt: Date.now(),
    signalStatus: "ended",
    quoteVol24h: live?.quoteVol24h ?? rec?.quoteVol24h,
  });
  activeMap.delete(sym);
}

function pruneSignalHistory(signalHistory) {
  const cutoff = Date.now() - SIGNAL_RETENTION_MS;
  for (const [sym, rec] of signalHistory) {
    if ((rec.triggeredAt ?? 0) < cutoff) signalHistory.delete(sym);
  }
}

function printHits(maps, force = false) {
  const {
    sfpActive = new Map(),
    sfpHistory = new Map(),
    sfpBearActive = new Map(),
    sfpBearHistory = new Map(),
    pbActive = new Map(),
    pbHistory = new Map(),
  } = maps;
  const now = Date.now();
  if (!force && now - lastHitsPrintAt < cfg.printHitsMinIntervalMs) return;
  lastHitsPrintAt = now;

  pruneSignalHistory(sfpHistory);
  pruneSignalHistory(sfpBearHistory);
  pruneSignalHistory(pbHistory);

  if (dashboard) {
    dashboard.setMeta({ prefetching });
    dashboard.publish(
      sfpActive,
      sfpHistory,
      pbActive,
      pbHistory,
      sfpBearActive,
      sfpBearHistory,
      force
    );
  }
}

function recordSignalHitDb(symbol, signalKind, metrics, at = Date.now()) {
  try {
    repos.signals.recordSignalHit(getDb(), {
      symbol,
      signalKind,
      signalStatus: "active",
      at,
      metrics,
    });
  } catch (e) {
    console.error(`signal_hits insert ${symbol}: ${e.message}`);
  }
}

function applySfpSignal(sym, analysis, qv, sfpActive, sfpHistory, lastSfp) {
  const pass = Boolean(analysis?.passes);
  const metrics = analysis?.metrics;
  const prev = lastSfp.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass && metrics) {
    const existing = sfpHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ??
        sfpActive.get(sym)?.triggeredAt ??
        Date.now());
    const row = {
      ...metrics,
      signalKind: "sfp",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    sfpActive.set(sym, row);
    sfpHistory.set(sym, row);
    if (!prev) {
      lastSfp.set(sym, true);
      recordSignalHitDb(sym, "sfp", metrics, triggeredAt);
      const detail = `sweep ${metrics.sweepLow?.toFixed(6)} · reclaim ${metrics.close} · ${metrics.barsSinceSweep} bars`;
      dashboard?.pushEvent("NEW_SFP", sym, detail);
      paperBot?.onSfpSignal(sym, metrics);
      liveBot?.onSfpSignal(sym, metrics);
    }
  } else if (prev) {
    markKindSignalEnded(sym, sfpActive, sfpHistory, "sfp", metrics);
    dashboard?.pushEvent("END_SFP", sym);
  }

  lastSfp.set(sym, pass);
}

function applySfpBearSignal(sym, analysis, qv, sfpBearActive, sfpBearHistory, lastSfpBear) {
  const pass = Boolean(analysis?.passes);
  const metrics = analysis?.metrics;
  const prev = lastSfpBear.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass && metrics) {
    const existing = sfpBearHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ??
        sfpBearActive.get(sym)?.triggeredAt ??
        Date.now());
    const row = {
      ...metrics,
      signalKind: "sfp_bear",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    sfpBearActive.set(sym, row);
    sfpBearHistory.set(sym, row);
    if (!prev) {
      lastSfpBear.set(sym, true);
      recordSignalHitDb(sym, "sfp_bear", metrics, triggeredAt);
      const detail = `sweep ${metrics.sweepHigh?.toFixed(6)} · reject ${metrics.close} · ${metrics.barsSinceSweep} bars`;
      dashboard?.pushEvent("NEW_SFP_BEAR", sym, detail);
      paperBot?.onSfpBearSignal(sym, metrics);
      liveBot?.onSfpBearSignal(sym, metrics);
    }
  } else if (prev) {
    markKindSignalEnded(sym, sfpBearActive, sfpBearHistory, "sfp_bear", metrics);
    dashboard?.pushEvent("END_SFP_BEAR", sym);
  }

  lastSfpBear.set(sym, pass);
}

function applyPullbackSignal(sym, pb, qv, pbActive, pbHistory, lastPb) {
  const pass = Boolean(pb?.passes);
  const prev = lastPb.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass) {
    const existing = pbHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ??
        pbActive.get(sym)?.triggeredAt ??
        Date.now());
    const row = {
      ...pb,
      signalKind: "pullback",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    pbActive.set(sym, row);
    pbHistory.set(sym, row);
    if (!prev) {
      lastPb.set(sym, true);
      recordSignalHitDb(sym, "pullback", pb, triggeredAt);
      const detail = `MA${pb.maBars} ${pb.ma} · +${pb.distFromMaPct}% · avg move ${pb.avgMovePct}%`;
      dashboard?.pushEvent("NEW_PB", sym, detail);
      paperBot?.onPullbackSignal(sym, pb);
      liveBot?.onPullbackSignal(sym, pb);
    }
  } else if (prev) {
    markKindSignalEnded(sym, pbActive, pbHistory, "pullback", pb);
    dashboard?.pushEvent("END_PB", sym);
  }

  lastPb.set(sym, pass);
}

function applyPullbackBearSignal(sym, pb, qv, pbBearActive, pbBearHistory, lastPbBear) {
  const pass = Boolean(pb?.passes);
  const prev = lastPbBear.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass) {
    const existing = pbBearHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ??
        pbBearActive.get(sym)?.triggeredAt ??
        Date.now());
    const row = {
      ...pb,
      signalKind: "pullback_bear",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    pbBearActive.set(sym, row);
    pbBearHistory.set(sym, row);
    if (!prev) {
      lastPbBear.set(sym, true);
      recordSignalHitDb(sym, "pullback_bear", pb, triggeredAt);
      const detail = `MA${pb.maBars} ${pb.ma} · ${pb.distFromMaPct}% · avg move ${pb.avgMovePct}%`;
      dashboard?.pushEvent("NEW_PB_BEAR", sym, detail);
      paperBot?.onPullbackBearSignal(sym, pb);
      liveBot?.onPullbackBearSignal(sym, pb);
    }
  } else if (prev) {
    markKindSignalEnded(sym, pbBearActive, pbBearHistory, "pullback_bear", pb);
    dashboard?.pushEvent("END_PB_BEAR", sym);
  }

  lastPbBear.set(sym, pass);
}

function applyFoiSignal(sym, foi, qv, foiActive, foiHistory, lastFoi) {
  const pass = Boolean(foi?.passes);
  const prev = lastFoi.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass) {
    const existing = foiHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ?? foiActive.get(sym)?.triggeredAt ?? Date.now());
    const row = {
      ...foi,
      signalKind: "foi",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    foiActive.set(sym, row);
    foiHistory.set(sym, row);
    if (!prev) {
      lastFoi.set(sym, true);
      recordSignalHitDb(sym, "foi", foi, triggeredAt);
      const detail = `fund ${(foi.fundingRate * 100).toFixed(4)}% · OIΔ ${foi.oiDelta1h?.toFixed?.(2) ?? "—"} · ${foi.confirmKind}`;
      dashboard?.pushEvent("NEW_FOI", sym, detail);
      paperBot?.onFoiSignal(sym, foi);
      liveBot?.onFoiSignal(sym, foi);
    }
  } else if (prev) {
    markKindSignalEnded(sym, foiActive, foiHistory, "foi", foi);
    dashboard?.pushEvent("END_FOI", sym);
  }

  lastFoi.set(sym, pass);
}

function applyFoiBearSignal(sym, foi, qv, foiBearActive, foiBearHistory, lastFoiBear) {
  const pass = Boolean(foi?.passes);
  const prev = lastFoiBear.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass) {
    const existing = foiBearHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ??
        foiBearActive.get(sym)?.triggeredAt ??
        Date.now());
    const row = {
      ...foi,
      signalKind: "foi_bear",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    foiBearActive.set(sym, row);
    foiBearHistory.set(sym, row);
    if (!prev) {
      lastFoiBear.set(sym, true);
      recordSignalHitDb(sym, "foi_bear", foi, triggeredAt);
      const detail = `fund ${(foi.fundingRate * 100).toFixed(4)}% · OIΔ ${foi.oiDelta1h?.toFixed?.(2) ?? "—"} · ${foi.confirmKind}`;
      dashboard?.pushEvent("NEW_FOI_BEAR", sym, detail);
      paperBot?.onFoiBearSignal(sym, foi);
      liveBot?.onFoiBearSignal(sym, foi);
    }
  } else if (prev) {
    markKindSignalEnded(sym, foiBearActive, foiBearHistory, "foi_bear", foi);
    dashboard?.pushEvent("END_FOI_BEAR", sym);
  }

  lastFoiBear.set(sym, pass);
}

function evaluateSymbolSignals(sym, signalBuffers, priceBuffers, qv, maps) {
  let out;
  symbolEvalLock.runExclusive(`eval:${sym}`, () => {
    out = evaluateSymbolSignalsUnlocked(sym, signalBuffers, priceBuffers, qv, maps);
  });
  return out;
}

function evaluateSymbolSignalsUnlocked(sym, signalBuffers, priceBuffers, qv, maps) {
  const {
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    pbBearActive,
    pbBearHistory,
    foiActive,
    foiHistory,
    foiBearActive,
    foiBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastPbBear,
    lastFoi,
    lastFoiBear,
  } = maps;
  const signalBars = evalSignalBars(sym, signalBuffers);
  const priceBars = evalBars(sym, priceBuffers);
  const fmOpts = fastMoverOptsFromCfg(cfg);
  const sfp = signalBars ? analyzeSweepReclaim(signalBars, cfg) : null;
  const sfpBear = signalBars ? analyzeSweepReject(signalBars, cfg) : null;
  const pb = signalBars
    ? fastMoverPullbackMetrics(signalBars, cfg, fmOpts, priceBars)
    : null;
  const pbBear = signalBars
    ? fastMoverPullbackBearMetrics(signalBars, cfg, fmOpts, priceBars)
    : null;

  applySfpSignal(sym, sfp, qv, sfpActive, sfpHistory, lastSfp);
  applySfpBearSignal(sym, sfpBear, qv, sfpBearActive, sfpBearHistory, lastSfpBear);
  applyPullbackSignal(sym, pb, qv, pbActive, pbHistory, lastPb);
  applyPullbackBearSignal(sym, pbBear, qv, pbBearActive, pbBearHistory, lastPbBear);

  const fundingOi = fundingOiProvider?.getFundingOiAt?.(sym) ?? null;
  const botCfg = {
    ...cfg,
    ...(liveBot?.getPublicState?.()?.config || paperBot?.getPublicState?.()?.config || {}),
  };
  const foi =
    signalBars && (botCfg.tradeFoiSignals || botCfg.tradeBearishFoiSignals)
      ? evaluateFoiLong(signalBars, botCfg, fundingOi, fmOpts, priceBars)
      : null;
  const foiBear =
    signalBars && (botCfg.tradeFoiSignals || botCfg.tradeBearishFoiSignals)
      ? evaluateFoiBear(signalBars, botCfg, fundingOi, fmOpts, priceBars)
      : null;
  if (foiActive && lastFoi) {
    applyFoiSignal(sym, foi, qv, foiActive, foiHistory, lastFoi);
  }
  if (foiBearActive && lastFoiBear) {
    applyFoiBearSignal(sym, foiBear, qv, foiBearActive, foiBearHistory, lastFoiBear);
  }

  return { sfp, sfpBear, pb, pbBear };
}

function reevaluateAllSymbols(
  symbols,
  historyBuffers,
  signalBuffers,
  maps,
  quoteVolMap
) {
  const {
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    pbBearActive,
    pbBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastPbBear,
  } = maps;

  for (const sym of symbols) {
    const qv = quoteVolMap.get(sym) ?? 0;
    if (cfg.minQuoteVolume24h > 0 && qv < cfg.minQuoteVolume24h) {
      if (lastSfp.get(sym)) {
        markKindSignalEnded(sym, sfpActive, sfpHistory, "sfp", null);
      }
      if (lastSfpBear.get(sym)) {
        markKindSignalEnded(sym, sfpBearActive, sfpBearHistory, "sfp_bear", null);
      }
      if (lastPb.get(sym)) {
        markKindSignalEnded(sym, pbActive, pbHistory, "pullback", null);
      }
      if (lastPbBear.get(sym)) {
        markKindSignalEnded(sym, pbBearActive, pbBearHistory, "pullback_bear", null);
      }
      lastSfp.set(sym, false);
      lastSfpBear.set(sym, false);
      lastPb.set(sym, false);
      lastPbBear.set(sym, false);
      continue;
    }

    evaluateSymbolSignals(sym, signalBuffers, historyBuffers, qv, maps);
  }
  refreshAllPaperBotPrices(historyBuffers);
  printHits(maps, true);
}

function createWsShards(
  symbols,
  historyBuffers,
  signalBuffers,
  maps,
  quoteVolMap,
  separateSignal
) {
  const {
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    pbBearActive,
    pbBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastPbBear,
  } = maps;
  const streamSuffix = `@kline_${PRIMARY_INTERVAL}`;
  const batches = chunk(
    symbols.map((s) => `${s.toLowerCase()}${streamSuffix}`),
    cfg.streamsPerSocket
  );
  wsStats.shardCount = batches.length;
  wsStats.connectedShards = 0;
  wsShardStats.length = 0;
  const sockets = [];

  const evaluate = (sym) => {
    const qv = quoteVolMap.get(sym) ?? 0;
    if (cfg.minQuoteVolume24h > 0 && qv < cfg.minQuoteVolume24h) {
      if (lastSfp.get(sym)) {
        markKindSignalEnded(sym, sfpActive, sfpHistory, "sfp", null);
      }
      if (lastSfpBear.get(sym)) {
        markKindSignalEnded(sym, sfpBearActive, sfpBearHistory, "sfp_bear", null);
      }
      if (lastPb.get(sym)) {
        markKindSignalEnded(sym, pbActive, pbHistory, "pullback", null);
      }
      if (lastPbBear.get(sym)) {
        markKindSignalEnded(sym, pbBearActive, pbBearHistory, "pullback_bear", null);
      }
      lastSfp.set(sym, false);
      lastSfpBear.set(sym, false);
      lastPb.set(sym, false);
      lastPbBear.set(sym, false);
      return;
    }

    const prevSfp = lastSfp.get(sym) ?? false;
    const prevSfpBear = lastSfpBear.get(sym) ?? false;
    const prevPb = lastPb.get(sym) ?? false;

    const { sfp, sfpBear, pb } = evaluateSymbolSignals(
      sym,
      signalBuffers,
      historyBuffers,
      qv,
      maps
    );

    const sfpPass = Boolean(sfp?.passes);
    const sfpBearPass = Boolean(sfpBear?.passes);
    const pbPass = Boolean(pb?.passes);
    if (
      sfpPass !== prevSfp ||
      sfpBearPass !== prevSfpBear ||
      pbPass !== prevPb
    ) {
      printHits(maps, true);
    }
    refreshAllPaperBotPrices(historyBuffers, sym, { barClosed: true });
  };

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const url = `${WS_STREAM_BASE}?streams=${batches[batchIdx].join("/")}`;
    const shard = {
      index: batchIdx,
      streamCount: batches[batchIdx].length,
      connected: false,
      connects: 0,
      closes: 0,
      messages: 0,
      klineMessages: 0,
      updates: 0,
      lastConnectAt: null,
      lastCloseAt: null,
      lastMessageAt: null,
      lastKlineAt: null,
      lastUpdateAt: null,
      lastError: null,
      sampleStreams: batches[batchIdx].slice(0, 8),
    };
    wsShardStats[batchIdx] = shard;
    let ws;
    let closed = false;
    let reconnectMs = 1000;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url);

      ws.on("open", () => {
        reconnectMs = 1000;
        if (!shard.connected) wsStats.connectedShards++;
        shard.connected = true;
        shard.connects++;
        shard.lastConnectAt = Date.now();
        console.error(`WS shard ${batchIdx} connected (${batches[batchIdx].length} streams)`);
      });

      ws.on("message", (raw) => {
        const now = Date.now();
        wsStats.messages++;
        wsStats.lastMessageAt = now;
        shard.messages++;
        shard.lastMessageAt = now;
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const data = msg.data ?? msg;
        if (data?.e !== "kline") return;
        const klineAt = Date.now();
        wsStats.klineMessages++;
        wsStats.lastKlineAt = klineAt;
        shard.klineMessages++;
        shard.lastKlineAt = klineAt;

        const sym = (data.s || data.k?.s || "").toUpperCase();
        if (!sym) return;
        const candle = closedCandleFromKline(data.k);
        const isClosed = Boolean(data.k?.x);
        const change = upsertHistoryCandle(historyBuffers, sym, candle, {
          persist: isClosed,
        });
        if (change.updated) {
          shard.updates++;
          shard.lastUpdateAt = wsStats.lastUpdateAt;
        }

        refreshAllPaperBotPrices(historyBuffers, sym, { barClosed: isClosed });
        if (!separateSignal && isClosed && change.updated) evaluate(sym);
      });

      ws.on("close", async () => {
        if (closed) return;
        if (shard.connected) {
          wsStats.connectedShards = Math.max(0, wsStats.connectedShards - 1);
        }
        shard.connected = false;
        shard.closes++;
        shard.lastCloseAt = Date.now();
        await sleep(reconnectMs);
        reconnectMs = Math.min(reconnectMs * 2, 60_000);
        connect();
      });

      ws.on("error", (err) => {
        wsStats.lastError = err?.message || String(err);
        shard.lastError = wsStats.lastError;
        console.error(`WS shard ${batchIdx} error: ${wsStats.lastError}`);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    };

    connect();
    sockets.push({
      close: () => {
        closed = true;
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      },
    });
  }

  return sockets;
}

/** Signal-timeframe klines when cfg.interval !== 1m; triggers SFP/PB evaluation on bar close. */
function createSignalWsShards(
  symbols,
  signalBuffers,
  historyBuffers,
  maps,
  quoteVolMap
) {
  const {
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    pbBearActive,
    pbBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastPbBear,
  } = maps;
  const streamSuffix = `@kline_${cfg.interval}`;
  const batches = chunk(
    symbols.map((s) => `${s.toLowerCase()}${streamSuffix}`),
    cfg.streamsPerSocket
  );
  const sockets = [];

  const evaluate = (sym) => {
    const qv = quoteVolMap.get(sym) ?? 0;
    if (cfg.minQuoteVolume24h > 0 && qv < cfg.minQuoteVolume24h) {
      if (lastSfp.get(sym)) {
        markKindSignalEnded(sym, sfpActive, sfpHistory, "sfp", null);
      }
      if (lastSfpBear.get(sym)) {
        markKindSignalEnded(sym, sfpBearActive, sfpBearHistory, "sfp_bear", null);
      }
      if (lastPb.get(sym)) {
        markKindSignalEnded(sym, pbActive, pbHistory, "pullback", null);
      }
      if (lastPbBear.get(sym)) {
        markKindSignalEnded(sym, pbBearActive, pbBearHistory, "pullback_bear", null);
      }
      lastSfp.set(sym, false);
      lastSfpBear.set(sym, false);
      lastPb.set(sym, false);
      lastPbBear.set(sym, false);
      return;
    }

    const prevSfp = lastSfp.get(sym) ?? false;
    const prevSfpBear = lastSfpBear.get(sym) ?? false;
    const prevPb = lastPb.get(sym) ?? false;

    const { sfp, sfpBear, pb } = evaluateSymbolSignals(
      sym,
      signalBuffers,
      historyBuffers,
      qv,
      maps
    );

    const sfpPass = Boolean(sfp?.passes);
    const sfpBearPass = Boolean(sfpBear?.passes);
    const pbPass = Boolean(pb?.passes);
    if (
      sfpPass !== prevSfp ||
      sfpBearPass !== prevSfpBear ||
      pbPass !== prevPb
    ) {
      printHits(maps, true);
    }
  };

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const url = `${WS_STREAM_BASE}?streams=${batches[batchIdx].join("/")}`;
    let ws;
    let closed = false;
    let reconnectMs = 1000;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url);

      ws.on("open", () => {
        reconnectMs = 1000;
        console.error(
          `WS signal (${cfg.interval}) shard ${batchIdx} connected (${batches[batchIdx].length} streams)`
        );
      });

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const data = msg.data ?? msg;
        if (data?.e !== "kline") return;

        const sym = (data.s || data.k?.s || "").toUpperCase();
        if (!sym) return;
        const candle = closedCandleFromKline(data.k);
        const isClosed = Boolean(data.k?.x);
        const change = upsertHistoryCandle(signalBuffers, sym, candle, {
          persist: isClosed,
          klineCache: signalKlineCache,
          maxBars: signalMemoryMaxBars(),
          trackLive: false,
        });
        if (isClosed && change.updated) evaluate(sym);
      });

      ws.on("close", async () => {
        if (closed) return;
        await sleep(reconnectMs);
        reconnectMs = Math.min(reconnectMs * 2, 60_000);
        connect();
      });

      ws.on("error", (err) => {
        console.error(
          `WS signal shard ${batchIdx} error: ${err?.message || err}`
        );
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    };

    connect();
    sockets.push({
      close: () => {
        closed = true;
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      },
    });
  }

  return sockets;
}

function startStaleSymbolRefresh(
  symbols,
  historyBuffers,
  signalBuffers,
  maps,
  quoteVolMap
) {
  const {
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    pbBearActive,
    pbBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
  } = maps;
  let cursor = 0;
  let running = false;

  async function refreshTick() {
    if (running || !symbols.length) return;
    running = true;
    try {
      const now = Date.now();
      const staleMs = cfg.barMs * cfg.staleSymbolRefreshAfterBars;
      const batch = [];
      let scanned = 0;

      while (
        scanned < symbols.length &&
        batch.length < cfg.staleSymbolRefreshBatchSize
      ) {
        const sym = symbols[cursor % symbols.length];
        cursor++;
        scanned++;

        const buf = historyBuffers.get(sym) ?? [];
        const last = buf[buf.length - 1];
        if (!last) continue;

        const hasStreamUpdate = liveUpdateAt.has(sym);
        const staleByBars = now - last.closeTime > staleMs;
        if (!hasStreamUpdate || staleByBars) batch.push({ sym, last });
      }

      for (const { sym, last } of batch) {
        try {
          const hasStreamUpdate = liveUpdateAt.has(sym);
          const bars = hasStreamUpdate
            ? await fetchKlinesGap(sym, last.closeTime + 1, Date.now())
            : await fetchKlines(
                sym,
                Math.max(cfg.fastMoveLookbackCandles ?? 10, 10)
              );
          if (applyRestRepairBars(historyBuffers, sym, bars)) {
            evaluateSymbolSignals(
              sym,
              signalBuffers,
              historyBuffers,
              quoteVolMap.get(sym) ?? 0,
              maps
            );
          }
        } catch (e) {
          wsStats.lastError = `REST repair ${sym}: ${e.message}`;
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(refreshTick, cfg.staleSymbolRefreshMs);
  refreshTick();
  return () => clearInterval(timer);
}

async function prefetchAllSymbols(
  symbols,
  historyBuffers,
  maps,
  quoteVolMap,
  reevaluateAllFn,
  afterPrefetch
) {
  prefetching = true;
  let done = 0;
  let planned = 0;
  let fromCache = 0;
  let refreshed = 0;
  let fetched = 0;
  let failed = 0;
  let cachePlanned = 0;
  let restPlanned = 0;
  let phase = "planning";
  const t0 = Date.now();
  let lastPrefetchUiPushAt = 0;
  const publishPrefetchStatus = (force = false) => {
    dashboard?.setMeta({
      prefetching: true,
      prefetchStatus: {
        phase,
        planned,
        done,
        total: symbols.length,
        cachePlanned,
        restPlanned,
        fromCache,
        refreshed,
        fetched,
        failed,
        elapsedSec: Math.round((Date.now() - t0) / 1000),
      },
    });
    const now = Date.now();
    if (
      force ||
      done === 0 ||
      done === symbols.length ||
      now - lastPrefetchUiPushAt >= 1000
    ) {
      lastPrefetchUiPushAt = now;
      pushScannerState?.();
    }
  };
  const heartbeat = setInterval(() => publishPrefetchStatus(true), 2000);
  publishPrefetchStatus(true);

  console.error(
    `Prefetch ALL ${symbols.length} symbols (${cfg.prefetchDays}d · ${cfg.limit} × ${PRIMARY_INTERVAL}` +
      (cfg.interval !== PRIMARY_INTERVAL
        ? ` + ${minSignalPrefetchBars()} × ${cfg.interval} signals`
        : "") +
      `, cache up to ${cfg.cacheMaxBars} bars → ${KLINES_CACHE_DIR})…`
  );

  const cacheSymbols = [];
  const restSymbols = [];

  const indexT0 = Date.now();
  const metaIndex = klineCache.buildMetaIndex?.() ?? new Map();
  console.error(
    `Prefetch cache index: ${metaIndex.size} symbols with disk meta (${((Date.now() - indexT0) / 1000).toFixed(1)}s)`
  );

  const planKind = new Array(symbols.length);
  await runConcurrent(symbols, cfg.prefetchCacheConcurrency * 2, async (sym, i) => {
    const meta = metaIndex.get(sym) ?? klineCache.readMeta(sym);
    planKind[i] = symbolCacheSufficientFromMeta(meta) ? "cache" : "rest";
    planned++;
    if (planned % 50 === 0 || planned === symbols.length) publishPrefetchStatus();
  });
  for (let i = 0; i < symbols.length; i++) {
    if (planKind[i] === "cache") cacheSymbols.push(symbols[i]);
    else restSymbols.push(symbols[i]);
  }

  cachePlanned = cacheSymbols.length;
  restPlanned = restSymbols.length;
  phase = cacheSymbols.length ? "cache" : "rest";
  console.error(
    `Prefetch plan: ${cacheSymbols.length} from disk (≥${minPrefetchBars()} bars) · ${restSymbols.length} REST`
  );
  publishPrefetchStatus(true);

  await runConcurrent(cacheSymbols, cfg.prefetchCacheConcurrency, async (sym) => {
    try {
      const bars = loadSymbolFromCache(sym);
      if (bars.length < minPrefetchBars()) {
        const loaded = await loadSymbolHistory(sym);
        historyBuffers.set(sym, loaded);
        refreshed++;
      } else {
        historyBuffers.set(sym, bars);
        fromCache++;
      }
    } catch (e) {
      failed++;
      console.error(`Prefetch cache load failed ${sym}: ${e.message}`);
      historyBuffers.set(sym, []);
    }
    done++;
    if (done % 50 === 0) publishPrefetchStatus();
  });

  if (restSymbols.length) phase = "rest";
  for (const sym of restSymbols) {
    try {
      const hadCache = Boolean(metaIndex.get(sym)?.barCount ?? klineCache.readMeta(sym)?.barCount);
      const bars = await loadSymbolHistory(sym);
      if (hadCache) refreshed++;
      else fetched++;
      historyBuffers.set(sym, bars);
    } catch (e) {
      failed++;
      console.error(`Prefetch failed ${sym}: ${e.message}`);
      historyBuffers.set(sym, historyBuffers.get(sym) ?? []);
    }

    done++;
    publishPrefetchStatus();
    if (done % 25 === 0 || done === symbols.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.error(
        `Prefetch ${done}/${symbols.length} | cache ${fromCache} | ` +
          `refresh ${refreshed} | rest ${fetched} | fail ${failed} | ${elapsed}s`
      );
    }
    if (cfg.prefetchPauseMs > 0) await sleep(cfg.prefetchPauseMs);
  }

  if (afterPrefetch) {
    phase = "signal";
    publishPrefetchStatus(true);
    await afterPrefetch(symbols);
  }

  if (reevaluateAllFn) reevaluateAllFn();

  clearInterval(heartbeat);
  prefetching = false;
  phase = "done";
  dashboard?.setMeta({
    prefetching: false,
    prefetchStatus: {
      phase: "done",
      planned: symbols.length,
      done,
      total: symbols.length,
      cachePlanned,
      restPlanned,
      fromCache,
      refreshed,
      fetched,
      failed,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    },
  });
  pushScannerState?.();
  printHits(maps, true);
  console.error(
    `Prefetch done: ${fromCache} cache-only, ${refreshed} refreshed, ${fetched} cold REST, ${failed} failed`
  );
}

function applyCloudDefaults(flags) {
  if (!process.env.PORT) return;
  if (!flags.has("no-prefetch")) {
    // console.error("Cloud (PORT set): skipping prefetch to avoid OOM");
    // flags.add("no-prefetch");
  }
}

async function main() {
  const { flags, kv } = parseArgs(process.argv);
  applyCloudDefaults(flags);

  const tgConfig = resolveTelegramConfig(flags, kv);
  telegram = createTelegramNotifier(tgConfig);
  if (telegram.enabled) {
    console.error(`Telegram alerts on → chat ${telegram.chatIdMasked}`);
  } else if (tgConfig.misconfigured) {
    console.error("Telegram misconfigured — fix TELEGRAM_CHAT_ID (see npm run telegram:chats)");
  } else if (!flags.has("no-telegram")) {
    console.error(
      "Telegram off (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env)"
    );
  }

  const intervalArg = kv.get("interval");
  if (intervalArg) {
    cfg.interval = intervalArg;
    applyBarConfig(cfg);
  }

  const prefetchDaysArg = kv.get("prefetch-days");
  if (prefetchDaysArg) {
    cfg.prefetchDays = Math.max(1, Number(prefetchDaysArg) || cfg.prefetchDays);
    applyBarConfig(cfg);
  }

  klineCache = createKlineCacheStore({
    dir: KLINES_CACHE_DIR,
    interval: PRIMARY_INTERVAL,
    maxBars: cfg.cacheMaxBars,
    evalLimit: cfg.limit,
    flushMs: cfg.klineCacheFlushMs,
    debounceMs: cfg.klineCacheWriteDebounceMs,
  });

  const separateSignal = cfg.interval !== PRIMARY_INTERVAL;
  if (separateSignal) {
    signalKlineCache = createKlineCacheStore({
      dir: KLINES_CACHE_DIR,
      interval: cfg.interval,
      maxBars: cfg.cacheMaxBars,
      evalLimit: minSignalPrefetchBars(),
      flushMs: cfg.klineCacheFlushMs,
      debounceMs: cfg.klineCacheWriteDebounceMs,
    });
  } else {
    signalKlineCache = klineCache;
  }

  const gapArg = kv.get("prefetch-gap-ms");
  if (gapArg) cfg.restMinGapMs = Math.max(200, Number(gapArg) || cfg.restMinGapMs);

  const wantPrefetch = !flags.has("no-prefetch");

  let quoteVolMap = new Map();
  const historyBuffers = new Map();
  const signalBuffers = separateSignal ? new Map() : historyBuffers;

  async function loadSignalHistory(symbol) {
    const limit = minSignalPrefetchBars();
    const cached = signalKlineCache.read(symbol) ?? [];
    const fetched = await fetchKlinesInterval(symbol, cfg.interval, limit);
    let bars = mergeBarsByOpenTime(cached, fetched);

    if (cached.length && fetched.length) {
      const barMs = cfg.signalBarMs ?? cfg.barMs;
      const lastCached = cached[cached.length - 1];
      const firstFetched = fetched[0];
      if (lastCached.closeTime + barMs < firstFetched.openTime) {
        const gap = await fetchKlinesGapForInterval(
          symbol,
          cfg.interval,
          lastCached.closeTime + 1,
          firstFetched.openTime - 1
        );
        bars = mergeBarsByOpenTime(cached, gap, fetched);
      }
    }

    bars = signalKlineCache.capBars(bars, cfg.cacheMaxBars);
    signalKlineCache.replace(symbol, bars);
    return signalKlineCache.capBars(bars, signalMemoryMaxBars());
  }

  async function prefetchSignalSymbols(symbols) {
    if (!separateSignal) return;
    const minBars = minSignalPrefetchBars();
    const t0 = Date.now();
    let done = 0;
    let fromCache = 0;
    let fetched = 0;
    let failed = 0;

    const publishSignalPrefetch = () => {
      dashboard?.setMeta({
        prefetching: true,
        prefetchStatus: {
          phase: "signal",
          done,
          total: symbols.length,
          fromCache,
          fetched,
          failed,
          elapsedSec: Math.round((Date.now() - t0) / 1000),
        },
      });
      pushScannerState?.();
    };

    console.error(
      `Prefetch ${cfg.interval} for SFP/PB signals (${symbols.length} symbols, ≥${minBars} bars)…`
    );
    publishSignalPrefetch();

    const signalIndex = signalKlineCache.buildMetaIndex?.() ?? new Map();

    await runConcurrent(symbols, cfg.prefetchCacheConcurrency, async (sym) => {
      try {
        const meta = signalIndex.get(sym) ?? signalKlineCache.readMeta(sym);
        if (meta?.barCount >= minBars) {
          const bars = signalKlineCache.capBars(
            signalKlineCache.read(sym) ?? [],
            signalMemoryMaxBars()
          );
          signalBuffers.set(sym, bars);
          fromCache++;
        } else {
          const bars = await loadSignalHistory(sym);
          signalBuffers.set(sym, bars);
          fetched++;
        }
      } catch (e) {
        failed++;
        console.error(`Signal prefetch failed ${sym}: ${e.message}`);
        signalBuffers.set(sym, []);
      }
      done++;
      if (done % 50 === 0 || done === symbols.length) publishSignalPrefetch();
    });

    console.error(
      `Signal prefetch done | cache ${fromCache} | rest ${fetched} | fail ${failed} | ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s`
    );
  }

  const sfpActive = new Map();
  const sfpHistory = new Map();
  const sfpBearActive = new Map();
  const sfpBearHistory = new Map();
  const pbActive = new Map();
  const pbHistory = new Map();
  const pbBearActive = new Map();
  const pbBearHistory = new Map();
  const foiActive = new Map();
  const foiHistory = new Map();
  const foiBearActive = new Map();
  const foiBearHistory = new Map();
  const lastSfp = new Map();
  const lastSfpBear = new Map();
  const lastPb = new Map();
  const lastPbBear = new Map();
  const lastFoi = new Map();
  const lastFoiBear = new Map();

  const signalMaps = () => ({
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    pbBearActive,
    pbBearHistory,
    foiActive,
    foiHistory,
    foiBearActive,
    foiBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastPbBear,
    lastFoi,
    lastFoiBear,
  });

  let symbols = [];
  let reevaluateAll = () => {};

  function barsForEvaluation(sym, searchParams) {
    const atRaw = searchParams?.get("at");
    const buf = signalBuffers.get(sym) ?? [];
    if (!atRaw) {
      const bars = signalKlineCache.evalWindow(buf, signalMemoryMaxBars());
      const signalBarAt = bars.length ? bars[bars.length - 1].closeTime : null;
      return { bars, atMs: null, signalBarAt };
    }
    const atMs = parseAtTime(atRaw);
    const needsDisk =
      !buf.length ||
      buf[0].openTime > atMs ||
      buf[buf.length - 1].closeTime < atMs;
    const source = needsDisk ? signalKlineCache.read(sym) ?? buf : buf;
    const bars = signalKlineCache.evalWindow(
      barsAtTime(source, atMs),
      minSignalPrefetchBars()
    );
    if (!bars.length) {
      throw new Error(`No candle data at or before ${formatIsoUtcPlus3(atMs)}`);
    }
    return { bars, atMs, signalBarAt: bars[bars.length - 1].closeTime };
  }

  function barsForMovers(sym, searchParams) {
    const atRaw = searchParams?.get("at");
    const buf = primaryBarSource(sym, historyBuffers);
    if (!atRaw) {
      const bars = klineCache.evalWindow(buf, cfg.limit);
      const signalBarAt = bars.length ? bars[bars.length - 1].closeTime : null;
      return { bars, atMs: null, signalBarAt };
    }
    const atMs = parseAtTime(atRaw);
    const needsDisk =
      !buf.length ||
      buf[0].openTime > atMs ||
      buf[buf.length - 1].closeTime < atMs;
    const source = needsDisk ? klineCache.read(sym) ?? buf : buf;
    const bars = klineCache.evalWindow(barsAtTime(source, atMs), cfg.limit);
    if (!bars.length) {
      throw new Error(
        `No ${PRIMARY_INTERVAL} candle data at or before ${formatIsoUtcPlus3(atMs)}`
      );
    }
    return { bars, atMs, signalBarAt: bars[bars.length - 1].closeTime };
  }

  function priceBarsAt(sym, searchParams) {
    const atRaw = searchParams?.get("at");
    const buf = primaryBarSource(sym, historyBuffers);
    if (!atRaw) return klineCache.evalWindow(buf, cfg.limit);
    const atMs = parseAtTime(atRaw);
    const source =
      !buf.length ||
      buf[0].openTime > atMs ||
      buf[buf.length - 1].closeTime < atMs
        ? klineCache.read(sym) ?? buf
        : buf;
    return klineCache.evalWindow(barsAtTime(source, atMs), cfg.limit);
  }

  const scannerApi = {
    getFastMovers(searchParams) {
      const q = (searchParams.get("q") || "").trim().toUpperCase();
      const lookback = Math.max(
        2,
        Math.min(
          120,
          Number(searchParams.get("lookback")) || cfg.fastMoveLookbackCandles
        )
      );
      const minAvgMovePct = Math.max(
        0.01,
        Math.min(
          20,
          Number(searchParams.get("minAvgMovePct")) || cfg.minAvgMovePct
        )
      );
      const excludeMult = Math.max(
        1.5,
        Math.min(
          20,
          Number(searchParams.get("excludeMult")) || cfg.fastMoveExcludeMult
        )
      );
      const minLinearChangePct = Math.max(
        0,
        Math.min(
          100,
          Number(searchParams.get("minLinearChangePct")) || cfg.minLinearChangePct
        )
      );
      const moverOpts = {
        fastMoveLookbackCandles: lookback,
        minAvgMovePct,
        minLinearChangePct,
        fastMoveExcludeMult: excludeMult,
      };

      let movers = symbols
        .map((sym) => {
          const buf = primaryBarSource(sym, historyBuffers);
          if (!buf.length) return null;
          let evalBars;
          try {
            const ev = barsForMovers(sym, searchParams);
            evalBars = ev.bars;
          } catch {
            return null;
          }

          const fm = fastMoverMetrics(evalBars, moverOpts);
          if (!fm?.fastMover) return null;
          const latest = buf[buf.length - 1];
          const cutoff = latest ? latest.closeTime - 24 * 60 * 60 * 1000 : null;
          const source =
            cutoff != null && buf[0]?.openTime > cutoff
              ? klineCache.read(sym) ?? buf
              : buf;
          let dayBase = null;
          if (cutoff != null) {
            for (const bar of source) {
              if (bar.closeTime <= cutoff) dayBase = bar;
              else break;
            }
          }
          const move24hPct =
            dayBase?.close > 0 && latest?.close
              ? ((latest.close - dayBase.close) / dayBase.close) * 100
              : null;

          return {
            symbol: sym,
            close: fm.close,
            avgMovePct: fm.avgMovePct,
            linearChangePct: fm.linearChangePct,
            absLinearChangePct: fm.absLinearChangePct,
            direction24h:
              move24hPct == null
                ? null
                : move24hPct >= 0
                  ? "bullish"
                  : "bearish",
            move24hPct:
              move24hPct == null ? null : +move24hPct.toFixed(3),
            absMove24hPct:
              move24hPct == null ? null : +Math.abs(move24hPct).toFixed(3),
            candlesUsed: fm.candlesUsed,
            candlesExcluded: fm.candlesExcluded,
          };
        })
        .filter(Boolean);

      if (q) movers = movers.filter((p) => p.symbol.includes(q));
      movers.sort((a, b) => b.avgMovePct - a.avgMovePct);

      return {
        updatedAt: formatIsoUtcPlus3(Date.now()),
        moverInterval: PRIMARY_INTERVAL,
        lookback,
        minAvgMovePct,
        minLinearChangePct,
        excludeMult,
        pairCount: movers.length,
        movers,
        ws: {
          ...wsStats,
          lastMessageAt:
            wsStats.lastMessageAt != null
              ? formatIsoUtcPlus3(wsStats.lastMessageAt)
              : null,
          lastKlineAt:
            wsStats.lastKlineAt != null
              ? formatIsoUtcPlus3(wsStats.lastKlineAt)
              : null,
          lastUpdateAt:
            wsStats.lastUpdateAt != null
              ? formatIsoUtcPlus3(wsStats.lastUpdateAt)
              : null,
        },
        telegramEnabled: Boolean(telegram?.enabled),
      };
    },
    getTopMovers(searchParams) {
      const TOP_MOVERS_WINDOW_MINUTES = [15, 60, 180, 600, 1440];
      const windowMinutesRaw = Number(searchParams.get("windowMinutes"));
      const windowMinutes = TOP_MOVERS_WINDOW_MINUTES.includes(windowMinutesRaw)
        ? windowMinutesRaw
        : 1440;
      const windowMs = windowMinutes * 60 * 1000;

      const q = (searchParams.get("q") || "").trim().toUpperCase();
      const minMovePct = Math.max(
        0.1,
        Math.min(1000, Number(searchParams.get("minMovePct")) || cfg.topMoveMinPct)
      );
      const fastLookback = fastMoverLookbackFor1m(
        cfg,
        Math.max(
          2,
          Math.min(
            120,
            Number(searchParams.get("fastLookback")) ||
              cfg.fastMoveLookbackCandles
          )
        )
      );
      const fastMinAvgMovePct = Math.max(
        0.01,
        Math.min(
          20,
          Number(searchParams.get("fastMinAvgMovePct")) || cfg.minAvgMovePct
        )
      );
      const fastExcludeMult = Math.max(
        1.5,
        Math.min(
          20,
          Number(searchParams.get("fastExcludeMult")) ||
            cfg.fastMoveExcludeMult
        )
      );
      const fastMoverOpts = {
        fastMoveLookbackCandles: fastLookback,
        minAvgMovePct: fastMinAvgMovePct,
        minLinearChangePct: cfg.minLinearChangePct,
        fastMoveExcludeMult: fastExcludeMult,
      };
      const now = Date.now();

      let movers = symbols
        .map((sym) => {
          const buf = primaryBarSource(sym, historyBuffers);
          if (!buf.length) return null;

          const latest = buf[buf.length - 1];
          const cutoff = latest.closeTime - windowMs;
          const needsDisk = buf[0].openTime > cutoff;
          const source = needsDisk ? klineCache.read(sym) ?? buf : buf;
          if (!source.length) return null;

          let base = null;
          for (const bar of source) {
            if (bar.closeTime <= cutoff) base = bar;
            else break;
          }
          if (!base) return null;
          if (!base?.close || base.close <= 0 || !latest?.close) return null;

          const movePct = ((latest.close - base.close) / base.close) * 100;
          if (Math.abs(movePct) < minMovePct) return null;
          const fm = fastMoverMetrics(
            klineCache.evalWindow(source, Math.max(cfg.limit, fastLookback)),
            fastMoverOpts
          );

          return {
            symbol: sym,
            direction: movePct >= 0 ? "bullish" : "bearish",
            movePct: +movePct.toFixed(3),
            absMovePct: +Math.abs(movePct).toFixed(3),
            avgMovePct: fm?.avgMovePct ?? null,
            candlesUsed: fm?.candlesUsed ?? null,
            candlesExcluded: fm?.candlesExcluded ?? null,
          };
        })
        .filter(Boolean);

      if (q) movers = movers.filter((p) => p.symbol.includes(q));
      movers.sort((a, b) => {
        if (a.direction !== b.direction) {
          return a.direction === "bullish" ? -1 : 1;
        }
        return b.absMovePct - a.absMovePct;
      });

      const windowLabel =
        windowMinutes < 60
          ? `${windowMinutes}m`
          : `${windowMinutes / 60}h`;

      return {
        updatedAt: formatIsoUtcPlus3(now),
        moverInterval: PRIMARY_INTERVAL,
        windowMinutes,
        windowLabel,
        minMovePct,
        fastLookback,
        fastMinAvgMovePct,
        fastExcludeMult,
        pairCount: movers.length,
        movers,
      };
    },
    getSweepReclaim(searchParams) {
      const q = (searchParams.get("q") || "").trim().toUpperCase();
      let items = symbols
        .map((sym) => {
          let evalBars;
          let signalBarAt = null;
          try {
            const ev = barsForEvaluation(sym, searchParams);
            evalBars = ev.bars;
            signalBarAt = ev.signalBarAt;
          } catch {
            return null;
          }
          const analysis = analyzeSweepReclaim(evalBars, cfg);
          if (!analysis.passes && analysis.metrics?.sweepLow == null) return null;
          const m = analysis.metrics;
          return {
            symbol: sym,
            passes: analysis.passes,
            close: m?.close ?? null,
            corridorLow: m?.corridorLow ?? null,
            corridorHigh: m?.corridorHigh ?? null,
            sweepLow: m?.sweepLow ?? null,
            barsSinceSweep: m?.barsSinceSweep ?? null,
            checks: serializeChecks(analysis.checks),
            signalBarAt:
              signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
            live: Boolean(sfpActive.get(sym)),
          };
        })
        .filter(Boolean);
      if (q) items = items.filter((p) => p.symbol.includes(q));
      items.sort((a, b) => {
        if (a.passes !== b.passes) return a.passes ? -1 : 1;
        return (b.barsSinceSweep ?? 0) - (a.barsSinceSweep ?? 0);
      });
      return {
        updatedAt: formatIsoUtcPlus3(Date.now()),
        ...pickLiveConfig(cfg),
        activeCount: sfpActive.size,
        pairCount: items.length,
        items,
      };
    },
    getSweepReject(searchParams) {
      const q = (searchParams.get("q") || "").trim().toUpperCase();
      let items = symbols
        .map((sym) => {
          let evalBars;
          let signalBarAt = null;
          try {
            const ev = barsForEvaluation(sym, searchParams);
            evalBars = ev.bars;
            signalBarAt = ev.signalBarAt;
          } catch {
            return null;
          }
          const analysis = analyzeSweepReject(evalBars, cfg);
          if (!analysis.passes && analysis.metrics?.sweepHigh == null) return null;
          const m = analysis.metrics;
          return {
            symbol: sym,
            passes: analysis.passes,
            close: m?.close ?? null,
            corridorLow: m?.corridorLow ?? null,
            corridorHigh: m?.corridorHigh ?? null,
            sweepHigh: m?.sweepHigh ?? null,
            barsSinceSweep: m?.barsSinceSweep ?? null,
            checks: serializeChecks(analysis.checks),
            signalBarAt:
              signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
            live: Boolean(sfpBearActive.get(sym)),
          };
        })
        .filter(Boolean);
      if (q) items = items.filter((p) => p.symbol.includes(q));
      items.sort((a, b) => {
        if (a.passes !== b.passes) return a.passes ? -1 : 1;
        return (b.barsSinceSweep ?? 0) - (a.barsSinceSweep ?? 0);
      });
      return {
        updatedAt: formatIsoUtcPlus3(Date.now()),
        ...pickLiveConfig(cfg),
        activeCount: sfpBearActive.size,
        pairCount: items.length,
        items,
      };
    },
    getPullback(searchParams) {
      const q = (searchParams.get("q") || "").trim().toUpperCase();
      const fmOpts = fastMoverOptsFromCfg(cfg);
      let items = symbols
        .map((sym) => {
          let evalBars;
          let signalBarAt = null;
          try {
            const ev = barsForEvaluation(sym, searchParams);
            evalBars = ev.bars;
            signalBarAt = ev.signalBarAt;
          } catch {
            return null;
          }
          const priceBars = priceBarsAt(sym, searchParams);
          const analysis = analyzePullback(evalBars, cfg, fmOpts, priceBars);
          if (!analysis.passes && !analysis.metrics?.touchedMa) return null;
          const m = analysis.metrics;
          return {
            symbol: sym,
            passes: analysis.passes,
            close: m?.close ?? null,
            ma: m?.ma ?? null,
            distFromMaPct: m?.distFromMaPct ?? null,
            avgMovePct: m?.avgMovePct ?? null,
            corridorHigh: m?.corridorHigh ?? null,
            corridorLow: m?.corridorLow ?? null,
            checks: serializeChecks(analysis.checks),
            signalBarAt:
              signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
            live: Boolean(pbActive.get(sym)),
          };
        })
        .filter(Boolean);
      if (q) items = items.filter((p) => p.symbol.includes(q));
      items.sort((a, b) => {
        if (a.passes !== b.passes) return a.passes ? -1 : 1;
        return (b.avgMovePct ?? 0) - (a.avgMovePct ?? 0);
      });
      return {
        updatedAt: formatIsoUtcPlus3(Date.now()),
        ...pickLiveConfig(cfg),
        activeCount: pbActive.size,
        pairCount: items.length,
        items,
      };
    },
    getStrategies() {
      return {
        updatedAt: formatIsoUtcPlus3(Date.now()),
        counts: {
          sfpActive: sfpActive.size,
          sfpBearActive: sfpBearActive.size,
          pullbackActive: pbActive.size,
        },
        config: {
          sfpLookbackBars: cfg.sfpLookbackBars,
          sfpReclaimBars: cfg.sfpReclaimBars,
          sfpMinSweepPct: cfg.sfpMinSweepPct,
          pullbackMaBars: cfg.pullbackMaBars,
          pullbackTouchLookback: cfg.pullbackTouchLookback,
          pullbackMaxDistancePct: cfg.pullbackMaxDistancePct,
          pullbackMaxAboveMaPct: cfg.pullbackMaxAboveMaPct,
        },
        live: {
          sfp: [...sfpActive.entries()].map(([symbol, row]) => ({
            symbol,
            ...row,
            triggeredAtIso: formatIsoUtcPlus3(row.triggeredAt),
          })),
          sfpBear: [...sfpBearActive.entries()].map(([symbol, row]) => ({
            symbol,
            ...row,
            triggeredAtIso: formatIsoUtcPlus3(row.triggeredAt),
          })),
          pullback: [...pbActive.entries()].map(([symbol, row]) => ({
            symbol,
            ...row,
            triggeredAtIso: formatIsoUtcPlus3(row.triggeredAt),
          })),
        },
      };
    },
    getChartData(symbol, searchParams) {
      const sym = String(symbol).toUpperCase();
      if (!symbols.includes(sym)) {
        throw new Error(`Unknown symbol: ${sym}`);
      }
      const buf = signalBuffers.get(sym) ?? [];
      if (!buf.length) throw new Error(`No bar data for ${sym}`);
      const { bars, atMs, signalBarAt } = barsForEvaluation(sym, searchParams);
      const priceBars = priceBarsAt(sym, searchParams);
      const indicator = (searchParams?.get("indicator") || "").toLowerCase();
      let analysis;
      if (indicator === "sfp") {
        analysis = analyzeSweepReclaim(bars, cfg);
      } else if (indicator === "pullback") {
        analysis = analyzePullback(
          bars,
          cfg,
          fastMoverOptsFromCfg(cfg),
          priceBars
        );
      } else {
        throw new Error(
          `indicator must be sfp or pullback (got ${indicator || "(empty)"})`
        );
      }
      return getChartPayload(sym, bars, cfg, analysis, {
        evaluateAt: atMs != null ? formatIsoUtcPlus3(atMs) : null,
        evaluateBarAt:
          signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
        indicator,
      });
    },
  };

  dashboard = createDashboardPublisher(cfg, {
    configWritable: !flags.has("no-http"),
    onPublish: (state) => dashboardWs?.broadcast("state", state),
  });
  dashboard.setMeta({ symbolCount: 0, prefetching: false });

  pushScannerState = () => {
    const m = signalMaps();
    dashboard.publish(
      m.sfpActive,
      m.sfpHistory,
      m.pbActive,
      m.pbHistory,
      m.sfpBearActive,
      m.sfpBearHistory,
      false
    );
  };

  function getBarsForTradeSnapshot(symbol, openedAt, closedAt) {
    let bars = historyBuffers.get(symbol) ?? [];
    if (bars.length < 30 && klineCache) {
      bars = klineCache.read(symbol) ?? bars;
    }
    const lookbackMs = (sfpRangeBars(cfg) + 60) * cfg.barMs;
    const needStart = openedAt - lookbackMs;
    const needEnd = closedAt + cfg.barMs * 30;
    return bars.filter(
      (b) => b.closeTime >= needStart && b.openTime <= needEnd
    );
  }

  async function captureTradeSnapshot(trade, posSnap) {
    const bars = getBarsForTradeSnapshot(
      trade.symbol,
      trade.openedAt,
      trade.closedAt
    );
    if (bars.length < 10) return null;
    const fullTrade = {
      ...trade,
      stopLoss: posSnap.stopLoss ?? trade.stopLoss,
      takeProfit: posSnap.takeProfit ?? trade.takeProfit,
      corridorHigh: posSnap.corridorHigh ?? trade.corridorHigh,
      corridorLow: posSnap.corridorLow ?? trade.corridorLow,
    };
    const { snapshotId } = await saveTradeSnapshot({
      trade: fullTrade,
      bars,
      interval: PRIMARY_INTERVAL,
    });
    return { snapshotId };
  }

  function createTradeClosedHandler(botLabel) {
    return async (trade, posSnap) => {
      // onTradeClose is void (returns undefined) — do not ??-fallback to
      // onNonSlTradeClose or every close sends the Telegram report twice.
      telegram?.onTradeClose?.(botLabel, trade);
      return captureTradeSnapshot(trade, posSnap);
    };
  }

  async function generatePaperBotOpenSnapshot(positionId) {
    refreshAllPaperBotPrices(historyBuffers);
    const state = paperBot.getPublicState();
    const pos = state.openPositions.find((p) => p.id === positionId);
    if (!pos) throw new Error("Open position not found");
    const asOf = Date.now();
    const bars = getBarsForTradeSnapshot(pos.symbol, pos.openedAt, asOf);
    if (bars.length < 10) throw new Error("Not enough price history for snapshot");
    const { snapshotId } = await saveOpenPositionSnapshot({
      position: pos,
      bars,
      interval: PRIMARY_INTERVAL,
    });
    return { snapshotId, symbol: pos.symbol };
  }

  async function generateLiveBotOpenSnapshot(positionId) {
    const state = await liveBot.getPublicState();
    const pos = state.openPositions.find((p) => p.id === positionId);
    if (!pos) throw new Error("Open position not found");
    const asOf = Date.now();
    const bars = getBarsForTradeSnapshot(pos.symbol, pos.openedAt, asOf);
    if (bars.length < 10) throw new Error("Not enough price history for snapshot");
    const { snapshotId } = await saveOpenPositionSnapshot({
      position: pos,
      bars,
      interval: PRIMARY_INTERVAL,
    });
    return { snapshotId, symbol: pos.symbol };
  }

  function handleDrawdownStop(payload) {
    if (!telegram?.enabled || payload.bot !== "live") return;
    return telegram.sendText(formatDrawdownTelegramMessage("Live bot", payload));
  }

  async function resolveExtremalSpikeGateForSymbol(symbol, atMs, botCfg = {}, opts = {}) {
    if (!botCfg?.extremalSpikeGateEnabled) {
      return { enabled: false, pass: true };
    }
    const bars = historyBuffers.get(symbol);
    if (!bars?.length) {
      return {
        enabled: true,
        pass: false,
        waiting: true,
        detail: "no kline history",
      };
    }
    return evaluateExtremalSpikeGate(
      bars,
      { ...cfg, ...botCfg },
      atMs,
      { positionSide: opts.positionSide ?? "LONG" }
    );
  }

  ensureAllDefaultModelsOnDisk();
  ensureAllSfpRegimeModelsOnDisk();
  ensureAllPullbackRegimeModelsOnDisk();
  ensureAllPullbackPatternBreakModelsOnDisk();
  ensureAllPullbackSignalModelsOnDisk();
  ensureAllAiExitLevelsModelsOnDisk();
  ensurePullbackGbm("paper", "paper");
  ensurePullbackGbm("live", "paper");
  ensureSfpRegimeGbm("paper", "paper");
  ensureSfpRegimeGbm("live", "paper");
  fundingOiProvider = createFundingOiProvider();

  sfpRegimeMonitor = createSfpRegimeMonitor({
    getClosedTrades: () => paperBot?.getClosedTrades?.() ?? [],
    modelScope: "paper",
    getBtcBars: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
    getFundingOiAt: (sym, asOf) => fundingOiProvider?.getFundingOiAt(sym, asOf),
  });

  pullbackRegimeMonitor = createPullbackRegimeMonitor({
    getClosedTrades: () => paperBot?.getClosedTrades?.() ?? [],
    modelScope: "paper",
    getBtcBars: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
  });

  pullbackPatternBreakMonitor = createPullbackPatternBreakMonitor({
    getClosedTrades: () => paperBot?.getClosedTrades?.() ?? [],
    modelScope: "paper",
    getBtcBars: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
  });

  paperBot = createPaperBot({
    onTradeClosed: captureTradeSnapshot,
    onDrawdownStop: handleDrawdownStop,
    resolveExtremalSpikeGate: resolveExtremalSpikeGateForSymbol,
    getRecentBars: (sym, limit) =>
      getRecentBarsForBot(sym, historyBuffers, limit),
    sfpRegimeMonitor,
    pullbackRegimeMonitor,
    pullbackPatternBreakMonitor,
    getBarsForSymbol: (sym) => getRecentBarsForBot(sym, historyBuffers, 400),
    getBtcBarsForRegime: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
    getFundingOiAt: (sym, asOf) => fundingOiProvider?.getFundingOiAt(sym, asOf),
    resolveBookTapeCombo: async (sym, side) => {
      const cfg = paperBot?.getPublicState?.()?.config ?? {};
      const [book, trades] = await Promise.all([
        fetchDepthSnapshot(sym, { limit: cfg.obiLevels || 20 }),
        fetchAggTrades(sym, { limit: cfg.tapeTradeCount || 100 }),
      ]);
      return computeBookTapeCombo({
        book,
        trades,
        side,
        levels: cfg.obiLevels || 20,
        tapeCount: cfg.tapeTradeCount || 100,
        cfg,
      });
    },
  });
  console.error(
    `Paper bot: simulated $${paperBot.getPublicState().config.initialDeposit} · ` +
      `${paperBot.getPublicState().config.enabled ? "enabled" : "disabled (enable in Paper bot tab)"}`
  );

  futuresTrader = createFuturesTrader({ kv });

  liveSfpRegimeMonitor = createSfpRegimeMonitor({
    getClosedTrades: () => liveBot?.getClosedTrades?.() ?? [],
    modelScope: "live",
    getBtcBars: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
    getFundingOiAt: (sym, asOf) => fundingOiProvider?.getFundingOiAt(sym, asOf),
  });

  livePullbackRegimeMonitor = createPullbackRegimeMonitor({
    getClosedTrades: () => liveBot?.getClosedTrades?.() ?? [],
    modelScope: "live",
    getBtcBars: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
  });

  livePullbackPatternBreakMonitor = createPullbackPatternBreakMonitor({
    getClosedTrades: () => liveBot?.getClosedTrades?.() ?? [],
    modelScope: "live",
    getBtcBars: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
  });

  const liveBotHistory = createLiveBotHistoryStore({ kv });

  liveBot = createLiveBot({
    trader: futuresTrader,
    onTradeClosed: createTradeClosedHandler("Live bot"),
    onDrawdownStop: handleDrawdownStop,
    onExitOrdersFailed: (pos, detail) =>
      telegram?.onExitOrdersFailed?.(pos, detail),
    resolveExtremalSpikeGate: resolveExtremalSpikeGateForSymbol,
    sfpRegimeMonitor: liveSfpRegimeMonitor,
    pullbackRegimeMonitor: livePullbackRegimeMonitor,
    pullbackPatternBreakMonitor: livePullbackPatternBreakMonitor,
    getRecentBars: (sym, limit) =>
      getRecentBarsForBot(sym, historyBuffers, limit),
    // ≥400×1m for FOI BTC lookalike 4h pathCosine gate
    getBarsForSymbol: (sym) => getRecentBarsForBot(sym, historyBuffers, 400),
    getBtcBarsForRegime: (asOf) => getBtcBarsForRegime(historyBuffers, asOf),
    getFundingOiAt: (sym, asOf) => fundingOiProvider?.getFundingOiAt(sym, asOf),
  });
  void liveBot.getPublicState().then((st) => {
    console.error(
      `Live bot: ${futuresTrader.enabled ? "API keys ok" : "no API keys"} · ` +
        `${st.config.armed ? "ARMED" : "disarmed"} · ` +
        `${st.config.leverage}x isolated`
    );
  });

  const auth = createTelegramAuth({ kv, flags });
  const getOpenPositions = createPositionsProvider({ kv });
  const getFuturesBalance = createFuturesBalanceProvider({ kv });
  const positionsOpenAtMs = new Map();
  let lastPositionsFullFetchAt = 0;
  let positionsFullRefreshPending = false;
  const POSITIONS_FULL_MS = 25_000;
  let positionsFetchInflight = null;

  function pruneOpenAtForMap(positionMap) {
    for (const sym of [...positionsOpenAtMs.keys()]) {
      if (!positionMap.has(sym)) positionsOpenAtMs.delete(sym);
    }
  }

  function markEnrichIfMissingOpenTimes(positionMap) {
    for (const sym of positionMap.keys()) {
      if (!positionsOpenAtMs.has(sym)) {
        positionsFullRefreshPending = true;
        return;
      }
    }
  }

  async function enrichPositionOpenTimes() {
    getOpenPositions.invalidateCache?.();
    const data = await getOpenPositions();
    rememberPositionOpenTimes(data.positions, positionsOpenAtMs);
  }

  async function attachExitOrderFlags(data) {
    if (!data.enabled || !data.positions?.length || !futuresTrader.enabled) {
      return data;
    }
    try {
      const flags = await futuresTrader.getExitOrderFlagsBySymbol();
      return {
        ...data,
        positions: data.positions.map((p) => {
          const ex = flags.get(p.symbol) ?? {};
          return {
            ...p,
            hasStopLoss: Boolean(ex.hasStopLoss),
            hasTakeProfit: Boolean(ex.hasTakeProfit),
            stopLoss: ex.stopLoss ?? null,
            takeProfit: ex.takeProfit ?? null,
          };
        }),
      };
    } catch (e) {
      return {
        ...data,
        positions: data.positions.map((p) => ({
          ...p,
          hasStopLoss: null,
          hasTakeProfit: null,
        })),
        exitOrdersError: e.message || String(e),
      };
    }
  }

  async function buildPositionsPayload() {
    const now = Date.now();
    if (!futuresTrader.enabled) {
      return getOpenPositions();
    }

    const needFull =
      positionsFullRefreshPending || now - lastPositionsFullFetchAt >= POSITIONS_FULL_MS;

    const map = await futuresTrader.getPositionMap({ force: needFull });
    pruneOpenAtForMap(map);
    markEnrichIfMissingOpenTimes(map);

    if (needFull) {
      try {
        await enrichPositionOpenTimes();
      } catch {
        /* open-time enrichment is optional */
      }
      lastPositionsFullFetchAt = now;
      positionsFullRefreshPending = false;
    }

    const positions = snapshotPositionsFromMap(map, positionsOpenAtMs);
    const totalPnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
    const withFlags = await attachExitOrderFlags({
      enabled: true,
      updatedAt: formatIsoUtcPlus3(now),
      positions,
      totalPnl: +totalPnl.toFixed(4),
      hint: null,
    });
    exchangeOpenSymbols = new Set(
      (withFlags.positions ?? []).map((p) => p.symbol).filter(Boolean)
    );
    return withFlags;
  }

  fetchPositionsPayload = async () => {
    if (positionsFetchInflight) return positionsFetchInflight;
    positionsFetchInflight = buildPositionsPayload().finally(() => {
      positionsFetchInflight = null;
    });
    return positionsFetchInflight;
  };

  broadcastPositionsUpdate = () => {
    if (!dashboardWs) return;
    dashboardWs.broadcastThrottled("positions", fetchPositionsPayload, 500);
  };

  broadcastAccountState = () => {
    if (!dashboardWs) return;
    broadcastPositionsUpdate();
    dashboardWs.broadcastThrottled("balance", getFuturesBalance, 5000);
    dashboardWs.broadcastThrottled("liveBot", () => liveBot.getPublicState(), 500);
  };

  const binanceUserStream = createBinanceUserStream({
    credentials: resolveBinanceCredentials(kv),
    trader: futuresTrader,
    onAccountUpdate: () => {
      getOpenPositions.invalidateCache?.();
      broadcastPositionsUpdate();
    },
    onOrderUpdate: () => {
      getOpenPositions.invalidateCache?.();
      positionsFullRefreshPending = true;
      broadcastPositionsUpdate();
    },
  });
  if (futuresTrader.enabled) binanceUserStream.start();

  const binanceCreds = resolveBinanceCredentials(kv);
  if (binanceCreds.enabled) {
    console.error("Binance Futures positions: enabled (header panel)");
  } else if (!flags.has("no-http")) {
    console.error(
      "Binance positions off (set BINANCE_API_KEY + BINANCE_API_SECRET in .env)"
    );
  }

  if (!flags.has("no-http")) {
    const { port, host } = resolveListenOptions({
      port: kv.has("port") ? Number(kv.get("port")) : undefined,
      host: kv.get("host"),
    });
    const { dashboardWs: wsHub } = startDashboard(
      () =>
        dashboard.buildState(
          sfpActive,
          sfpHistory,
          pbActive,
          pbHistory,
          sfpBearActive,
          sfpBearHistory
        ),
      {
        port,
        host,
        getWsSnapshot: async () => ({
          state: dashboard.buildState(
            sfpActive,
            sfpHistory,
            pbActive,
            pbHistory,
            sfpBearActive,
            sfpBearHistory
          ),
          paperBot: paperBot.getPublicState(),
          liveBot: await liveBot.getPublicState(),
          positions: await fetchPositionsPayload(),
          balance: await getFuturesBalance(),
        }),
        getFastMovers: (searchParams) => scannerApi.getFastMovers(searchParams),
        getSweepReclaim: (searchParams) => scannerApi.getSweepReclaim(searchParams),
        getSweepReject: (searchParams) => scannerApi.getSweepReject(searchParams),
        getPullback: (searchParams) => scannerApi.getPullback(searchParams),
        getStrategies: () => scannerApi.getStrategies(),
        getTopMovers: (searchParams) => scannerApi.getTopMovers(searchParams),
        getChartData: (symbol, searchParams) =>
          scannerApi.getChartData(symbol, searchParams),
        getPositions: fetchPositionsPayload,
        closeFuturesPosition: async (symbol) => {
          const sym = String(symbol || "").toUpperCase();
          if (!sym) throw new Error("Symbol required");
          if (!futuresTrader.enabled) {
            throw new Error("Binance API not configured");
          }
          const liveState = await liveBot.getPublicState();
          if (liveState.openPositions?.some((p) => p.symbol === sym)) {
            return liveBot.closeSymbol(sym, "manual");
          }
          await futuresTrader.closePosition(sym);
          return { ok: true, symbol: sym, via: "exchange" };
        },
        getFuturesBalance,
        getLiveBotHistory: async (searchParams) =>
          liveBotHistory.list(searchParams, liveBot?.getClosedTrades?.() ?? []),
        getLiveBotHistoryExport: async (searchParams, options) => {
          const history = await liveBotHistory.list(
            searchParams,
            liveBot?.getClosedTrades?.() ?? []
          );
          const liveState = await liveBot.getPublicState();
          return buildLiveBotHistoryExport({
            history,
            searchParams,
            liveBotConfig: liveState.config,
            liveBotSummary: liveState.summary,
            scannerConfig: scannerConfig.getAll(),
            signalConfig: pickLiveConfig(cfg),
            interval: cfg.interval,
            primaryInterval: PRIMARY_INTERVAL,
            options,
          });
        },
        getPaperBot: () => {
          refreshBotPrices(historyBuffers, null, { paperOnly: true });
          return paperBot.getPublicState();
        },
        patchPaperBotConfig: (patch) => {
          paperBot.patchConfig(patch);
          refreshBotPrices(historyBuffers, null, { paperOnly: true });
          return paperBot.getPublicState();
        },
        resetPaperBot: () => {
          paperBot.reset();
          return paperBot.getPublicState();
        },
        closePaperBotSymbol: (symbol) => {
          refreshBotPrices(historyBuffers, symbol, { paperOnly: true });
          const state = paperBot.closeSymbol(symbol);
          dashboardWs?.broadcast("paperBot", state);
          return state;
        },
        getEarlyExitModelStatus: (scope) =>
          getEarlyExitModelStatusFull(scope),
        getEarlyExitModelData: (scope) =>
          getEarlyExitModel(normalizeAiModelScope(scope)),
        importEarlyExitModel: (body) => importEarlyExitModelFromBody(body),
        trainEarlyExitModel: (body) => trainEarlyExitModelFromHistory(body),
        getSfpRegimeModelStatus: (scope) =>
          getSfpRegimeModelStatusFull(scope),
        getSfpRegimeModelData: (scope) =>
          getSfpRegimeModel(normalizeAiModelScope(scope)),
        getSfpRegimeMonitor: (scope) =>
          normalizeAiModelScope(scope) === "live"
            ? getLiveSfpRegimeMonitorSnapshot()
            : getSfpRegimeMonitorSnapshot(),
        trainSfpRegimeModel: (body) => trainSfpRegimeModelFromHistory(body),
        importSfpRegimeModel: (body) => importSfpRegimeModelFromBody(body),
        getAiExitLevelsModelStatus: (scope) =>
          getAiExitLevelsModelStatusFull(scope),
        getAiExitLevelsModelData: (scope) =>
          getAiExitLevelsModel(normalizeAiModelScope(scope)),
        importAiExitLevelsModel: (body) =>
          importAiExitLevelsModelFromBody(body),
        trainAiExitLevelsModel: (body) => startAiExitLevelsTraining(body),
        getPullbackRegimeModelStatus: (scope) =>
          getPullbackRegimeModelStatusFull(scope),
        getPullbackRegimeModelData: (scope) =>
          getPullbackRegimeModel(normalizeAiModelScope(scope)),
        importPullbackRegimeModel: (body) =>
          importPullbackRegimeModelFromBody(body),
        trainPullbackRegimeModel: (body) =>
          trainPullbackRegimeModelFromHistory(body),
        getPullbackRegimeMonitor: (scope) =>
          normalizeAiModelScope(scope) === "live"
            ? getLivePullbackRegimeMonitorSnapshot()
            : getPullbackRegimeMonitorSnapshot(),
        getPullbackPatternBreakModelStatus: (scope) =>
          getPullbackPatternBreakModelStatusFull(scope),
        getPullbackPatternBreakModelData: (scope) =>
          getPullbackPatternBreakModel(normalizeAiModelScope(scope)),
        importPullbackPatternBreakModel: (body) =>
          importPullbackPatternBreakModelFromBody(body),
        trainPullbackPatternBreakModel: (body) =>
          trainPullbackPatternBreakModelFromHistory(body),
        getPullbackPatternBreakMonitor: (scope) =>
          normalizeAiModelScope(scope) === "live"
            ? getLivePullbackPatternBreakMonitorSnapshot()
            : getPullbackPatternBreakMonitorSnapshot(),
        getPullbackSignalModelStatus: (scope) =>
          getPullbackSignalModelStatusFull(scope),
        getPullbackSignalModelData: (scope) =>
          getPullbackSignalModel(normalizeAiModelScope(scope)),
        importPullbackSignalModel: (body) =>
          importPullbackSignalModelFromBody(body),
        trainPullbackSignalModel: (body) =>
          trainPullbackSignalModelFromHistory(body),
        getLiveAiReport: () => getLiveAiReport(),
        getLiveBot: () => liveBot.getPublicState(),
        patchLiveBotConfig: async (patch) => {
          const result = await liveBot.patchConfig(patch);
          refreshAllPaperBotPrices(historyBuffers);
          return result;
        },
        armLiveBot: () => liveBot.arm(),
        disarmLiveBot: () => liveBot.disarm(),
        closeLiveBotSymbol: (symbol) => liveBot.closeSymbol(symbol),
        closeAllLiveBot: () => liveBot.closeAll(),
        forgetLiveBotOpen: (symbol) => liveBot.forgetOpenPositions(symbol),
        syncLiveBot: () => liveBot.syncFromExchange(),
        resetLiveBotHistory: (opts) => liveBot.resetHistory(opts),
        generatePaperBotOpenSnapshot,
        generateLiveBotOpenSnapshot,
        generateBacktestTradeSnapshot,
        getBacktestStatus: () => {
          reconcileBacktestJob();
          return {
            running: backtestJob.running,
            progress: backtestJob.progress,
            result: backtestJob.result,
            error: backtestJob.error,
            last: loadLastBacktestResult(),
            klineCache: getBacktestKlineCacheInfo(),
            snapshots: {
              running: backtestSnapshotJob.running,
              progress: backtestSnapshotJob.progress,
              error: backtestSnapshotJob.error,
            },
            defaultDays: DEFAULT_DAYS,
            signalConfig: pickLiveConfig(cfg),
          };
        },
        stopAndResetBacktest: () => {
          const wasRunning = backtestJob.running;
          const wasSnapshots = backtestSnapshotJob.running;
          bumpBacktestRunEpoch();
          backtestJob.cancelled = true;
          backtestRestQueue.reset();
          cancelBacktestSnapshotJob();
          backtestJob.running = false;
          backtestJob.result = null;
          backtestJob.error = null;
          backtestJob.progress = null;
          backtestJob.startedAt = null;
          backtestJob.lastProgressAt = null;
          backtestJob.barCache = null;
          backtestJob.chartCfg = null;
          resetBacktestData();
          if (wasRunning || wasSnapshots) {
            console.error("Paper bot backtest stopped and reset");
          }
          return {
            running: false,
            progress: null,
            result: null,
            error: null,
            last: null,
            klineCache: getBacktestKlineCacheInfo(),
            snapshots: freshBacktestSnapshotJobState(),
            defaultDays: DEFAULT_DAYS,
            signalConfig: pickLiveConfig(cfg),
            reset: true,
          };
        },
        startBacktest: async (body) => {
          if (backtestJob.running) {
            throw new Error("Backtest already running");
          }
          cancelBacktestSnapshotJob();
          clearBacktestRunArtifacts();
          bumpBacktestRunEpoch();
          backtestRestQueue.reset();
          const runEpoch = backtestRunEpoch;
          const days = Math.max(
            1,
            Math.min(21, Number(body?.days) || DEFAULT_DAYS)
          );
          const { symList, unknown, mode, requested } = resolveBacktestSymbols(
            body,
            symbols
          );
          const startedAt = Date.now();
          backtestJob.cancelled = false;
          backtestJob.running = true;
          backtestJob.result = null;
          backtestJob.error = null;
          backtestJob.startedAt = startedAt;
          backtestJob.lastProgressAt = startedAt;
          backtestJob.barCache = null;
          backtestJob.chartCfg = null;
          backtestJob.progress = {
            phase: "starting",
            done: 0,
            total: symList.length,
            ok: 0,
            skip: 0,
            message: `Starting ${symList.length} symbols × ${days}d…`,
          };
          const shouldAbortBacktest = () =>
            backtestJob.cancelled || backtestRunEpoch !== runEpoch;
          const heartbeatKlines = (sym) => {
            if (shouldAbortBacktest()) return;
            const prev = backtestJob.progress ?? {};
            touchBacktestProgress({
              ...prev,
              phase: prev.phase === "simulate" ? "simulate" : "loading",
              symbol: sym,
              message:
                prev.phase === "simulate"
                  ? prev.message
                  : `Loading ${sym} (${days}d)…`,
            });
          };
          runPaperBotBacktest({
            symbols: symList,
            signalCfg: cfg,
            botConfig: paperBot.getPublicState().config,
            days,
            fetchKlinesForSymbol: (sym, limit) =>
              fetchKlinesForBacktest(
                sym,
                limit,
                cfg.interval,
                () => heartbeatKlines(sym),
                shouldAbortBacktest
              ),
            fetchKlines1mForSymbol: (sym, limit) =>
              fetchKlinesForBacktest(
                sym,
                limit,
                "1m",
                () => heartbeatKlines(sym),
                shouldAbortBacktest
              ),
            onProgress: (p) => {
              if (!backtestRunActive(runEpoch)) return;
              touchBacktestProgress(p);
            },
            restGapMs: Math.max(80, Math.floor(cfg.restMinGapMs / 2)),
            shouldAbort: shouldAbortBacktest,
            runMeta: {
              days,
              symbolMode: mode,
              symbolsRequested: requested,
              symbolsSelected: symList.length,
              symbolsUnknown: unknown,
            },
          })
            .then(({ result, barCache, chartCfg }) => {
              if (!backtestRunActive(runEpoch)) return;
              backtestJob.running = false;
              backtestJob.result = result;
              backtestJob.barCache = barCache ?? null;
              backtestJob.chartCfg = chartCfg ?? null;
              touchBacktestProgress({
                phase: "done",
                done: symList.length,
                total: symList.length,
                ok: result.symbolsProcessed ?? symList.length,
                skip: result.symbolsSkipped ?? 0,
                message: "Complete",
              });
              console.error(
                `Paper bot backtest done: ${result.summary.closedCount} trades · PnL ${result.summary.totalPnl}`
              );
            })
            .catch((e) => {
              if (backtestRunEpoch !== runEpoch) return;
              backtestJob.running = false;
              if (
                backtestJob.cancelled ||
                e.code === "BACKTEST_CANCELLED" ||
                e.code === "QUEUE_RESET"
              ) {
                return;
              }
              backtestJob.error = e.message || String(e);
              console.error(`Paper bot backtest failed: ${backtestJob.error}`);
            });
          return {
            ok: true,
            started: true,
            days,
            symbols: symList.length,
            mode,
            requested,
            unknown,
          };
        },
        auth,
        onConfigUpdate: async (patch) => {
          const updates = validateLiveConfigPatch(patch);
          Object.assign(cfg, updates);
          applyBarConfig(cfg);
          scannerConfig.saveFrom(cfg);
          dashboard.syncConfigFromCfg();
          dashboard.pushEvent(
            "CONFIG",
            "scanner",
            Object.entries(updates)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")
          );
          console.error(
            `Config updated: ${Object.entries(updates)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")} | 1m bars: ${cfg.limit} | signal bars: ${cfg.signalLimit ?? cfg.limit}`
          );
          if (updates.interval) {
            console.error(
              "Note: interval changed — restart scanner to reload signal-timeframe cache"
            );
          }
          reevaluateAll();
          return dashboard.buildState(
            sfpActive,
            sfpHistory,
            pbActive,
            pbHistory,
            sfpBearActive,
            sfpBearHistory
          );
        },
        onStorageClean: () => {
          const allSyms = new Set([
            ...historyBuffers.keys(),
            ...signalBuffers.keys(),
          ]);
          for (const sym of allSyms) {
            historyBuffers.set(sym, []);
            if (separateSignal) signalBuffers.set(sym, []);
            klineCache.replace(sym, []);
            if (separateSignal) signalKlineCache.replace(sym, []);
          }
          backtestJob.result = null;
          backtestJob.error = null;
          backtestJob.progress = null;
        },
      }
    );
    dashboardWs = wsHub;
    void fetchPositionsPayload().then((data) => dashboardWs?.broadcast("positions", data));
    dashboard.publish(
      sfpActive,
      sfpHistory,
      pbActive,
      pbHistory,
      sfpBearActive,
      sfpBearHistory,
      true
    );
  }

  symbols = await resolveSymbols(flags, kv);
  const defaultMax =
    process.env.PORT && process.env.SCAN_ALL !== "1" ? 150 : 0;
  const maxSymbols = Number(process.env.MAX_SYMBOLS || defaultMax);
  if (maxSymbols > 0 && symbols.length > maxSymbols) {
    console.error(`MAX_SYMBOLS=${maxSymbols}: using first ${maxSymbols} of ${symbols.length}`);
    symbols = symbols.slice(0, maxSymbols);
  }
  dashboard.setMeta({ symbolCount: symbols.length, prefetching: false });

  if (fundingOiProvider) {
    fundingOiProvider.setSymbols(symbols);
    fundingOiProvider.startAutoRefresh();
    void fundingOiProvider.refreshAll().then((r) => {
      console.error(`Funding/OI provider: cached ${r.ok} symbols (${r.fail} failed)`);
    }).catch((e) => console.error(`Funding/OI refresh: ${e.message}`));
  }

  obiLiveRunner = createObiLiveRunner({
    maxSymbols: 40,
    getConfig: () => ({
      ...(paperBot?.getPublicState?.()?.config || {}),
      ...(liveBot?.getPublicState?.()?.config || {}),
    }),
    getSymbols: () => symbols,
    onLong: (sym, metrics) => {
      dashboard?.pushEvent(
        "NEW_OBI",
        sym,
        `Bid/Ask ${metrics.imbalance?.toFixed?.(2) ?? "?"} · bid $${Math.round(metrics.bidVol || 0)} / ask $${Math.round(metrics.askVol || 0)}`
      );
      paperBot?.onObiSignal?.(sym, metrics);
      liveBot?.onObiSignal?.(sym, metrics);
    },
    onShort: (sym, metrics) => {
      dashboard?.pushEvent(
        "NEW_OBI_BEAR",
        sym,
        `Ask/Bid ${metrics.askBidRatio?.toFixed?.(2) ?? "?"} · bid $${Math.round(metrics.bidVol || 0)} / ask $${Math.round(metrics.askVol || 0)}`
      );
      paperBot?.onObiBearSignal?.(sym, metrics);
      liveBot?.onObiBearSignal?.(sym, metrics);
    },
  });
  {
    const obiStart = obiLiveRunner.start();
    if (obiStart.started) {
      console.error(`OBI depth runner: ${obiStart.symbols} symbols (WS depth20)`);
    } else {
      console.error(`OBI depth runner idle (${obiStart.reason}) — enable tradeObiSignals to start`);
    }
  }

  tapeLiveRunner = createTapeLiveRunner({
    maxSymbols: 40,
    getConfig: () => ({
      ...(paperBot?.getPublicState?.()?.config || {}),
      ...(liveBot?.getPublicState?.()?.config || {}),
    }),
    getSymbols: () => symbols,
    onLong: (sym, metrics) => {
      dashboard?.pushEvent(
        "NEW_TAPE",
        sym,
        `sell ${(100 * (metrics.sellShare || 0)).toFixed(0)}% · Δpx ${metrics.priceChangePct?.toFixed?.(3) ?? "?"}% · seller absorption`
      );
      paperBot?.onTapeSignal?.(sym, metrics);
      liveBot?.onTapeSignal?.(sym, metrics);
    },
    onShort: (sym, metrics) => {
      dashboard?.pushEvent(
        "NEW_TAPE_BEAR",
        sym,
        `buy ${(100 * (metrics.buyShare || 0)).toFixed(0)}% · Δpx ${metrics.priceChangePct?.toFixed?.(3) ?? "?"}% · buyer absorption`
      );
      paperBot?.onTapeBearSignal?.(sym, metrics);
      liveBot?.onTapeBearSignal?.(sym, metrics);
    },
  });
  {
    const tapeStart = tapeLiveRunner.start();
    if (tapeStart.started) {
      console.error(`Tape runner: ${tapeStart.symbols} symbols (WS @trade)`);
    } else {
      console.error(`Tape runner idle (${tapeStart.reason}) — enable tradeTapeSignals to start`);
    }
  }

  const snapshotClean = cleanOldSnapshots();
  if (snapshotClean.removed > 0) {
    console.error(
      `Snapshots: removed ${snapshotClean.removed} file(s) older than 24h ` +
        `(${formatBytes(snapshotClean.freedBytes)} freed)`
    );
  }
  setInterval(cleanOldSnapshots, 60 * 60 * 1000).unref?.();

  reevaluateAll = () =>
    reevaluateAllSymbols(
      symbols,
      historyBuffers,
      signalBuffers,
      signalMaps(),
      quoteVolMap
    );

  console.error(
    `Symbols: ${symbols.length} | live: ${PRIMARY_INTERVAL} (${cfg.limit} bars) | ` +
      `signals: ${cfg.interval} (${cfg.signalLimit ?? cfg.limit} bars) | ` +
      `cache max: ${cfg.cacheMaxBars} | ` +
      `live prefetch: ${wantPrefetch ? "yes (per-symbol if cache insufficient)" : "no"}`
  );

  klineCache.startPeriodicFlush(historyBuffers);
  if (separateSignal) {
    signalKlineCache.startPeriodicFlush(signalBuffers);
  }

  console.error(
    `WebSocket live on fstream (${PRIMARY_INTERVAL}` +
      (separateSignal ? ` + ${cfg.interval} signals` : "") +
      ")…"
  );
  const sockets = createWsShards(
    symbols,
    historyBuffers,
    signalBuffers,
    signalMaps(),
    quoteVolMap,
    separateSignal
  );
  const signalSockets = separateSignal
    ? createSignalWsShards(
        symbols,
        signalBuffers,
        historyBuffers,
        signalMaps(),
        quoteVolMap
      )
    : [];

  if (wantPrefetch) {
    await prefetchAllSymbols(
      symbols,
      historyBuffers,
      signalMaps(),
      quoteVolMap,
      reevaluateAll,
      prefetchSignalSymbols
    );
  } else {
    console.error(
      "Skipping prefetch (--no-prefetch). History will build from cache/WebSocket."
    );
  }

  const stopStaleRefresh = startStaleSymbolRefresh(
    symbols,
    historyBuffers,
    signalBuffers,
    signalMaps(),
    quoteVolMap
  );

  const paperBotPriceTimer = setInterval(() => {
    if (
      paperBot?.getPublicState().summary?.openCount > 0 ||
      liveBot?.hasOpenPositions()
    ) {
      refreshBotPrices(historyBuffers, null, { barClosed: true });
    }
    if (sfpRegimeMonitor && paperBot?.getPublicState?.().config?.aiSfpRegimeEnabled) {
      const syms = [...historyBuffers.keys()];
      sfpRegimeMonitor.refreshBatch(
        syms,
        (sym) => getRecentBarsForBot(sym, historyBuffers, 120),
        paperBot.getPublicState().config,
        50
      );
    }
    if (
      pullbackRegimeMonitor &&
      paperBot?.getPublicState?.().config?.aiPullbackRegimeEnabled
    ) {
      const syms = [...historyBuffers.keys()];
      pullbackRegimeMonitor.refreshBatch(
        syms,
        (sym) => getRecentBarsForBot(sym, historyBuffers, 120),
        paperBot.getPublicState().config,
        50
      );
    }
    if (
      pullbackPatternBreakMonitor &&
      paperBot?.getPublicState?.().config?.aiPullbackPatternBreakEnabled
    ) {
      const syms = [...historyBuffers.keys()];
      pullbackPatternBreakMonitor.refreshBatch(
        syms,
        (sym) => getRecentBarsForBot(sym, historyBuffers, 120),
        paperBot.getPublicState().config,
        50
      );
    }
    if (liveSfpRegimeMonitor && liveBot?.getConfig?.()?.aiSfpRegimeEnabled) {
      const syms = [...historyBuffers.keys()];
      liveSfpRegimeMonitor.refreshBatch(
        syms,
        (sym) => getRecentBarsForBot(sym, historyBuffers, 120),
        liveBot.getConfig(),
        50
      );
    }
    if (
      livePullbackRegimeMonitor &&
      liveBot?.getConfig?.()?.aiPullbackRegimeEnabled
    ) {
      const syms = [...historyBuffers.keys()];
      livePullbackRegimeMonitor.refreshBatch(
        syms,
        (sym) => getRecentBarsForBot(sym, historyBuffers, 120),
        liveBot.getConfig(),
        50
      );
    }
    if (
      livePullbackPatternBreakMonitor &&
      liveBot?.getConfig?.()?.aiPullbackPatternBreakEnabled
    ) {
      const syms = [...historyBuffers.keys()];
      livePullbackPatternBreakMonitor.refreshBatch(
        syms,
        (sym) => getRecentBarsForBot(sym, historyBuffers, 120),
        liveBot.getConfig(),
        50
      );
    }
  }, 15_000);

  const positionsBroadcastTimer = setInterval(() => {
    if (futuresTrader?.enabled) broadcastPositionsUpdate();
  }, 2000);

  if (telegram.enabled && tgConfig.paperBotReport) {
    stopPaperBotReport = startPaperBotMorningReports({
      enabled: true,
      hour: tgConfig.paperBotReportHour,
      minute: tgConfig.paperBotReportMinute,
      getReportState: () => {
        refreshBotPrices(historyBuffers, null, { paperOnly: true });
        return paperBot.getPublicState();
      },
      sendText: (text) => telegram.sendText(text),
    });
  }

  const shutdown = () => {
    console.error("Flushing kline cache…");
    stopPaperBotReport();
    clearInterval(paperBotPriceTimer);
    stopStaleRefresh();
    klineCache.flushAll(historyBuffers);
    klineCache.stop();
    if (separateSignal) {
      signalKlineCache.flushAll(signalBuffers);
      signalKlineCache.stop();
    }
    paperBot?.flush();
    liveBot?.flush();
    closeDb();
    sockets.forEach((s) => s.close());
    signalSockets.forEach((s) => s.close());
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
