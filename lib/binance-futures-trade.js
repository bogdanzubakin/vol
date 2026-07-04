const fs = require("fs");
const path = require("path");
const { resolveBinanceCredentials } = require("./binance-positions");
const { signedFuturesRequest } = require("./binance-signed");
const { dataPath } = require("./data-dir");

const REST_BASE = "https://fapi.binance.com";
const EXCHANGE_INFO_FILE = () => dataPath("futures-exchangeInfo-full.json");
const EXCHANGE_INFO_TTL_MS = 24 * 60 * 60 * 1000;

let symbolMetaCache = null;
let symbolMetaLoadedAt = 0;

function decimalsForStep(step) {
  if (step == null || step === "") return 0;
  const raw = String(step).trim();
  if (raw.includes(".") && !/e/i.test(raw)) {
    return (raw.split(".")[1] || "").length;
  }
  const n = Number(step);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 0;
  // Binance tick sizes like 0.0000001 become 1e-7 in JS — derive decimals from magnitude.
  return Math.max(0, Math.round(-Math.log10(n) + 1e-9));
}

function floorToStep(value, step) {
  const s = Number(step);
  const v = Number(value);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(v)) return null;
  const precision = decimalsForStep(step);
  const n = Math.floor(v / s + 1e-9) * s;
  const out = +n.toFixed(precision);
  return out > 0 ? out : null;
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
    stepSizeStr: lot?.stepSize ?? null,
    minQty: lot?.minQty ? Number(lot.minQty) : null,
    tickSize: price?.tickSize ? Number(price.tickSize) : null,
    tickSizeStr: price?.tickSize ?? null,
    minPrice: price?.minPrice ? Number(price.minPrice) : null,
    maxPrice: price?.maxPrice ? Number(price.maxPrice) : null,
    minNotional: minNotional?.notional
      ? Number(minNotional.notional)
      : minNotional?.minNotional
        ? Number(minNotional.minNotional)
        : 5,
  };
}

async function signedRequest(method, apiPath, params, apiKey, apiSecret) {
  return signedFuturesRequest(method, apiPath, params, apiKey, apiSecret);
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
  const step = meta?.tickSizeStr ?? meta?.tickSize;
  if (!step) return null;
  const formatted = floorToStep(price, step);
  if (formatted == null) return null;
  if (meta?.minPrice != null && formatted < meta.minPrice) return null;
  if (meta?.maxPrice != null && formatted > meta.maxPrice) return null;
  return formatted;
}

function clientOrderId(prefix, symbol) {
  return `${prefix}_${symbol}_${Date.now()}`.slice(0, 36);
}

