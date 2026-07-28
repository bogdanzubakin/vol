/**
 * Order Book Imbalance (OBI) — BidVol / AskVol from L2 depth.
 *
 * Cannot be derived from candles. Needs depth REST or WS.
 *
 *   imbalance = bidVol / askVol
 *   LONG  when imbalance >= minRatio  (buyers dominate, e.g. 3–5×)
 *   SHORT when askVol / bidVol >= minRatio
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const OBI_DEFAULTS = {
  tradeObiSignals: false,
  tradeBearishObiSignals: false,
  /** Top N book levels to sum (REST/WS depth limit). */
  obiLevels: 20,
  /** Bid/Ask ratio threshold for LONG (Ask/Bid for SHORT). */
  obiMinRatio: 3,
  /**
   * Optional ceiling — skip absurd one-sided walls (0 = off).
   * Example: 12 blocks 12×+ imbalances that are often spoof/illiquid.
   */
  obiMaxRatio: 12,
  /** Min notional (quote) on each side to trust the ratio. */
  obiMinSideQuote: 50_000,
  /** Persist: require ratio above threshold for this many consecutive updates. */
  obiPersistUpdates: 2,
  /** Cooldown ms after an edge fires (per symbol). */
  obiCooldownMs: 60_000,
  /** TP cap % for OBI entries. */
  obiTakeProfitPct: 2.5,
  /** SL distance % from mid when no corridor. */
  obiStopLossPct: 1.2,
};

function normalizeObiConfig(raw = {}) {
  const d = OBI_DEFAULTS;
  return {
    tradeObiSignals: Boolean(raw.tradeObiSignals ?? d.tradeObiSignals),
    tradeBearishObiSignals: Boolean(
      raw.tradeBearishObiSignals ?? d.tradeBearishObiSignals
    ),
    obiLevels: clamp(Math.round(num(raw.obiLevels, d.obiLevels)), 5, 100),
    obiMinRatio: clamp(num(raw.obiMinRatio, d.obiMinRatio), 1.2, 50),
    obiMaxRatio: clamp(num(raw.obiMaxRatio, d.obiMaxRatio), 0, 100),
    obiMinSideQuote: clamp(
      num(raw.obiMinSideQuote, d.obiMinSideQuote),
      0,
      50_000_000
    ),
    obiPersistUpdates: clamp(
      Math.round(num(raw.obiPersistUpdates, d.obiPersistUpdates)),
      1,
      20
    ),
    obiCooldownMs: clamp(
      Math.round(num(raw.obiCooldownMs, d.obiCooldownMs)),
      0,
      3_600_000
    ),
    obiTakeProfitPct: clamp(
      num(raw.obiTakeProfitPct, d.obiTakeProfitPct),
      0.3,
      50
    ),
    obiStopLossPct: clamp(num(raw.obiStopLossPct, d.obiStopLossPct), 0.2, 20),
  };
}

/**
 * Sum quote notional on one side: Σ price * qty for top `levels`.
 * @param {Array<[string|number, string|number]|{price,qty}>} levels
 */
function sideQuoteVolume(levels, maxLevels) {
  if (!Array.isArray(levels) || !levels.length) return 0;
  const n = Math.min(maxLevels, levels.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const row = levels[i];
    let price;
    let qty;
    if (Array.isArray(row)) {
      price = Number(row[0]);
      qty = Number(row[1]);
    } else {
      price = Number(row?.price ?? row?.p);
      qty = Number(row?.qty ?? row?.q ?? row?.quantity);
    }
    if (!(price > 0) || !(qty > 0)) continue;
    sum += price * qty;
  }
  return sum;
}

function bookMid(bids, asks) {
  const bid = Number(Array.isArray(bids?.[0]) ? bids[0][0] : bids?.[0]?.price);
  const ask = Number(Array.isArray(asks?.[0]) ? asks[0][0] : asks?.[0]?.price);
  if (!(bid > 0) || !(ask > 0)) return null;
  return (bid + ask) / 2;
}

/**
 * @returns {{ bidVol: number, askVol: number, imbalance: number|null, mid: number|null }}
 */
function computeObiSnapshot(book, levels = 20) {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const bidVol = sideQuoteVolume(bids, levels);
  const askVol = sideQuoteVolume(asks, levels);
  const imbalance =
    askVol > 0 && bidVol > 0 ? bidVol / askVol : null;
  return {
    bidVol: +bidVol.toFixed(2),
    askVol: +askVol.toFixed(2),
    imbalance: imbalance != null ? +imbalance.toFixed(4) : null,
    mid: bookMid(bids, asks),
    levels,
    asOfMs: book?.asOfMs ?? book?.ts ?? Date.now(),
  };
}

