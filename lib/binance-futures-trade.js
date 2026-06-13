const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveBinanceCredentials } = require("./binance-positions");
const { dataPath } = require("./data-dir");

const REST_BASE = "https://fapi.binance.com";
const EXCHANGE_INFO_FILE = () => dataPath("futures-exchangeInfo-full.json");
const EXCHANGE_INFO_TTL_MS = 24 * 60 * 60 * 1000;

let symbolMetaCache = null;
let symbolMetaLoadedAt = 0;

function floorToStep(value, step) {
  const s = Number(step);
  const v = Number(value);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(v)) return null;
  const precision = Math.max(0, (String(s).split(".")[1] || "").length);
  const n = Math.floor(v / s) * s;
  return +n.toFixed(precision);
}

function parseSymbolMeta(row) {
  const lot = (row.filters || []).find((f) => f.filterType === "LOT_SIZE");
  const price = (row.filters || []).find((f) => f.filterType === "PRICE_FILTER");
  const minNotional = (row.filters || []).find(
    (f) => f.filterType === "MIN_NOTIONAL"
  );
  return {
    symbol: row.symbol,
    status: row.status,
    quantityPrecision: row.quantityPrecision,
    pricePrecision: row.pricePrecision,
    stepSize: lot?.stepSize ? Number(lot.stepSize) : null,
    minQty: lot?.minQty ? Number(lot.minQty) : null,
    tickSize: price?.tickSize ? Number(price.tickSize) : null,
    minNotional: minNotional?.notional
      ? Number(minNotional.notional)
      : minNotional?.minNotional
        ? Number(minNotional.minNotional)
        : 5,
  };
}

