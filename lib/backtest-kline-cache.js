const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");

const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_ROOT = () => dataPath("backtest-klines");
const MANIFEST_FILE = () => path.join(CACHE_ROOT(), "manifest.json");

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

function manifestMatches(manifest, params) {
  if (!manifest?.savedAt) return false;
  if (Date.now() - manifest.savedAt > TTL_MS) return false;
  const {
    days,
    interval,
    symbols,
    barCount,
    moverBarCount = 0,
    needs1mMovers = false,
  } = params;
  if (manifest.days !== days) return false;
  if (manifest.interval !== interval) return false;
  if (manifest.symbolCount !== symbols.length) return false;
  if (manifest.symbolsFingerprint !== symbolsFingerprint(symbols)) return false;
  if ((manifest.barCount ?? 0) < barCount) return false;
  if (needs1mMovers && (manifest.moverBarCount ?? 0) < moverBarCount) return false;
  return true;
}

function barsFile(kind, symbol) {
  return path.join(CACHE_ROOT(), kind, `${symbol}.json.gz`);
}

function readSymbolBars(kind, symbol) {
  const file = barsFile(kind, symbol);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    const data = JSON.parse(raw.toString("utf8"));
    return Array.isArray(data.bars) ? data.bars : null;
  } catch {
    return null;
  }
}

function readSymbolBarsAsync(kind, symbol) {
  const file = barsFile(kind, symbol);
  return new Promise((resolve) => {
    fs.readFile(file, (err, data) => {
      if (err) return resolve(null);
      zlib.gunzip(data, (gunzipErr, raw) => {
        if (gunzipErr) return resolve(null);
        try {
          const parsed = JSON.parse(raw.toString("utf8"));
          resolve(Array.isArray(parsed.bars) ? parsed.bars : null);
        } catch {
          resolve(null);
        }
      });
    });
  });
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
}

function clearBacktestKlineCache() {
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
  const expired = ageMs > TTL_MS;
  return {
    valid: !expired,
    expired,
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
    needs1mMovers = false,
  } = params;

  const manifest = loadManifest();
  const bundleValid = manifestMatches(manifest, params);
  let hits = 0;
  let misses = 0;

  async function loadBars(symbol, kind, requiredBars, fetchFn) {
    if (bundleValid) {
      const cached = await readSymbolBarsAsync(kind, symbol);
      if (cached?.length >= requiredBars) {
        hits++;
        return cached.length > requiredBars ? cached.slice(-requiredBars) : cached;
      }
    }
    misses++;
    return fetchFn(symbol, requiredBars);
  }

  async function saveFromBarCaches(signalBarCache, moverBarCache) {
    fs.mkdirSync(path.join(CACHE_ROOT(), "signal"), { recursive: true });
    if (needs1mMovers) {
      fs.mkdirSync(path.join(CACHE_ROOT(), "mover"), { recursive: true });
    }

    let n = 0;
    for (const [symbol, bars] of signalBarCache) {
      writeSymbolBars("signal", symbol, bars);
      if (++n % 8 === 0) await yieldToLoop();
    }
    if (needs1mMovers) {
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
      moverBarCount: needs1mMovers ? moverBarCount : 0,
      needs1mMovers,
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
  clearBacktestKlineCache,
  getBacktestKlineCacheStatus,
  getBacktestKlineCacheInfo,
  createBacktestKlineCache,
  readSymbolBars,
  symbolsFingerprint,
};
