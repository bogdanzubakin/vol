const FUNDING_OI_FEATURE_NAMES = ["fundingRateNorm", "fundingTrend", "oiDelta1h"];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalize raw funding/OI lookup into model features.
 * Bear signals flip funding sign (crowded longs → positive funding supports shorts).
 */
function extractFundingOiFeatures(fundingOi = {}, signalKind = "pullback") {
  const bear = signalKind === "pullback_bear";
  const rate = fundingOi.fundingRate;
  const trend = fundingOi.fundingTrend;
  const oiDelta = fundingOi.oiDelta1h;

  const rateScaled = rate == null ? 0 : Math.tanh(rate * 800);
  const trendScaled = trend == null ? 0 : Math.tanh(trend * 1200);
  const oiScaled = oiDelta == null ? 0 : Math.tanh(oiDelta / 4);

  return {
    fundingRateNorm: bear ? -rateScaled : rateScaled,
    fundingTrend: bear ? -trendScaled : trendScaled,
    oiDelta1h: oiScaled,
    _fundingRateRaw: rate,
    _fundingTrendRaw: trend,
    _oiDelta1hRaw: oiDelta,
  };
}

module.exports = {
  FUNDING_OI_FEATURE_NAMES,
  extractFundingOiFeatures,
};
