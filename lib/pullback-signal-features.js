const {
  extractBtcRegimeFeatures,
  formatBtcTrendDetail,
} = require("./btc-regime-context");
const {
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
  recordPullbackTradeStats,
  tradeStatsRowForSymbol,
} = require("./pullback-regime-features");

const FEATURE_NAMES = [
  "corridorWidthPct",
  "recentVolPct",
  "momentum30",
  "choppiness",
  "distFromMaNorm",
  "fastMoveStrength",
  "touchQuality",
  "bounceStrength",
  "trendAlignment",
  "symbolWinRate",
  "symbolSlRate",
  "rangeExpansion",
  "btcMomentum12h",
  "btcTrendStrength12h",
];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function recentVolatilityPct(bars) {
  if (!bars?.length || bars.length < 3) return 0;
  const tail = bars.slice(-6);
  const rets = [];
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1].close;
    const cur = tail[i].close;
    if (!Number.isFinite(prev) || prev <= 0 || !Number.isFinite(cur)) continue;
    rets.push(Math.abs(((cur - prev) / prev) * 100));
  }
  if (!rets.length) return 0;
  return rets.reduce((s, r) => s + r, 0) / rets.length;
}

function rollingCorridorWidth(bars, lookback = 60) {
  const tail = bars.slice(-lookback);
  if (tail.length < 5) return 0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of tail) {
    hi = Math.max(hi, b.high ?? b.close);
    lo = Math.min(lo, b.low ?? b.close);
  }
  const mid = (hi + lo) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return 0;
  return ((hi - lo) / mid) * 100;
}

function momentumBarsPct(bars, n = 30) {
  if (!bars?.length) return 0;
  const tail = bars.slice(-Math.max(2, n));
  const first = tail[0].close;
  const last = tail[tail.length - 1].close;
  if (!Number.isFinite(first) || first <= 0 || !Number.isFinite(last)) return 0;
  return ((last - first) / first) * 100;
}

function choppinessScore(bars, n = 24) {
  const tail = bars.slice(-Math.max(4, n));
  if (tail.length < 4) return 0;
  let flips = 0;
  let prevSign = 0;
  for (let i = 1; i < tail.length; i++) {
    const d = tail[i].close - tail[i - 1].close;
    const sign = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips++;
    if (sign !== 0) prevSign = sign;
  }
  return Math.min(1, flips / Math.max(1, tail.length - 2));
}

function rangeExpansion(bars) {
  const tail = bars.slice(-40);
  if (tail.length < 20) return 0;
  const avgRange = (list) => {
    const rs = list.map((b) => {
      const h = b.high ?? b.close;
      const l = b.low ?? b.close;
      const c = b.close;
      return c > 0 ? ((h - l) / c) * 100 : 0;
    });
    return rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : 0;
  };
  const r = avgRange(tail.slice(-10));
  const o = avgRange(tail.slice(0, 10));
  if (o <= 0) return Math.tanh(r / 2);
  return Math.tanh((r - o) / o);
}

function symbolTradeStats(tradeStats = {}) {
  const total = num(tradeStats.total, 0);
  const sl = num(tradeStats.slCount, 0);
  const wins = num(tradeStats.winCount, 0);
  return {
    symbolSlRate: total > 0 ? sl / total : 0,
    symbolWinRate: total > 0 ? wins / total : 0.5,
  };
}

function extractPullbackSignalFeatures(bars, extras = {}) {
  const {
    metrics = null,
    tradeStats = null,
    signalKind = "pullback",
    btcBars = null,
    asOf = null,
  } = extras;
  const bear = signalKind === "pullback_bear";
  const btcLookbackHours = extras.btcLookbackHours ?? 12;
  const corridorWidth =
    num(metrics?.corridorWidthPct, 0) > 0
      ? metrics.corridorWidthPct
      : rollingCorridorWidth(bars);
  const stats = symbolTradeStats(tradeStats ?? {});
  const dist = num(metrics?.distFromMaPct, 0);
  const absDist = Math.abs(dist);
  const fastMove = Math.max(
    num(metrics?.avgMovePct, 0),
    num(metrics?.absLinearChangePct, Math.abs(num(metrics?.linearChangePct, 0)))
  );
  const mom = momentumBarsPct(bars, 20);
  const approachMom = momentumBarsPct(bars, 8);
  const linear = num(metrics?.linearChangePct, mom);
  const touchQuality = metrics?.touchedMa ? 1 : 0;
  const bounceStrength = bear
    ? metrics?.rejection
      ? 1
      : 0
    : metrics?.bounce
      ? 1
      : 0;

  const btcFeat = extractBtcRegimeFeatures(btcBars ?? [], {
    asOf,
    btcLookbackHours,
    signalKind,
  });

  return {
    corridorWidthPct: Math.min(1, corridorWidth / 25),
    recentVolPct: Math.min(1, recentVolatilityPct(bars) / 2),
    momentum30: Math.tanh((bear ? -mom : mom) / 4),
    choppiness: choppinessScore(bars),
    distFromMaNorm: Math.min(1, absDist / 3),
    fastMoveStrength: Math.min(1, fastMove / 3),
    touchQuality,
    bounceStrength,
    trendAlignment: bear
      ? Math.tanh((-linear) / 3)
      : Math.tanh(linear / 3),
    symbolWinRate: stats.symbolWinRate,
    symbolSlRate: stats.symbolSlRate,
    rangeExpansion: rangeExpansion(bars),
    btcMomentum12h: btcFeat.btcMomentum12h,
    btcTrendStrength12h: btcFeat.btcTrendStrength12h,
    _btcMomentumPct: btcFeat._btcMomentumPct,
  };
}

function featuresToVector(features) {
  return FEATURE_NAMES.map((name) => num(features[name], 0));
}

module.exports = {
  FEATURE_NAMES,
  extractPullbackSignalFeatures,
  featuresToVector,
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
  recordPullbackTradeStats,
  tradeStatsRowForSymbol,
  formatBtcTrendDetail,
};