async function signedRequest(method, apiPath, params, apiKey, apiSecret) {
  const timestamp = Date.now();
  const qs = new URLSearchParams({ ...params, timestamp: String(timestamp) });
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(qs.toString())
    .digest("hex");
  qs.set("signature", signature);

  const url = `${REST_BASE}${apiPath}?${qs}`;
  const res = await fetch(url, {
    method,
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
    const err = new Error(msg);
    err.code = body?.code;
    throw err;
  }
  return body;
}

async function fetchExchangeInfoMap() {
  const res = await fetch(`${REST_BASE}/fapi/v1/exchangeInfo`);
  const info = await res.json();
  if (!res.ok) throw new Error(info?.msg || "exchangeInfo failed");
  const map = new Map();
  for (const row of info.symbols || []) {
    if (row.contractType !== "PERPETUAL" || row.quoteAsset !== "USDT") continue;
    map.set(row.symbol, parseSymbolMeta(row));
  }
  try {
    fs.mkdirSync(path.dirname(EXCHANGE_INFO_FILE()), { recursive: true });
    fs.writeFileSync(
      EXCHANGE_INFO_FILE(),
      JSON.stringify({ savedAt: Date.now(), symbols: [...map.entries()] })
    );
  } catch {
    /* cache optional */
  }
  return map;
}

async function loadSymbolMetaMap() {
  const now = Date.now();
  if (symbolMetaCache && now - symbolMetaLoadedAt < EXCHANGE_INFO_TTL_MS) {
    return symbolMetaCache;
  }
  try {
    const raw = fs.readFileSync(EXCHANGE_INFO_FILE(), "utf8");
    const data = JSON.parse(raw);
    if (data?.symbols?.length && now - (data.savedAt ?? 0) < EXCHANGE_INFO_TTL_MS) {
      symbolMetaCache = new Map(data.symbols);
      symbolMetaLoadedAt = data.savedAt ?? now;
      return symbolMetaCache;
    }
  } catch {
    /* fetch fresh */
  }
  symbolMetaCache = await fetchExchangeInfoMap();
  symbolMetaLoadedAt = now;
  return symbolMetaCache;
}

function formatQty(quantity, meta) {
  if (!meta?.stepSize) return null;
  const q = floorToStep(quantity, meta.stepSize);
  if (q == null || (meta.minQty != null && q < meta.minQty)) return null;
  return q;
}

function formatPrice(price, meta) {
  if (!meta?.tickSize) return null;
  return floorToStep(price, meta.tickSize);
}

function clientOrderId(prefix, symbol) {
  return `${prefix}_${symbol}_${Date.now()}`.slice(0, 36);
}

function createFuturesTrader(options = {}) {
  const kv = options.kv ?? new Map();
  const credentials = resolveBinanceCredentials(kv);

  async function requireCreds() {
    if (!credentials.enabled) {
      throw new Error(
        "Binance API not configured (BINANCE_API_KEY + BINANCE_API_SECRET)"
      );
    }
    return credentials;
  }

  async function getSymbolMeta(symbol) {
    const map = await loadSymbolMetaMap();
    const meta = map.get(symbol);
    if (!meta) throw new Error(`Unknown symbol: ${symbol}`);
    return meta;
  }

  async function getUsdtBalance() {
    const { apiKey, apiSecret } = await requireCreds();
    const rows = await signedRequest("GET", "/fapi/v2/balance", {}, apiKey, apiSecret);
    const usdt = (rows || []).find(
      (r) => String(r.asset || "").toUpperCase() === "USDT"
    );
    if (!usdt) return { wallet: 0, available: 0 };
    return {
      wallet: Number(usdt.balance) || 0,
      available: Number(usdt.availableBalance) || 0,
      crossWallet: Number(usdt.crossWalletBalance) || 0,
    };
  }

  async function getPosition(symbol) {
    const { apiKey, apiSecret } = await requireCreds();
    const rows = await signedRequest(
      "GET",
      "/fapi/v2/positionRisk",
      { symbol },
      apiKey,
      apiSecret
    );
    const row = (rows || []).find((r) => r.symbol === symbol);
    if (!row) return null;
    const amt = Number(row.positionAmt);
    if (!Number.isFinite(amt) || Math.abs(amt) < 1e-12) return null;
    return {
      symbol,
      positionAmt: amt,
      entryPrice: Number(row.entryPrice),
      markPrice: Number(row.markPrice),
      unrealizedProfit: Number(row.unRealizedProfit),
      leverage: Number(row.leverage),
      marginType: row.marginType,
      isolatedWallet: Number(row.isolatedWallet),
      liquidationPrice: Number(row.liquidationPrice),
    };
  }

  async function ensureIsolated(symbol) {
    const { apiKey, apiSecret } = await requireCreds();
    try {
      await signedRequest(
        "POST",
        "/fapi/v1/marginType",
        { symbol, marginType: "ISOLATED" },
        apiKey,
        apiSecret
      );
      return { changed: true };
    } catch (e) {
      if (e.code === -4046 || /No need to change margin type/i.test(e.message)) {
        return { changed: false };
      }
      throw e;
    }
  }

  async function ensureLeverage(symbol, leverage) {
    const lev = Math.max(1, Math.min(125, Math.round(Number(leverage) || 1)));
    const { apiKey, apiSecret } = await requireCreds();
    const body = await signedRequest(
      "POST",
      "/fapi/v1/leverage",
      { symbol, leverage: String(lev) },
      apiKey,
      apiSecret
    );
    return { leverage: Number(body.leverage) || lev };
  }

  async function cancelAllOrders(symbol) {
    const { apiKey, apiSecret } = await requireCreds();
    return signedRequest(
      "DELETE",
      "/fapi/v1/allOpenOrders",
      { symbol },
      apiKey,
      apiSecret
    );
  }

  async function getOpenOrders(symbol) {
    const { apiKey, apiSecret } = await requireCreds();
    return signedRequest(
      "GET",
      "/fapi/v1/openOrders",
      { symbol },
      apiKey,
      apiSecret
    );
  }

  async function marketOrder(symbol, side, quantity, opts = {}) {
    const meta = await getSymbolMeta(symbol);
    const qty = formatQty(quantity, meta);
    if (!qty) throw new Error(`Invalid quantity for ${symbol}`);
    const notional = qty * (opts.markPrice || opts.price || 0);
    if (opts.markPrice && meta.minNotional && notional < meta.minNotional) {
      throw new Error(
        `Notional $${notional.toFixed(2)} below min $${meta.minNotional} for ${symbol}`
      );
    }
    const { apiKey, apiSecret } = await requireCreds();
    const params = {
      symbol,
      side,
      type: "MARKET",
      quantity: String(qty),
      newClientOrderId: clientOrderId("vol", symbol),
    };
    if (opts.reduceOnly) params.reduceOnly = "true";
    return signedRequest("POST", "/fapi/v1/order", params, apiKey, apiSecret);
  }

  async function placeCloseStop(symbol, stopPrice) {
    const meta = await getSymbolMeta(symbol);
    const sp = formatPrice(stopPrice, meta);
    if (!sp) throw new Error(`Invalid stop price for ${symbol}`);
    const { apiKey, apiSecret } = await requireCreds();
    return signedRequest(
      "POST",
      "/fapi/v1/order",
      {
        symbol,
        side: "SELL",
        type: "STOP_MARKET",
        stopPrice: String(sp),
        closePosition: "true",
        workingType: "MARK_PRICE",
        newClientOrderId: clientOrderId("volsl", symbol),
      },
      apiKey,
      apiSecret
    );
  }

  async function placeCloseTakeProfit(symbol, stopPrice) {
    const meta = await getSymbolMeta(symbol);
    const sp = formatPrice(stopPrice, meta);
    if (!sp) throw new Error(`Invalid TP price for ${symbol}`);
    const { apiKey, apiSecret } = await requireCreds();
    return signedRequest(
      "POST",
      "/fapi/v1/order",
      {
        symbol,
        side: "SELL",
        type: "TAKE_PROFIT_MARKET",
        stopPrice: String(sp),
        closePosition: "true",
        workingType: "MARK_PRICE",
        newClientOrderId: clientOrderId("voltp", symbol),
      },
      apiKey,
      apiSecret
    );
  }

  async function prepareSymbol(symbol, leverage) {
    await ensureIsolated(symbol);
    const { leverage: lev } = await ensureLeverage(symbol, leverage);
    return { marginType: "ISOLATED", leverage: lev };
  }

  return {
    enabled: credentials.enabled,
    credentials,
    getSymbolMeta,
    formatQty,
    formatPrice,
    getUsdtBalance,
    getPosition,
    ensureIsolated,
    ensureLeverage,
    prepareSymbol,
    marketOrder,
    placeCloseStop,
    placeCloseTakeProfit,
    cancelAllOrders,
    getOpenOrders,
    signedRequest: async (method, apiPath, params) => {
      const { apiKey, apiSecret } = await requireCreds();
      return signedRequest(method, apiPath, params, apiKey, apiSecret);
    },
  };
}

module.exports = {
  createFuturesTrader,
  floorToStep,
  formatQty,
  formatPrice,
  loadSymbolMetaMap,
};
