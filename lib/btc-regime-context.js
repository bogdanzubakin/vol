/**
 * BTCUSDT trend context for regime AI features (e.g. 12h growing / falling).
 */

const BTC_SYMBOL = "BTCUSDT";
const DEFAULT_BTC_LOOKBACK_HOURS = 12;
const DEFAULT_BTC_FAST_LOOKBACK_HOURS = 1;

const BTC_SLOW_FEATURE_NAMES = ["btcMomentum12h", "btcTrendStrength12h"];
const BTC_FAST_FEATURE_NAMES = ["btcMomentum1h", "btcTrendStrength1h"];
const BTC_DUAL_FEATURE_NAMES = [...BTC_SLOW_FEATURE_NAMES, ...BTC_FAST_FEATURE_NAMES];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function barsBeforeTime(allBars, asOf, count) {
  if (!allBars?.length) return [];
  if (asOf == null) return allBars.slice(-count);
  const idx = allBars.findIndex((b) => b.closeTime > asOf);
  const end = idx >= 0 ? idx : allBars.length;
  return allBars.slice(Math.max(0, end - count), end);
}

function inferBarMs(bars) {
  if (!bars || bars.length < 2) return 60_000;
  const d = bars[bars.length - 1].closeTime - bars[bars.length - 2].closeTime;
  return d > 0 ? d : 60_000;
}

function barsForLookbackHours(btcBars, asOf, lookbackHours = DEFAULT_BTC_LOOKBACK_HOURS) {
  if (!btcBars?.length) return [];
  const hours = Math.max(1, num(lookbackHours, DEFAULT_BTC_LOOKBACK_HOURS));
  const barMs = inferBarMs(btcBars);
  const count = Math.max(2, Math.ceil((hours * 3_600_000) / barMs));
  return asOf != null ? barsBeforeTime(btcBars, asOf, count) : btcBars.slice(-count);
}

/** Signed % change over lookback window. Positive = growing, negative = falling. */
function btcMomentumPct(btcBars, asOf = null, lookbackHours = DEFAULT_BTC_LOOKBACK_HOURS) {
  const window = barsForLookbackHours(btcBars, asOf, lookbackHours);
  if (window.length < 2) return 0;
  const first = window[0].close;
  const last = window[window.length - 1].close;
  if (!Number.isFinite(first) || first <= 0 || !Number.isFinite(last)) return 0;
  return ((last - first) / first) * 100;
}

function isBearSignalKind(signalKind) {
  return String(signalKind || "").includes("bear");
}

/**
 * Normalized BTC trend features for regime models.
 * btcMomentum12h: 0.5 = flat, >0.5 = BTC up, <0.5 = BTC down
 * btcTrendStrength12h: 0..1 strength of move regardless of direction
 */
function extractBtcRegimeFeatures(btcBars, extras = {}) {
  const lookbackHours = extras.btcLookbackHours ?? DEFAULT_BTC_LOOKBACK_HOURS;
  const asOf = extras.asOf ?? null;
  const pct = btcMomentumPct(btcBars, asOf, lookbackHours);
  const momentumNorm = (Math.tanh(pct / 3) + 1) / 2;
  const strength = Math.min(1, Math.abs(pct) / 6);
  return {
    btcMomentum12h: momentumNorm,
    btcTrendStrength12h: strength,
    _btcMomentumPct: pct,
  };
}

function formatBtcTrendDetail(features) {
  const slowPct = features?._btcMomentumSlowPct ?? features?._btcMomentumPct;
  const fastPct = features?._btcMomentumFastPct;
  if (!Number.isFinite(slowPct)) return null;
  const slowArrow = slowPct > 0 ? "↑" : slowPct < 0 ? "↓" : "→";
  const slowLabel =
    Math.abs(slowPct) < 0.05
      ? "BTC flat"
      : `BTC ${slowArrow}${Math.abs(slowPct).toFixed(1)}%`;
  if (!Number.isFinite(fastPct)) return slowLabel;
  if (Math.abs(fastPct) < 0.05) return slowLabel;
  const fastArrow = fastPct > 0 ? "↑" : "↓";
  const diverged =
    Math.sign(fastPct || 0) !== Math.sign(slowPct || 0) &&
    Math.abs(slowPct) >= 0.05;
  if (!diverged) return slowLabel;
  return `${slowLabel} · 1h ${fastArrow}${Math.abs(fastPct).toFixed(1)}%`;
}

/**
 * Slow (e.g. 24h) + fast (e.g. 1h) BTC trend features for regime models.
 * btcMomentum12h / btcTrendStrength12h use btcLookbackHours (slow).
 * btcMomentum1h / btcTrendStrength1h use btcFastLookbackHours (fast, lower weight in bootstrap).
 */
function extractDualBtcRegimeFeatures(btcBars, extras = {}) {
  const slowHours = extras.btcLookbackHours ?? DEFAULT_BTC_LOOKBACK_HOURS;
  const fastHours = extras.btcFastLookbackHours ?? DEFAULT_BTC_FAST_LOOKBACK_HOURS;
  const slow = extractBtcRegimeFeatures(btcBars, {
    ...extras,
    btcLookbackHours: slowHours,
  });
  const fast = extractBtcRegimeFeatures(btcBars, {
    ...extras,
    btcLookbackHours: fastHours,
  });
  return {
    btcMomentum12h: slow.btcMomentum12h,
    btcTrendStrength12h: slow.btcTrendStrength12h,
    btcMomentum1h: fast.btcMomentum12h,
    btcTrendStrength1h: fast.btcTrendStrength12h,
    _btcMomentumPct: slow._btcMomentumPct,
    _btcMomentumSlowPct: slow._btcMomentumPct,
    _btcMomentumFastPct: fast._btcMomentumPct,
  };
}

module.exports = {
  BTC_SYMBOL,
  DEFAULT_BTC_LOOKBACK_HOURS,
  DEFAULT_BTC_FAST_LOOKBACK_HOURS,
  BTC_SLOW_FEATURE_NAMES,
  BTC_FAST_FEATURE_NAMES,
  BTC_DUAL_FEATURE_NAMES,
  barsBeforeTime,
  barsForLookbackHours,
  btcMomentumPct,
  extractBtcRegimeFeatures,
  extractDualBtcRegimeFeatures,
  formatBtcTrendDetail,
  isBearSignalKind,
};
