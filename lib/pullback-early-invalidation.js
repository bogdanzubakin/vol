/**
 * In-trade early invalidation for pullback / pullback_bear positions.
 * Exits before full SL when price breaks corridor, reclaim/reject, or MA thesis.
 */

const {
  isShort,
  peakMovePct,
  adverseMovePct,
  favorableMovePct,
} = require("./position-side");

const PB_EARLY_INVALIDATION_DEFAULTS = {
  pbEarlyInvalidationEnabled: false,
  /** Max bars to monitor after entry. */
  pbEarlyInvalidationBars: 10,
  /** First N bars: strict corridor / reclaim / MA break → early_invalidation. */
  pbEarlyInvalidationInvalidateBars: 4,
  pbEarlyInvalidationMinProgressPct: 0.35,
  pbEarlyInvalidationMaxAdversePct: 0.9,
  /** Close beyond MA by this % invalidates (long below, short above). */
  pbEarlyInvalidationMaBreakPct: 0.2,
};

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function isPullbackPosition(pos) {
  const k = pos?.signalKind;
  return k === "pullback" || k === "pullback_bear";
}

function normalizePullbackEarlyInvalidationConfig(raw = {}) {
  const d = PB_EARLY_INVALIDATION_DEFAULTS;
  return {
    pbEarlyInvalidationEnabled: Boolean(raw.pbEarlyInvalidationEnabled),
    pbEarlyInvalidationBars: clamp(
      Math.round(num(raw.pbEarlyInvalidationBars, d.pbEarlyInvalidationBars)),
      1,
      60
    ),
    pbEarlyInvalidationInvalidateBars: clamp(
      Math.round(
        num(raw.pbEarlyInvalidationInvalidateBars, d.pbEarlyInvalidationInvalidateBars)
      ),
      1,
      30
    ),
    pbEarlyInvalidationMinProgressPct: clamp(
      num(raw.pbEarlyInvalidationMinProgressPct, d.pbEarlyInvalidationMinProgressPct),
      0,
      20
    ),
    pbEarlyInvalidationMaxAdversePct: clamp(
      num(raw.pbEarlyInvalidationMaxAdversePct, d.pbEarlyInvalidationMaxAdversePct),
      0.1,
      20
    ),
    pbEarlyInvalidationMaBreakPct: clamp(
      num(raw.pbEarlyInvalidationMaBreakPct, d.pbEarlyInvalidationMaBreakPct),
      0.02,
      3
    ),
  };
}

function reclaimLevelFor(pos) {
  const corridorLow = pos.corridorLow;
  const sweepLow = pos.sweepLow ?? pos.signalSnapshot?.sweepLow;
  if (Number.isFinite(sweepLow) && Number.isFinite(corridorLow)) {
    return Math.max(corridorLow, sweepLow);
  }
  return corridorLow ?? sweepLow ?? null;
}

function rejectLevelFor(pos) {
  const corridorHigh = pos.corridorHigh;
  const sweepHigh = pos.sweepHigh ?? pos.signalSnapshot?.sweepHigh;
  if (Number.isFinite(sweepHigh) && Number.isFinite(corridorHigh)) {
    return Math.min(corridorHigh, sweepHigh);
  }
  return corridorHigh ?? sweepHigh ?? null;
}

function maLevelFor(pos) {
  const snap = pos.signalSnapshot ?? {};
  const ma = snap.ma ?? pos.ma ?? snap.levelPrice;
  return Number.isFinite(ma) && ma > 0 ? ma : null;
}

function corridorInvalidate(pos, close) {
  if (!Number.isFinite(close)) return null;
  if (isShort(pos)) {
    if (Number.isFinite(pos.corridorHigh) && close > pos.corridorHigh) {
      return { detail: "close above corridor high" };
    }
    const reject = pos.rejectLevel ?? rejectLevelFor(pos);
    if (Number.isFinite(reject) && close > reject) {
      return { detail: "close above reject" };
    }
  } else {
    if (Number.isFinite(pos.corridorLow) && close < pos.corridorLow) {
      return { detail: "close below corridor low" };
    }
    const reclaim = pos.reclaimLevel ?? reclaimLevelFor(pos);
    if (Number.isFinite(reclaim) && close < reclaim) {
      return { detail: "close below reclaim" };
    }
  }
  return null;
}

