/**
 * FOI VWAP trail — after +armPct favorable, trail stop loss to rolling VWAP.
 *
 * Best research preset: VWAP120, arm 0.3%.
 * 3×10d CF: $0.98 → $15.17 (Δ+$14.19), WR 36%→75%, OOS 3/3 (FOI v1.5).
 * Prior 30d counterfactual also strongly positive.
 *
 * SHORT: SL trails down to VWAP when VWAP < entry (locks profit).
 * LONG:  SL trails up to VWAP when VWAP > entry.
 */
const {
  computeRollingVwap,
} = require("./vwap-reversion-signal");
const { isShort, favorableMovePct, peakMovePct } = require("./position-side");

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const FOI_VWAP_TRAIL_DEFAULTS = {
  /** Master switch. */
  foiVwapTrailEnabled: true,
  /** Only apply on FOI / FOI bear (recommended). */
  foiVwapTrailOnlyFoi: true,
  /** Favorable move % before trailing starts. */
  foiVwapTrailArmPct: 0.3,
  /** Rolling VWAP window (1m bars). */
  foiVwapTrailBars: 120,
};

function normalizeFoiVwapTrailConfig(raw = {}) {
  const d = FOI_VWAP_TRAIL_DEFAULTS;
  return {
    foiVwapTrailEnabled: Boolean(
      raw.foiVwapTrailEnabled ?? d.foiVwapTrailEnabled
    ),
    foiVwapTrailOnlyFoi:
      raw.foiVwapTrailOnlyFoi !== undefined
        ? Boolean(raw.foiVwapTrailOnlyFoi)
        : d.foiVwapTrailOnlyFoi,
    foiVwapTrailArmPct: clamp(
      num(raw.foiVwapTrailArmPct, d.foiVwapTrailArmPct),
      0.05,
      20
    ),
    foiVwapTrailBars: clamp(
      Math.round(num(raw.foiVwapTrailBars, d.foiVwapTrailBars)),
      20,
      1440
    ),
  };
}

function isFoiKind(signalKind) {
  const k = String(signalKind || "");
  return k === "foi" || k === "foi_bear";
}

function stopPricesCloseEnough(a, b, ref) {
  if (!(a > 0) || !(b > 0)) return false;
  const scale = ref > 0 ? ref : Math.max(a, b);
  return Math.abs(a - b) / scale < 1e-6;
}

/**
 * Compute rolling VWAP at tip of bars array.
 * @returns {number|null}
 */
function tipVwap(bars, windowBars) {
  if (!bars?.length) return null;
  const roll = computeRollingVwap(bars, bars.length - 1, windowBars);
  return roll?.vwap > 0 ? roll.vwap : null;
}

/**
 * Apply one trail step. Mutates pos.stopLoss / pos.foiVwapTrailArmed when trailing.
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.pos
 * @param {object[]} options.bars OHLC with volume (need ≥ vwapBars)
 * @param {number} [options.favPrice] optional extreme for arming this tick
 * @returns {{ trailed: boolean, prevSl: number|null, vwap: number|null, armed: boolean, detail: string|null }}
 */
