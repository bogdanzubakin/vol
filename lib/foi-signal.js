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
  /** Require OI/trend still feeding the crowded side. */
  foiRequireOiConfirm: true,
  /** Allow SFP reclaim/reject as price confirm. */
  foiConfirmSfp: true,
  /** Allow fast-mover pullback as price confirm. */
  foiConfirmPullback: true,
};

function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(v) {
  if (v === undefined || v === null || v === "") return null;
  return num(v, null);
}

function foiCfg(cfg = {}) {
  const shared = Math.max(
    0,
    num(cfg.foiMinAbsFundingRate, FOI_DEFAULTS.foiMinAbsFundingRate)
  );
  return {
    foiMinAbsFundingRate: shared,
    foiMinAbsFundingRateBull: optionalNum(cfg.foiMinAbsFundingRateBull) ?? shared,
    foiMinAbsFundingRateBear: optionalNum(cfg.foiMinAbsFundingRateBear) ?? shared,
    foiRequireOiConfirm:
      cfg.foiRequireOiConfirm !== undefined
        ? Boolean(cfg.foiRequireOiConfirm)
        : FOI_DEFAULTS.foiRequireOiConfirm,
    foiConfirmSfp:
      cfg.foiConfirmSfp !== undefined
        ? Boolean(cfg.foiConfirmSfp)
        : FOI_DEFAULTS.foiConfirmSfp,
    foiConfirmPullback:
      cfg.foiConfirmPullback !== undefined
        ? Boolean(cfg.foiConfirmPullback)
        : FOI_DEFAULTS.foiConfirmPullback,
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

/**
 * Crowded shorts → long FOI candidate.
 * fundingRate < -minAbs; optional OI still rising or funding trend more negative.
 */
function crowdedShorts(foi, fc) {
  if (foi.fundingRate > -fc.foiMinAbsFundingRateBull) return false;
  if (!fc.foiRequireOiConfirm) return true;
  return foi.oiDelta1h > 0 || foi.fundingTrend < 0;
}

/**
 * Crowded longs → short FOI candidate.
 */
function crowdedLongs(foi, fc) {
  if (foi.fundingRate < fc.foiMinAbsFundingRateBear) return false;
  if (!fc.foiRequireOiConfirm) return true;
  return foi.oiDelta1h > 0 || foi.fundingTrend > 0;
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
  if (!crowdedShorts(foi, fc)) {
    return {
      passes: false,
      signalKind: "foi",
      fundingRate: foi.fundingRate,
      fundingTrend: foi.fundingTrend,
      oiDelta1h: foi.oiDelta1h,
      reason: "funding_not_crowded_short",
    };
  }

  let confirmKind = null;
  let metrics = null;

  if (fc.foiConfirmSfp) {
    const sfp = sweepReclaimMetrics(ohlc, cfg);
    if (sfp?.passes) {
      confirmKind = "sfp";
      metrics = attachFunding(sfp, foi, confirmKind, "foi");
    }
  }
  if (!metrics && fc.foiConfirmPullback) {
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
  if (!crowdedLongs(foi, fc)) {
    return {
      passes: false,
      signalKind: "foi_bear",
      fundingRate: foi.fundingRate,
      fundingTrend: foi.fundingTrend,
      oiDelta1h: foi.oiDelta1h,
      reason: "funding_not_crowded_long",
    };
  }

  let confirmKind = null;
  let metrics = null;

  if (fc.foiConfirmSfp) {
    const sfp = sweepRejectMetrics(ohlc, cfg);
    if (sfp?.passes) {
      confirmKind = "sfp_bear";
      metrics = attachFunding(sfp, foi, confirmKind, "foi_bear");
    }
  }
  if (!metrics && fc.foiConfirmPullback) {
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
    foiRequireOiConfirm:
      raw.foiRequireOiConfirm !== undefined
        ? Boolean(raw.foiRequireOiConfirm)
        : FOI_DEFAULTS.foiRequireOiConfirm,
    foiConfirmSfp:
      raw.foiConfirmSfp !== undefined
        ? Boolean(raw.foiConfirmSfp)
        : FOI_DEFAULTS.foiConfirmSfp,
    foiConfirmPullback:
      raw.foiConfirmPullback !== undefined
        ? Boolean(raw.foiConfirmPullback)
        : FOI_DEFAULTS.foiConfirmPullback,
  };
}

module.exports = {
  FOI_DEFAULTS,
  normalizeFoiConfig,
  evaluateFoiLong,
  evaluateFoiBear,
  crowdedShorts,
  crowdedLongs,
};
