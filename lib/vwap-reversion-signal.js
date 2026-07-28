/**
 * VWAP Reversion — fade extensions away from rolling VWAP.
 *
 * Crypto is 24/7 → rolling VWAP over `vwapBars` (typical price × volume).
 *
 *   deviationPct = (close − vwap) / vwap × 100
 *   LONG  when price is stretched below VWAP (mean-revert up)
 *   SHORT when price is stretched above VWAP (mean-revert down)
 *
 * Entry modes:
 *   extreme — fire while |dev| ≥ minDev (rising edge into zone)
 *   reclaim — was extreme, then closes back toward VWAP
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const VWAP_DEFAULTS = {
  tradeVwapSignals: false,
  tradeBearishVwapSignals: false,
  /** Rolling window length (1m bars). */
  vwapBars: 120,
  /**
   * Min |deviation| % from VWAP to count as extreme.
   * 0.25 ≈ 25 bps on 1m alts; raise for fewer signals.
   */
  vwapMinDevPct: 0.35,
  /** Optional ceiling — skip absurd spikes (0 = off). */
  vwapMaxDevPct: 3.5,
  /** extreme | reclaim */
  vwapEntryMode: "reclaim",
  /**
   * Reclaim: require |dev| to shrink by at least this fraction of prior |dev|
   * (e.g. 0.15 = 15% closer to VWAP vs previous bar).
   */
  vwapReclaimShrinkFrac: 0.15,
  /** Skip when local corridor (high−low)/mid over window exceeds this % (0=off). */
  vwapMaxCorridorWidthPct: 12,
  /** Optional: require bar volume ≥ mult × avg volume in window (0=off). */
  vwapMinVolMult: 0,
  vwapTakeProfitPct: 1.2,
  vwapStopLossPct: 0.7,
};

function normalizeVwapConfig(raw = {}) {
  const d = VWAP_DEFAULTS;
  const mode = String(raw.vwapEntryMode ?? d.vwapEntryMode).toLowerCase();
  return {
    tradeVwapSignals: Boolean(raw.tradeVwapSignals ?? d.tradeVwapSignals),
    tradeBearishVwapSignals: Boolean(
      raw.tradeBearishVwapSignals ?? d.tradeBearishVwapSignals
    ),
    vwapBars: clamp(Math.round(num(raw.vwapBars, d.vwapBars)), 20, 1440),
    vwapMinDevPct: clamp(num(raw.vwapMinDevPct, d.vwapMinDevPct), 0.05, 20),
    vwapMaxDevPct: clamp(num(raw.vwapMaxDevPct, d.vwapMaxDevPct), 0, 50),
    vwapEntryMode: mode === "extreme" ? "extreme" : "reclaim",
    vwapReclaimShrinkFrac: clamp(
      num(raw.vwapReclaimShrinkFrac, d.vwapReclaimShrinkFrac),
      0,
      0.9
    ),
    vwapMaxCorridorWidthPct: clamp(
      num(raw.vwapMaxCorridorWidthPct, d.vwapMaxCorridorWidthPct),
      0,
      100
    ),
    vwapMinVolMult: clamp(num(raw.vwapMinVolMult, d.vwapMinVolMult), 0, 20),
    vwapTakeProfitPct: clamp(
      num(raw.vwapTakeProfitPct, d.vwapTakeProfitPct),
      0.2,
      50
    ),
    vwapStopLossPct: clamp(num(raw.vwapStopLossPct, d.vwapStopLossPct), 0.15, 20),
  };
}

function minHistoryBars(cfg) {
  return normalizeVwapConfig(cfg).vwapBars + 3;
}

function typicalPrice(bar) {
  const h = Number(bar.high);
  const l = Number(bar.low);
  const c = Number(bar.close);
  if (h > 0 && l > 0 && c > 0) return (h + l + c) / 3;
  return c > 0 ? c : null;
}

/**
 * Rolling VWAP ending at `endIndex` inclusive (last bar = bars[endIndex]).
 * @returns {{ vwap, sumPv, sumV, high, low, avgVol, barVol }|null}
 */
