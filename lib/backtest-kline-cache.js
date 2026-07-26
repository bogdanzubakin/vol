const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { mergeBarsByOpenTime } = require("./kline-cache");
const { fetchFuturesJson, parseKlineRows, FUTURES_REST_BASE } = require("./binance-rest-fetch");
const { createRestQueue, sleep } = require("./rest-queue");

const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_ROOT = () => dataPath("backtest-klines");
const MANIFEST_FILE = () => path.join(CACHE_ROOT(), "manifest.json");

function intervalBarMs(interval) {
  const m = /^(\d+)([mhd])$/.exec(interval ?? "5m");
  if (!m) return 60_000;
  const n = Number(m[1]);
  const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 24 * 60;
  return minutes * 60_000;
}

function barsForDays(interval, days) {
  const barMs = intervalBarMs(interval);
  return Math.ceil((days * 24 * 60 * 60 * 1000) / barMs);
}

function symbolsFingerprint(symbols) {
  const sorted = [...symbols].sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex").slice(0, 16);
}

function loadManifest() {
  return readJsonFile(MANIFEST_FILE(), null);
}

function writeManifest(manifest) {
  writeJsonFile(MANIFEST_FILE(), manifest);
}

function manifestNeeds1m(params, manifest) {
  const needs =
    params.needs1mBars ??
    params.needs1mMovers ??
    manifest?.needs1mBars ??
    manifest?.needs1mMovers ??
    false;
  return Boolean(needs);
}

function manifestMatches(manifest, params) {
  if (!manifest?.savedAt) return false;
  if (!manifest.persistent && Date.now() - manifest.savedAt > TTL_MS) return false;
  const {
    days,
    interval,
    symbols,
    barCount,
    moverBarCount = 0,
    needs1mBars = false,
    needs1mMovers = false,
  } = params;
  const needs1m = needs1mBars || needs1mMovers;
  if ((manifest.days ?? 0) < days) return false;
  if (manifest.interval !== interval) return false;
  if (manifest.symbolCount !== symbols.length) return false;
  if (manifest.symbolsFingerprint !== symbolsFingerprint(symbols)) return false;
  if ((manifest.barCount ?? 0) < barCount) return false;
  if (needs1m && (manifest.moverBarCount ?? 0) < moverBarCount) return false;
  if (needs1m && !manifestNeeds1m(params, manifest)) return false;
  return true;
}

