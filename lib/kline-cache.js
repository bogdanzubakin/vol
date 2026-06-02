const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const LEGACY_CACHE_RE = /^(.+)_(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)_(\d+)\.json$/;
const GZIP_LEVEL = zlib.constants.Z_DEFAULT_COMPRESSION;

function mergeBarsByOpenTime(...arrays) {
  const map = new Map();
  for (const arr of arrays) {
    for (const bar of arr ?? []) {
      if (bar?.openTime != null) map.set(bar.openTime, bar);
    }
  }
  return [...map.values()].sort((a, b) => a.openTime - b.openTime);
}

function capBars(bars, maxBars) {
  if (!maxBars || bars.length <= maxBars) return bars;
  return bars.slice(-maxBars);
}

function evalWindow(bars, evalLimit) {
  return capBars(bars, evalLimit);
}

function klineCacheDataFile(dir, symbol, interval) {
  return path.join(dir, `${symbol}_${interval}.json.gz`);
}

function klineCacheMetaFile(dir, symbol, interval) {
  return path.join(dir, `${symbol}_${interval}.meta.json`);
}

function klineLiveDataFile(dir, symbol, interval) {
  return path.join(dir, `${symbol}_${interval}.live.json.gz`);
}

function klineLiveMetaFile(dir, symbol, interval) {
  return path.join(dir, `${symbol}_${interval}.live.meta.json`);
}

/** @deprecated Use klineCacheDataFile — kept for callers expecting a primary path. */
function klineCacheFile(dir, symbol, interval) {
  return klineCacheDataFile(dir, symbol, interval);
}

function klineLiveCacheFile(dir, symbol, interval) {
  return klineLiveDataFile(dir, symbol, interval);
}

function metaPathForDataFile(dataPath) {
  if (dataPath.endsWith(".live.json.gz")) {
    return dataPath.slice(0, -".live.json.gz".length) + ".live.meta.json";
  }
  if (dataPath.endsWith(".json.gz")) {
    return dataPath.slice(0, -".json.gz".length) + ".meta.json";
  }
  if (dataPath.endsWith(".live.json")) {
    return dataPath.slice(0, -".live.json".length) + ".live.meta.json";
  }
  if (dataPath.endsWith(".json") && !dataPath.endsWith(".meta.json")) {
    return dataPath.slice(0, -".json".length) + ".meta.json";
  }
  return null;
}

