/**
 * vol-spike-scanner — Binance USDT-M perpetuals
 *
 * node index.js --all
 * node index.js --all --no-prefetch
 * node index.js --symbols VICUSDT --prefetch
 * Dashboard: http://127.0.0.1:3877/  (--no-http to disable)
 */

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const {
  applyBarConfig,
  volSpikeMetrics: computeVolSpikeMetrics,
  validateLiveConfigPatch,
  analyzeVolSpike,
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

const REST_BASE = "https://fapi.binance.com";
const WS_STREAM_BASE = "wss://fstream.binance.com/stream";
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
  restMinGapMs: 450,
  restRetryMs: 8000,
  exchangeInfoCacheTtlMs: 24 * 60 * 60 * 1000,
  klineCacheExtraMs: 2 * 60 * 1000,
  prefetchPauseMs: 200,
  streamsPerSocket: 180,
  maxHitsToPrint: 40,
  quoteVolRefreshMs: 15 * 60 * 1000,
  minQuoteVolume24h: 0,
  printHitsMinIntervalMs: 2000,
};

applyBarConfig(cfg);

const restLimiter = { chain: Promise.resolve() };
let lastHitsPrintAt = 0;
let prefetching = false;
let dashboard = null;

function volSpikeMetrics(ohlc) {
  return computeVolSpikeMetrics(ohlc, cfg);
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

function klineCacheFile(symbol) {
  return path.join(KLINES_CACHE_DIR, `${symbol}_${cfg.interval}_${cfg.limit}.json`);
}

function readKlineCache(symbol) {
  try {
    const raw = fs.readFileSync(klineCacheFile(symbol), "utf8");
    const data = JSON.parse(raw);
    if (data.interval !== cfg.interval || data.limit !== cfg.limit) return null;
    if (!data.bars?.length) return null;

    const last = data.bars[data.bars.length - 1];
    const age = Date.now() - last.closeTime;
    if (age > cfg.barMs + cfg.klineCacheExtraMs) return null;

    return data.bars;
  } catch {
    return null;
  }
}

function writeKlineCache(symbol, bars) {
  fs.mkdirSync(KLINES_CACHE_DIR, { recursive: true });
  fs.writeFileSync(
    klineCacheFile(symbol),
    JSON.stringify({
      savedAt: Date.now(),
      interval: cfg.interval,
      limit: cfg.limit,
      bars,
    })
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

async function loadSymbolHistory(symbol) {
  const cached = readKlineCache(symbol);
  if (cached) return cached;

  const bars = await fetchKlines(symbol);
  writeKlineCache(symbol, bars);
  return bars;
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

function upsertCandle(buf, candle) {
  const last = buf[buf.length - 1];
  if (last && last.openTime === candle.openTime) {
    buf[buf.length - 1] = candle;
    return false;
  }
  if (last && candle.openTime < last.openTime) return false;
  buf.push(candle);
  if (buf.length > cfg.limit) buf.splice(0, buf.length - cfg.limit);
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
  buffers,
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

    const buf = buffers.get(sym) ?? [];
    const m = volSpikeMetrics(buf);
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
  buffers,
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

    const buf = buffers.get(sym) ?? [];
    const m = volSpikeMetrics(buf);
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
    let ws;
    let closed = false;
    let reconnectMs = 1000;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url);

      ws.on("open", () => {
        reconnectMs = 1000;
        console.error(`WS shard ${batchIdx} connected (${batches[batchIdx].length} streams)`);
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

        const sym = data.s;
        const candle = closedCandleFromKline(data.k);
        const buf = buffers.get(sym) ?? [];
        const isClosed = Boolean(data.k?.x);
        const appended = upsertCandle(buf, candle);
        buffers.set(sym, buf);

        if (isClosed && appended) evaluate(sym);
      });

      ws.on("close", async () => {
        if (closed) return;
        await sleep(reconnectMs);
        reconnectMs = Math.min(reconnectMs * 2, 60_000);
        connect();
      });

      ws.on("error", () => {
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

async function prefetchAllSymbols(
  symbols,
  buffers,
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
    `Prefetch ALL ${symbols.length} symbols (${cfg.prefetchDays}d, ${cfg.limit} × ${cfg.interval}, ` +
      `cache: ${KLINES_CACHE_DIR})…`
  );

  for (const sym of symbols) {
    try {
      const cached = readKlineCache(sym);
      const bars = cached ?? (await loadSymbolHistory(sym));
      if (cached) fromCache++;
      else fetched++;

      buffers.set(sym, bars);
      evaluateAfterPrefetch(
        sym,
        buffers,
        activeHits,
        nearBreakHits,
        lastPass,
        lastNearBreak,
        quoteVolMap
      );
    } catch (e) {
      failed++;
      console.error(`Prefetch failed ${sym}: ${e.message}`);
      buffers.set(sym, buffers.get(sym) ?? []);
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
  buffers,
  activeHits,
  nearBreakHits,
  lastPass,
  lastNearBreak,
  quoteVolMap
) {
  const m = volSpikeMetrics(buffers.get(sym) ?? []);
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

  const gapArg = kv.get("prefetch-gap-ms");
  if (gapArg) cfg.restMinGapMs = Math.max(200, Number(gapArg) || cfg.restMinGapMs);

  const wantPrefetch = !flags.has("no-prefetch");

  let quoteVolMap = new Map();
  const buffers = new Map();
  const activeHits = new Map();
  const nearBreakHits = new Map();
  const lastPass = new Map();
  const lastNearBreak = new Map();

  let symbols = [];
  let reevaluateAll = () => {};

  function barsForEvaluation(buf, searchParams) {
    const atRaw = searchParams?.get("at");
    if (!atRaw) {
      const bars = buf ?? [];
      const signalBarAt = bars.length ? bars[bars.length - 1].closeTime : null;
      return { bars, atMs: null, signalBarAt };
    }
    const atMs = parseAtTime(atRaw);
    const bars = barsAtTime(buf, atMs);
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
        const buf = buffers.get(sym) ?? [];
        let evalBars;
        let signalBarAt = null;
        try {
          const ev = barsForEvaluation(buf, searchParams);
          evalBars = ev.bars;
          signalBarAt = ev.signalBarAt;
          if (ev.atMs != null) {
            atMs = ev.atMs;
            sampleBarAt = signalBarAt;
          }
        } catch {
          evalBars = [];
        }

        const analysis = analyzeVolSpike(evalBars, cfg);
        const m = analysis.metrics;
        const checks = serializeChecks(analysis.checks);
        mergeCriteriaCatalog(criteriaCatalog, checks);
        return {
          symbol: sym,
          passes: analysis.passes,
          nearBreak: Boolean(m?.nearBreak),
          bars: evalBars.length,
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
      };
    },
    getChartData(symbol, searchParams) {
      const sym = String(symbol).toUpperCase();
      if (!symbols.includes(sym)) {
        throw new Error(`Unknown symbol: ${sym}`);
      }
      const buf = buffers.get(sym) ?? [];
      if (!buf.length) throw new Error(`No bar data for ${sym}`);
      const { bars, atMs, signalBarAt } = barsForEvaluation(buf, searchParams);
      const analysis = analyzeVolSpike(bars, cfg);
      return getChartPayload(sym, bars, cfg, analysis, {
        evaluateAt: atMs != null ? formatIsoUtcPlus3(atMs) : null,
        evaluateBarAt:
          signalBarAt != null ? formatIsoUtcPlus3(signalBarAt) : null,
      });
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
      getChartData: (symbol, searchParams) =>
        scannerApi.getChartData(symbol, searchParams),
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
      buffers,
      activeHits,
      nearBreakHits,
      lastPass,
      lastNearBreak,
      quoteVolMap
    );

  console.error(
    `Symbols: ${symbols.length} | interval: ${cfg.interval} | ` +
      `prefetch: ${cfg.prefetchDays}d (${cfg.limit} bars) | ` +
      `live prefetch: ${wantPrefetch ? "yes" : "no"}`
  );

  console.error(`WebSocket live on fstream (${cfg.interval})…`);
  const sockets = createWsShards(
    symbols,
    buffers,
    activeHits,
    nearBreakHits,
    lastPass,
    lastNearBreak,
    quoteVolMap
  );

  if (wantPrefetch) {
    await prefetchAllSymbols(
      symbols,
      buffers,
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