function maInvalidate(pos, close, maBreakPct) {
  const ma = maLevelFor(pos);
  if (!ma || !Number.isFinite(close)) return null;
  const buf = maBreakPct / 100;
  if (isShort(pos)) {
    const limit = ma * (1 + buf);
    if (close > limit) {
      return { detail: `close ${close.toFixed(6)} above MA ${ma.toFixed(6)}` };
    }
  } else {
    const limit = ma * (1 - buf);
    if (close < limit) {
      return { detail: `close ${close.toFixed(6)} below MA ${ma.toFixed(6)}` };
    }
  }
  return null;
}

function structureBreakInvalidate(pos, bar, minAdversePct = 0.45) {
  const close = bar.close;
  const open = bar.open ?? close;
  const entry = pos.entryPrice;
  if (!Number.isFinite(close) || !Number.isFinite(entry) || entry <= 0) return null;
  const adverse = isShort(pos)
    ? ((close - entry) / entry) * 100
    : ((entry - close) / entry) * 100;
  if (adverse < minAdversePct) return null;
  if (isShort(pos)) {
    if (close > open) {
      return { detail: `adverse bar +${adverse.toFixed(2)}%` };
    }
  } else if (close < open) {
    return { detail: `adverse bar -${adverse.toFixed(2)}%` };
  }
  return null;
}

/**
 * @returns {{ reason: string, exitPrice: number, detail: string } | null}
 */
function evaluatePullbackEarlyInvalidation(cfg, pos, bar) {
  const invCfg = normalizePullbackEarlyInvalidationConfig(cfg);
  if (!invCfg.pbEarlyInvalidationEnabled) return null;
  if (!isPullbackPosition(pos)) return null;

  const close = bar.close;
  if (!Number.isFinite(close)) return null;

  const bars = pos.barsInTrade ?? 0;
  if (bars <= 0) return null;

  const invalidateBars = invCfg.pbEarlyInvalidationInvalidateBars;
  const maxBars = invCfg.pbEarlyInvalidationBars;

  if (bars <= invalidateBars) {
    const corridor = corridorInvalidate(pos, close);
    if (corridor) {
      return {
        reason: "early_invalidation",
        exitPrice: close,
        detail: corridor.detail,
      };
    }
    const ma = maInvalidate(pos, close, invCfg.pbEarlyInvalidationMaBreakPct);
    if (ma) {
      return {
        reason: "early_invalidation",
        exitPrice: close,
        detail: ma.detail,
      };
    }
    const structure = structureBreakInvalidate(pos, bar);
    if (structure) {
      return {
        reason: "early_invalidation",
        exitPrice: close,
        detail: structure.detail,
      };
    }
  }

  if (bars <= maxBars) {
    const minProg = invCfg.pbEarlyInvalidationMinProgressPct;
    const maxAdv = invCfg.pbEarlyInvalidationMaxAdversePct;
    const peak = peakMovePct(pos);
    const adverse = adverseMovePct(pos);
    if (
      adverse != null &&
      adverse >= maxAdv &&
      (peak == null || peak < minProg)
    ) {
      return {
        reason: "early_adverse",
        exitPrice: close,
        detail: `${isShort(pos) ? "peak" : "trough"} ${adverse.toFixed(2)}%`,
      };
    }

    const fav = favorableMovePct(pos, close);
    if (bars >= maxBars && (fav == null || fav < minProg)) {
      return {
        reason: "early_stall",
        exitPrice: close,
        detail: `fav ${fav == null ? "—" : fav.toFixed(2)}%`,
      };
    }
  }

  return null;
}

module.exports = {
  PB_EARLY_INVALIDATION_DEFAULTS,
  normalizePullbackEarlyInvalidationConfig,
  isPullbackPosition,
  evaluatePullbackEarlyInvalidation,
  reclaimLevelFor,
  rejectLevelFor,
  maLevelFor,
};