function readFileUtf8(filePath) {
  const raw = fs.readFileSync(filePath);
  if (filePath.endsWith(".gz")) {
    return zlib.gunzipSync(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function writeGzipJson(filePath, obj) {
  const json = JSON.stringify(obj);
  fs.writeFileSync(
    filePath,
    zlib.gzipSync(Buffer.from(json, "utf8"), { level: GZIP_LEVEL })
  );
}

function cachePayload(bars, interval, evalLimit) {
  return {
    savedAt: Date.now(),
    interval,
    evalLimit: evalLimit ?? null,
    barCount: bars.length,
    firstOpenTime: bars[0]?.openTime ?? null,
    lastCloseTime: bars[bars.length - 1]?.closeTime ?? null,
    bars,
  };
}

function metaFromPayload(payload) {
  return {
    savedAt: payload.savedAt,
    interval: payload.interval,
    evalLimit: payload.evalLimit,
    barCount: payload.barCount,
    firstOpenTime: payload.firstOpenTime,
    lastCloseTime: payload.lastCloseTime,
  };
}

function readMetaFile(metaPath, interval) {
  try {
    if (!fs.existsSync(metaPath)) return null;
    const data = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (data.interval !== interval || !data.barCount) return null;
    return {
      barCount: data.barCount,
      lastCloseTime: data.lastCloseTime ?? null,
      interval: data.interval,
    };
  } catch {
    return null;
  }
}

function readBarsFile(file, interval) {
  const data = JSON.parse(readFileUtf8(file));
  if (data.interval !== interval || !data.bars?.length) return null;
  return data.bars;
}

/** Read barCount / lastCloseTime from sidecar meta or legacy JSON header. */
function readCacheFileMeta(filePath, interval) {
  const metaPath = metaPathForDataFile(filePath);
  if (metaPath) {
    const fromMeta = readMetaFile(metaPath, interval);
    if (fromMeta) return fromMeta;
  }
  if (filePath.endsWith(".gz")) return null;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const head = buf.toString("utf8", 0, n);
    const intervalM = head.match(/"interval"\s*:\s*"([^"]+)"/);
    if (intervalM?.[1] !== interval) return null;
    const barCountM = head.match(/"barCount"\s*:\s*(\d+)/);
    const lastCloseM = head.match(/"lastCloseTime"\s*:\s*(\d+)/);
    const barCount = barCountM ? Number(barCountM[1]) : 0;
    const lastCloseTime = lastCloseM ? Number(lastCloseM[1]) : null;
    if (!barCount) return null;
    return { barCount, lastCloseTime, interval };
  } catch {
    return null;
  }
}

function isKlineDataFile(name) {
  if (name.endsWith(".meta.json") || name.endsWith(".live.meta.json")) return false;
  return (
    name.endsWith(".json.gz") ||
    name.endsWith(".live.json.gz") ||
    (name.endsWith(".json") && !name.endsWith(".meta.json"))
  );
}

function pickBetterMeta(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a.barCount >= b.barCount ? a : b;
}

function readKlineCacheMeta(dir, symbol, interval) {
  let best = null;

  for (const metaPath of [
    klineCacheMetaFile(dir, symbol, interval),
    klineLiveMetaFile(dir, symbol, interval),
  ]) {
    best = pickBetterMeta(best, readMetaFile(metaPath, interval));
  }

  for (const dataPath of [
    klineCacheDataFile(dir, symbol, interval),
    path.join(dir, `${symbol}_${interval}.json`),
    klineLiveDataFile(dir, symbol, interval),
    path.join(dir, `${symbol}_${interval}.live.json`),
  ]) {
    try {
      if (!fs.existsSync(dataPath)) continue;
      best = pickBetterMeta(best, readCacheFileMeta(dataPath, interval));
    } catch {
      /* ignore */
    }
  }

  if (best) return best;

  try {
    if (!fs.existsSync(dir)) return null;
    const prefix = `${symbol}_${interval}_`;
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(prefix) || !isKlineDataFile(file)) continue;
      const meta = readCacheFileMeta(path.join(dir, file), interval);
      best = pickBetterMeta(best, meta);
    }
  } catch {
    return null;
  }

  return best;
}

function readKlineCache(dir, symbol, interval) {
  const primaryPaths = [
    klineCacheDataFile(dir, symbol, interval),
    path.join(dir, `${symbol}_${interval}.json`),
  ];
  const livePaths = [
    klineLiveDataFile(dir, symbol, interval),
    path.join(dir, `${symbol}_${interval}.live.json`),
  ];

  let primaryBars = null;
  for (const file of primaryPaths) {
    try {
      if (!fs.existsSync(file)) continue;
      primaryBars = readBarsFile(file, interval);
      if (primaryBars) break;
    } catch {
      /* try next */
    }
  }

  let liveBars = null;
  for (const file of livePaths) {
    try {
      if (!fs.existsSync(file)) continue;
      liveBars = readBarsFile(file, interval);
      if (liveBars) break;
    } catch {
      /* ignore */
    }
  }

  if (primaryBars || liveBars) {
    return mergeBarsByOpenTime(primaryBars ?? [], liveBars ?? []);
  }

  try {
    if (!fs.existsSync(dir)) return null;
    const prefix = `${symbol}_${interval}_`;
    let best = null;
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(prefix) || !isKlineDataFile(file)) continue;
      const data = JSON.parse(readFileUtf8(path.join(dir, file)));
      if (!data.bars?.length) continue;
      if (!best || data.bars.length > best.length) best = data.bars;
    }
    return best;
  } catch {
    return null;
  }
}

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* missing */
  }
}

function writeKlineCache(dir, symbol, interval, bars, options = {}) {
  const { maxBars, evalLimit } = options;
  const capped = capBars(bars, maxBars);
  const payload = cachePayload(capped, interval, evalLimit);
  fs.mkdirSync(dir, { recursive: true });
  writeGzipJson(klineCacheDataFile(dir, symbol, interval), payload);
  fs.writeFileSync(
    klineCacheMetaFile(dir, symbol, interval),
    JSON.stringify(metaFromPayload(payload))
  );
  unlinkIfExists(path.join(dir, `${symbol}_${interval}.json`));
  unlinkIfExists(path.join(dir, `${symbol}_${interval}.live.json`));
  unlinkIfExists(klineLiveDataFile(dir, symbol, interval));
  unlinkIfExists(klineLiveMetaFile(dir, symbol, interval));
  return capped;
}

