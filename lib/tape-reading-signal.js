/**
 * Tape Reading — last N aggTrades buy/sell volume + absorption.
 *
 * Binance aggTrade `m` (isBuyerMaker):
 *   m=false → buyer was taker (aggressive BUY)
 *   m=true  → seller was taker (aggressive SELL)
 *
 * Absorption (fade):
 *   Buy share ≥ 80% but price not rising  → SHORT (buyers absorbed)
 *   Sell share ≥ 80% but price not falling → LONG (sellers absorbed)
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const TAPE_DEFAULTS = {
  tradeTapeSignals: false,
  tradeBearishTapeSignals: false,
  /** Rolling trades in the tape window. */
  tapeTradeCount: 100,
  /** Aggressive buy share threshold (0–1), e.g. 0.8 = 80%. */
  tapeMinDominantShare: 0.8,
  /**
   * Max price rise (%) allowed while buys dominate → still "not rising".
   * Buy absorption SHORT if priceChangePct <= this.
   */
  tapeMaxPriceRisePct: 0.05,
  /**
   * Max price drop (%) magnitude while sells dominate → still "not falling".
   * Sell absorption LONG if priceChangePct >= -this.
   */
  tapeMaxPriceDropPct: 0.05,
  /** Min total quote notional in the window. */
  tapeMinQuoteVol: 5_000,
  /** Persist consecutive evals before edge. */
  tapePersistUpdates: 2,
  tapeCooldownMs: 60_000,
  tapeTakeProfitPct: 2.0,
  tapeStopLossPct: 1.0,
};

function normalizeTapeConfig(raw = {}) {
  const d = TAPE_DEFAULTS;
  return {
    tradeTapeSignals: Boolean(raw.tradeTapeSignals ?? d.tradeTapeSignals),
    tradeBearishTapeSignals: Boolean(
      raw.tradeBearishTapeSignals ?? d.tradeBearishTapeSignals
    ),
    tapeTradeCount: clamp(
      Math.round(num(raw.tapeTradeCount, d.tapeTradeCount)),
      20,
      1000
    ),
    tapeMinDominantShare: clamp(
      num(raw.tapeMinDominantShare, d.tapeMinDominantShare),
      0.55,
      0.99
    ),
    tapeMaxPriceRisePct: clamp(
      num(raw.tapeMaxPriceRisePct, d.tapeMaxPriceRisePct),
      -1,
      5
    ),
    tapeMaxPriceDropPct: clamp(
      num(raw.tapeMaxPriceDropPct, d.tapeMaxPriceDropPct),
      -1,
      5
    ),
    tapeMinQuoteVol: clamp(
      num(raw.tapeMinQuoteVol, d.tapeMinQuoteVol),
      0,
      50_000_000
    ),
    tapePersistUpdates: clamp(
      Math.round(num(raw.tapePersistUpdates, d.tapePersistUpdates)),
      1,
      20
    ),
    tapeCooldownMs: clamp(
      Math.round(num(raw.tapeCooldownMs, d.tapeCooldownMs)),
      0,
      3_600_000
    ),
    tapeTakeProfitPct: clamp(
      num(raw.tapeTakeProfitPct, d.tapeTakeProfitPct),
      0.3,
      50
    ),
    tapeStopLossPct: clamp(num(raw.tapeStopLossPct, d.tapeStopLossPct), 0.2, 20),
  };
}

/**
 * Normalize one aggTrade (WS or REST).
 * @returns {{ t, price, qty, quote, isBuy: boolean }|null}
 */
function normalizeAggTrade(row) {
  if (!row) return null;
  const price = Number(row.p ?? row.price);
  const qty = Number(row.q ?? row.qty ?? row.quantity);
  const t = Number(row.T ?? row.time ?? row.timestamp ?? Date.now());
  // REST/WS: m = isBuyerMaker → taker sell when true
  const buyerMaker = Boolean(row.m ?? row.isBuyerMaker);
  if (!(price > 0) || !(qty > 0)) return null;
  return {
    t,
    price,
    qty,
    quote: price * qty,
    isBuy: !buyerMaker, // aggressive buy
  };
}

/**
 * @param {object[]} trades normalized or raw aggTrades (oldest→newest or any)
 */
function summarizeTape(trades, count = 100) {
  const norm = [];
  for (const row of trades ?? []) {
    const n = row?.isBuy != null && row?.quote != null ? row : normalizeAggTrade(row);
    if (n) norm.push(n);
  }
  if (!norm.length) {
    return {
      n: 0,
      buyVol: 0,
      sellVol: 0,
      buyShare: null,
      sellShare: null,
      priceFirst: null,
      priceLast: null,
      priceChangePct: null,
      mid: null,
    };
  }
  // Keep last `count` by time
  norm.sort((a, b) => a.t - b.t);
  const window = norm.length > count ? norm.slice(-count) : norm;
  let buyVol = 0;
  let sellVol = 0;
  for (const tr of window) {
    if (tr.isBuy) buyVol += tr.quote;
    else sellVol += tr.quote;
  }
  const total = buyVol + sellVol;
  const priceFirst = window[0].price;
  const priceLast = window[window.length - 1].price;
  const priceChangePct =
    priceFirst > 0 ? ((priceLast - priceFirst) / priceFirst) * 100 : null;
  return {
    n: window.length,
    buyVol: +buyVol.toFixed(2),
    sellVol: +sellVol.toFixed(2),
    buyShare: total > 0 ? +(buyVol / total).toFixed(4) : null,
    sellShare: total > 0 ? +(sellVol / total).toFixed(4) : null,
    priceFirst,
    priceLast,
    priceChangePct:
      priceChangePct != null ? +priceChangePct.toFixed(5) : null,
    mid: priceLast,
    fromMs: window[0].t,
    toMs: window[window.length - 1].t,
  };
}

