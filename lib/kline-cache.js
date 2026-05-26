const fs = require("fs");
const path = require("path");

const LEGACY_CACHE_RE = /^(.+)_(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)_(\d+)\.json$/;

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

function klineCacheFile(dir, symbol, interval) {
  return path.join(dir, `${symbol}_${interval}.json`);
}

function klineLiveCacheFile(dir, symbol, interval) {
  return path.join(dir, `${symbol}_${interval}.live.json`);
}

function readBarsFile(file, interval) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.interval !== interval || !data.bars?.length) return null;
  return data.bars;
}

function readKlineCache(dir, symbol, interval) {
  const primary = klineCacheFile(dir, symbol, interval);
  const live = klineLiveCacheFile(dir, symbol, interval);
  let primaryBars = null;
  let liveBars = null;

  try {
    if (fs.existsSync(primary)) {
      primaryBars = readBarsFile(primary, interval);
    }
  } catch {
    /* try legacy */
  }

  try {
    if (fs.existsSync(live)) {
      liveBars = readBarsFile(live, interval);
    }
  } catch {
    /* ignore live cache */
  }

  if (primaryBars || liveBars) {
    return mergeBarsByOpenTime(primaryBars ?? [], liveBars ?? []);
  }

  try {
    if (!fs.existsSync(dir)) return null;
    const prefix = `${symbol}_${interval}_`;
    let best = null;
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (!data.bars?.length) continue;
      if (!best || data.bars.length > best.length) best = data.bars;
    }
    return best;
  } catch {
    return null;
  }
}

function writeKlineCache(dir, symbol, interval, bars, options = {}) {
  const { maxBars, evalLimit } = options;
  const capped = capBars(bars, maxBars);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    klineCacheFile(dir, symbol, interval),
    JSON.stringify({
      savedAt: Date.now(),
      interval,
      evalLimit: evalLimit ?? null,
      barCount: capped.length,
      firstOpenTime: capped[0]?.openTime ?? null,
      lastCloseTime: capped[capped.length - 1]?.closeTime ?? null,
      bars: capped,
    })
  );
  try {
    fs.unlinkSync(klineLiveCacheFile(dir, symbol, interval));
  } catch {
    /* no live tail */
  }
  return capped;
}

function writeKlineLiveCache(dir, symbol, interval, bars, options = {}) {
  const { maxBars, evalLimit } = options;
  const capped = capBars(bars, maxBars);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    klineLiveCacheFile(dir, symbol, interval),
    JSON.stringify({
      savedAt: Date.now(),
      interval,
      evalLimit: evalLimit ?? null,
      barCount: capped.length,
      firstOpenTime: capped[0]?.openTime ?? null,
      lastCloseTime: capped[capped.length - 1]?.closeTime ?? null,
      bars: capped,
    })
  );
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
  readKlineCache,
  writeKlineCache,
  upsertBar,
  createKlineCacheStore,
};
