const crypto = require("crypto");
const { loadEnvFile } = require("./load-env");
const { formatIsoUtcPlus3 } = require("./time-format");

const REST_BASE = "https://fapi.binance.com";
const CACHE_MS = 5000;

let cache = { at: 0, data: null };

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
  const timestamp = Date.now();
  const qs = new URLSearchParams({ ...params, timestamp: String(timestamp) });
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(qs.toString())
    .digest("hex");
  qs.set("signature", signature);

  const url = `${REST_BASE}${path}?${qs}`;
  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.msg || body?.message || text || res.statusText;
    throw new Error(msg);
  }
  return body;
}

function parseOpenPositions(rows) {
  return (rows ?? [])
    .filter((row) => {
      const amt = Number(row.positionAmt);
      return Number.isFinite(amt) && Math.abs(amt) > 0;
    })
    .map((row) => {
      const amt = Number(row.positionAmt);
      const pnl = Number(row.unRealizedProfit);
      const entryPrice = row.entryPrice != null ? Number(row.entryPrice) : null;
      const notionalAtEntry =
        Number.isFinite(amt) && Number.isFinite(entryPrice)
          ? Math.abs(amt * entryPrice)
          : null;
      const roiPct =
        Number.isFinite(pnl) && Number.isFinite(notionalAtEntry) && notionalAtEntry > 0
          ? (pnl / notionalAtEntry) * 100
          : null;
      const side = String(row.positionSide || "").toUpperCase();
      let direction = amt > 0 ? "LONG" : "SHORT";
      if (side === "LONG" || side === "SHORT") direction = side;

      return {
        symbol: row.symbol,
        direction,
        positionAmt: amt,
        pnl: Number.isFinite(pnl) ? +pnl.toFixed(4) : null,
        roiPct: Number.isFinite(roiPct) ? +roiPct.toFixed(3) : null,
        entryPrice,
        markPrice: row.markPrice != null ? Number(row.markPrice) : null,
      };
    })
    .sort((a, b) => Math.abs(b.pnl ?? 0) - Math.abs(a.pnl ?? 0));
}

async function fetchOpenPositions(credentials) {
  const rows = await signedGet(
    "/fapi/v2/positionRisk",
    {},
    credentials.apiKey,
    credentials.apiSecret
  );
  return parseOpenPositions(rows);
}

function createPositionsProvider(options = {}) {
  const kv = options.kv ?? new Map();
  const credentials = resolveBinanceCredentials(kv);

  return async function getOpenPositions() {
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
  };
}

module.exports = {
  createPositionsProvider,
  resolveBinanceCredentials,
  parseOpenPositions,
};
