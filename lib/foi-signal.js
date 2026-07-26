/**
 * Funding–OI Impulse (FOI) signal mode.
 *
 * Primary trigger: crowded positioning via funding rate (+ optional OI/trend).
 * Confirm: soft SFP reclaim/reject and/or fast-mover pullback in unwind direction.
 *
 *   foi      → LONG  (crowded shorts: funding deeply negative)
 *   foi_bear → SHORT (crowded longs: funding deeply positive)
 */
const {
  sweepReclaimMetrics,
  sweepRejectMetrics,
  fastMoverPullbackMetrics,
  fastMoverPullbackBearMetrics,
  corridorWidthFromWindow,
} = require("./signal-metrics");

const FOI_DEFAULTS = {
  tradeFoiSignals: false,
  tradeBearishFoiSignals: false,
  /** Absolute funding rate threshold (e.g. 0.00012 = 0.012%). */
  foiMinAbsFundingRate: 0.00012,
  /** Optional side-specific funding floors (null/omit = use shared). */
  foiMinAbsFundingRateBull: null,
  foiMinAbsFundingRateBear: null,
  /**
   * Optional ceiling on |fundingRate| (null = no cap).
   * Rejects extreme crowding that historically underperformed.
   */
  foiMaxAbsFundingRate: null,
  /** Require OI/trend still feeding the crowded side. */
  foiRequireOiConfirm: true,
  /**
   * Reject when abs(oiDelta1h) >= this (null = no cap).
   * Blocks OI spike / crash entries.
   */
  foiMaxOiDelta1hAbs: null,
  /**
   * Optional OI cap that applies only to SFP confirm (null = no extra gate).
   * When set, SFP is skipped if abs(oiDelta1h) >= this; pullback may still confirm.
   */
  foiConfirmSfpMaxOiDelta1hAbs: null,
  /**
   * Optional OI cap that applies only to pullback confirm (null = no extra gate).
   * When set, pullback is skipped if abs(oiDelta1h) >= this; SFP may still confirm.
   */
  foiConfirmPullbackMaxOiDelta1hAbs: null,
  /** Allow SFP reclaim/reject as price confirm. */
  foiConfirmSfp: true,
  /** Allow fast-mover pullback as price confirm. */
  foiConfirmPullback: true,
  /** Optional side-specific confirm toggles (null = inherit shared). */
  foiConfirmSfpBull: null,
  foiConfirmSfpBear: null,
  foiConfirmPullbackBull: null,
  foiConfirmPullbackBear: null,
  /**
   * Skip FOI opens in these UTC hours (empty = off).
   * Example: [2, 16] blocks 02:00–02:59 and 16:00–16:59 UTC.
   */
  foiBlockedUtcHours: [],
  /**
   * When true, reject if BOTH |funding| and |oiDelta1h| exceed extreme thresholds
   * (AND gate — tighter than separate max caps).
   */
  foiSkipExtremeCrowdingAnd: false,
  /** |fundingRate| floor for AND extreme skip (null = off). */
  foiExtremeFundingAbs: null,
  /** |oiDelta1h| floor for AND extreme skip (null = off). */
  foiExtremeOiDelta1hAbs: null,
};

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(v) {
  if (v === undefined || v === null || v === "") return null;
  return num(v, null);
}

function optionalBool(v) {
  if (v === undefined || v === null || v === "") return null;
  return Boolean(v);
}

function normalizeBlockedUtcHours(raw) {
  if (!Array.isArray(raw)) return [...FOI_DEFAULTS.foiBlockedUtcHours];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const h = Math.round(Number(v));
    if (!Number.isFinite(h) || h < 0 || h > 23 || seen.has(h)) continue;
    seen.add(h);
    out.push(h);
  }
  return out.sort((a, b) => a - b);
}