function computeRollingVwap(bars, endIndex, windowBars) {
  if (!bars?.length || endIndex < 0) return null;
  const start = Math.max(0, endIndex - windowBars + 1);
  if (endIndex - start + 1 < Math.min(20, windowBars)) return null;
  let sumPv = 0;
  let sumV = 0;
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i <= endIndex; i++) {
    const b = bars[i];
    const tp = typicalPrice(b);
    const v = Number(b.volume) || 0;
    if (!(tp > 0) || !(v >= 0)) continue;
    sumPv += tp * v;
    sumV += v;
    const h = Number(b.high);
    const l = Number(b.low);
    if (h > high) high = h;
    if (l < low) low = l;
  }
  if (!(sumV > 0)) return null;
  const vwap = sumPv / sumV;
  const n = endIndex - start + 1;
  return {
    vwap,
    sumPv,
    sumV,
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null,
    avgVol: sumV / n,
    barVol: Number(bars[endIndex].volume) || 0,
    windowBars: n,
  };
}

function deviationPct(close, vwap) {
  if (!(close > 0) || !(vwap > 0)) return null;
  return ((close - vwap) / vwap) * 100;
}

function corridorWidthPct(high, low, mid) {
  if (!(high > 0) || !(low > 0) || !(mid > 0) || high < low) return null;
  return ((high - low) / mid) * 100;
}

function buildMetrics(snap, cfg, side) {
  const close = snap.close;
  if (!(close > 0) || !(snap.vwap > 0)) return null;
  const long = side === "LONG";
  const slPct = cfg.vwapStopLossPct / 100;
  const tpPct = cfg.vwapTakeProfitPct / 100;
  return {
    ...snap,
    signalKind: long ? "vwap" : "vwap_bear",
    side,
    corridorHigh: close * (1 + Math.max(slPct, tpPct) * 1.5),
    corridorLow: close * (1 - Math.max(slPct, tpPct) * 1.5),
    stopLoss: long ? close * (1 - slPct) : close * (1 + slPct),
    takeProfit: long ? close * (1 + tpPct) : close * (1 - tpPct),
  };
}

function volOk(snap, cfg) {
  const mult = cfg.vwapMinVolMult;
  if (!(mult > 0)) return true;
  return snap.barVol >= mult * (snap.avgVol || 0);
}

function corridorOk(snap, cfg) {
  const maxW = cfg.vwapMaxCorridorWidthPct;
  if (!(maxW > 0)) return true;
  const w = corridorWidthPct(snap.high, snap.low, snap.vwap);
  if (w == null) return true;
  return w <= maxW;
}

function inExtremeBand(dev, cfg, side) {
  if (dev == null) return false;
  const min = cfg.vwapMinDevPct;
  const max = cfg.vwapMaxDevPct;
  if (side === "LONG") {
    if (!(dev <= -min)) return false;
    if (max > 0 && dev < -max) return false;
    return true;
  }
  if (!(dev >= min)) return false;
  if (max > 0 && dev > max) return false;
  return true;
}

/**
 * @param {object[]} bars
 * @param {object} cfgInput
 * @param {number} [endIndex] default last bar
 * @param {number|null} [prevDevPct] for reclaim mode
 */
function evaluateVwapAt(bars, cfgInput, endIndex, prevDevPct = null) {
  const cfg = normalizeVwapConfig(cfgInput);
  const i =
    endIndex == null ? bars.length - 1 : Math.min(endIndex, bars.length - 1);
  if (i < 0) return { passes: false, reason: "empty" };
  const roll = computeRollingVwap(bars, i, cfg.vwapBars);
  if (!roll) return { passes: false, reason: "warmup" };
  const close = Number(bars[i].close);
  const dev = deviationPct(close, roll.vwap);
  const snap = {
    close,
    vwap: +roll.vwap.toFixed(8),
    deviationPct: dev != null ? +dev.toFixed(5) : null,
    high: roll.high,
    low: roll.low,
    avgVol: +roll.avgVol.toFixed(4),
    barVol: roll.barVol,
    windowBars: roll.windowBars,
    corridorWidthPct: corridorWidthPct(roll.high, roll.low, roll.vwap),
    prevDeviationPct:
      prevDevPct != null ? +Number(prevDevPct).toFixed(5) : null,
  };
  if (!volOk(snap, cfg)) return { ...snap, passes: false, reason: "thin_vol" };
  if (!corridorOk(snap, cfg))
    return { ...snap, passes: false, reason: "wide_corridor" };
  return { ...snap, cfg, passes: false, reason: "eval" };
}

