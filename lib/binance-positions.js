const { loadEnvFile } = require("./load-env");
const { formatIsoUtcPlus3, parseDisplayIso } = require("./time-format");
const { signedFuturesGet } = require("./binance-signed");

const REST_BASE = "https://fapi.binance.com";
const CACHE_MS = 2000;
const TRADE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

let cache = { at: 0, data: null };
let balanceCache = { at: 0, data: null };

function resolveBinanceCredentials(kv = new Map()) {
  loadEnvFile();
  const apiKey =
    kv.get("binance-api-key")?.trim() ||
    process.env.BINANCE_API_KEY?.trim() ||
    "";
  const apiSecret =
    kv.get("binance-api-secret")?.trim() ||
    process.env.BINANCE_API_SECRET?.trim() ||
    "";
  if (!apiKey || !apiSecret) {
    return { enabled: false, apiKey: "", apiSecret: "" };
  }
  return { enabled: true, apiKey, apiSecret };
}

async function signedGet(path, params, apiKey, apiSecret) {
  return signedFuturesGet(path, params, apiKey, apiSecret);
}

function sideDelta(side, qty) {
  return String(side).toUpperCase() === "BUY" ? qty : -qty;
}

function bucketDelta(positionSide, side, qty) {
  const ps = String(positionSide || "BOTH").toUpperCase();
  if (ps === "LONG") return { bucket: "LONG", delta: sideDelta(side, qty) };
  if (ps === "SHORT") return { bucket: "SHORT", delta: sideDelta(side, qty) * -1 };
  return { bucket: "BOTH", delta: sideDelta(side, qty) };
}

function inferOpenPositionMs(trades, direction) {
  const state = {
    LONG: { qty: 0, openAt: null },
    SHORT: { qty: 0, openAt: null },
    BOTH: { qty: 0, openAt: null, direction: null },
  };
  const sorted = [...(trades || [])].sort(
    (a, b) => Number(a.time) - Number(b.time)
  );

  for (const t of sorted) {
    const qty = Number(t.qty);
    const tm = Number(t.time);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(tm)) continue;

    const { bucket, delta } = bucketDelta(t.positionSide, t.side, qty);
    const s = state[bucket];
    const prev = s.qty;
    const next = prev + delta;

    if (bucket === "BOTH") {
      const prevSign = Math.sign(prev);
      const nextSign = Math.sign(next);

      if (prev === 0 && next !== 0) {
        s.openAt = tm;
        s.direction = next > 0 ? "LONG" : "SHORT";
      } else if (prev !== 0 && next === 0) {
        s.openAt = null;
        s.direction = null;
      } else if (prev !== 0 && next !== 0 && prevSign !== nextSign) {
        s.openAt = tm;
        s.direction = next > 0 ? "LONG" : "SHORT";
      }
      s.qty = next;
      continue;
    }

    if (prev <= 0 && next > 0) {
      s.openAt = tm;
    } else if (prev > 0 && next <= 0) {
      s.openAt = next > 0 ? tm : null;
    }
    s.qty = Math.max(0, next);
  }

  const dir = String(direction || "").toUpperCase();
  if (state.BOTH.qty !== 0) {
    const openDir =
      state.BOTH.direction || (state.BOTH.qty > 0 ? "LONG" : "SHORT");
    if (openDir === dir) return state.BOTH.openAt;
  }
  if (dir === "LONG" && state.LONG.qty > 0) return state.LONG.openAt;
  if (dir === "SHORT" && state.SHORT.qty > 0) return state.SHORT.openAt;
  return null;
}

function sortPositionsByDurationNewest(positions) {
  return [...positions].sort((a, b) => {
    const ad = a.durationSec ?? Number.POSITIVE_INFINITY;
    const bd = b.durationSec ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return String(a.symbol ?? "").localeCompare(String(b.symbol ?? ""));
  });
}

function pnlFromMark(amt, entryPrice, markPrice) {
  if (
    !Number.isFinite(amt) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(markPrice)
  ) {
    return null;
  }
  const qty = Math.abs(amt);
  if (qty <= 0) return null;
  return amt > 0
    ? (markPrice - entryPrice) * qty
    : (entryPrice - markPrice) * qty;
}