function foiCfg(cfg = {}) {
  const shared = Math.max(
    0,
    num(cfg.foiMinAbsFundingRate, FOI_DEFAULTS.foiMinAbsFundingRate)
  );
  const confirmSfp =
    cfg.foiConfirmSfp !== undefined
      ? Boolean(cfg.foiConfirmSfp)
      : FOI_DEFAULTS.foiConfirmSfp;
  const confirmPullback =
    cfg.foiConfirmPullback !== undefined
      ? Boolean(cfg.foiConfirmPullback)
      : FOI_DEFAULTS.foiConfirmPullback;
  return {
    foiMinAbsFundingRate: shared,
    foiMinAbsFundingRateBull: optionalNum(cfg.foiMinAbsFundingRateBull) ?? shared,
    foiMinAbsFundingRateBear: optionalNum(cfg.foiMinAbsFundingRateBear) ?? shared,
    foiMaxAbsFundingRate: optionalNum(cfg.foiMaxAbsFundingRate),
    foiRequireOiConfirm:
      cfg.foiRequireOiConfirm !== undefined
        ? Boolean(cfg.foiRequireOiConfirm)
        : FOI_DEFAULTS.foiRequireOiConfirm,
    foiMaxOiDelta1hAbs: optionalNum(cfg.foiMaxOiDelta1hAbs),
    foiConfirmSfpMaxOiDelta1hAbs: optionalNum(cfg.foiConfirmSfpMaxOiDelta1hAbs),
    foiConfirmPullbackMaxOiDelta1hAbs: optionalNum(cfg.foiConfirmPullbackMaxOiDelta1hAbs),
    foiConfirmSfp: confirmSfp,
    foiConfirmPullback: confirmPullback,
    foiConfirmSfpBull: optionalBool(cfg.foiConfirmSfpBull) ?? confirmSfp,
    foiConfirmSfpBear: optionalBool(cfg.foiConfirmSfpBear) ?? confirmSfp,
    foiConfirmPullbackBull: optionalBool(cfg.foiConfirmPullbackBull) ?? confirmPullback,
    foiConfirmPullbackBear: optionalBool(cfg.foiConfirmPullbackBear) ?? confirmPullback,
    foiBlockedUtcHours: normalizeBlockedUtcHours(cfg.foiBlockedUtcHours),
    foiSkipExtremeCrowdingAnd: Boolean(
      cfg.foiSkipExtremeCrowdingAnd ?? FOI_DEFAULTS.foiSkipExtremeCrowdingAnd
    ),
    foiExtremeFundingAbs: optionalNum(cfg.foiExtremeFundingAbs),
    foiExtremeOiDelta1hAbs: optionalNum(cfg.foiExtremeOiDelta1hAbs),
  };
}

function normalizeFundingOi(fundingOi) {
  if (!fundingOi || typeof fundingOi !== "object") return null;
  const fundingRate = num(fundingOi.fundingRate, null);
  const fundingTrend = num(fundingOi.fundingTrend, 0);
  const oiDelta1h = num(fundingOi.oiDelta1h, 0);
  if (fundingRate == null) return null;
  return { fundingRate, fundingTrend, oiDelta1h };
}

function fundingWithinCaps(foi, fc, side) {
  const minAbs =
    side === "long" ? fc.foiMinAbsFundingRateBull : fc.foiMinAbsFundingRateBear;
  if (side === "long") {
    if (foi.fundingRate > -minAbs) return { ok: false, reason: "funding_not_crowded_short" };
  } else if (foi.fundingRate < minAbs) {
    return { ok: false, reason: "funding_not_crowded_long" };
  }
  if (fc.foiMaxAbsFundingRate != null && Math.abs(foi.fundingRate) >= fc.foiMaxAbsFundingRate) {
    return { ok: false, reason: "funding_above_max_abs" };
  }
  if (fc.foiMaxOiDelta1hAbs != null && Math.abs(foi.oiDelta1h) >= fc.foiMaxOiDelta1hAbs) {
    return { ok: false, reason: "oi_delta_above_max_abs" };
  }
  if (
    fc.foiSkipExtremeCrowdingAnd &&
    fc.foiExtremeFundingAbs != null &&
    fc.foiExtremeOiDelta1hAbs != null &&
    Math.abs(foi.fundingRate) >= fc.foiExtremeFundingAbs &&
    Math.abs(foi.oiDelta1h) >= fc.foiExtremeOiDelta1hAbs
  ) {
    return { ok: false, reason: "extreme_crowding_and" };
  }
  return { ok: true };
}

/** Allow FOI open at asOfMs unless UTC hour is in foiBlockedUtcHours. */
function foiUtcHourAllows(cfg = {}, asOfMs = Date.now()) {
  const hours = normalizeBlockedUtcHours(cfg.foiBlockedUtcHours);
  if (!hours.length) return { ok: true };
  const ms = Number(asOfMs);
  if (!Number.isFinite(ms)) return { ok: true };
  const hour = new Date(ms).getUTCHours();
  if (hours.includes(hour)) {
    return { ok: false, reason: `foi_blocked_utc_hour_${hour}`, hour };
  }
  return { ok: true, hour };
}

/** SFP confirm allowed unless optional SFP-only OI cap is exceeded. */
function sfpOiAllows(foi, fc) {
  if (fc.foiConfirmSfpMaxOiDelta1hAbs == null) return true;
  return Math.abs(foi.oiDelta1h) < fc.foiConfirmSfpMaxOiDelta1hAbs;
}