function writeKlineLiveCache(dir, symbol, interval, bars, options = {}) {
  const { maxBars, evalLimit } = options;
  const capped = capBars(bars, maxBars);
  const payload = cachePayload(capped, interval, evalLimit);
  fs.mkdirSync(dir, { recursive: true });
  writeGzipJson(klineLiveDataFile(dir, symbol, interval), payload);
  fs.writeFileSync(
    klineLiveMetaFile(dir, symbol, interval),
    JSON.stringify(metaFromPayload(payload))
  );
  unlinkIfExists(path.join(dir, `${symbol}_${interval}.live.json`));
  return capped;
}

function sameBar(a, b) {
  return (
    a?.openTime === b?.openTime &&
    a?.open === b?.open &&
    a?.high === b?.high &&
    a?.low === b?.low &&
    a?.close === b?.close &&
    a?.volume === b?.volume &&
    a?.closeTime === b?.closeTime
  );
}

function upsertBar(buf, candle, maxBars) {
  const last = buf[buf.length - 1];
  if (last && last.openTime === candle.openTime) {
    const changed = !sameBar(last, candle);
    if (changed) buf[buf.length - 1] = candle;
    return { appended: false, updated: changed, ignored: false };
  }
  if (last && candle.openTime < last.openTime) {
    return { appended: false, updated: false, ignored: true };
  }
  buf.push(candle);
  if (maxBars && buf.length > maxBars) buf.splice(0, buf.length - maxBars);
  return { appended: true, updated: true, ignored: false };
}

function createKlineCacheStore(options) {
  const {
    dir,
    interval,
    maxBars,
    evalLimit,
    flushMs = 60_000,
    debounceMs = 3000,
  } = options;

  const pendingTimers = new Map();
  let flushAllTimer = null;

  function persist(symbol, bars) {
    if (!bars?.length) return;
    writeKlineLiveCache(dir, symbol, interval, bars, {
      maxBars: evalLimit,
      evalLimit,
    });
  }

  function replace(symbol, bars) {
    if (!bars?.length) return;
    writeKlineCache(dir, symbol, interval, bars, { maxBars, evalLimit });
  }

  function schedulePersist(symbol, bars) {
    if (pendingTimers.has(symbol)) return;
    pendingTimers.set(
      symbol,
      setTimeout(() => {
        pendingTimers.delete(symbol);
        persist(symbol, bars);
      }, debounceMs)
    );
  }

  function flushPending(buffers) {
    for (const t of pendingTimers.values()) clearTimeout(t);
    const symbols = [...pendingTimers.keys()];
    pendingTimers.clear();
    for (const symbol of symbols) {
      persist(symbol, buffers.get(symbol));
    }
  }

  function flushAll(buffers) {
    flushPending(buffers);
    for (const [symbol, bars] of buffers) {
      persist(symbol, bars);
    }
  }

  function startPeriodicFlush(buffers) {
    if (flushAllTimer) return;
    flushAllTimer = setInterval(() => flushPending(buffers), flushMs);
  }

  function stop() {
    if (flushAllTimer) {
      clearInterval(flushAllTimer);
      flushAllTimer = null;
    }
    for (const t of pendingTimers.values()) clearTimeout(t);
    pendingTimers.clear();
  }

  return {
    read: (symbol) => readKlineCache(dir, symbol, interval),
    readMeta: (symbol) => readKlineCacheMeta(dir, symbol, interval),
    write: (symbol, bars) => persist(symbol, bars),
    replace,
    schedulePersist,
    flushPending,
    flushAll,
    startPeriodicFlush,
    stop,
    mergeBarsByOpenTime,
    capBars,
    evalWindow,
    upsertBar,
  };
}

module.exports = {
  LEGACY_CACHE_RE,
  mergeBarsByOpenTime,
  capBars,
  evalWindow,
  klineCacheFile,
  klineCacheDataFile,
  readKlineCache,
  readKlineCacheMeta,
  writeKlineCache,
  readFileUtf8,
  upsertBar,
  createKlineCacheStore,
};