function isImmediateTriggerError(err) {
  return (
    err?.code === -2021 ||
    /would immediately trigger/i.test(String(err?.message || ""))
  );
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

  const POSITION_CACHE_TTL_MS = 15_000;
  const BALANCE_CACHE_TTL_MS = 15_000;
  const ALGO_ORDERS_CACHE_TTL_MS = 15_000;

  let positionCache = { at: 0, map: null, inflight: null };
  let balanceCache = { at: 0, data: null, inflight: null };
  let algoOrdersCache = { at: 0, all: null, inflight: null };

  function invalidateRestCache() {
    positionCache = { at: 0, map: null, inflight: null };
    balanceCache = { at: 0, data: null, inflight: null };
    algoOrdersCache = { at: 0, all: null, inflight: null };
  }

  function parseWsPositionRow(row) {
    const sym = row?.s || row?.symbol;
    const amt = Number(row?.pa ?? row?.positionAmt);
    if (!sym || !Number.isFinite(amt) || Math.abs(amt) < 1e-12) return null;
    const existing = positionCache.map?.get(sym);
    return {
      symbol: sym,
      positionAmt: amt,
      entryPrice: Number(row.ep ?? row.entryPrice),
      markPrice: Number(row.mp ?? row.markPrice ?? existing?.markPrice ?? row.ep),
      unrealizedProfit: Number(row.up ?? row.unRealizedProfit ?? row.unrealizedProfit),
      leverage: Number(row.le ?? row.leverage),
      marginType: row.mt ?? row.marginType,
      isolatedWallet: Number(row.iw ?? row.isolatedWallet),
      liquidationPrice: Number(row.lp ?? row.liquidationPrice ?? existing?.liquidationPrice),
      updateTime: Number(row.uT ?? row.updateTime) || existing?.updateTime || null,
    };
  }

  function applyWsAccountUpdate(account = {}) {
    const now = Date.now();
    for (const b of account.B || []) {
      if (String(b.a || b.asset || "").toUpperCase() !== "USDT") continue;
      balanceCache = {
        at: now,
        data: {
          wallet: Number(b.wb ?? b.balance) || 0,
          available: Number(b.cw ?? b.crossWalletBalance ?? b.availableBalance) || 0,
          crossWallet: Number(b.cw ?? b.crossWalletBalance) || 0,
        },
        inflight: null,
      };
      break;
    }

    const map = positionCache.map ? new Map(positionCache.map) : new Map();
    for (const row of account.P || []) {
      const sym = row?.s || row?.symbol;
      if (!sym) continue;
      const pos = parseWsPositionRow(row);
      if (pos) map.set(sym, pos);
      else map.delete(sym);
    }
    positionCache = { at: now, map, inflight: null };
  }

  function applyMarkPrice(symbol, price) {
    if (!symbol || !Number.isFinite(price) || !positionCache.map) return;
    const pos = positionCache.map.get(symbol);
    if (!pos) return;
    pos.markPrice = price;
    positionCache.at = Date.now();
  }

  function parsePositionRow(row) {
    const sym = row?.symbol;
    const amt = Number(row?.positionAmt);
    if (!sym || !Number.isFinite(amt) || Math.abs(amt) < 1e-12) return null;
    return {
      symbol: sym,
      positionAmt: amt,
      entryPrice: Number(row.entryPrice),
      markPrice: Number(row.markPrice),
      unrealizedProfit: Number(row.unRealizedProfit),
      leverage: Number(row.leverage),
      marginType: row.marginType,
      isolatedWallet: Number(row.isolatedWallet),
      liquidationPrice: Number(row.liquidationPrice),
      updateTime: Number(row.updateTime) || null,
    };
  }

  async function fetchAllPositions() {
    const { apiKey, apiSecret } = await requireCreds();
    const rows = await signedRequest(
      "GET",
      "/fapi/v2/positionRisk",
      {},
      apiKey,
      apiSecret
    );
    const map = new Map();
    for (const row of rows || []) {
      const pos = parsePositionRow(row);
      if (pos) map.set(pos.symbol, pos);
    }
    return map;
  }

  async function getPositionMap({ force = false } = {}) {
    const now = Date.now();
    if (!force && positionCache.map && now - positionCache.at < POSITION_CACHE_TTL_MS) {
      return positionCache.map;
    }
    if (positionCache.inflight) return positionCache.inflight;
    positionCache.inflight = fetchAllPositions()
      .then((map) => {
        positionCache = { at: Date.now(), map, inflight: null };
        return map;
      })
      .catch((e) => {
        positionCache.inflight = null;
        throw e;
      });
    return positionCache.inflight;
  }

  async function getUsdtBalance({ force = false } = {}) {
    const now = Date.now();
    if (!force && balanceCache.data && now - balanceCache.at < BALANCE_CACHE_TTL_MS) {
      return balanceCache.data;
    }
    if (balanceCache.inflight) return balanceCache.inflight;
    balanceCache.inflight = (async () => {
      const { apiKey, apiSecret } = await requireCreds();
      const rows = await signedRequest("GET", "/fapi/v2/balance", {}, apiKey, apiSecret);
      const usdt = (rows || []).find(
        (r) => String(r.asset || "").toUpperCase() === "USDT"
      );
      const data = !usdt
        ? { wallet: 0, available: 0 }
        : {
            wallet: Number(usdt.balance) || 0,
            available: Number(usdt.availableBalance) || 0,
            crossWallet: Number(usdt.crossWalletBalance) || 0,
          };
      balanceCache = { at: Date.now(), data, inflight: null };
      return data;
    })().catch((e) => {
      balanceCache.inflight = null;
      throw e;
    });
    return balanceCache.inflight;
  }

  async function getPosition(symbol, { force = false } = {}) {
    const map = await getPositionMap({ force });
    return map.get(symbol) ?? null;
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
    await signedRequest(
      "DELETE",
      "/fapi/v1/allOpenOrders",
      { symbol },
      apiKey,
      apiSecret
    ).catch((e) => {
      if (e.code !== -2011 && !/Unknown order sent/i.test(e.message)) throw e;
    });
    await signedRequest(
      "DELETE",
      "/fapi/v1/algoOpenOrders",
      { symbol },
      apiKey,
      apiSecret
    ).catch((e) => {
      if (e.code !== -2011 && !/Unknown order sent/i.test(e.message)) throw e;
    });
    invalidateRestCache();
  }

  async function placeAlgoCloseOrder(symbol, type, triggerPrice, closeSide = "SELL") {
    const meta = await getSymbolMeta(symbol);
    const tp = formatPrice(triggerPrice, meta);
    if (!tp) {
      throw new Error(
        `Invalid trigger price for ${symbol} (raw ${triggerPrice}, tick ${meta.tickSizeStr ?? meta.tickSize})`
      );
    }
    const { apiKey, apiSecret } = await requireCreds();
    const prefix = type === "STOP_MARKET" ? "volsl" : "voltp";
    const result = await signedRequest(
      "POST",
      "/fapi/v1/algoOrder",
      {
        algoType: "CONDITIONAL",
        symbol,
        side: closeSide,
        type,
        triggerPrice: String(tp),
        closePosition: "true",
        workingType: "MARK_PRICE",
        clientAlgoId: clientOrderId(prefix, symbol),
      },
      apiKey,
      apiSecret
    );
    invalidateRestCache();
    return result;
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

  function normalizeAlgoOrders(body) {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.orders)) return body.orders;
    return [];
  }

  function isCloseStopAlgo(order, closeSide = null) {
    const type = String(order?.orderType || order?.type || "").toUpperCase();
    if (type !== "STOP_MARKET") return false;
    const side = String(order?.side || "").toUpperCase();
    if (closeSide) {
      if (side && side !== closeSide) return false;
    } else if (side !== "SELL" && side !== "BUY") {
      return false;
    }
    const cp = order?.closePosition;
    return cp === true || cp === "true" || cp === "1" || side === "SELL" || side === "BUY";
  }

  function isCloseTakeProfitAlgo(order, closeSide = null) {
    const type = String(order?.orderType || order?.type || "").toUpperCase();
    if (type !== "TAKE_PROFIT_MARKET") return false;
    const side = String(order?.side || "").toUpperCase();
    if (closeSide) {
      if (side && side !== closeSide) return false;
    } else if (side !== "SELL" && side !== "BUY") {
      return false;
    }
    const cp = order?.closePosition;
    return cp === true || cp === "true" || cp === "1" || side === "SELL" || side === "BUY";
  }

  function pickCloseStopAlgo(orders, closeSide = null) {
    return normalizeAlgoOrders(orders).find((o) => isCloseStopAlgo(o, closeSide)) ?? null;
  }

  function pickCloseTakeProfitAlgo(orders, closeSide = null) {
    return normalizeAlgoOrders(orders).find((o) =>
      isCloseTakeProfitAlgo(o, closeSide)
    ) ?? null;
  }

  function hasCloseStopLoss(orders, closeSide = null) {
    return pickCloseStopAlgo(orders, closeSide) != null;
  }

  function hasCloseTakeProfit(orders, closeSide = null) {
    return pickCloseTakeProfitAlgo(orders, closeSide) != null;
  }

  async function fetchAllAlgoOpenOrders({ force = false } = {}) {
    const now = Date.now();
    if (!force && algoOrdersCache.all && now - algoOrdersCache.at < ALGO_ORDERS_CACHE_TTL_MS) {
      return algoOrdersCache.all;
    }
    if (algoOrdersCache.inflight) return algoOrdersCache.inflight;
    algoOrdersCache.inflight = (async () => {
      const { apiKey, apiSecret } = await requireCreds();
      const body = await signedRequest(
        "GET",
        "/fapi/v1/openAlgoOrders",
        {},
        apiKey,
        apiSecret
      );
      const all = normalizeAlgoOrders(body);
      algoOrdersCache = { at: Date.now(), all, inflight: null };
      return all;
    })().catch((e) => {
      algoOrdersCache.inflight = null;
      throw e;
    });
    return algoOrdersCache.inflight;
  }

  async function getAlgoOpenOrders(symbol, { force = false } = {}) {
    const all = await fetchAllAlgoOpenOrders({ force });
    if (!symbol) return all;
    return all.filter((o) => o?.symbol === symbol);
  }

  async function cancelAlgoOrder(algoId) {
    const { apiKey, apiSecret } = await requireCreds();
    const result = await signedRequest(
      "DELETE",
      "/fapi/v1/algoOrder",
      { algoId: String(algoId) },
      apiKey,
      apiSecret
    );
    invalidateRestCache();
    return result;
  }

  async function cancelStopOrders(symbol) {
    const orders = await getAlgoOpenOrders(symbol);
    for (const order of orders) {
      if (!isCloseStopAlgo(order) || order.algoId == null) continue;
      await cancelAlgoOrder(order.algoId).catch((e) => {
        if (e.code !== -2011 && !/Unknown order sent/i.test(e.message)) throw e;
      });
    }
  }

  async function cancelTakeProfitOrders(symbol) {
    const orders = await getAlgoOpenOrders(symbol);
    for (const order of orders) {
      if (!isCloseTakeProfitAlgo(order) || order.algoId == null) continue;
      await cancelAlgoOrder(order.algoId).catch((e) => {
        if (e.code !== -2011 && !/Unknown order sent/i.test(e.message)) throw e;
      });
    }
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
    const result = await signedRequest("POST", "/fapi/v1/order", params, apiKey, apiSecret);
    invalidateRestCache();
    return result;
  }

  async function placeCloseStop(symbol, stopPrice, closeSide = "SELL") {
    return placeAlgoCloseOrder(symbol, "STOP_MARKET", stopPrice, closeSide);
  }

  async function placeCloseTakeProfit(symbol, stopPrice, closeSide = "SELL") {
    return placeAlgoCloseOrder(symbol, "TAKE_PROFIT_MARKET", stopPrice, closeSide);
  }

  async function prepareSymbol(symbol, leverage) {
    await ensureIsolated(symbol);
    const { leverage: lev } = await ensureLeverage(symbol, leverage);
    return { marginType: "ISOLATED", leverage: lev };
  }

  async function closePosition(symbol) {
    await requireCreds();
    try {
      await cancelAllOrders(symbol);
    } catch (e) {
      if (e.code !== -2011 && !/Unknown order sent/i.test(e.message)) {
        throw e;
      }
    }
    const exPos = await getPosition(symbol, { force: true });
    if (!exPos) throw new Error(`No open position for ${symbol}`);
    const amt = exPos.positionAmt;
    const qty = Math.abs(amt);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`No open position for ${symbol}`);
    }
    const side = amt > 0 ? "SELL" : "BUY";
    return marketOrder(symbol, side, qty, {
      reduceOnly: true,
      markPrice: exPos.markPrice,
    });
  }

  /** Map symbol → close SL/TP algo order flags (all open positions). */
  async function getExitOrderFlagsBySymbol() {
    const orders = await getAlgoOpenOrders();
    const map = new Map();
    for (const order of orders) {
      const sym = order?.symbol;
      if (!sym) continue;
      let rec = map.get(sym);
      if (!rec) {
        rec = {
          hasStopLoss: false,
          hasTakeProfit: false,
          stopLoss: null,
          takeProfit: null,
        };
      }
      if (isCloseStopAlgo(order)) {
        rec.hasStopLoss = true;
        const px = Number(order.triggerPrice);
        if (Number.isFinite(px)) rec.stopLoss = px;
      }
      if (isCloseTakeProfitAlgo(order)) {
        rec.hasTakeProfit = true;
        const px = Number(order.triggerPrice);
        if (Number.isFinite(px)) rec.takeProfit = px;
      }
      map.set(sym, rec);
    }
    return map;
  }

  return {
    enabled: credentials.enabled,
    credentials,
    getSymbolMeta,
    formatQty,
    formatPrice,
    getUsdtBalance,
    getPosition,
    getPositionMap,
    invalidateRestCache,
    applyWsAccountUpdate,
    applyMarkPrice,
    ensureIsolated,
    ensureLeverage,
    prepareSymbol,
    marketOrder,
    closePosition,
    getExitOrderFlagsBySymbol,
    placeCloseStop,
    placeCloseTakeProfit,
    cancelAllOrders,
    cancelStopOrders,
    cancelTakeProfitOrders,
    getOpenOrders,
    getAlgoOpenOrders,
    pickCloseStopAlgo,
    pickCloseTakeProfitAlgo,
    hasCloseStopLoss,
    hasCloseTakeProfit,
    signedRequest: async (method, apiPath, params) => {
      const { apiKey, apiSecret } = await requireCreds();
      return signedRequest(method, apiPath, params, apiKey, apiSecret);
    },
  };
}

module.exports = {
  createFuturesTrader,
  decimalsForStep,
  floorToStep,
  formatQty,
  formatPrice,
  loadSymbolMetaMap,
  isImmediateTriggerError,
};