function ratioOk(ratio, minRatio, maxRatio) {
  if (!(ratio > 0)) return false;
  if (ratio < minRatio) return false;
  if (maxRatio > 0 && ratio > maxRatio) return false;
  return true;
}

function buildMetrics(snap, cfg, side) {
  const mid = snap.mid;
  const slPct = cfg.obiStopLossPct / 100;
  const tpPct = cfg.obiTakeProfitPct / 100;
  if (!(mid > 0)) return null;
  const long = side === "LONG";
  return {
    ...snap,
    close: mid,
    corridorHigh: mid * (1 + Math.max(slPct, tpPct) * 1.5),
    corridorLow: mid * (1 - Math.max(slPct, tpPct) * 1.5),
    signalKind: long ? "obi" : "obi_bear",
    side,
    imbalanceRatio: snap.imbalance,
    askBidRatio: snap.askVol > 0 ? snap.bidVol / snap.askVol : null,
  };
}

/**
 * LONG when Bid/Ask >= minRatio (buyers dominate).
 */
function evaluateObiLong(book, cfgInput = {}) {
  const cfg = normalizeObiConfig(cfgInput);
  const snap = computeObiSnapshot(book, cfg.obiLevels);
  if (snap.imbalance == null) {
    return { ...snap, passes: false, reason: "no_book" };
  }
  if (
    snap.bidVol < cfg.obiMinSideQuote ||
    snap.askVol < cfg.obiMinSideQuote
  ) {
    return { ...snap, passes: false, reason: "thin_book" };
  }
  const ok = ratioOk(snap.imbalance, cfg.obiMinRatio, cfg.obiMaxRatio);
  const metrics = buildMetrics(snap, cfg, "LONG");
  return {
    ...snap,
    ...metrics,
    passes: Boolean(ok && metrics),
    reason: ok ? "bid_dominates" : "ratio_low",
    signalKind: "obi",
  };
}

/**
 * SHORT when Ask/Bid >= minRatio (sellers dominate).
 */
function evaluateObiBear(book, cfgInput = {}) {
  const cfg = normalizeObiConfig(cfgInput);
  const snap = computeObiSnapshot(book, cfg.obiLevels);
  if (snap.imbalance == null || !(snap.bidVol > 0)) {
    return { ...snap, passes: false, reason: "no_book" };
  }
  if (
    snap.bidVol < cfg.obiMinSideQuote ||
    snap.askVol < cfg.obiMinSideQuote
  ) {
    return { ...snap, passes: false, reason: "thin_book" };
  }
  const askBid = snap.askVol / snap.bidVol;
  const ok = ratioOk(askBid, cfg.obiMinRatio, cfg.obiMaxRatio);
  const metrics = buildMetrics(snap, cfg, "SHORT");
  return {
    ...snap,
    ...metrics,
    askBidRatio: +askBid.toFixed(4),
    passes: Boolean(ok && metrics),
    reason: ok ? "ask_dominates" : "ratio_low",
    signalKind: "obi_bear",
  };
}

/**
 * Stateful edge helper: persist N updates + cooldown.
 */
function createObiEdgeTracker(cfgInput = {}) {
  const streak = new Map(); // sym -> { long: n, short: n }
  const lastFire = new Map();

  function note(sym, longPass, shortPass, cfg) {
    const key = String(sym).toUpperCase();
    const row = streak.get(key) || { long: 0, short: 0 };
    row.long = longPass ? row.long + 1 : 0;
    row.short = shortPass ? row.short + 1 : 0;
    streak.set(key, row);
    const need = cfg.obiPersistUpdates;
    const now = Date.now();
    const cool = cfg.obiCooldownMs;
    const last = lastFire.get(key) || 0;
    const cooled = now - last >= cool;
    const fireLong = cooled && row.long >= need;
    const fireShort = cooled && row.short >= need;
    if (fireLong || fireShort) lastFire.set(key, now);
    return { fireLong, fireShort, streak: { ...row } };
  }

  return { note, streak, lastFire };
}

module.exports = {
  OBI_DEFAULTS,
  normalizeObiConfig,
  sideQuoteVolume,
  computeObiSnapshot,
  evaluateObiLong,
  evaluateObiBear,
  createObiEdgeTracker,
  bookMid,
};