function formatOpenPosition(row, openedAtMs, now = Date.now()) {
  const sym = row.symbol ?? row.s;
  const amt = Number(row.positionAmt ?? row.pa);
  if (!sym || !Number.isFinite(amt) || Math.abs(amt) < 1e-12) return null;

  const entryPrice =
    row.entryPrice != null
      ? Number(row.entryPrice)
      : row.ep != null
        ? Number(row.ep)
        : null;
  const markPrice =
    row.markPrice != null
      ? Number(row.markPrice)
      : row.mp != null
        ? Number(row.mp)
        : null;
  const leverage = Number(row.leverage ?? row.le);
  let pnl =
    row.unRealizedProfit != null
      ? Number(row.unRealizedProfit)
      : row.unrealizedProfit != null
        ? Number(row.unrealizedProfit)
        : row.up != null
          ? Number(row.up)
          : null;
  if (!Number.isFinite(pnl)) {
    pnl = pnlFromMark(amt, entryPrice, markPrice);
  }

  const notionalAtEntry =
    Number.isFinite(amt) && Number.isFinite(entryPrice)
      ? Math.abs(amt * entryPrice)
      : null;
  const isolatedWallet =
    row.isolatedWallet != null
      ? Number(row.isolatedWallet)
      : row.iw != null
        ? Number(row.iw)
        : null;
  let margin = null;
  if (Number.isFinite(isolatedWallet) && isolatedWallet > 0) {
    margin = isolatedWallet;
  } else if (
    Number.isFinite(notionalAtEntry) &&
    Number.isFinite(leverage) &&
    leverage > 0
  ) {
    margin = notionalAtEntry / leverage;
  }
  const roiPct =
    Number.isFinite(pnl) &&
    Number.isFinite(notionalAtEntry) &&
    notionalAtEntry > 0
      ? ((pnl / notionalAtEntry) * 100) *
        (Number.isFinite(leverage) && leverage > 0 ? leverage : 1)
      : null;
  const side = String(row.positionSide || row.ps || "").toUpperCase();
  let direction = amt > 0 ? "LONG" : "SHORT";
  if (side === "LONG" || side === "SHORT") direction = side;

  const updateTime =
    row.updateTime != null ? Number(row.updateTime) : null;

  const out = {
    symbol: sym,
    direction,
    positionAmt: amt,
    leverage: Number.isFinite(leverage) ? leverage : null,
    margin: Number.isFinite(margin) ? +margin.toFixed(2) : null,
    pnl: Number.isFinite(pnl) ? +pnl.toFixed(4) : null,
    roiPct: Number.isFinite(roiPct) ? +roiPct.toFixed(3) : null,
    entryPrice,
    markPrice: Number.isFinite(markPrice) ? markPrice : null,
    updateTime: Number.isFinite(updateTime) ? updateTime : null,
  };

  if (openedAtMs != null && Number.isFinite(openedAtMs)) {
    out.openedAtMs = openedAtMs;
    out.openedAt = formatIsoUtcPlus3(openedAtMs);
    out.durationSec = Math.max(0, Math.round((now - openedAtMs) / 1000));
  } else if (Number.isFinite(updateTime) && updateTime > 0) {
    out.openedAtMs = updateTime;
    out.openedAt = formatIsoUtcPlus3(updateTime);
    out.durationSec = Math.max(0, Math.round((now - updateTime) / 1000));
  } else {
    out.openedAtMs = null;
    out.openedAt = null;
    out.durationSec = null;
  }

  return out;
}

function parseOpenPositions(rows) {
  return (rows ?? [])
    .map((row) => formatOpenPosition(row, null))
    .filter(Boolean);
}

function snapshotPositionsFromMap(positionMap, openedAtBySymbol = new Map()) {
  const now = Date.now();
  const positions = [];
  for (const pos of positionMap.values()) {
    const openedAtMs = openedAtBySymbol.get(pos.symbol) ?? null;
    const formatted = formatOpenPosition(pos, openedAtMs, now);
    if (formatted) positions.push(formatted);
  }
  return sortPositionsByDurationNewest(positions);
}

function rememberPositionOpenTimes(positions, openedAtBySymbol) {
  const now = Date.now();
  const seen = new Set();
  for (const p of positions || []) {
    if (!p?.symbol) continue;
    seen.add(p.symbol);
    let ms = null;
    if (p.openedAtMs != null && Number.isFinite(p.openedAtMs)) {
      ms = p.openedAtMs;
    } else if (typeof p.openedAt === "number" && Number.isFinite(p.openedAt)) {
      ms = p.openedAt;
    } else if (p.openedAt) {
      ms = parseDisplayIso(p.openedAt);
    }
    if (ms == null && p.durationSec != null) {
      ms = now - Number(p.durationSec) * 1000;
    }
    if (ms != null) openedAtBySymbol.set(p.symbol, ms);
  }
  for (const sym of [...openedAtBySymbol.keys()]) {
    if (!seen.has(sym)) openedAtBySymbol.delete(sym);
  }
}