/** Pullback confirm allowed unless optional pullback-only OI cap is exceeded. */
function pullbackOiAllows(foi, fc) {
  if (fc.foiConfirmPullbackMaxOiDelta1hAbs == null) return true;
  return Math.abs(foi.oiDelta1h) < fc.foiConfirmPullbackMaxOiDelta1hAbs;
}

/**
 * Crowded shorts → long FOI candidate.
 * fundingRate < -minAbs; optional OI still rising or funding trend more negative.
 */
function crowdedShorts(foi, fc) {
  const cap = fundingWithinCaps(foi, fc, "long");
  if (!cap.ok) return cap;
  if (!fc.foiRequireOiConfirm) return { ok: true };
  if (!(foi.oiDelta1h > 0 || foi.fundingTrend < 0)) {
    return { ok: false, reason: "funding_not_crowded_short" };
  }
  return { ok: true };
}

/**
 * Crowded longs → short FOI candidate.
 */
function crowdedLongs(foi, fc) {
  const cap = fundingWithinCaps(foi, fc, "short");
  if (!cap.ok) return cap;
  if (!fc.foiRequireOiConfirm) return { ok: true };
  if (!(foi.oiDelta1h > 0 || foi.fundingTrend > 0)) {
    return { ok: false, reason: "funding_not_crowded_long" };
  }
  return { ok: true };
}

function attachFunding(metrics, foi, confirmKind, signalKind) {
  if (!metrics) return null;
  return {
    ...metrics,
    signalKind,
    confirmKind,
    fundingRate: foi.fundingRate,
    fundingTrend: foi.fundingTrend,
    oiDelta1h: foi.oiDelta1h,
    foi: true,
  };
}

function fallbackCorridor(ohlc) {
  const cw = corridorWidthFromWindow(ohlc?.slice(-Math.min(120, ohlc?.length || 0)) ?? []);
  if (!cw) return null;
  return {
    corridorHigh: cw.corridorHigh,
    corridorLow: cw.corridorLow,
    corridorWidthPct: cw.corridorWidthPct,
    close: ohlc[ohlc.length - 1]?.close,
  };
}

/**
 * Long FOI: crowded shorts + (SFP reclaim OR pullback bounce).
 */
function evaluateFoiLong(ohlc, cfg, fundingOi, fmOpts = {}, moverBars = null) {
  const foi = normalizeFundingOi(fundingOi);
  const fc = foiCfg(cfg);
  if (!foi || !ohlc?.length) return null;
  const crowd = crowdedShorts(foi, fc);
  if (!crowd.ok) {
    return {
      passes: false,
      signalKind: "foi",
      fundingRate: foi.fundingRate,
      fundingTrend: foi.fundingTrend,
      oiDelta1h: foi.oiDelta1h,
      reason: crowd.reason || "funding_not_crowded_short",
    };
  }

  let confirmKind = null;
  let metrics = null;

  if (fc.foiConfirmSfpBull && sfpOiAllows(foi, fc)) {
    const sfp = sweepReclaimMetrics(ohlc, cfg);
    if (sfp?.passes) {
      confirmKind = "sfp";
      metrics = attachFunding(sfp, foi, confirmKind, "foi");
    }
  }
  if (!metrics && fc.foiConfirmPullbackBull && pullbackOiAllows(foi, fc)) {
    const pb = fastMoverPullbackMetrics(ohlc, cfg, fmOpts, moverBars);
    if (pb?.passes) {
      confirmKind = "pullback";
      metrics = attachFunding(pb, foi, confirmKind, "foi");
    }
  }

  if (!metrics) {
    const corr = fallbackCorridor(ohlc);
    return {
      passes: false,
      signalKind: "foi",
      fundingRate: foi.fundingRate,
      fundingTrend: foi.fundingTrend,
      oiDelta1h: foi.oiDelta1h,
      reason: "no_price_confirm",
      ...(corr || {}),
    };
  }

  return { ...metrics, passes: true, reason: `confirm_${confirmKind}` };
}

/**
 * Short FOI: crowded longs + (SFP reject OR pullback bear rejection).
 */
