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
  analyzeLevelBreakUp,
  analyzeLevelBreakDown,
  fastMoverPullbackMetrics,
  analyzePullback,
  fastMoverOptsFromCfg,
  fastMoverLookbackFor1m,
  sfpRangeBars,
} = require("./lib/signal-metrics");
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
  ensureDefaultModelOnDisk,
  getModelStatus,
  trainFromTrades,
  reloadModel,
} = require("./lib/early-exit-model");
const {
  ensureDefaultModelOnDisk: ensureSfpRegimeModelOnDisk,
  getModelStatus: getSfpRegimeModelStatus,
  trainFromTrades: trainSfpRegimeFromTrades,
  reloadModel: reloadSfpRegimeModel,
} = require("./lib/sfp-regime-model");
const { createSfpRegimeMonitor } = require("./lib/sfp-regime-monitor");
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
const { createPositionsHistoryStore } = require("./lib/positions-history");
const { createTelegramAuth } = require("./lib/telegram-auth");
const {
  dataPath,
  migrateLegacyCache,
  resolveDataDir,
  formatBytes,
  writeJsonFile,
} = require("./lib/data-dir");
const scannerConfig = require("./lib/scanner-config");

const REST_BASE = "https://fapi.binance.com";
// DO NOT CHANGE BASE wss://stream.binance.com:443
const WS_STREAM_BASE = "wss://stream.binance.com:443/stream";
const KLINE_MAX = 1500;
const SIGNAL_RETENTION_MS = 24 * 60 * 60 * 1000;
migrateLegacyCache();
scannerConfig.migrateFromResultsJson();
console.error(`Persistent data: ${resolveDataDir()}`);
const EXCHANGE_INFO_CACHE = dataPath("futures-exchangeInfo.json");
const KLINES_CACHE_DIR = dataPath("klines");
console.error(`Kline cache dir: ${KLINES_CACHE_DIR}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = {
  interval: "1m",
  prefetchDays: 3,
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

const restLimiter = { chain: Promise.resolve() };
let lastHitsPrintAt = 0;
let prefetching = false;
let dashboard = null;
let pushScannerState = null;
let telegram = null;
let paperBot = null;
let sfpRegimeMonitor = null;
let liveBot = null;
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
  early_exit: freshAiTrainJob(),
  sfp_regime: freshAiTrainJob(),
};

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

function getEarlyExitModelStatusFull() {
  return modelStatusWithTraining(getModelStatus, aiTrainJob.early_exit);
}

function getSfpRegimeModelStatusFull() {
  return modelStatusWithTraining(getSfpRegimeModelStatus, aiTrainJob.sfp_regime);
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
    bars = readSymbolBars("signal", symbol) ?? [];
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

function collectEarlyExitTrainingTrades(source = "auto") {
  const mode = String(source || "auto").toLowerCase();
  const backtest = loadLastBacktestResult();
  const paper = paperBot?.getClosedTrades?.() ?? [];
  if (mode === "paper") return paper;
  if (mode === "backtest") return backtest?.closedTrades ?? [];
  const merged = [...(backtest?.closedTrades ?? []), ...paper];
  const seen = new Set();
  const out = [];
  for (const t of merged) {
    const key = t.id ?? `${t.symbol}-${t.openedAt}-${t.closedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function startEarlyExitTraining(body = {}) {
  const job = aiTrainJob.early_exit;
  if (job.running) {
    throw new Error("Early-exit model training already running");
  }
  const trades = collectEarlyExitTrainingTrades(body.source);
  if (!trades.length) {
    throw new Error(
      "No closed trades for training — run train bot or accumulate paper bot history"
    );
  }

  job.running = true;
  job.error = null;
  job.result = null;
  job.progress = {
    phase: "starting",
    done: 0,
    total: trades.length,
    message: `Preparing ${trades.length} trades…`,
  };

  const cfg = paperBot.getPublicState().config;
  void (async () => {
    try {
      await trainFromTrades(trades, fetchBarsForEarlyExitTraining, {
        ...cfg,
        source: `trained:${body.source ?? "auto"}`,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      reloadModel();
      job.result = {
        tradesUsed: trades.length,
        model: getModelStatus(),
      };
      job.progress = {
        phase: "done",
        done: trades.length,
        total: trades.length,
        message: "Training complete",
      };
    } catch (e) {
      job.error = e.message || String(e);
      console.error(`Early-exit model training failed: ${job.error}`);
    } finally {
      job.running = false;
    }
  })();

  return { ok: true, started: true, trades: trades.length };
}

function trainEarlyExitModelFromHistory(body = {}) {
  return startEarlyExitTraining(body);
}

function collectSfpRegimeTrainingTrades(source = "auto") {
  const mode = String(source || "auto").toLowerCase();
  const backtest = loadLastBacktestResult();
  const paper = paperBot?.getClosedTrades?.() ?? [];
  const filterSfp = (list) =>
    (list ?? []).filter(
      (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
    );
  if (mode === "paper") return filterSfp(paper);
  if (mode === "backtest") return filterSfp(backtest?.closedTrades);
  const merged = [...filterSfp(backtest?.closedTrades), ...filterSfp(paper)];
  const seen = new Set();
  const out = [];
  for (const t of merged) {
    const key = t.id ?? `${t.symbol}-${t.openedAt}-${t.closedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function startSfpRegimeTraining(body = {}) {
  const job = aiTrainJob.sfp_regime;
  if (job.running) {
    throw new Error("SFP regime model training already running");
  }
  const trades = collectSfpRegimeTrainingTrades(body.source);
  if (!trades.length) {
    throw new Error(
      "No SFP closed trades for training — run train bot with SFP signals enabled"
    );
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

  const cfg = paperBot.getPublicState().config;
  void (async () => {
    try {
      await trainSfpRegimeFromTrades(trades, fetchBarsForSfpRegimeTraining, {
        ...cfg,
        source: `trained:${body.source ?? "auto"}`,
        onProgress: (p) => {
          job.progress = p;
        },
      });
      reloadSfpRegimeModel();
      job.result = {
        tradesUsed: trades.length,
        model: getSfpRegimeModelStatus(),
      };
      job.progress = {
        phase: "done",
        done: trades.length,
        total: trades.length,
        message: "Training complete",
      };
    } catch (e) {
      job.error = e.message || String(e);
      console.error(`SFP regime model training failed: ${job.error}`);
    } finally {
      job.running = false;
    }
  })();

  return { ok: true, started: true, trades: trades.length };
}

function trainSfpRegimeModelFromHistory(body = {}) {
  return startSfpRegimeTraining(body);
}

function refreshSfpRegimeForSymbol(sym, historyBuffers) {
  if (!sfpRegimeMonitor || !paperBot) return;
  const cfg = paperBot.getPublicState().config;
  if (!cfg.aiSfpRegimeEnabled) return;
  const bars = getRecentBarsForBot(sym, historyBuffers, 120);
  if (bars.length < 30) return;
  sfpRegimeMonitor.refreshSymbol(sym, bars, cfg);
}

function getSfpRegimeMonitorSnapshot() {
  if (!sfpRegimeMonitor || !paperBot) {
    return { ok: true, enabled: false, tracked: 0, badCount: 0, worst: [] };
  }
  return sfpRegimeMonitor.getSnapshot(paperBot.getPublicState().config);
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

async function waitForBan(banUntil) {
  while (true) {
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

restLimiter.schedule = function schedule(fn) {
  this.chain = this.chain.then(async () => {
    await sleep(cfg.restMinGapMs);
    return fn();
  });
  return this.chain;
};

async function getJson(pathName, params = {}, attempt = 0) {
  return restLimiter.schedule(async () => {
    const q = new URLSearchParams(params).toString();
    const url = `${REST_BASE}${pathName}${q ? `?${q}` : ""}`;
    const res = await fetch(url);
    const text = await res.text();

    if (res.status === 418 || res.status === 429) {
      const banUntil = parseBanUntil(text);
      if (banUntil && banUntil > Date.now()) {
        await waitForBan(banUntil);
        return getJson(pathName, params, attempt);
      }
      if (attempt < 5) {
        await sleep(cfg.restRetryMs * (attempt + 1));
        return getJson(pathName, params, attempt + 1);
      }
      throw new Error(`${pathName} ${res.status} ${text}`);
    }

    if (!res.ok) throw new Error(`${pathName} ${res.status} ${text}`);
    return JSON.parse(text);
  });
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

async function fetchKlinesInterval(symbol, interval, limit, onBatch) {
  let all = [];
  let endTime;
  let remaining = limit;
  const { ms: barMs } = (() => {
    const m = /^(\d+)([mhd])$/.exec(interval);
    if (!m) return { ms: 60_000 };
    const n = Number(m[1]);
    const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 24 * 60;
    return { ms: minutes * 60 * 1000 };
  })();

  while (remaining > 0) {
    const batch = Math.min(remaining, KLINE_MAX);
    const params = {
      symbol,
      interval,
      limit: String(batch),
    };
    if (endTime !== undefined) params.endTime = String(endTime);

    const rows = await getJson("/fapi/v1/klines", params);
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
  onBatch
) {
  if (startTime >= endTime) return [];
  const barMs = intervalBarMs(interval);
  let cursor = startTime;
  let merged = [];

  while (cursor < endTime) {
    const params = {
      symbol,
      interval,
      limit: String(KLINE_MAX),
      startTime: String(cursor),
      endTime: String(endTime),
    };
    const rows = await getJson("/fapi/v1/klines", params);
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
  onHeartbeat
) {
  const touch = () => onHeartbeat?.({ symbol, interval });
  const useSignalCache =
    interval === cfg.interval && signalKlineCache != null;
  const cache = useSignalCache ? signalKlineCache : klineCache;
  const cached = cache?.read(symbol) ?? [];
  let bars = [...cached];

  const slice = () => (bars.length > barCount ? bars.slice(-barCount) : bars);
  const barMs =
    interval === cfg.interval
      ? cfg.signalBarMs ?? cfg.barMs
      : intervalBarMs(interval);

  if (bars.length >= barCount) {
    return slice();
  }

  try {
    const fetched = await fetchKlinesInterval(symbol, interval, barCount, () =>
      touch()
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
          () => touch()
        );
        bars = mergeBarsByOpenTime(cached, gap, fetched);
      }
    }
    return slice();
  } catch (e) {
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

function applyLevelBreakSignal(
  sym,
  analysis,
  qv,
  levelBreakActive,
  levelBreakHistory,
  lastLevelBreak
) {
  const pass = Boolean(analysis?.passes);
  const metrics = analysis?.metrics;
  const prev = lastLevelBreak.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass && metrics) {
    const existing = levelBreakHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ??
        levelBreakActive.get(sym)?.triggeredAt ??
        Date.now());
    const row = {
      ...metrics,
      signalKind: "level_break",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    levelBreakActive.set(sym, row);
    levelBreakHistory.set(sym, row);
    if (!prev) {
      const detail = `level ${metrics.levelPrice} · ${metrics.levelTouches} touches · break ${metrics.close}`;
      dashboard?.pushEvent("NEW_LEVEL_BREAK", sym, detail);
      paperBot?.onLevelBreakSignal(sym, metrics);
    }
  } else if (prev) {
    markKindSignalEnded(sym, levelBreakActive, levelBreakHistory, "level_break", metrics);
    dashboard?.pushEvent("END_LEVEL_BREAK", sym);
  }

  lastLevelBreak.set(sym, pass);
}

function applyLevelBreakBearSignal(
  sym,
  analysis,
  qv,
  levelBreakBearActive,
  levelBreakBearHistory,
  lastLevelBreakBear
) {
  const pass = Boolean(analysis?.passes);
  const metrics = analysis?.metrics;
  const prev = lastLevelBreakBear.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass && metrics) {
    const existing = levelBreakBearHistory.get(sym);
    const triggeredAt = !prev
      ? Date.now()
      : (existing?.triggeredAt ??
        levelBreakBearActive.get(sym)?.triggeredAt ??
        Date.now());
    const row = {
      ...metrics,
      signalKind: "level_break_bear",
      signalStatus: "active",
      quoteVol24h: qvRounded,
      triggeredAt,
      ended: false,
    };
    levelBreakBearActive.set(sym, row);
    levelBreakBearHistory.set(sym, row);
    if (!prev) {
      const detail = `level ${metrics.levelPrice} · ${metrics.levelTouches} touches · break ${metrics.close}`;
      dashboard?.pushEvent("NEW_LEVEL_BREAK_BEAR", sym, detail);
      paperBot?.onLevelBreakBearSignal(sym, metrics);
    }
  } else if (prev) {
    markKindSignalEnded(
      sym,
      levelBreakBearActive,
      levelBreakBearHistory,
      "level_break_bear",
      metrics
    );
    dashboard?.pushEvent("END_LEVEL_BREAK_BEAR", sym);
  }

  lastLevelBreakBear.set(sym, pass);
}

function evaluateSymbolSignals(sym, signalBuffers, priceBuffers, qv, maps) {
  const {
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    levelBreakActive,
    levelBreakHistory,
    levelBreakBearActive,
    levelBreakBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastLevelBreak,
    lastLevelBreakBear,
  } = maps;
  const signalBars = evalSignalBars(sym, signalBuffers);
  const priceBars = evalBars(sym, priceBuffers);
  const fmOpts = fastMoverOptsFromCfg(cfg);
  const sfp = signalBars ? analyzeSweepReclaim(signalBars, cfg) : null;
  const sfpBear = signalBars ? analyzeSweepReject(signalBars, cfg) : null;
  const pb = signalBars
    ? fastMoverPullbackMetrics(signalBars, cfg, fmOpts, priceBars)
    : null;
  const levelBreak = signalBars ? analyzeLevelBreakUp(signalBars, cfg) : null;
  const levelBreakBear = signalBars ? analyzeLevelBreakDown(signalBars, cfg) : null;

  applySfpSignal(sym, sfp, qv, sfpActive, sfpHistory, lastSfp);
  applySfpBearSignal(sym, sfpBear, qv, sfpBearActive, sfpBearHistory, lastSfpBear);
  applyPullbackSignal(sym, pb, qv, pbActive, pbHistory, lastPb);
  applyLevelBreakSignal(
    sym,
    levelBreak,
    qv,
    levelBreakActive,
    levelBreakHistory,
    lastLevelBreak
  );
  applyLevelBreakBearSignal(
    sym,
    levelBreakBear,
    qv,
    levelBreakBearActive,
    levelBreakBearHistory,
    lastLevelBreakBear
  );

  return { sfp, sfpBear, pb, levelBreak, levelBreakBear };
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
    levelBreakActive,
    levelBreakHistory,
    levelBreakBearActive,
    levelBreakBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastLevelBreak,
    lastLevelBreakBear,
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
      if (lastLevelBreak.get(sym)) {
        markKindSignalEnded(sym, levelBreakActive, levelBreakHistory, "level_break", null);
      }
      if (lastLevelBreakBear.get(sym)) {
        markKindSignalEnded(
          sym,
          levelBreakBearActive,
          levelBreakBearHistory,
          "level_break_bear",
          null
        );
      }
      lastSfp.set(sym, false);
      lastSfpBear.set(sym, false);
      lastPb.set(sym, false);
      lastLevelBreak.set(sym, false);
      lastLevelBreakBear.set(sym, false);
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
    levelBreakActive,
    levelBreakHistory,
    levelBreakBearActive,
    levelBreakBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastLevelBreak,
    lastLevelBreakBear,
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
      if (lastLevelBreak.get(sym)) {
        markKindSignalEnded(sym, levelBreakActive, levelBreakHistory, "level_break", null);
      }
      if (lastLevelBreakBear.get(sym)) {
        markKindSignalEnded(
          sym,
          levelBreakBearActive,
          levelBreakBearHistory,
          "level_break_bear",
          null
        );
      }
      lastSfp.set(sym, false);
      lastSfpBear.set(sym, false);
      lastPb.set(sym, false);
      lastLevelBreak.set(sym, false);
      lastLevelBreakBear.set(sym, false);
      return;
    }

    const prevSfp = lastSfp.get(sym) ?? false;
    const prevSfpBear = lastSfpBear.get(sym) ?? false;
    const prevPb = lastPb.get(sym) ?? false;
    const prevLevelBreak = lastLevelBreak.get(sym) ?? false;
    const prevLevelBreakBear = lastLevelBreakBear.get(sym) ?? false;

    const { sfp, sfpBear, pb, levelBreak, levelBreakBear } = evaluateSymbolSignals(
      sym,
      signalBuffers,
      historyBuffers,
      qv,
      maps
    );

    const sfpPass = Boolean(sfp?.passes);
    const sfpBearPass = Boolean(sfpBear?.passes);
    const pbPass = Boolean(pb?.passes);
    const lbPass = Boolean(levelBreak?.passes);
    const lbBearPass = Boolean(levelBreakBear?.passes);
    if (
      sfpPass !== prevSfp ||
      sfpBearPass !== prevSfpBear ||
      pbPass !== prevPb ||
      lbPass !== prevLevelBreak ||
      lbBearPass !== prevLevelBreakBear
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
    levelBreakActive,
    levelBreakHistory,
    levelBreakBearActive,
    levelBreakBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastLevelBreak,
    lastLevelBreakBear,
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
      if (lastLevelBreak.get(sym)) {
        markKindSignalEnded(sym, levelBreakActive, levelBreakHistory, "level_break", null);
      }
      if (lastLevelBreakBear.get(sym)) {
        markKindSignalEnded(
          sym,
          levelBreakBearActive,
          levelBreakBearHistory,
          "level_break_bear",
          null
        );
      }
      lastSfp.set(sym, false);
      lastSfpBear.set(sym, false);
      lastPb.set(sym, false);
      lastLevelBreak.set(sym, false);
      lastLevelBreakBear.set(sym, false);
      return;
    }

    const prevSfp = lastSfp.get(sym) ?? false;
    const prevSfpBear = lastSfpBear.get(sym) ?? false;
    const prevPb = lastPb.get(sym) ?? false;
    const prevLevelBreak = lastLevelBreak.get(sym) ?? false;
    const prevLevelBreakBear = lastLevelBreakBear.get(sym) ?? false;

    const { sfp, sfpBear, pb, levelBreak, levelBreakBear } = evaluateSymbolSignals(
      sym,
      signalBuffers,
      historyBuffers,
      qv,
      maps
    );

    const sfpPass = Boolean(sfp?.passes);
    const sfpBearPass = Boolean(sfpBear?.passes);
    const pbPass = Boolean(pb?.passes);
    const lbPass = Boolean(levelBreak?.passes);
    const lbBearPass = Boolean(levelBreakBear?.passes);
    if (
      sfpPass !== prevSfp ||
      sfpBearPass !== prevSfpBear ||
      pbPass !== prevPb ||
      lbPass !== prevLevelBreak ||
      lbBearPass !== prevLevelBreakBear
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
  let fromCache = 0;
  let refreshed = 0;
  let fetched = 0;
  let failed = 0;
  const t0 = Date.now();
  let lastPrefetchUiPushAt = 0;
  const publishPrefetchStatus = (force = false) => {
    dashboard?.setMeta({
      prefetching: true,
      prefetchStatus: {
        done,
        total: symbols.length,
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

  await runConcurrent(symbols, cfg.prefetchCacheConcurrency * 2, (sym) => {
    const meta = klineCache.readMeta(sym);
    if (symbolCacheSufficientFromMeta(meta)) cacheSymbols.push(sym);
    else restSymbols.push(sym);
  });

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

  for (const sym of restSymbols) {
    try {
      const hadCache = Boolean(klineCache.readMeta(sym)?.barCount);
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

  if (afterPrefetch) await afterPrefetch(symbols);

  if (reevaluateAllFn) reevaluateAllFn();

  prefetching = false;
  dashboard?.setMeta({
    prefetching: false,
    prefetchStatus: {
      done,
      total: symbols.length,
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
    let fromCache = 0;
    let fetched = 0;
    let failed = 0;

    console.error(
      `Prefetch ${cfg.interval} for SFP/PB signals (${symbols.length} symbols, ≥${minBars} bars)…`
    );

    await runConcurrent(symbols, cfg.prefetchCacheConcurrency, async (sym) => {
      try {
        const meta = signalKlineCache.readMeta(sym);
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
  const levelBreakActive = new Map();
  const levelBreakHistory = new Map();
  const levelBreakBearActive = new Map();
  const levelBreakBearHistory = new Map();
  const lastSfp = new Map();
  const lastSfpBear = new Map();
  const lastPb = new Map();
  const lastLevelBreak = new Map();
  const lastLevelBreakBear = new Map();

  const signalMaps = () => ({
    sfpActive,
    sfpHistory,
    sfpBearActive,
    sfpBearHistory,
    pbActive,
    pbHistory,
    levelBreakActive,
    levelBreakHistory,
    levelBreakBearActive,
    levelBreakBearHistory,
    lastSfp,
    lastSfpBear,
    lastPb,
    lastLevelBreak,
    lastLevelBreakBear,
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
          levelBreakActive: levelBreakActive.size,
          levelBreakBearActive: levelBreakBearActive.size,
        },
        config: {
          sfpLookbackBars: cfg.sfpLookbackBars,
          sfpReclaimBars: cfg.sfpReclaimBars,
          sfpMinSweepPct: cfg.sfpMinSweepPct,
          pullbackMaBars: cfg.pullbackMaBars,
          pullbackTouchLookback: cfg.pullbackTouchLookback,
          pullbackMaxDistancePct: cfg.pullbackMaxDistancePct,
          pullbackMaxAboveMaPct: cfg.pullbackMaxAboveMaPct,
          levelBreakPivotBars: cfg.levelBreakPivotBars,
          levelBreakLookbackBars: cfg.levelBreakLookbackBars,
          levelBreakMinTouches: cfg.levelBreakMinTouches,
          levelBreakTouchPct: cfg.levelBreakTouchPct,
          levelBreakMinPct: cfg.levelBreakMinPct,
          levelBreakApproachPct: cfg.levelBreakApproachPct,
          levelBreakApproachBars: cfg.levelBreakApproachBars,
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
      telegram?.onNonSlTradeClose?.(botLabel, trade);
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

  ensureDefaultModelOnDisk();
  ensureSfpRegimeModelOnDisk();

  sfpRegimeMonitor = createSfpRegimeMonitor({
    getClosedTrades: () => paperBot?.getClosedTrades?.() ?? [],
  });

  paperBot = createPaperBot({
    onTradeClosed: captureTradeSnapshot,
    onDrawdownStop: handleDrawdownStop,
    resolveExtremalSpikeGate: resolveExtremalSpikeGateForSymbol,
    getRecentBars: (sym, limit) =>
      getRecentBarsForBot(sym, historyBuffers, limit),
    sfpRegimeMonitor,
    getBarsForSymbol: (sym) => getRecentBarsForBot(sym, historyBuffers, 120),
  });
  console.error(
    `Paper bot: simulated $${paperBot.getPublicState().config.initialDeposit} · ` +
      `${paperBot.getPublicState().config.enabled ? "enabled" : "disabled (enable in Paper bot tab)"}`
  );

  futuresTrader = createFuturesTrader({ kv });
  liveBot = createLiveBot({
    trader: futuresTrader,
    onTradeClosed: createTradeClosedHandler("Live bot"),
    onDrawdownStop: handleDrawdownStop,
    onExitOrdersFailed: (pos, detail) =>
      telegram?.onExitOrdersFailed?.(pos, detail),
    resolveExtremalSpikeGate: resolveExtremalSpikeGateForSymbol,
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

  const positionsHistory = createPositionsHistoryStore({ kv });
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
        getPositionsHistory: async (searchParams) =>
          positionsHistory.list(searchParams),
        updatePositionsHistoryComment: async (body) => {
          const row = positionsHistory.setComment(body?.id, body?.comment ?? "");
          return { ok: true, item: row };
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
        getEarlyExitModelStatus: () => getEarlyExitModelStatusFull(),
        trainEarlyExitModel: (body) => trainEarlyExitModelFromHistory(body),
        getSfpRegimeModelStatus: () => getSfpRegimeModelStatusFull(),
        getSfpRegimeMonitor: () => getSfpRegimeMonitorSnapshot(),
        trainSfpRegimeModel: (body) => trainSfpRegimeModelFromHistory(body),
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
        resetLiveBotHistory: () => liveBot.resetHistory(),
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
          backtestJob.cancelled = true;
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
          const heartbeatKlines = (sym) => {
            if (!backtestJob.running) return;
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
          const savedRestGap = cfg.restMinGapMs;
          cfg.restMinGapMs = Math.max(100, Math.floor(savedRestGap / 5));
          runPaperBotBacktest({
            symbols: symList,
            signalCfg: cfg,
            botConfig: paperBot.getPublicState().config,
            days,
            fetchKlinesForSymbol: (sym, limit) =>
              fetchKlinesForBacktest(sym, limit, cfg.interval, () =>
                heartbeatKlines(sym)
              ),
            fetchKlines1mForSymbol: (sym, limit) =>
              fetchKlinesForBacktest(sym, limit, "1m", () =>
                heartbeatKlines(sym)
              ),
            onProgress: (p) => {
              touchBacktestProgress(p);
            },
            restGapMs: Math.max(80, Math.floor(cfg.restMinGapMs / 2)),
            shouldAbort: () => backtestJob.cancelled,
            runMeta: {
              days,
              symbolMode: mode,
              symbolsRequested: requested,
              symbolsSelected: symList.length,
              symbolsUnknown: unknown,
            },
          })
            .then(({ result, barCache, chartCfg }) => {
              cfg.restMinGapMs = savedRestGap;
              if (backtestJob.cancelled) return;
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
              cfg.restMinGapMs = savedRestGap;
              if (backtestJob.cancelled || e.code === "BACKTEST_CANCELLED") {
                backtestJob.running = false;
                return;
              }
              backtestJob.running = false;
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
  const stopStaleRefresh = startStaleSymbolRefresh(
    symbols,
    historyBuffers,
    signalBuffers,
    signalMaps(),
    quoteVolMap
  );

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