function buildMetrics(snap, cfg, side) {
  const mid = snap.mid;
  if (!(mid > 0)) return null;
  const slPct = cfg.tapeStopLossPct / 100;
  const tpPct = cfg.tapeTakeProfitPct / 100;
  const long = side === "LONG";
  return {
    ...snap,
    close: mid,
    corridorHigh: mid * (1 + Math.max(slPct, tpPct) * 1.5),
    corridorLow: mid * (1 - Math.max(slPct, tpPct) * 1.5),
    signalKind: long ? "tape" : "tape_bear",
    side,
    absorption: long ? "seller_absorption" : "buyer_absorption",
  };
}

/**
 * LONG: sellers dominate tape but price is not falling (sellers absorbed).
 */
function evaluateTapeLong(trades, cfgInput = {}) {
  const cfg = normalizeTapeConfig(cfgInput);
  const snap = summarizeTape(trades, cfg.tapeTradeCount);
  if (snap.n < Math.min(20, cfg.tapeTradeCount)) {
    return { ...snap, passes: false, reason: "warmup" };
  }
  if (snap.buyVol + snap.sellVol < cfg.tapeMinQuoteVol) {
    return { ...snap, passes: false, reason: "thin_tape" };
  }
  const sellDom = (snap.sellShare ?? 0) >= cfg.tapeMinDominantShare;
  const notFalling =
    snap.priceChangePct != null &&
    snap.priceChangePct >= -cfg.tapeMaxPriceDropPct;
  const ok = sellDom && notFalling;
  const metrics = buildMetrics(snap, cfg, "LONG");
  return {
    ...snap,
    ...metrics,
    passes: Boolean(ok && metrics),
    reason: ok
      ? "seller_absorption"
      : !sellDom
        ? "sell_share_low"
        : "price_falling",
    signalKind: "tape",
  };
}

/**
 * SHORT: buyers dominate tape but price is not rising (buyers absorbed).
 */
function evaluateTapeBear(trades, cfgInput = {}) {
  const cfg = normalizeTapeConfig(cfgInput);
  const snap = summarizeTape(trades, cfg.tapeTradeCount);
  if (snap.n < Math.min(20, cfg.tapeTradeCount)) {
    return { ...snap, passes: false, reason: "warmup" };
  }
  if (snap.buyVol + snap.sellVol < cfg.tapeMinQuoteVol) {
    return { ...snap, passes: false, reason: "thin_tape" };
  }
  const buyDom = (snap.buyShare ?? 0) >= cfg.tapeMinDominantShare;
  const notRising =
    snap.priceChangePct != null &&
    snap.priceChangePct <= cfg.tapeMaxPriceRisePct;
  const ok = buyDom && notRising;
  const metrics = buildMetrics(snap, cfg, "SHORT");
  return {
    ...snap,
    ...metrics,
    passes: Boolean(ok && metrics),
    reason: ok
      ? "buyer_absorption"
      : !buyDom
        ? "buy_share_low"
        : "price_rising",
    signalKind: "tape_bear",
  };
}

function createTapeEdgeTracker() {
  const streak = new Map();
  const lastFire = new Map();

  function note(sym, longPass, shortPass, cfg) {
    const key = String(sym).toUpperCase();
    const row = streak.get(key) || { long: 0, short: 0 };
    row.long = longPass ? row.long + 1 : 0;
    row.short = shortPass ? row.short + 1 : 0;
    streak.set(key, row);
    const need = cfg.tapePersistUpdates;
    const now = Date.now();
    const last = lastFire.get(key) || 0;
    const cooled = now - last >= cfg.tapeCooldownMs;
    const fireLong = cooled && row.long >= need;
    const fireShort = cooled && row.short >= need;
    if (fireLong || fireShort) lastFire.set(key, now);
    return { fireLong, fireShort, streak: { ...row } };
  }

  return { note };
}

/**
 * Per-symbol ring buffer of recent aggTrades.
 */
function createTapeBuffer(maxKeep = 200) {
  /** @type {Map<string, object[]>} */
  const bySym = new Map();

  function push(symbol, rawOrNorm) {
    const sym = String(symbol || "").toUpperCase();
    const tr = rawOrNorm?.isBuy != null ? rawOrNorm : normalizeAggTrade(rawOrNorm);
    if (!sym || !tr) return null;
    let arr = bySym.get(sym);
    if (!arr) {
      arr = [];
      bySym.set(sym, arr);
    }
    arr.push(tr);
    if (arr.length > maxKeep) arr.splice(0, arr.length - maxKeep);
    return tr;
  }

  function get(symbol) {
    return bySym.get(String(symbol || "").toUpperCase()) ?? [];
  }

  function seed(symbol, trades) {
    const sym = String(symbol || "").toUpperCase();
    const arr = [];
    for (const row of trades ?? []) {
      const tr = normalizeAggTrade(row);
      if (tr) arr.push(tr);
    }
    arr.sort((a, b) => a.t - b.t);
    bySym.set(sym, arr.slice(-maxKeep));
    return bySym.get(sym);
  }

  return {
    push,
    get,
    seed,
    get size() {
      return bySym.size;
    },
  };
}

module.exports = {
  TAPE_DEFAULTS,
  normalizeTapeConfig,
  normalizeAggTrade,
  summarizeTape,
  evaluateTapeLong,
  evaluateTapeBear,
  createTapeEdgeTracker,
  createTapeBuffer,
};
