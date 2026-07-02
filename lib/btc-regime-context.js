/**
 * BTCUSDT trend context for regime AI features (e.g. 12h growing / falling).
 */

const BTC_SYMBOL = "BTCUSDT";
const DEFAULT_BTC_LOOKBACK_HOURS = 12;

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
  const pct = features?._btcMomentumPct;
  if (!Number.isFinite(pct)) return null;
  if (Math.abs(pct) < 0.05) return "BTC flat";
  const arrow = pct > 0 ? "↑" : "↓";
  return `BTC ${arrow}${Math.abs(pct).toFixed(1)}%`;
}

module.exports = {
  BTC_SYMBOL,
  DEFAULT_BTC_LOOKBACK_HOURS,
  barsBeforeTime,
  barsForLookbackHours,
  btcMomentumPct,
  extractBtcRegimeFeatures,
  formatBtcTrendDetail,
  isBearSignalKind,
};
