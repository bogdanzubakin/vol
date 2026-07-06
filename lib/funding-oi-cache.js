const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");

const REST_BASE = "https://fapi.binance.com";
const DATA_BASE = "https://fapi.binance.com/futures/data";
const CACHE_ROOT = () => dataPath("backtest-funding-oi");
const MANIFEST_FILE = () => path.join(CACHE_ROOT(), "manifest.json");
const DEFAULT_REST_GAP_MS = 120;
const FETCH_TIMEOUT_MS = 45_000;
const OI_MAX_RANGE_MS = 29 * 24 * 60 * 60 * 1000;
const OI_MAX_PAGES = 24;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function symbolFile(symbol) {
  return path.join(CACHE_ROOT(), `${String(symbol).toUpperCase()}.json.gz`);
}

function readSymbolSeries(symbol) {
  const file = symbolFile(symbol);
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function writeSymbolSeries(symbol, data) {
  const file = symbolFile(symbol);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Buffer.from(JSON.stringify(data));
  fs.writeFileSync(file, zlib.gzipSync(body));
}

async function fetchJson(url, restGapMs = DEFAULT_REST_GAP_MS, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${url} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    if (restGapMs > 0) await sleep(restGapMs);
    return data;
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`fetch timeout after ${timeoutMs}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFundingHistory(symbol, startTime, endTime, restGapMs = DEFAULT_REST_GAP_MS) {
  const sym = String(symbol).toUpperCase();
  const out = [];
  let cursorStart = startTime;
  while (cursorStart < endTime) {
    const params = new URLSearchParams({
      symbol: sym,
      startTime: String(cursorStart),
      endTime: String(endTime),
      limit: "1000",
    });
    const rows = await fetchJson(`${REST_BASE}/fapi/v1/fundingRate?${params}`, restGapMs);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      out.push({
        t: num(row.fundingTime),
        rate: num(row.fundingRate),
      });
    }
    const lastT = rows[rows.length - 1].fundingTime;
    if (lastT <= cursorStart) break;
    cursorStart = lastT + 1;
    if (rows.length < 1000) break;
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

async function fetchOiHistory(symbol, startTime, endTime, restGapMs = DEFAULT_REST_GAP_MS) {
  const sym = String(symbol).toUpperCase();
  const targetStart = Math.max(startTime, endTime - OI_MAX_RANGE_MS);
  const out = [];
  let cursorEnd = endTime;
  let pages = 0;

  while (cursorEnd > targetStart && pages < OI_MAX_PAGES) {
    pages++;
    const params = new URLSearchParams({
      symbol: sym,
      period: "5m",
      endTime: String(cursorEnd),
      limit: "500",
    });
    const rows = await fetchJson(`${DATA_BASE}/openInterestHist?${params}`, restGapMs);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      out.push({
        t: num(row.timestamp),
        oi: num(row.sumOpenInterest),
      });
    }
    const firstT = num(rows[0].timestamp);
    const lastT = num(rows[rows.length - 1].timestamp);
    if (!Number.isFinite(firstT) || firstT <= targetStart) break;
    if (firstT >= cursorEnd) break;
    cursorEnd = firstT - 1;
    if (rows.length < 500) break;
    if (lastT <= targetStart) break;
  }

  const dedup = new Map();
  for (const row of out) {
    if (row.t >= targetStart && row.t <= endTime) dedup.set(row.t, row);
  }
  return [...dedup.values()].sort((a, b) => a.t - b.t);
}

function mergeSeries(existing, incoming, key) {
  const map = new Map();
  for (const row of existing ?? []) map.set(row.t, row[key]);
  for (const row of incoming ?? []) map.set(row.t, row[key]);
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t, [key]: v }));
}

function valueAtOrBefore(series, asOfMs, valueKey) {
  if (!series?.length || asOfMs == null) return null;
  let lo = 0;
  let hi = series.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= asOfMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  return series[best][valueKey];
}

function lookupFundingOiSeries(funding, oi, asOfMs) {
  const fundingRate = valueAtOrBefore(funding, asOfMs, "rate");
  const funding24hAgo = valueAtOrBefore(funding, asOfMs - 24 * 60 * 60 * 1000, "rate");
  const oiNow = valueAtOrBefore(oi, asOfMs, "oi");
  const oi1hAgo = valueAtOrBefore(oi, asOfMs - 60 * 60 * 1000, "oi");
  let oiDelta1h = null;
  if (oiNow != null && oi1hAgo != null && oi1hAgo > 0) {
    oiDelta1h = ((oiNow - oi1hAgo) / oi1hAgo) * 100;
  }
  let fundingTrend = null;
  if (fundingRate != null && funding24hAgo != null) {
    fundingTrend = fundingRate - funding24hAgo;
  }
  return {
    fundingRate,
    fundingTrend,
    oiDelta1h,
    asOfMs,
  };
}

function createFundingOiLookup(cache = {}) {
  const bySymbol = cache.bySymbol ?? cache;
  return function getFundingOiAt(symbol, asOfMs) {
    const sym = String(symbol || "").toUpperCase();
    const row = bySymbol[sym];
    if (!row) {
      return { fundingRate: null, fundingTrend: null, oiDelta1h: null, asOfMs };
    }
    return lookupFundingOiSeries(row.funding ?? [], row.oi ?? [], asOfMs);
  };
}

function loadFundingOiCache(symbols = []) {
  const bySymbol = {};
  for (const sym of symbols) {
    const row = readSymbolSeries(sym);
    if (row) bySymbol[String(sym).toUpperCase()] = row;
  }
  return { bySymbol, lookup: createFundingOiLookup({ bySymbol }) };
}

async function ensureSymbolFundingOi(symbol, { startTime, endTime, restGapMs = DEFAULT_REST_GAP_MS }) {
  const sym = String(symbol).toUpperCase();
  const existing = readSymbolSeries(sym) ?? { symbol: sym, funding: [], oi: [] };
  const needFunding =
    !existing.funding?.length ||
    existing.funding[0].t > startTime + 8 * 60 * 60 * 1000 ||
    existing.funding[existing.funding.length - 1].t < endTime - 8 * 60 * 60 * 1000;
  const needOi =
    !existing.oi?.length ||
    existing.oi[0].t > startTime + 60 * 60 * 1000 ||
    existing.oi[existing.oi.length - 1].t < endTime - 15 * 60 * 1000;

  let funding = existing.funding ?? [];
  let oi = existing.oi ?? [];
  let oiError = null;
  if (needFunding) {
    const fetched = await fetchFundingHistory(sym, startTime, endTime, restGapMs);
    funding = mergeSeries(funding, fetched.map((r) => ({ t: r.t, rate: r.rate })), "rate");
  }
  if (needOi) {
    try {
      const fetched = await fetchOiHistory(sym, startTime, endTime, restGapMs);
      oi = mergeSeries(oi, fetched.map((r) => ({ t: r.t, oi: r.oi })), "oi");
    } catch (e) {
      oiError = e.message;
    }
  }
  if (!funding.length && !oi.length) {
    throw new Error(oiError || "no funding/OI data");
  }
  const payload = {
    symbol: sym,
    funding,
    oi,
    savedAt: Date.now(),
    range: { startTime, endTime },
    oiError,
  };
  writeSymbolSeries(sym, payload);
  return payload;
}

async function prefetchFundingOiCache({
  symbols,
  days = 30,
  restGapMs = DEFAULT_REST_GAP_MS,
  onProgress,
}) {
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000;
  fs.mkdirSync(CACHE_ROOT(), { recursive: true });
  const list = [...symbols].map((s) => String(s).toUpperCase());
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < list.length; i++) {
    const sym = list[i];
    onProgress?.({
      phase: "funding_oi",
      done: i,
      total: list.length,
      symbol: sym,
      message: `Funding/OI ${i + 1}/${list.length} ${sym}`,
    });
    try {
      await ensureSymbolFundingOi(sym, { startTime, endTime, restGapMs });
      ok++;
    } catch (e) {
      fail++;
      if (fail <= 5 || fail % 25 === 0) {
        onProgress?.({
          phase: "funding_oi",
          symbol: sym,
          error: e.message,
          fail,
        });
      }
    }
  }
  const manifest = {
    savedAt: Date.now(),
    days,
    symbolCount: list.length,
    ok,
    fail,
    range: { startTime, endTime },
  };
  writeJsonFile(MANIFEST_FILE(), manifest);
  return manifest;
}

module.exports = {
  CACHE_ROOT,
  MANIFEST_FILE,
  readSymbolSeries,
  writeSymbolSeries,
  fetchFundingHistory,
  fetchOiHistory,
  lookupFundingOiSeries,
  createFundingOiLookup,
  loadFundingOiCache,
  ensureSymbolFundingOi,
  prefetchFundingOiCache,
  valueAtOrBefore,
};
