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
  fastMoverPullbackMetrics,
  analyzePullback,
  fastMoverOptsFromCfg,
  fastMoverLookbackFor1m,
  sfpRangeBars,
} = require("./lib/signal-metrics");
const {
  evaluateHtfContraindications,
  mergeHtfConfig,
} = require("./lib/htf-contraindication");
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
const { createLiveBot } = require("./lib/live-bot");
const { formatDrawdownTelegramMessage } = require("./lib/bot-drawdown-guard");
const { createFuturesTrader } = require("./lib/binance-futures-trade");
const { startPaperBotMorningReports } = require("./lib/paper-bot-report");
const {
  saveTradeSnapshot,
  saveOpenPositionSnapshot,
  cleanOldSnapshots,
} = require("./lib/paper-bot-snapshot");
const {
  runPaperBotBacktest,
  runBacktestSnapshotJob,
  loadLastBacktestResult,
  resetBacktestData,
  resolveBacktestSymbols,
  DEFAULT_DAYS,
  RESULT_FILE,
} = require("./lib/paper-bot-backtest");
const {
  mergeBarsByOpenTime,
  createKlineCacheStore,
} = require("./lib/kline-cache");
const {
  createPositionsProvider,
  createFuturesBalanceProvider,
  resolveBinanceCredentials,
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
  maxHitsToPrint: 40,
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
let telegram = null;
let paperBot = null;
let liveBot = null;
let stopPaperBotReport = () => {};
const BACKTEST_STALE_MS = 12 * 60 * 1000;

let backtestJob = {
  running: false,
  cancelled: false,
  progress: null,
  result: null,
  error: null,
  startedAt: null,
  lastProgressAt: null,
};

let backtestSnapshotJob = {
  running: false,
  cancelled: false,
  progress: null,
  error: null,
  lastProgressAt: null,
};

function freshBacktestSnapshotJobState() {
  return {
    running: false,
    cancelled: false,
    progress: null,
    error: null,
    lastProgressAt: null,
  };
}

function touchBacktestSnapshotProgress(p) {
  backtestSnapshotJob.progress = p;
  backtestSnapshotJob.lastProgressAt = Date.now();
}

function cancelBacktestSnapshotJob() {
  backtestSnapshotJob.cancelled = true;
  backtestSnapshotJob.running = false;
  backtestSnapshotJob.progress = null;
  backtestSnapshotJob.error = null;
  backtestSnapshotJob.lastProgressAt = null;
}

function startBacktestSnapshotJob(snapshotWork) {
  if (!snapshotWork?.trades?.length) return;

  cancelBacktestSnapshotJob();
  backtestSnapshotJob.running = true;
  backtestSnapshotJob.cancelled = false;
  backtestSnapshotJob.error = null;
  touchBacktestSnapshotProgress({
    phase: "snapshots",
    done: 0,
    total: snapshotWork.trades.length,
    ok: 0,
    failed: 0,
    message: `Queued ${snapshotWork.trades.length} trade previews…`,
  });

  let snapshotSaveTimer = null;

  const queueSnapshotSave = () => {
    clearTimeout(snapshotSaveTimer);
    snapshotSaveTimer = setTimeout(() => {
      if (backtestJob.result) writeJsonFile(RESULT_FILE(), backtestJob.result);
    }, 1500);
  };

  const flushSnapshotSave = () => {
    clearTimeout(snapshotSaveTimer);
    if (backtestJob.result) writeJsonFile(RESULT_FILE(), backtestJob.result);
  };

  runBacktestSnapshotJob({
    ...snapshotWork,
    shouldAbort: () => backtestSnapshotJob.cancelled || backtestJob.cancelled,
    onProgress: (p) => touchBacktestSnapshotProgress(p),
    onTradeSnapshot: (trade, snapshotId) => {
      if (backtestJob.result?.closedTrades) {
        const row = backtestJob.result.closedTrades.find((t) => t.id === trade.id);
        if (row) row.snapshotId = snapshotId;
      }
      queueSnapshotSave();
    },
  })
    .then((stats) => {
      if (backtestSnapshotJob.cancelled || backtestJob.cancelled) return;
      backtestSnapshotJob.running = false;
      flushSnapshotSave();
      if (backtestJob.result) {
        backtestJob.result.snapshotsPending = false;
        backtestJob.result.snapshotsGeneratedAt = formatIsoUtcPlus3(Date.now());
        backtestJob.result.snapshotStats = stats;
        writeJsonFile(RESULT_FILE(), backtestJob.result);
      }
      touchBacktestSnapshotProgress({
        phase: "snapshots_done",
        done: stats.ok + stats.failed,
        total: stats.ok + stats.failed,
        ok: stats.ok,
        failed: stats.failed,
        message: `Previews ready · ${stats.ok} ok · ${stats.failed} skipped`,
      });
      console.error(
        `Backtest previews done: ${stats.ok} ok · ${stats.failed} skipped`
      );
    })
    .catch((e) => {
      if (backtestSnapshotJob.cancelled || backtestJob.cancelled) {
        backtestSnapshotJob.running = false;
        return;
      }
      backtestSnapshotJob.running = false;
      backtestSnapshotJob.error = e.message || String(e);
      console.error(`Backtest previews failed: ${backtestSnapshotJob.error}`);
    });
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
}

function reconcileBacktestJob() {
  if (!backtestJob.running || !backtestJob.lastProgressAt) return;
  const idle = Date.now() - backtestJob.lastProgressAt;
  if (idle <= BACKTEST_STALE_MS) return;
  backtestJob.running = false;
  const mins = Math.round(idle / 60_000);
  backtestJob.error =
    backtestJob.error ||
    `Backtest stalled (no progress for ${mins} min). Use a symbol list, reduce pairs, or wait for rate-limit cooldown and retry.`;
  console.error(backtestJob.error);
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

function getPaperBotBar(sym, historyBuffers) {
  const bars = primaryBarSource(sym, historyBuffers);
  let b = bars?.[bars.length - 1];
  if (!b && klineCache) {
    const cached = klineCache.read(sym);
    b = cached?.[cached.length - 1];
  }
  if (!b) return null;
  return {
    close: +b.close,
    low: +(b.low ?? b.close),
    high: +(b.high ?? b.close),
  };
}

function refreshAllPaperBotPrices(historyBuffers, klineSymbol = null) {
  const getBar = (s) => getPaperBotBar(s, historyBuffers);
  paperBot?.updatePrices(getBar);
  if (liveBot?.hasOpenPositions?.()) {
    if (!klineSymbol || liveBot.hasOpenSymbol?.(klineSymbol)) {
      void liveBot.updatePrices(getBar, klineSymbol || null);
    }
  }
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
  await sleep(waitMs + 500);
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

async function fetchKlinesInterval(symbol, interval, limit) {
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
  endTime
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
async function fetchKlinesForBacktest(symbol, barCount, interval = cfg.interval) {
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
    const fetched = await fetchKlinesInterval(symbol, interval, barCount);
    bars = mergeBarsByOpenTime(bars, fetched);

    if (cached.length && fetched.length) {
      const lastCached = cached[cached.length - 1];
      const firstFetched = fetched[0];
      if (lastCached.closeTime + barMs < firstFetched.openTime) {
        const gap = await fetchKlinesGapForInterval(
          symbol,
          interval,
          lastCached.closeTime + 1,
          firstFetched.openTime - 1
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
    pbActive = new Map(),
    pbHistory = new Map(),
  } = maps;
  const now = Date.now();
  if (!force && now - lastHitsPrintAt < cfg.printHitsMinIntervalMs) return;
  lastHitsPrintAt = now;

  pruneSignalHistory(sfpHistory);
  pruneSignalHistory(pbHistory);

  const rows = [
    ...[...sfpHistory.entries()].map(([symbol, m]) => ({
      symbol,
      status: m.ended ? "ENDED" : "SFP",
      triggeredAt: formatIsoUtcPlus3(m.triggeredAt),
      signalKind: "sfp",
      ...m,
    })),
    ...[...pbHistory.entries()].map(([symbol, m]) => ({
      symbol,
      status: m.ended ? "ENDED" : "PULLBACK",
      triggeredAt: formatIsoUtcPlus3(m.triggeredAt),
      signalKind: "pullback",
      ...m,
    })),
  ]
    .sort((a, b) => {
      const at = a.triggeredAt ? Date.parse(a.triggeredAt) : 0;
      const bt = b.triggeredAt ? Date.parse(b.triggeredAt) : 0;
      return bt - at;
    })
    .slice(0, cfg.maxHitsToPrint);

  if (dashboard) {
    dashboard.setMeta({ prefetching });
    dashboard.publish(sfpActive, sfpHistory, pbActive, pbHistory, force);
  }

  console.clear();
  console.log(
    formatIsoUtcPlus3(Date.now()),
    `${cfg.interval}: SFP + pullback scanner` +
      (prefetching ? " (prefetching…)" : "")
  );
  console.table(rows);
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
      console.log(`NEW SFP\t${sym}\t${detail}`);
      paperBot?.onSfpSignal(sym, metrics);
      liveBot?.onSfpSignal(sym, metrics);
    }
  } else if (prev) {
    markKindSignalEnded(sym, sfpActive, sfpHistory, "sfp", metrics);
    dashboard?.pushEvent("END_SFP", sym);
    console.log(`SFP END\t${sym}`);
  }

  lastSfp.set(sym, pass);
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
      console.log(`NEW PULLBACK\t${sym}\t${detail}`);
      paperBot?.onPullbackSignal(sym, pb);
      liveBot?.onPullbackSignal(sym, pb);
    }
  } else if (prev) {
    markKindSignalEnded(sym, pbActive, pbHistory, "pullback", pb);
    dashboard?.pushEvent("END_PB", sym);
    console.log(`PULLBACK END\t${sym}`);
  }

  lastPb.set(sym, pass);
}

function evaluateSymbolSignals(
  sym,
  signalBuffers,
  priceBuffers,
  qv,
  sfpActive,
  sfpHistory,
  pbActive,
  pbHistory,
  lastSfp,
  lastPb
) {
  const signalBars = evalSignalBars(sym, signalBuffers);
  const priceBars = evalBars(sym, priceBuffers);
  const fmOpts = fastMoverOptsFromCfg(cfg);
  const sfp = signalBars ? analyzeSweepReclaim(signalBars, cfg) : null;
  const pb = signalBars
    ? fastMoverPullbackMetrics(signalBars, cfg, fmOpts, priceBars)
    : null;

  applySfpSignal(sym, sfp, qv, sfpActive, sfpHistory, lastSfp);
  applyPullbackSignal(sym, pb, qv, pbActive, pbHistory, lastPb);

  return { sfp, pb };
}

function reevaluateAllSymbols(
  symbols,
  historyBuffers,
  signalBuffers,
  maps,
  quoteVolMap
) {
  const { sfpActive, sfpHistory, pbActive, pbHistory, lastSfp, lastPb } = maps;

  for (const sym of symbols) {
    const qv = quoteVolMap.get(sym) ?? 0;
    if (cfg.minQuoteVolume24h > 0 && qv < cfg.minQuoteVolume24h) {
      if (lastSfp.get(sym)) {
        markKindSignalEnded(sym, sfpActive, sfpHistory, "sfp", null);
      }
      if (lastPb.get(sym)) {
        markKindSignalEnded(sym, pbActive, pbHistory, "pullback", null);
      }
      lastSfp.set(sym, false);
      lastPb.set(sym, false);
      continue;
    }

    evaluateSymbolSignals(
      sym,
      signalBuffers,
      historyBuffers,
      qv,
      sfpActive,
      sfpHistory,
      pbActive,
      pbHistory,
      lastSfp,
      lastPb
    );
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
  const { sfpActive, sfpHistory, pbActive, pbHistory, lastSfp, lastPb } = maps;
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
      if (lastPb.get(sym)) {
        markKindSignalEnded(sym, pbActive, pbHistory, "pullback", null);
      }
      lastSfp.set(sym, false);
      lastPb.set(sym, false);
      return;
    }

    const prevSfp = lastSfp.get(sym) ?? false;
    const prevPb = lastPb.get(sym) ?? false;

    const { sfp, pb } = evaluateSymbolSignals(
      sym,
      signalBuffers,
      historyBuffers,
      qv,
      sfpActive,
      sfpHistory,
      pbActive,
      pbHistory,
      lastSfp,
      lastPb
    );

    const sfpPass = Boolean(sfp?.passes);
    const pbPass = Boolean(pb?.passes);
    if (sfpPass !== prevSfp || pbPass !== prevPb) {
      printHits(maps, true);
    }
    refreshAllPaperBotPrices(historyBuffers, sym);
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

        refreshAllPaperBotPrices(historyBuffers, sym);
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
  const { sfpActive, sfpHistory, pbActive, pbHistory, lastSfp, lastPb } = maps;
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
      if (lastPb.get(sym)) {
        markKindSignalEnded(sym, pbActive, pbHistory, "pullback", null);
      }
      lastSfp.set(sym, false);
      lastPb.set(sym, false);
      return;
    }

    const prevSfp = lastSfp.get(sym) ?? false;
    const prevPb = lastPb.get(sym) ?? false;

    const { sfp, pb } = evaluateSymbolSignals(
      sym,
      signalBuffers,
      historyBuffers,
      qv,
      sfpActive,
      sfpHistory,
      pbActive,
      pbHistory,
      lastSfp,
      lastPb
    );

    const sfpPass = Boolean(sfp?.passes);
    const pbPass = Boolean(pb?.passes);
    if (sfpPass !== prevSfp || pbPass !== prevPb) {
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
  const { sfpActive, sfpHistory, pbActive, pbHistory, lastSfp, lastPb } = maps;
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
              sfpActive,
              sfpHistory,
              pbActive,
              pbHistory,
              lastSfp,
              lastPb
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
  const publishPrefetchStatus = () => {
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
  };
  publishPrefetchStatus();

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
  const pbActive = new Map();
  const pbHistory = new Map();
  const lastSfp = new Map();
  const lastPb = new Map();

  const signalMaps = () => ({
    sfpActive,
    sfpHistory,
    pbActive,
    pbHistory,
    lastSfp,
    lastPb,
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

  dashboard = createDashboardPublisher(cfg, { configWritable: !flags.has("no-http") });
  dashboard.setMeta({ symbolCount: 0, prefetching: false });

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
    if (!telegram?.enabled) return;
    const label = payload.bot === "live" ? "Live bot" : "Paper bot";
    return telegram.sendText(formatDrawdownTelegramMessage(label, payload));
  }

  const htf15mCache = new Map();

  async function fetchHtf15mBars(symbol) {
    const botCfg = paperBot?.getPublicState()?.config ?? {};
    const barCount = Math.max(120, (botCfg.htfMaBars ?? 20) + 100);
    const cached = htf15mCache.get(symbol);
    if (
      cached &&
      Date.now() - cached.fetchedAt < 5 * 60_000 &&
      cached.bars?.length >= 40
    ) {
      return cached.bars;
    }
    const bars = await fetchKlinesInterval(symbol, "15m", barCount);
    htf15mCache.set(symbol, { bars, fetchedAt: Date.now() });
    return bars;
  }

  async function resolveExtremalSpikeGateForSymbol(symbol, atMs, botCfg = {}) {
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
    return evaluateExtremalSpikeGate(bars, { ...cfg, ...botCfg }, atMs);
  }

  const resolveHtfForBot = async (symbol, _signalKind, atMs, botCfg = {}) => {
    if (!botCfg?.htfContraindicationEnabled) {
      return { enabled: false, pass: true };
    }
    try {
      const bars = await fetchHtf15mBars(symbol);
      return evaluateHtfContraindications(
        barsAtTime(bars, atMs),
        mergeHtfConfig({ ...cfg, ...botCfg }),
        atMs
      );
    } catch (e) {
      return {
        enabled: true,
        pass: false,
        label: "error",
        detail: e.message || String(e),
        blocks: [],
      };
    }
  };

  paperBot = createPaperBot({
    onTradeClosed: createTradeClosedHandler("Paper bot"),
    onDrawdownStop: handleDrawdownStop,
    resolveHtfContraindication: resolveHtfForBot,
    resolveExtremalSpikeGate: resolveExtremalSpikeGateForSymbol,
  });
  console.error(
    `Paper bot: simulated $${paperBot.getPublicState().config.initialDeposit} · ` +
      `${paperBot.getPublicState().config.enabled ? "enabled" : "disabled (enable in Paper bot tab)"}`
  );

  const futuresTrader = createFuturesTrader({ kv });
  liveBot = createLiveBot({
    trader: futuresTrader,
    onTradeClosed: createTradeClosedHandler("Live bot"),
    onDrawdownStop: handleDrawdownStop,
    resolveHtfContraindication: resolveHtfForBot,
    resolveExtremalSpikeGate: resolveExtremalSpikeGateForSymbol,
  });
  void liveBot.getPublicState().then((st) => {
    console.error(
      `Live bot: ${futuresTrader.enabled ? "API keys ok" : "no API keys"} · ` +
        `${st.config.armed ? "ARMED" : "disarmed"} · ` +
        `${st.config.enabled ? "enabled" : "disabled"} · ` +
        `${st.config.leverage}x isolated`
    );
  });

  const auth = createTelegramAuth({ kv, flags });
  const getOpenPositions = createPositionsProvider({ kv });
  const getFuturesBalance = createFuturesBalanceProvider({ kv });
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
    startDashboard(
      () =>
        dashboard.buildState(sfpActive, sfpHistory, pbActive, pbHistory),
      {
        port,
        host,
        getFastMovers: (searchParams) => scannerApi.getFastMovers(searchParams),
        getSweepReclaim: (searchParams) => scannerApi.getSweepReclaim(searchParams),
        getPullback: (searchParams) => scannerApi.getPullback(searchParams),
        getStrategies: () => scannerApi.getStrategies(),
        getTopMovers: (searchParams) => scannerApi.getTopMovers(searchParams),
        getChartData: (symbol, searchParams) =>
          scannerApi.getChartData(symbol, searchParams),
        getPositions: getOpenPositions,
        getFuturesBalance,
        getPositionsHistory: async (searchParams) =>
          positionsHistory.list(searchParams),
        updatePositionsHistoryComment: async (body) => {
          const row = positionsHistory.setComment(body?.id, body?.comment ?? "");
          return { ok: true, item: row };
        },
        getPaperBot: () => {
          refreshAllPaperBotPrices(historyBuffers);
          return paperBot.getPublicState();
        },
        patchPaperBotConfig: (patch) => {
          paperBot.patchConfig(patch);
          refreshAllPaperBotPrices(historyBuffers);
          return paperBot.getPublicState();
        },
        resetPaperBot: () => {
          paperBot.reset();
          return paperBot.getPublicState();
        },
        getLiveBot: () => {
          refreshAllPaperBotPrices(historyBuffers);
          return liveBot.getPublicState();
        },
        patchLiveBotConfig: async (patch) => {
          const result = await liveBot.patchConfig(patch);
          refreshAllPaperBotPrices(historyBuffers);
          return result;
        },
        armLiveBot: () => liveBot.arm(),
        disarmLiveBot: () => liveBot.disarm(),
        closeLiveBotSymbol: (symbol) => liveBot.closeSymbol(symbol),
        closeAllLiveBot: () => liveBot.closeAll(),
        syncLiveBot: () => liveBot.syncFromExchange(),
        resetLiveBotHistory: () => liveBot.resetHistory(),
        generatePaperBotOpenSnapshot,
        generateLiveBotOpenSnapshot,
        getBacktestStatus: () => {
          reconcileBacktestJob();
          return {
            running: backtestJob.running,
            progress: backtestJob.progress,
            result: backtestJob.result,
            error: backtestJob.error,
            last: loadLastBacktestResult(),
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
          if (backtestSnapshotJob.running) {
            cancelBacktestSnapshotJob();
          }
          const days = Math.max(
            1,
            Math.min(14, Number(body?.days) || DEFAULT_DAYS)
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
          backtestJob.progress = {
            phase: "starting",
            done: 0,
            total: symList.length,
            ok: 0,
            skip: 0,
            message: `Starting ${symList.length} symbols × ${days}d…`,
          };
          runPaperBotBacktest({
            symbols: symList,
            signalCfg: cfg,
            botConfig: paperBot.getPublicState().config,
            days,
            fetchKlinesForSymbol: (sym, limit) =>
              fetchKlinesForBacktest(sym, limit),
            fetchKlines1mForSymbol: (sym, limit) =>
              fetchKlinesForBacktest(sym, limit, "1m"),
            fetchHtfBars: (sym, limit) => fetchKlinesInterval(sym, "15m", limit),
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
            .then(({ result, snapshotWork }) => {
              if (backtestJob.cancelled) return;
              backtestJob.running = false;
              backtestJob.result = result;
              touchBacktestProgress({
                phase: "done",
                done: symList.length,
                total: symList.length,
                ok: result.symbolsProcessed ?? symList.length,
                skip: result.symbolsSkipped ?? 0,
                message: snapshotWork
                  ? "Simulation complete — generating previews in background"
                  : "Complete",
              });
              console.error(
                `Paper bot backtest done: ${result.summary.closedCount} trades · PnL ${result.summary.totalPnl}`
              );
              if (snapshotWork) startBacktestSnapshotJob(snapshotWork);
            })
            .catch((e) => {
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
          return dashboard.buildState(sfpActive, sfpHistory, pbActive, pbHistory);
        },
        onStorageClean: () => {
          htf15mCache.clear();
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
    dashboard.publish(sfpActive, sfpHistory, pbActive, pbHistory, true);
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
      refreshAllPaperBotPrices(historyBuffers);
    }
  }, 15_000);

  if (telegram.enabled && tgConfig.paperBotReport !== false) {
    stopPaperBotReport = startPaperBotMorningReports({
      enabled: true,
      hour: tgConfig.paperBotReportHour,
      minute: tgConfig.paperBotReportMinute,
      getReportState: () => {
        refreshAllPaperBotPrices(historyBuffers);
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