async function enrichOpenPositionTimes(positions, credentials) {
  const now = Date.now();
  const startTime = now - TRADE_LOOKBACK_MS;
  const { apiKey, apiSecret } = credentials;

  await Promise.all(
    positions.map(async (p) => {
      let openedAtMs = null;
      try {
        const trades = await signedGet(
          "/fapi/v1/userTrades",
          {
            symbol: p.symbol,
            startTime: String(startTime),
            limit: "1000",
          },
          apiKey,
          apiSecret
        );
        openedAtMs = inferOpenPositionMs(trades, p.direction);
      } catch {
        // Fall back to Binance position updateTime below.
      }
      if (openedAtMs == null && Number.isFinite(p.updateTime) && p.updateTime > 0) {
        openedAtMs = p.updateTime;
      }
      if (openedAtMs != null) {
        p.openedAtMs = openedAtMs;
        p.openedAt = formatIsoUtcPlus3(openedAtMs);
        p.durationSec = Math.max(0, Math.round((now - openedAtMs) / 1000));
      } else {
        p.openedAtMs = null;
        p.openedAt = null;
        p.durationSec = null;
      }
    })
  );

  return sortPositionsByDurationNewest(positions);
}

async function fetchOpenPositions(credentials) {
  const rows = await signedGet(
    "/fapi/v2/positionRisk",
    {},
    credentials.apiKey,
    credentials.apiSecret
  );
  const positions = parseOpenPositions(rows);
  if (!positions.length) return positions;
  return enrichOpenPositionTimes(positions, credentials);
}

async function fetchUsdtFuturesBalance(credentials) {
  const rows = await signedGet(
    "/fapi/v2/balance",
    {},
    credentials.apiKey,
    credentials.apiSecret
  );
  const usdt = (rows || []).find((r) => String(r.asset || "").toUpperCase() === "USDT");
  if (!usdt) return null;
  const wallet = Number(usdt.balance);
  return Number.isFinite(wallet) ? +wallet.toFixed(8) : null;
}

function createPositionsProvider(options = {}) {
  const kv = options.kv ?? new Map();
  const credentials = resolveBinanceCredentials(kv);

  async function getOpenPositions() {
    const now = Date.now();
    if (cache.data && now - cache.at < CACHE_MS) {
      return cache.data;
    }

    if (!credentials.enabled) {
      const out = {
        enabled: false,
        updatedAt: formatIsoUtcPlus3(now),
        positions: [],
        totalPnl: null,
        hint: "Set BINANCE_API_KEY and BINANCE_API_SECRET in .env (Futures read)",
      };
      cache = { at: now, data: out };
      return out;
    }

    try {
      const positions = await fetchOpenPositions(credentials);
      const totalPnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
      const out = {
        enabled: true,
        updatedAt: formatIsoUtcPlus3(now),
        positions,
        totalPnl: +totalPnl.toFixed(4),
        hint: null,
      };
      cache = { at: now, data: out };
      return out;
    } catch (e) {
      const out = {
        enabled: true,
        updatedAt: formatIsoUtcPlus3(now),
        positions: [],
        totalPnl: null,
        error: e.message || String(e),
        hint: null,
      };
      cache = { at: now, data: out };
      return out;
    }
  }

  getOpenPositions.invalidateCache = () => {
    cache = { at: 0, data: null };
  };

  return getOpenPositions;
}

function createFuturesBalanceProvider(options = {}) {
  const kv = options.kv ?? new Map();
  const credentials = resolveBinanceCredentials(kv);

  return async function getFuturesBalance() {
    const now = Date.now();
    if (balanceCache.data && now - balanceCache.at < CACHE_MS) {
      return balanceCache.data;
    }
    if (!credentials.enabled) {
      const out = {
        enabled: false,
        updatedAt: formatIsoUtcPlus3(now),
        usdtBalance: null,
        hint: "Set BINANCE_API_KEY and BINANCE_API_SECRET in .env (Futures read)",
      };
      balanceCache = { at: now, data: out };
      return out;
    }
    try {
      const usdtBalance = await fetchUsdtFuturesBalance(credentials);
      const out = {
        enabled: true,
        updatedAt: formatIsoUtcPlus3(now),
        usdtBalance,
        hint: null,
      };
      balanceCache = { at: now, data: out };
      return out;
    } catch (e) {
      const out = {
        enabled: true,
        updatedAt: formatIsoUtcPlus3(now),
        usdtBalance: null,
        error: e.message || String(e),
        hint: null,
      };
      balanceCache = { at: now, data: out };
      return out;
    }
  };
}

module.exports = {
  createPositionsProvider,
  createFuturesBalanceProvider,
  resolveBinanceCredentials,
  parseOpenPositions,
  snapshotPositionsFromMap,
  rememberPositionOpenTimes,
};