function reclaimOk(dev, prevDev, cfg, side) {
  if (prevDev == null || dev == null) return false;
  // Must have been extreme on prior bar
  if (!inExtremeBand(prevDev, cfg, side)) return false;
  const absPrev = Math.abs(prevDev);
  const absNow = Math.abs(dev);
  // Moving toward VWAP
  if (!(absNow < absPrev * (1 - cfg.vwapReclaimShrinkFrac))) return false;
  // Still on the extreme side of VWAP (or just crossed — allow small overshoot)
  if (side === "LONG") return prevDev < 0 && dev <= Math.abs(cfg.vwapMinDevPct) * 0.25;
  return prevDev > 0 && dev >= -Math.abs(cfg.vwapMinDevPct) * 0.25;
}

function evaluateVwapLong(bars, cfgInput = {}, endIndex, prevDevPct = null) {
  const base = evaluateVwapAt(bars, cfgInput, endIndex, prevDevPct);
  if (base.reason === "empty" || base.reason === "warmup") return base;
  if (base.passes === false && base.reason !== "eval") return base;
  const cfg = base.cfg || normalizeVwapConfig(cfgInput);
  const dev = base.deviationPct;
  let ok = false;
  let reason = "dev_low";
  if (cfg.vwapEntryMode === "extreme") {
    ok = inExtremeBand(dev, cfg, "LONG");
    reason = ok ? "extreme_below_vwap" : "dev_low";
  } else {
    ok = reclaimOk(dev, prevDevPct ?? base.prevDeviationPct, cfg, "LONG");
    reason = ok
      ? "reclaim_toward_vwap"
      : !inExtremeBand(prevDevPct ?? base.prevDeviationPct, cfg, "LONG")
        ? "prev_not_extreme"
        : "not_reclaiming";
  }
  const metrics = buildMetrics(base, cfg, "LONG");
  return {
    ...base,
    ...metrics,
    passes: Boolean(ok && metrics),
    reason,
    signalKind: "vwap",
  };
}

function evaluateVwapBear(bars, cfgInput = {}, endIndex, prevDevPct = null) {
  const base = evaluateVwapAt(bars, cfgInput, endIndex, prevDevPct);
  if (base.reason === "empty" || base.reason === "warmup") return base;
  if (base.passes === false && base.reason !== "eval") return base;
  const cfg = base.cfg || normalizeVwapConfig(cfgInput);
  const dev = base.deviationPct;
  let ok = false;
  let reason = "dev_low";
  if (cfg.vwapEntryMode === "extreme") {
    ok = inExtremeBand(dev, cfg, "SHORT");
    reason = ok ? "extreme_above_vwap" : "dev_low";
  } else {
    ok = reclaimOk(dev, prevDevPct ?? base.prevDeviationPct, cfg, "SHORT");
    reason = ok
      ? "reclaim_toward_vwap"
      : !inExtremeBand(prevDevPct ?? base.prevDeviationPct, cfg, "SHORT")
        ? "prev_not_extreme"
        : "not_reclaiming";
  }
  const metrics = buildMetrics(base, cfg, "SHORT");
  return {
    ...base,
    ...metrics,
    passes: Boolean(ok && metrics),
    reason,
    signalKind: "vwap_bear",
  };
}

/**
 * Convenience: evaluate on full bar array tip (computes prevDev from prior bar).
 */
function evaluateVwapLongTip(bars, cfgInput = {}) {
  if (!bars?.length) return { passes: false, reason: "empty" };
  const i = bars.length - 1;
  const cfg = normalizeVwapConfig(cfgInput);
  let prevDev = null;
  if (i >= 1) {
    const prev = computeRollingVwap(bars, i - 1, cfg.vwapBars);
    if (prev) prevDev = deviationPct(Number(bars[i - 1].close), prev.vwap);
  }
  return evaluateVwapLong(bars, cfg, i, prevDev);
}

function evaluateVwapBearTip(bars, cfgInput = {}) {
  if (!bars?.length) return { passes: false, reason: "empty" };
  const i = bars.length - 1;
  const cfg = normalizeVwapConfig(cfgInput);
  let prevDev = null;
  if (i >= 1) {
    const prev = computeRollingVwap(bars, i - 1, cfg.vwapBars);
    if (prev) prevDev = deviationPct(Number(bars[i - 1].close), prev.vwap);
  }
  return evaluateVwapBear(bars, cfg, i, prevDev);
}

module.exports = {
  VWAP_DEFAULTS,
  normalizeVwapConfig,
  minHistoryBars,
  computeRollingVwap,
  deviationPct,
  evaluateVwapLong,
  evaluateVwapBear,
  evaluateVwapLongTip,
  evaluateVwapBearTip,
};
