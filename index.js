/**
 * vol-spike-scanner — Binance USDT-M perpetuals
 *
 * node index.js --all
 * node index.js --all --no-prefetch
 * node index.js --symbols VICUSDT --prefetch
 * Dashboard: http://127.0.0.1:3877/  (--no-http to disable)
 *
 * Telegram (optional): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in `.env`
 *   --no-telegram  disable   --telegram-near  also alert NEAR setups
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const {
  applyBarConfig,
  volSpikeMetrics: computeVolSpikeMetrics,
  validateLiveConfigPatch,
  analyzeVolSpike,
  fastMoverMetrics,
  failedCheckLabels,
  serializeChecks,
  mergeCriteriaCatalog,
  pickLiveConfig,
  parseAtTime,
  barsAtTime,
} = require("./lib/signal-metrics");
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
const {
  mergeBarsByOpenTime,
  createKlineCacheStore,
} = require("./lib/kline-cache");

const REST_BASE = "https://fapi.binance.com";
// DO NOT CHANGE BASE wss://stream.binance.com:443
const WS_STREAM_BASE = "wss://stream.binance.com:443/stream";
const KLINE_MAX = 1500;
const CACHE_DIR = path.join(__dirname, ".cache");
const EXCHANGE_INFO_CACHE = path.join(CACHE_DIR, "futures-exchangeInfo.json");
const KLINES_CACHE_DIR = path.join(CACHE_DIR, "klines");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = {
  interval: "1m",
  corridorDays: 2,
  corridorExcludeMinutes: 15,
  prefetchDays: 3,
  signalCandles: 3,
  bullishLookbackCandles: 10,
  minBullishCandles: 3,
  nearBreakMaxGapPct: 0.1,
  maxCorridorWidthPct: 15,
  minRangeMultiplier: 1.8,
  minCorridorRangePct: 0.02,
  minBreakVolumeMultiplier: 2,
  breakVolumeNearBars: 3,
  fastMoveLookbackCandles: 10,
  minAvgMovePct: 0.5,
  fastMoveExcludeMult: 3,
  topMoveMinPct: 5,
  restMinGapMs: 450,
  restRetryMs: 8000,
  exchangeInfoCacheTtlMs: 24 * 60 * 60 * 1000,
  klineCacheExtraMs: 2 * 60 * 1000,
  // Disk history cap. Memory keeps only the live evaluation window.
  cacheMaxBars: 50_000,
  memoryMaxBars: 0,
  klineCacheFlushMs: 60_000,
  klineCacheWriteDebounceMs: 3000,
  prefetchPauseMs: 200,
  streamsPerSocket: 60,
  staleSymbolRefreshMs: 30_000,
  staleSymbolRefreshBatchSize: 30,
  staleSymbolRefreshAfterBars: 3,
  maxHitsToPrint: 40,
  quoteVolRefreshMs: 15 * 60 * 1000,
  minQuoteVolume24h: 0,
  printHitsMinIntervalMs: 2000,
  signalNotifyCooldownMs: 60 * 60 * 1000,
};

applyBarConfig(cfg);

const restLimiter = { chain: Promise.resolve() };
let lastHitsPrintAt = 0;
let prefetching = false;
let dashboard = null;
let telegram = null;
let klineCache = null;
const lastSignalNotifyAt = new Map();

function evalBars(sym, historyBuffers) {
  return klineCache.evalWindow(historyBuffers.get(sym) ?? [], cfg.limit);
}

function memoryMaxBars() {
  if (cfg.memoryMaxBars > 0) return cfg.memoryMaxBars;
  return Math.min(
    cfg.cacheMaxBars,
    Math.max(cfg.limit, cfg.fastMoveLookbackCandles ?? 0, 6000)
  );
}

function volSpikeMetrics(sym, historyBuffers) {
  return computeVolSpikeMetrics(evalBars(sym, historyBuffers), cfg);
}

function shouldNotifySignal(sym) {
  const now = Date.now();
  const last = lastSignalNotifyAt.get(sym) ?? 0;
  if (now - last < cfg.signalNotifyCooldownMs) return false;
  lastSignalNotifyAt.set(sym, now);
  return true;
}

function parseArgs(argv) {
  const flags = new Set();
  const kv = new Map();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) kv.set(k, v);
      else flags.add(k);
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
  fs.mkdirSync(CACHE_DIR, { recursive: true });
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
      interval: cfg.interval,
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
      interval: cfg.interval,
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
  klineCache.write(symbol, bars);
  return klineCache.capBars(bars, memoryMaxBars());
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

function upsertHistoryCandle(historyBuffers, sym, candle) {
  const buf = historyBuffers.get(sym) ?? [];
  const result = klineCache.upsertBar(buf, candle, memoryMaxBars());
  historyBuffers.set(sym, buf);
  if (result.updated) {
    const now = Date.now();
    liveUpdateAt.set(sym, now);
    wsStats.updates++;
    wsStats.lastUpdateAt = now;
    klineCache.schedulePersist(sym, buf);
  }
  return result;
}

function applyRestRepairBars(historyBuffers, sym, bars) {
  if (!bars?.length) return false;
  const existing = historyBuffers.get(sym) ?? [];
  const merged = klineCache.capBars(
    mergeBarsByOpenTime(existing, bars),
    memoryMaxBars()
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
  liveUpdateAt.set(sym, now);
  wsStats.restRepairs++;
  wsStats.lastRestRepairAt = now;
  wsStats.lastUpdateAt = now;
  klineCache.schedulePersist(sym, merged);
  return true;
}

function printHits(activeHits, nearBreakHits, force = false) {
  const now = Date.now();
  if (!force && now - lastHitsPrintAt < cfg.printHitsMinIntervalMs) return;
  lastHitsPrintAt = now;

  const rows = [
    ...[...activeHits.entries()].map(([symbol, m]) => ({
      symbol,
      status: "SIGNAL",
      ...m,
    })),
    ...[...nearBreakHits.entries()].map(([symbol, m]) => ({
      symbol,
      status: "NEAR",
      ...m,
    })),
  ]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "SIGNAL" ? -1 : 1;
      if (a.status === "NEAR") return a.breakGapPct - b.breakGapPct;
      return b.rangeRatio - a.rangeRatio;
    })
    .slice(0, cfg.maxHitsToPrint);

  if (dashboard) {
    dashboard.setMeta({ prefetching });
    dashboard.publish(activeHits, nearBreakHits, force);
  }

  console.clear();
  console.log(
    formatIsoUtcPlus3(Date.now()),
    `${cfg.interval}: ${cfg.signalCandles} vol↑ bars break ${cfg.corridorDays}d range high` +
      (prefetching ? " (prefetching…)" : "")
  );
  console.table(rows);
}

function applySymbolSignal(
  sym,
  m,
  qv,
  activeHits,
  nearBreakHits,
  lastPass,
  lastNearBreak
) {
  const pass = Boolean(m?.passes);
  const near = Boolean(m?.nearBreak);
  const prevPass = lastPass.get(sym) ?? false;
  const prevNear = lastNearBreak.get(sym) ?? false;
  const qvRounded = Math.round(qv);

  if (pass) {
    activeHits.set(sym, { ...m, signalStatus: "active", quoteVol24h: qvRounded });
    nearBreakHits.delete(sym);
    if (!prevPass) {
      const detail = `close ${m.close} > ${m.corridorHigh} range×${m.rangeRatio}`;
      dashboard?.pushEvent("NEW", sym, detail);
      console.log(`NEW SPIKE\t${sym}\t${detail}`);
      if (shouldNotifySignal(sym)) {
        telegram?.onNewSignal(sym, m, cfg);
      } else {
        console.log(`SKIP NOTIFY\t${sym}\tsignal cooldown`);
      }
    }
    if (prevNear) {
      dashboard?.pushEvent("END_NEAR", sym, "broke out");
      console.log(`NEAR END\t${sym}\tbreak`);
    }
  } else if (near) {
    nearBreakHits.set(sym, {
      ...m,
      signalStatus: "near",
      quoteVol24h: qvRounded,
    });
    activeHits.delete(sym);
    if (!prevNear) {
      const detail = `${m.breakGapPct}% below ${m.corridorHigh} range×${m.rangeRatio}`;
      dashboard?.pushEvent("NEAR", sym, detail);
      console.log(`NEAR BREAK\t${sym}\t${detail}`);
      telegram?.onNearSignal(sym, m, cfg);
    }
    if (prevPass) {
      dashboard?.pushEvent("END", sym);
      console.log(`ENDED\t${sym}`);
    }
  } else {
    if (prevPass) {
      activeHits.delete(sym);
      dashboard?.pushEvent("END", sym);
      console.log(`ENDED\t${sym}`);
    }
    if (prevNear) {
      nearBreakHits.delete(sym);
      dashboard?.pushEvent("END_NEAR", sym);
      console.log(`NEAR END\t${sym}`);
    }
  }

  lastPass.set(sym, pass);
  lastNearBreak.set(sym, near);
}

function reevaluateAllSymbols(
  symbols,
  historyBuffers,
  activeHits,
  nearBreakHits,
  lastPass,
  lastNearBreak,
  quoteVolMap
) {
  for (const sym of symbols) {
    const qv = quoteVolMap.get(sym) ?? 0;
    if (cfg.minQuoteVolume24h > 0 && qv < cfg.minQuoteVolume24h) {
      if (lastPass.get(sym)) activeHits.delete(sym);
      if (lastNearBreak.get(sym)) nearBreakHits.delete(sym);
      lastPass.set(sym, false);
      lastNearBreak.set(sym, false);
      continue;
    }

    const m = volSpikeMetrics(sym, historyBuffers);
    applySymbolSignal(
      sym,
      m,
      qv,
      activeHits,
      nearBreakHits,
      lastPass,
      lastNearBreak
    );
  }
  printHits(activeHits, nearBreakHits, true);
}

function createWsShards(
  symbols,
  historyBuffers,
  activeHits,
  nearBreakHits,
  lastPass,
  lastNearBreak,
  quoteVolMap
) {
  const streamSuffix = `@kline_${cfg.interval}`;
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
      if (lastPass.get(sym)) activeHits.delete(sym);
      if (lastNearBreak.get(sym)) nearBreakHits.delete(sym);
      lastPass.set(sym, false);
      lastNearBreak.set(sym, false);
      return;
    }

    const m = volSpikeMetrics(sym, historyBuffers);
    const prevPass = lastPass.get(sym) ?? false;
    const prevNear = lastNearBreak.get(sym) ?? false;

    applySymbolSignal(
      sym,
      m,
      qv,
      activeHits,
      nearBreakHits,
      lastPass,
      lastNearBreak
    );

    const pass = Boolean(m?.passes);
    const near = Boolean(m?.nearBreak);
    if (pass !== prevPass || near !== prevNear) {
      printHits(activeHits, nearBreakHits, true);
    }
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
        const change = upsertHistoryCandle(historyBuffers, sym, candle);
        if (change.updated) {
          shard.updates++;
          shard.lastUpdateAt = wsStats.lastUpdateAt;
        }

        if (isClosed && change.updated) evaluate(sym);
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

function startStaleSymbolRefresh(
  symbols,
  historyBuffers,
  activeHits,
  nearBreakHits,
  lastPass,
  lastNearBreak,
  quoteVolMap
) {
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
            const m = volSpikeMetrics(sym, historyBuffers);
            // Keep signal state in sync for symbols repaired through REST fallback.
            applySymbolSignal(
              sym,
              m,
              quoteVolMap.get(sym) ?? 0,
              activeHits,
              nearBreakHits,
              lastPass,
              lastNearBreak
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
  activeHits,
  nearBreakHits,
  lastPass,
  lastNearBreak,
  quoteVolMap
) {
  prefetching = true;
  dashboard?.setMeta({ prefetching: true });
  let done = 0;
  let fromCache = 0;
  let fetched = 0;
  let failed = 0;
  const t0 = Date.now();

  console.error(
    `Prefetch ALL ${symbols.length} symbols (${cfg.prefetchDays}d eval window ${cfg.limit} × ${cfg.interval}, ` +
      `cache up to ${cfg.cacheMaxBars} bars → ${KLINES_CACHE_DIR})…`
  );

  for (const sym of symbols) {
    try {
      const hadCache = Boolean(klineCache.read(sym)?.length);
      const bars = await loadSymbolHistory(sym);
      if (hadCache) fromCache++;
      else fetched++;

      historyBuffers.set(sym, bars);
      evaluateAfterPrefetch(
        sym,
        historyBuffers,
        activeHits,
        nearBreakHits,
        lastPass,
        lastNearBreak,
        quoteVolMap
      );
    } catch (e) {
      failed++;
      console.error(`Prefetch failed ${sym}: ${e.message}`);
      historyBuffers.set(sym, historyBuffers.get(sym) ?? []);
    }

    done++;
    if (done % 25 === 0 || done === symbols.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.error(
        `Prefetch ${done}/${symbols.length} | cache ${fromCache} | ` +
          `rest ${fetched} | fail ${failed} | ${elapsed}s`
      );
    }
    await sleep(cfg.prefetchPauseMs);
  }

  prefetching = false;
  dashboard?.setMeta({ prefetching: false });
  printHits(activeHits, nearBreakHits, true);
  console.error(
    `Prefetch done: ${fromCache} from cache, ${fetched} from REST, ${failed} failed`
  );
}

function evaluateAfterPrefetch(
  sym,
  historyBuffers,
  activeHits,
  nearBreakHits,
  lastPass,
  lastNearBreak,
  quoteVolMap
) {
  const m = volSpikeMetrics(sym, historyBuffers);
  if (!m) return;

  const prevPass = lastPass.get(sym) ?? false;
  const prevNear = lastNearBreak.get(sym) ?? false;
  if ((m.passes && prevPass) || (m.nearBreak && prevNear)) return;

  applySymbolSignal(
    sym,
    m,
    quoteVolMap.get(sym) ?? 0,
    activeHits,
    nearBreakHits,
    lastPass,
    lastNearBreak
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
    interval: cfg.interval,
    maxBars: cfg.cacheMaxBars,
    evalLimit: cfg.limit,
    flushMs: cfg.klineCacheFlushMs,
    debounceMs: cfg.klineCacheWriteDebounceMs,
  });

  const gapArg = kv.get("prefetch-gap-ms");
  if (gapArg) cfg.restMinGapMs = Math.max(200, Number(gapArg) || cfg.restMinGapMs);

  const wantPrefetch = !flags.has("no-prefetch");

  let quoteVolMap = new Map();
  const historyBuffers = new Map();
  const activeHits = new Map();
  const nearBreakHits = new Map();
  const lastPass = new Map();
  const lastNearBreak = new Map();

  let symbols = [];
  let reevaluateAll = () => {};

  function barsForEvaluation(sym, searchParams) {
    const atRaw = searchParams?.get("at");
    const buf = historyBuffers.get(sym) ?? [];
    if (!atRaw) {
      const bars = buf ?? [];
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
      throw new Error(`No candle data at or before ${formatIsoUtcPlus3(atMs)}`);
    }
    return { bars, atMs, signalBarAt: bars[bars.length - 1].closeTime };
  }

  const scannerApi = {
    getPairs(searchParams) {
      const q = (searchParams.get("q") || "").trim().toUpperCase();
      const filter = searchParams.get("filter") || "all";
      const criterion = searchParams.get("criterion") || "";
      const criterionPass = searchParams.get("criterionPass") || "any";
      let atMs = null;
      let sampleBarAt = null;
      const criteriaCatalog = new Map();

      let pairs = symbols.map((sym) => {
        const buf = historyBuffers.get(sym) ?? [];
        let evalBars;
        let signalBarAt = null;
        try {
          const ev = barsForEvaluation(sym, searchParams);
          evalBars = ev.bars;
          signalBarAt = ev.signalBarAt;
          if (ev.atMs != null) {
            atMs = ev.atMs;
            sampleBarAt = signalBarAt;
          }
        } catch {
          evalBars = [];
        }

        const analysis = analyzeVolSpike(
          klineCache.evalWindow(evalBars, cfg.limit),
          cfg
        );
        const m = analysis.metrics;
        const checks = serializeChecks(analysis.checks);
        mergeCriteriaCatalog(criteriaCatalog, checks);
        return {
          symbol: sym,
          passes: analysis.passes,
          nearBreak: Boolean(m?.nearBreak),
          bars: buf.length,
          signalBarAt:
            signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
          failReasons: failedCheckLabels(analysis.checks),
          checks,
          close: m?.close ?? null,
          corridorHigh: m?.corridorHigh ?? null,
          rangeRatio: m?.rangeRatio ?? null,
          corridorWidthPct: m?.corridorWidthPct ?? null,
        };
      });

      if (q) pairs = pairs.filter((p) => p.symbol.includes(q));
      if (filter === "pass") pairs = pairs.filter((p) => p.passes);
      if (filter === "fail") pairs = pairs.filter((p) => !p.passes);
      if (criterion) {
        pairs = pairs.filter((p) => {
          const ch = p.checks?.find((c) => c.id === criterion);
          if (!ch) return false;
          if (criterionPass === "pass") return ch.pass;
          if (criterionPass === "fail") return !ch.pass;
          return true;
        });
      }

      pairs.sort((a, b) => {
        if (a.passes !== b.passes) return a.passes ? -1 : 1;
        return (b.rangeRatio ?? 0) - (a.rangeRatio ?? 0);
      });

      return {
        updatedAt: formatIsoUtcPlus3(Date.now()),
        mode: atMs != null ? "historical" : "live",
        evaluateAt: atMs != null ? formatIsoUtcPlus3(atMs) : null,
        evaluateBarAt:
          sampleBarAt != null ? formatIsoUtcPlus3(sampleBarAt) : null,
        ...pickLiveConfig(cfg),
        pairCount: pairs.length,
        criteria: [...criteriaCatalog.values()].sort((a, b) =>
          a.label.localeCompare(b.label)
        ),
        pairs,
        telegramEnabled: Boolean(telegram?.enabled),
      };
    },
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
      const moverOpts = {
        fastMoveLookbackCandles: lookback,
        minAvgMovePct,
        fastMoveExcludeMult: excludeMult,
      };

      let movers = symbols
        .map((sym) => {
          const buf = historyBuffers.get(sym) ?? [];
          let evalBars;
          let signalBarAt = null;
          try {
            const ev = barsForEvaluation(sym, searchParams);
            evalBars = ev.bars;
            signalBarAt = ev.signalBarAt;
          } catch {
            return null;
          }

          const fm = fastMoverMetrics(evalBars, moverOpts);
          if (!fm?.fastMover) return null;

          return {
            symbol: sym,
            close: fm.close,
            avgMovePct: fm.avgMovePct,
            candlesUsed: fm.candlesUsed,
            candlesExcluded: fm.candlesExcluded,
            bars: buf.length,
            signalBarAt:
              signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
            liveUpdateAt:
              liveUpdateAt.get(sym) != null
                ? formatIsoUtcPlus3(liveUpdateAt.get(sym))
                : null,
          };
        })
        .filter(Boolean);

      if (q) movers = movers.filter((p) => p.symbol.includes(q));
      movers.sort((a, b) => b.avgMovePct - a.avgMovePct);

      return {
        updatedAt: formatIsoUtcPlus3(Date.now()),
        lookback,
        minAvgMovePct,
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
      const q = (searchParams.get("q") || "").trim().toUpperCase();
      const minMovePct = Math.max(
        0.1,
        Math.min(1000, Number(searchParams.get("minMovePct")) || cfg.topMoveMinPct)
      );
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      let movers = symbols
        .map((sym) => {
          const buf = historyBuffers.get(sym) ?? [];
          if (!buf.length) return null;

          const latest = buf[buf.length - 1];
          const cutoff = latest.closeTime - dayMs;
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

          return {
            symbol: sym,
            direction: movePct >= 0 ? "bullish" : "bearish",
            movePct: +movePct.toFixed(3),
            absMovePct: +Math.abs(movePct).toFixed(3),
            fromClose: base.close,
            close: latest.close,
            fromAt: formatIsoUtcPlus3(base.closeTime),
            lastBarAt: formatIsoUtcPlus3(latest.closeTime),
            liveUpdateAt:
              liveUpdateAt.get(sym) != null
                ? formatIsoUtcPlus3(liveUpdateAt.get(sym))
                : null,
            bars: buf.length,
          };
        })
        .filter(Boolean);

      if (q) movers = movers.filter((p) => p.symbol.includes(q));
      movers.sort((a, b) => b.absMovePct - a.absMovePct);

      return {
        updatedAt: formatIsoUtcPlus3(now),
        windowHours: 24,
        minMovePct,
        pairCount: movers.length,
        movers,
      };
    },
    getChartData(symbol, searchParams) {
      const sym = String(symbol).toUpperCase();
      if (!symbols.includes(sym)) {
        throw new Error(`Unknown symbol: ${sym}`);
      }
      const buf = historyBuffers.get(sym) ?? [];
      if (!buf.length) throw new Error(`No bar data for ${sym}`);
      const { bars, atMs, signalBarAt } = barsForEvaluation(sym, searchParams);
      const analysis = analyzeVolSpike(bars, cfg);
      return getChartPayload(sym, bars, cfg, analysis, {
        evaluateAt: atMs != null ? formatIsoUtcPlus3(atMs) : null,
        evaluateBarAt:
          signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
      });
    },
    async postTelegramSignal(symbol, searchParams) {
      if (!telegram?.enabled) {
        throw new Error(
          "Telegram not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)"
        );
      }
      const sym = String(symbol).toUpperCase();
      if (!symbols.includes(sym)) {
        throw new Error(`Unknown symbol: ${sym}`);
      }
      const buf = historyBuffers.get(sym) ?? [];
      if (!buf.length) throw new Error(`No bar data for ${sym}`);
      const { bars } = barsForEvaluation(sym, searchParams);
      const m = computeVolSpikeMetrics(
        klineCache.evalWindow(bars, cfg.limit),
        cfg
      );
      if (!m) {
        throw new Error(`Insufficient history to build signal message for ${sym}`);
      }
      await telegram.sendNewSignal(sym, m, cfg);
      return { ok: true, symbol: sym };
    },
  };

  dashboard = createDashboardPublisher(cfg, { configWritable: !flags.has("no-http") });
  dashboard.setMeta({ symbolCount: 0, prefetching: false });

  if (!flags.has("no-http")) {
    const { port, host } = resolveListenOptions({
      port: kv.has("port") ? Number(kv.get("port")) : undefined,
      host: kv.get("host"),
    });
    startDashboard(() => dashboard.buildState(activeHits, nearBreakHits), {
      port,
      host,
      getPairs: (searchParams) => scannerApi.getPairs(searchParams),
      getFastMovers: (searchParams) => scannerApi.getFastMovers(searchParams),
      getTopMovers: (searchParams) => scannerApi.getTopMovers(searchParams),
      getWsDiagnostics: () => wsDiagnostics(),
      getChartData: (symbol, searchParams) =>
        scannerApi.getChartData(symbol, searchParams),
      postTelegramSignal: (symbol, searchParams) =>
        scannerApi.postTelegramSignal(symbol, searchParams),
      onConfigUpdate: async (patch) => {
        const updates = validateLiveConfigPatch(patch);
        Object.assign(cfg, updates);
        applyBarConfig(cfg);
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
            .join(", ")} | bars needed: ${cfg.limit}`
        );
        reevaluateAll();
        return dashboard.buildState(activeHits, nearBreakHits);
      },
    });
    dashboard.publish(activeHits, nearBreakHits, true);
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

  reevaluateAll = () =>
    reevaluateAllSymbols(
      symbols,
      historyBuffers,
      activeHits,
      nearBreakHits,
      lastPass,
      lastNearBreak,
      quoteVolMap
    );

  console.error(
    `Symbols: ${symbols.length} | interval: ${cfg.interval} | ` +
      `eval window: ${cfg.limit} bars | cache max: ${cfg.cacheMaxBars} | ` +
      `live prefetch: ${wantPrefetch ? "yes" : "no"}`
  );

  klineCache.startPeriodicFlush(historyBuffers);

  console.error(`WebSocket live on fstream (${cfg.interval})…`);
  const sockets = createWsShards(
    symbols,
    historyBuffers,
    activeHits,
    nearBreakHits,
    lastPass,
    lastNearBreak,
    quoteVolMap
  );
  const stopStaleRefresh = startStaleSymbolRefresh(
    symbols,
    historyBuffers,
    activeHits,
    nearBreakHits,
    lastPass,
    lastNearBreak,
    quoteVolMap
  );

  if (wantPrefetch) {
    await prefetchAllSymbols(
      symbols,
      historyBuffers,
      activeHits,
      nearBreakHits,
      lastPass,
      lastNearBreak,
      quoteVolMap
    );
  } else {
    console.error("Skipping prefetch (--no-prefetch). History will build from WebSocket only.");
  }

  const shutdown = () => {
    console.error("Flushing kline cache…");
    stopStaleRefresh();
    klineCache.flushAll(historyBuffers);
    klineCache.stop();
    sockets.forEach((s) => s.close());
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