function evaluateFoiBear(ohlc, cfg, fundingOi, fmOpts = {}, moverBars = null) {
  const foi = normalizeFundingOi(fundingOi);
  const fc = foiCfg(cfg);
  if (!foi || !ohlc?.length) return null;
  const crowd = crowdedLongs(foi, fc);
  if (!crowd.ok) {
    return {
      passes: false,
      signalKind: "foi_bear",
      fundingRate: foi.fundingRate,
      fundingTrend: foi.fundingTrend,
      oiDelta1h: foi.oiDelta1h,
      reason: crowd.reason || "funding_not_crowded_long",
    };
  }

  let confirmKind = null;
  let metrics = null;

  if (fc.foiConfirmSfpBear && sfpOiAllows(foi, fc)) {
    const sfp = sweepRejectMetrics(ohlc, cfg);
    if (sfp?.passes) {
      confirmKind = "sfp_bear";
      metrics = attachFunding(sfp, foi, confirmKind, "foi_bear");
    }
  }
  if (!metrics && fc.foiConfirmPullbackBear && pullbackOiAllows(foi, fc)) {
    const pb = fastMoverPullbackBearMetrics(ohlc, cfg, fmOpts, moverBars);
    if (pb?.passes) {
      confirmKind = "pullback_bear";
      metrics = attachFunding(pb, foi, confirmKind, "foi_bear");
    }
  }

  if (!metrics) {
    const corr = fallbackCorridor(ohlc);
    return {
      passes: false,
      signalKind: "foi_bear",
      fundingRate: foi.fundingRate,
      fundingTrend: foi.fundingTrend,
      oiDelta1h: foi.oiDelta1h,
      reason: "no_price_confirm",
      ...(corr || {}),
    };
  }

  return { ...metrics, passes: true, reason: `confirm_${confirmKind}` };
}

function normalizeFoiConfig(raw = {}) {
  const shared = Math.max(
    0,
    num(raw.foiMinAbsFundingRate, FOI_DEFAULTS.foiMinAbsFundingRate) ??
      FOI_DEFAULTS.foiMinAbsFundingRate
  );
  return {
    tradeFoiSignals:
      raw.tradeFoiSignals !== undefined
        ? Boolean(raw.tradeFoiSignals)
        : FOI_DEFAULTS.tradeFoiSignals,
    tradeBearishFoiSignals:
      raw.tradeBearishFoiSignals !== undefined
        ? Boolean(raw.tradeBearishFoiSignals)
        : FOI_DEFAULTS.tradeBearishFoiSignals,
    foiMinAbsFundingRate: shared,
    foiMinAbsFundingRateBull: optionalNum(raw.foiMinAbsFundingRateBull),
    foiMinAbsFundingRateBear: optionalNum(raw.foiMinAbsFundingRateBear),
    foiMaxAbsFundingRate: optionalNum(raw.foiMaxAbsFundingRate),
    foiRequireOiConfirm:
      raw.foiRequireOiConfirm !== undefined
        ? Boolean(raw.foiRequireOiConfirm)
        : FOI_DEFAULTS.foiRequireOiConfirm,
    foiMaxOiDelta1hAbs: optionalNum(raw.foiMaxOiDelta1hAbs),
    foiConfirmSfpMaxOiDelta1hAbs: optionalNum(raw.foiConfirmSfpMaxOiDelta1hAbs),
    foiConfirmPullbackMaxOiDelta1hAbs: optionalNum(raw.foiConfirmPullbackMaxOiDelta1hAbs),
    foiConfirmSfp:
      raw.foiConfirmSfp !== undefined
        ? Boolean(raw.foiConfirmSfp)
        : FOI_DEFAULTS.foiConfirmSfp,
    foiConfirmPullback:
      raw.foiConfirmPullback !== undefined
        ? Boolean(raw.foiConfirmPullback)
        : FOI_DEFAULTS.foiConfirmPullback,
    foiConfirmSfpBull: optionalBool(raw.foiConfirmSfpBull),
    foiConfirmSfpBear: optionalBool(raw.foiConfirmSfpBear),
    foiConfirmPullbackBull: optionalBool(raw.foiConfirmPullbackBull),
    foiConfirmPullbackBear: optionalBool(raw.foiConfirmPullbackBear),
    foiBlockedUtcHours: normalizeBlockedUtcHours(raw.foiBlockedUtcHours),
    foiSkipExtremeCrowdingAnd: Boolean(
      raw.foiSkipExtremeCrowdingAnd ?? FOI_DEFAULTS.foiSkipExtremeCrowdingAnd
    ),
    foiExtremeFundingAbs: optionalNum(raw.foiExtremeFundingAbs),
    foiExtremeOiDelta1hAbs: optionalNum(raw.foiExtremeOiDelta1hAbs),
  };
}

function foiCrowdingOk(fundingOi, cfg, side) {
  const foi = normalizeFundingOi(fundingOi);
  if (!foi) return false;
  const fc = foiCfg(cfg);
  return side === "long"
    ? crowdedShorts(foi, fc).ok
    : crowdedLongs(foi, fc).ok;
}

module.exports = {
  FOI_DEFAULTS,
  normalizeFoiConfig,
  evaluateFoiLong,
  evaluateFoiBear,
  crowdedShorts,
  crowdedLongs,
  foiUtcHourAllows,
  normalizeBlockedUtcHours,
  foiCrowdingOk,
};