function processFoiVwapTrail({ cfg: cfgInput, pos, bars, favPrice = null }) {
  const cfg = normalizeFoiVwapTrailConfig(cfgInput ?? {});
  const out = {
    trailed: false,
    prevSl: null,
    vwap: null,
    armed: Boolean(pos?.foiVwapTrailArmed),
    detail: null,
  };
  if (!cfg.foiVwapTrailEnabled || !pos) return out;
  if (cfg.foiVwapTrailOnlyFoi && !isFoiKind(pos.signalKind)) return out;

  const entry = Number(pos.initialEntryPrice ?? pos.entryPrice);
  if (!(entry > 0)) return out;

  // Arm on peak favorable move (or this bar's fav price)
  let peak = peakMovePct(pos);
  if (favPrice != null) {
    const tick = favorableMovePct(pos, favPrice);
    if (tick != null) peak = Math.max(peak ?? 0, tick);
  }
  if (!pos.foiVwapTrailArmed) {
    if (peak != null && peak >= cfg.foiVwapTrailArmPct) {
      pos.foiVwapTrailArmed = true;
      out.armed = true;
    }
  }
  if (!pos.foiVwapTrailArmed) return out;

  const vwap = tipVwap(bars, cfg.foiVwapTrailBars);
  out.vwap = vwap;
  if (!(vwap > 0)) return out;

  const short = isShort(pos);
  // Must lock profit vs entry
  const locks = short ? vwap < entry : vwap > entry;
  if (!locks) return out;

  const curSl = Number(pos.stopLoss);
  if (!(curSl > 0)) return out;

  // Tighten only
  const tighter = short ? vwap < curSl : vwap > curSl;
  if (!tighter) return out;
  if (stopPricesCloseEnough(vwap, curSl, entry)) return out;

  out.prevSl = curSl;
  pos.stopLoss = vwap;
  pos.foiVwapTrailArmed = true;
  out.trailed = true;
  out.armed = true;
  out.detail = `VWAP${cfg.foiVwapTrailBars} trail after +${cfg.foiVwapTrailArmPct}% · SL ${curSl.toFixed(6)} → ${vwap.toFixed(6)}`;
  return out;
}

/**
 * Counterfactual path simulator (research / 30d eval).
 * @param {object} trade { side, entry, exit, pnl, path: [{high,low,close,vwap}] }
 */
function simulateFoiVwapTrailOnPath(trade, opts = {}) {
  const armPct = opts.armPct ?? 0.3;
  const short = trade.side === "SHORT" || trade.side === "SELL";
  const entry = Number(trade.entry);
  const actualPnl = Number(trade.pnl) || 0;
  const actualExit = trade.exit != null ? Number(trade.exit) : null;
  let armed = false;
  let sl = short ? entry * 1.5 : entry * 0.5; // loose until real SL / trail
  if (trade.initialSl > 0) sl = trade.initialSl;
  const initialSl = sl;

  function proxyPnl(exitPx) {
    const qtySign = short ? -1 : 1;
    const movePct = ((exitPx - entry) / entry) * 100 * qtySign;
    if (actualExit != null && entry > 0) {
      const actualMove = ((actualExit - entry) / entry) * 100 * qtySign;
      // Avoid unstable scale when actual exit ≈ entry.
      if (Math.abs(actualMove) > 1e-4) return actualPnl * (movePct / actualMove);
    }
    // $6 notional ≈ 0.06 $ per 1% move (matches prior FOI sims).
    return movePct * 0.06;
  }

  for (const p of trade.path || []) {
    const close = Number(p.close);
    const high = Number(p.high);
    const low = Number(p.low);
    const vwap = Number(p.vwap);
    const fav = short
      ? ((entry - Math.min(low, close)) / entry) * 100
      : ((Math.max(high, close) - entry) / entry) * 100;
    if (!armed && fav >= armPct) armed = true;

    if (armed && vwap > 0) {
      const locks = short ? vwap < entry : vwap > entry;
      if (locks) {
        if (short && vwap < sl) sl = vwap;
        if (!short && vwap > sl) sl = vwap;
      }
    }

    const hitSl = short ? high >= sl : low <= sl;
    if (hitSl) {
      const trailed = armed && Math.abs(sl - initialSl) / entry > 1e-8;
      return {
        pnl: +proxyPnl(sl).toFixed(4),
        exitReason: trailed ? "foi_vwap_trail" : "stop_loss",
        exitPrice: sl,
        armed,
      };
    }
  }

  return {
    pnl: actualPnl,
    exitReason: trade.exitReason || "original",
    exitPrice: actualExit,
    armed,
  };
}

module.exports = {
  FOI_VWAP_TRAIL_DEFAULTS,
  normalizeFoiVwapTrailConfig,
  processFoiVwapTrail,
  tipVwap,
  simulateFoiVwapTrailOnPath,
  isFoiKind,
};