function listCachedSymbols(kind = "signal") {
  const dir = path.join(CACHE_ROOT(), kind);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json.gz"))
      .map((f) => f.replace(/\.json\.gz$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Prepend older bars before the first cached candle (incremental history extension).
 */
async function extendSymbolBars(kind, symbol, targetBarCount, fetchOlderFn) {
  let bars = readSymbolBars(kind, symbol) ?? [];
  const had = bars.length;
  if (had >= targetBarCount) {
    const trimmed = bars.length > targetBarCount ? bars.slice(-targetBarCount) : bars;
    if (trimmed.length !== had) writeSymbolBars(kind, symbol, trimmed);
    return { symbol, kind, had, now: trimmed.length, fetched: 0, skipped: true };
  }

  const need = targetBarCount - had;
  let fetched = 0;
  if (had > 0) {
    const endTime = bars[0].openTime - 1;
    const older = await fetchOlderFn(symbol, need, endTime);
    fetched = older?.length ?? 0;
    bars = mergeBarsByOpenTime(older ?? [], bars);
  } else {
    const full = await fetchOlderFn(symbol, targetBarCount, Date.now());
    fetched = full?.length ?? 0;
    bars = mergeBarsByOpenTime([], full ?? []);
  }

  bars = bars.length > targetBarCount ? bars.slice(-targetBarCount) : bars;
  writeSymbolBars(kind, symbol, bars);
  return {
    symbol,
    kind,
    had,
    now: bars.length,
    fetched,
    skipped: false,
  };
}

function symbolAtTarget(symbol, signalBarCount, moverBarCount, needs1m) {
  const sig = readSymbolBars("signal", symbol);
  if ((sig?.length ?? 0) < signalBarCount) return false;
  if (!needs1m) return true;
  const mov = readSymbolBars("mover", symbol);
  return (mov?.length ?? 0) >= moverBarCount;
}

async function extendBacktestKlineCache(options = {}) {
  const {
    targetDays,
    interval = "5m",
    moverInterval = "1m",
    symbols,
    needs1m = true,
    fetchSignalOlder,
    fetchMoverOlder,
    onProgress,
    resume = true,
    symbolPauseMs = 0,
  } = options;

  if (typeof fetchSignalOlder !== "function") {
    throw new Error("fetchSignalOlder required");
  }

  const signalBarCount = barsForDays(interval, targetDays);
  const moverBarCount = needs1m ? barsForDays(moverInterval, targetDays) : 0;
  const manifest = loadManifest() ?? {};
  const symList = symbols?.length ? symbols : listCachedSymbols("signal");

  if (!symList.length) {
    throw new Error("No cached backtest symbols — run train bot first");
  }

  const stats = {
    symbols: symList.length,
    signalSkipped: 0,
    signalExtended: 0,
    moverSkipped: 0,
    moverExtended: 0,
    resumeSkipped: 0,
    errors: 0,
  };

  function writeExtendCheckpoint(symbol, done) {
    writeManifest({
      ...manifest,
      savedAt: Date.now(),
      days: manifest.days ?? targetDays,
      interval,
      symbolCount: symList.length,
      symbolsFingerprint: symbolsFingerprint(symList),
      barCount: Math.max(manifest.barCount ?? 0, signalBarCount),
      moverBarCount: needs1m ? Math.max(manifest.moverBarCount ?? 0, moverBarCount) : 0,
      needs1mBars: needs1m,
      needs1mMovers: needs1m,
      persistent: true,
      extendedFromDays: manifest.extendedFromDays ?? manifest.days ?? null,
      extendTargetDays: targetDays,
      extendInProgress: true,
      extendCheckpoint: {
        symbol,
        done,
        total: symList.length,
        stats: { ...stats },
        at: Date.now(),
      },
    });
  }

  for (let i = 0; i < symList.length; i++) {
    const symbol = symList[i];

    if (resume && symbolAtTarget(symbol, signalBarCount, moverBarCount, needs1m)) {
      stats.resumeSkipped++;
      onProgress?.({
        phase: "extend",
        done: i,
        total: symList.length,
        symbol,
        resumed: true,
        message: `${symbol} already at ${targetDays}d — skip`,
      });
      continue;
    }

    onProgress?.({
      phase: "extend",
      done: i,
      total: symList.length,
      symbol,
      message: `Extending ${symbol}…`,
    });

    try {
      const sig = await extendSymbolBars("signal", symbol, signalBarCount, fetchSignalOlder);
      if (sig.skipped) stats.signalSkipped++;
      else stats.signalExtended++;
    } catch (e) {
      stats.errors++;
      onProgress?.({
        phase: "extend",
        done: i,
        total: symList.length,
        symbol,
        error: e.message,
        message: `${symbol} signal: ${e.message}`,
      });
    }

    if (needs1m && typeof fetchMoverOlder === "function") {
      try {
        const mov = await extendSymbolBars("mover", symbol, moverBarCount, fetchMoverOlder);
        if (mov.skipped) stats.moverSkipped++;
        else stats.moverExtended++;
      } catch (e) {
        stats.errors++;
        onProgress?.({
          phase: "extend",
          done: i,
          total: symList.length,
          symbol,
          error: e.message,
          message: `${symbol} 1m: ${e.message}`,
        });
      }
    }

    writeExtendCheckpoint(symbol, i + 1);
    onProgress?.({
      phase: "done",
      done: i + 1,
      total: symList.length,
      symbol,
      message: `Extended ${symbol}`,
    });
    if (symbolPauseMs > 0) await new Promise((r) => setTimeout(r, symbolPauseMs));
    if (i % 4 === 0) await yieldToLoop();
  }

  writeManifest({
    ...manifest,
    savedAt: Date.now(),
    days: targetDays,
    interval,
    symbolCount: symList.length,
    symbolsFingerprint: symbolsFingerprint(symList),
    barCount: signalBarCount,
    moverBarCount: needs1m ? moverBarCount : 0,
    needs1mBars: needs1m,
    needs1mMovers: needs1m,
    persistent: true,
    extendedFromDays: manifest.extendedFromDays ?? manifest.days ?? null,
    extendTargetDays: targetDays,
    extendInProgress: false,
    extendCheckpoint: null,
  });

  return { ...stats, targetDays, signalBarCount, moverBarCount };
}

function barsFile(kind, symbol) {
  return path.join(CACHE_ROOT(), kind, `${symbol}.json.gz`);
}

/** In-process memo so symbols()/fetchers/backtest don't gunzip the same file repeatedly. */
const barsMemoryCache = new Map();
const BARS_MEMORY_MAX_ENTRIES = 400;

function barsMemoryKey(kind, symbol) {
  return `${kind}:${String(symbol || "").toUpperCase()}`;
}

function rememberBars(key, bars) {
  if (barsMemoryCache.size >= BARS_MEMORY_MAX_ENTRIES && !barsMemoryCache.has(key)) {
    const oldest = barsMemoryCache.keys().next().value;
    if (oldest != null) barsMemoryCache.delete(oldest);
  }
  barsMemoryCache.set(key, bars);
}

function clearBarsMemoryCache() {
  barsMemoryCache.clear();
}

function readSymbolBars(kind, symbol) {
  const key = barsMemoryKey(kind, symbol);
  if (barsMemoryCache.has(key)) return barsMemoryCache.get(key);
  const file = barsFile(kind, symbol);
  let bars = null;
  try {
    if (fs.existsSync(file)) {
      const raw = zlib.gunzipSync(fs.readFileSync(file));
      const data = JSON.parse(raw.toString("utf8"));
      bars = Array.isArray(data.bars) ? data.bars : null;
    }
  } catch {
    bars = null;
  }
  rememberBars(key, bars);
  return bars;
}

function readSymbolBarsAsync(kind, symbol) {
  const key = barsMemoryKey(kind, symbol);
  if (barsMemoryCache.has(key)) {
    return Promise.resolve(barsMemoryCache.get(key));
  }
  const file = barsFile(kind, symbol);
  return new Promise((resolve) => {
    fs.readFile(file, (err, data) => {
      if (err) {
        rememberBars(key, null);
        return resolve(null);
      }
      zlib.gunzip(data, (gunzipErr, raw) => {
        if (gunzipErr) {
          rememberBars(key, null);
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(raw.toString("utf8"));
          const bars = Array.isArray(parsed.bars) ? parsed.bars : null;
          rememberBars(key, bars);
          resolve(bars);
        } catch {
          rememberBars(key, null);
          resolve(null);
        }
      });
    });
  });
}

/**
 * Prefer signal 1m bars; only load mover if signal missing/short.
 * Same selection rule as railway bars1m helpers.
 */
function readBest1mBars(symbol, minBars = 200) {
  const sym = String(symbol || "").toUpperCase();
  const signal = readSymbolBars("signal", sym);
  if ((signal?.length ?? 0) >= minBars) return signal;
  const mover = readSymbolBars("mover", sym);
  if (signal?.length && mover?.length) {
    return signal.length >= mover.length ? signal : mover;
  }
  return signal ?? mover ?? null;
}

/** Async prefetch for pipelining I/O ahead of simulation. */
function prefetchBest1mBars(symbol, minBars = 200) {
  const sym = String(symbol || "").toUpperCase();
  return (async () => {
    const signal = await readSymbolBarsAsync("signal", sym);
    if ((signal?.length ?? 0) >= minBars) return signal;
    const mover = await readSymbolBarsAsync("mover", sym);
    if (signal?.length && mover?.length) {
      return signal.length >= mover.length ? signal : mover;
    }
    return signal ?? mover ?? null;
  })();
}

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

function writeSymbolBars(kind, symbol, bars) {
  if (!bars?.length) return;
  const file = barsFile(kind, symbol);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify({ bars });
  fs.writeFileSync(
    file,
    zlib.gzipSync(Buffer.from(json, "utf8"), {
      level: zlib.constants.Z_DEFAULT_COMPRESSION,
    })
  );
  barsMemoryCache.set(barsMemoryKey(kind, symbol), bars);
}

async function fetchKlinesForward(symbol, interval, startTime, restQueue, options = {}) {
  const { batchPauseMs = 300, onRateLimit, label = "refresh" } = options;
  const KLINE_MAX = 1500;
  let all = [];
  let start = startTime;

  while (start < Date.now()) {
    const url = new URL("/fapi/v1/klines", FUTURES_REST_BASE);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(KLINE_MAX));
    url.searchParams.set("startTime", String(start));
    const rows = await restQueue.schedule(() =>
      fetchFuturesJson(url.toString(), {
        label: `${label} ${symbol} ${interval}`,
        onRateLimit,
      })
    );
    if (!rows.length) break;
    const parsed = parseKlineRows(rows);
    all = mergeBarsByOpenTime(all, parsed);
    if (rows.length < KLINE_MAX) break;
    start = rows[rows.length - 1][6] + 1;
    if (batchPauseMs > 0) await sleep(batchPauseMs);
  }
  return all;
}

/**
 * Append newer candles and trim to the last targetDays window (in-place cache refresh).
 */
async function refreshBacktestKlineCacheTail(options = {}) {
  const {
    targetDays = 10,
    interval = loadManifest()?.interval ?? "1m",
    symbols = listCachedSymbols("signal"),
    restGapMs = 400,
    batchPauseMs = 300,
    symbolPauseMs = 800,
    onProgress,
    onRateLimit,
    fetchOlder,
  } = options;

  if (!symbols.length) throw new Error("No cached symbols to refresh");

  const signalBarCount = barsForDays(interval, targetDays);
  const needs1m = interval !== "1m";
  const moverBarCount = needs1m ? barsForDays("1m", targetDays) : signalBarCount;
  const restQueue = createRestQueue({ label: "refresh-klines", gapMs: restGapMs });
  const { createOlderKlineFetcher } = require("./binance-rest-fetch");
  const fetchOlderFn =
    fetchOlder ??
    createOlderKlineFetcher({
      interval,
      restQueue,
      batchPauseMs,
      symbolPauseMs: 0,
      onRateLimit,
    });
  const fetchMoverOlder = needs1m
    ? createOlderKlineFetcher({
        interval: "1m",
        restQueue,
        batchPauseMs,
        symbolPauseMs: 0,
        onRateLimit,
      })
    : null;

  const stats = { refreshed: 0, skipped: 0, fullFetch: 0, errors: 0 };

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    onProgress?.({
      phase: "refresh",
      done: i,
      total: symbols.length,
      symbol,
      stats: { ...stats },
    });

    try {
      let bars = readSymbolBars("signal", symbol) ?? [];
      if (!bars.length) {
        bars = await fetchOlderFn(symbol, signalBarCount, Date.now());
        stats.fullFetch++;
      } else {
        const lastClose = bars[bars.length - 1]?.closeTime ?? 0;
        if (Date.now() - lastClose > 60_000) {
          const newer = await fetchKlinesForward(symbol, interval, lastClose + 1, restQueue, {
            batchPauseMs,
            onRateLimit,
            label: "refresh",
          });
          if (newer.length) {
            bars = mergeBarsByOpenTime(bars, newer);
            stats.refreshed++;
          } else {
            stats.skipped++;
          }
        } else {
          stats.skipped++;
        }
      }
      bars = bars.length > signalBarCount ? bars.slice(-signalBarCount) : bars;
      writeSymbolBars("signal", symbol, bars);

      if (needs1m && fetchMoverOlder) {
        let mover = readSymbolBars("mover", symbol) ?? [];
        if (!mover.length) {
          mover = await fetchMoverOlder(symbol, moverBarCount, Date.now());
        } else {
          const lastClose = mover[mover.length - 1]?.closeTime ?? 0;
          if (Date.now() - lastClose > 60_000) {
            const newer = await fetchKlinesForward(symbol, "1m", lastClose + 1, restQueue, {
              batchPauseMs,
              onRateLimit,
              label: "refresh-1m",
            });
            if (newer.length) mover = mergeBarsByOpenTime(mover, newer);
          }
        }
        mover = mover.length > moverBarCount ? mover.slice(-moverBarCount) : mover;
        writeSymbolBars("mover", symbol, mover);
      } else {
        writeSymbolBars("mover", symbol, bars);
      }
    } catch (e) {
      stats.errors++;
      onProgress?.({
        phase: "refresh-error",
        done: i + 1,
        total: symbols.length,
        symbol,
        error: e.message,
      });
    }

    if (symbolPauseMs > 0) await sleep(symbolPauseMs);
  }

  const manifest = loadManifest() ?? {};
  writeManifest({
    ...manifest,
    savedAt: Date.now(),
    refreshedAt: Date.now(),
    days: targetDays,
    interval,
    symbolCount: symbols.length,
    symbolsFingerprint: symbolsFingerprint(symbols),
    barCount: signalBarCount,
    moverBarCount: needs1m ? moverBarCount : 0,
    needs1mBars: needs1m,
    needs1mMovers: needs1m,
    persistent: true,
  });

  return stats;
}

function clearBacktestKlineCache() {
  clearBarsMemoryCache();
  try {
    fs.rmSync(CACHE_ROOT(), { recursive: true, force: true });
  } catch {
    /* missing */
  }
}

function getBacktestKlineCacheStatus(params) {
  const manifest = loadManifest();
  const valid = manifestMatches(manifest, params);
  const ageMs = manifest?.savedAt ? Date.now() - manifest.savedAt : null;
  return {
    valid,
    ttlHours: TTL_MS / 3_600_000,
    manifest: valid
      ? {
          savedAt: manifest.savedAt,
          ageHours: +(ageMs / 3_600_000).toFixed(2),
          days: manifest.days,
          symbolCount: manifest.symbolCount,
          interval: manifest.interval,
          barCount: manifest.barCount,
          moverBarCount: manifest.moverBarCount ?? 0,
        }
      : manifest
        ? {
            expired: ageMs != null && ageMs > TTL_MS,
            days: manifest.days,
            symbolCount: manifest.symbolCount,
            interval: manifest.interval,
          }
        : null,
  };
}

function getBacktestKlineCacheInfo() {
  const manifest = loadManifest();
  if (!manifest?.savedAt) {
    return { valid: false, ttlHours: TTL_MS / 3_600_000, manifest: null };
  }
  const ageMs = Date.now() - manifest.savedAt;
  const expired = !manifest.persistent && ageMs > TTL_MS;
  return {
    valid: !expired,
    expired,
    persistent: Boolean(manifest.persistent),
    ttlHours: TTL_MS / 3_600_000,
    manifest: {
      savedAt: manifest.savedAt,
      ageHours: +(ageMs / 3_600_000).toFixed(2),
      days: manifest.days,
      symbolCount: manifest.symbolCount,
      interval: manifest.interval,
      barCount: manifest.barCount,
      moverBarCount: manifest.moverBarCount ?? 0,
    },
  };
}

function createBacktestKlineCache(params) {
  const {
    days,
    interval,
    symbols,
    barCount,
    moverBarCount = 0,
    needs1mBars = false,
    needs1mMovers = false,
    /** When true, always call fetchFn (needed for shifted OOS windows). */
    forceFetch = false,
  } = params;
  const needs1m = needs1mBars || needs1mMovers;

  const manifest = loadManifest();
  const bundleValid = !forceFetch && manifestMatches(manifest, params);
  let hits = 0;
  let misses = 0;

  async function loadBars(symbol, kind, requiredBars, fetchFn) {
    if (forceFetch) {
      misses++;
      return fetchFn(symbol, requiredBars);
    }
    const cached = await readSymbolBarsAsync(kind, symbol);
    if (cached?.length >= requiredBars) {
      hits++;
      return cached.length > requiredBars ? cached.slice(-requiredBars) : cached;
    }
    misses++;
    return fetchFn(symbol, requiredBars);
  }

  async function saveFromBarCaches(signalBarCache, moverBarCache) {
    fs.mkdirSync(path.join(CACHE_ROOT(), "signal"), { recursive: true });
    if (needs1m) {
      fs.mkdirSync(path.join(CACHE_ROOT(), "mover"), { recursive: true });
    }

    let n = 0;
    for (const [symbol, bars] of signalBarCache) {
      writeSymbolBars("signal", symbol, bars);
      if (++n % 8 === 0) await yieldToLoop();
    }
    if (needs1m) {
      for (const [symbol, bars] of moverBarCache) {
        writeSymbolBars("mover", symbol, bars);
        if (++n % 8 === 0) await yieldToLoop();
      }
    }

    writeManifest({
      savedAt: Date.now(),
      days,
      interval,
      symbolCount: symbols.length,
      symbolsFingerprint: symbolsFingerprint(symbols),
      barCount,
      moverBarCount: needs1m ? moverBarCount : 0,
      needs1mBars: needs1m,
      needs1mMovers: needs1m,
      persistent: manifest?.persistent ?? false,
    });
  }

  return {
    bundleValid,
    loadSignalBars: (symbol, fetchFn) =>
      loadBars(symbol, "signal", barCount, fetchFn),
    loadMoverBars: (symbol, fetchFn) =>
      loadBars(symbol, "mover", moverBarCount, fetchFn),
    saveFromBarCaches,
    stats: () => ({ hits, misses, bundleValid }),
  };
}

module.exports = {
  TTL_MS,
  barsForDays,
  intervalBarMs,
  clearBacktestKlineCache,
  clearBarsMemoryCache,
  getBacktestKlineCacheStatus,
  getBacktestKlineCacheInfo,
  createBacktestKlineCache,
  readSymbolBars,
  readSymbolBarsAsync,
  readBest1mBars,
  prefetchBest1mBars,
  listCachedSymbols,
  extendSymbolBars,
  symbolAtTarget,
  extendBacktestKlineCache,
  refreshBacktestKlineCacheTail,
  symbolsFingerprint,
  loadManifest,
};
