const {
  extractBtcRegimeFeatures,
  formatBtcTrendDetail,
} = require("./btc-regime-context");
const {
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
  recordPullbackTradeStats,
  tradeStatsRowForSymbol,
  buildSymbolTradeStatsMap,
} = require("./pullback-regime-features");

const FEATURE_NAMES = [
  "corridorBreakScore",
  "reclaimBreakScore",
  "maBreakScore",
  "failedBounce",
  "closeVsMaPct",
  "touchQuality",
  "bounceStrength",
  "barsSinceTouchNorm",
  "wickRejectionScore",
  "signalBodyRatio",
  "distFromMaNorm",
  "trendAlignment",
  "fastMoveStrength",
  "approachMomentum8",
  "postTouchMomentum3",
  "momentum30",
  "choppiness",
  "corridorWidthPct",
  "corridorPosition",
  "recentVolPct",
  "rangeExpansion",
  "wickImbalance",
  "trendStrength",
  "symbolSlRate",
  "symbolWinRate",
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

function wickImbalance(bars, n = 20) {
  const tail = bars.slice(-n);
  if (!tail.length) return 0;
  let upper = 0;
  let lower = 0;
  for (const b of tail) {
    const o = b.open ?? b.close;
    const c = b.close;
    const h = b.high ?? c;
    const l = b.low ?? c;
    upper += Math.max(0, h - Math.max(o, c));
    lower += Math.max(0, Math.min(o, c) - l);
  }
  const u = upper / tail.length;
  const lo = lower / tail.length;
  const mid = Math.max(u, lo, 0.0001);
  return Math.tanh((u - lo) / mid);
}

function trendStrength(bars, n = 30) {
  const tail = bars.slice(-n);
  if (tail.length < 5) return 0;
  const ys = tail.map((b) => b.close);
  const nPts = ys.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < nPts; i++) {
    sumX += i;
    sumY += ys[i];
    sumXY += i * ys[i];
    sumXX += i * i;
  }
  const denom = nPts * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (nPts * sumXY - sumX * sumY) / denom;
  const avg = sumY / nPts;
  if (!avg) return 0;
  return Math.tanh(Math.abs((slope / avg) * 100 * nPts) / 5);
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

function reclaimLevel(metrics = {}) {
  const corridorLow = metrics.corridorLow;
  const sweepLow = metrics.sweepLow;
  if (Number.isFinite(sweepLow) && Number.isFinite(corridorLow)) {
    return Math.max(corridorLow, sweepLow);
  }
  return corridorLow ?? sweepLow ?? null;
}

function rejectLevel(metrics = {}) {
  const corridorHigh = metrics.corridorHigh;
  const sweepHigh = metrics.sweepHigh;
  if (Number.isFinite(sweepHigh) && Number.isFinite(corridorHigh)) {
    return Math.min(corridorHigh, sweepHigh);
  }
  return corridorHigh ?? sweepHigh ?? null;
}

function corridorBreakScore(metrics = {}, signalKind = "pullback") {
  const close = num(metrics.close, 0);
  if (!close) return 0;
  const bear = signalKind === "pullback_bear";
  if (bear) {
    if (Number.isFinite(metrics.corridorHigh) && close > metrics.corridorHigh) return 1;
    return 0;
  }
  if (Number.isFinite(metrics.corridorLow) && close < metrics.corridorLow) return 1;
  return 0;
}

function reclaimBreakScore(metrics = {}, signalKind = "pullback") {
  const close = num(metrics.close, 0);
  if (!close) return 0;
  const bear = signalKind === "pullback_bear";
  if (bear) {
    const reject = rejectLevel(metrics);
    if (Number.isFinite(reject) && close > reject) return Math.min(1, (close - reject) / Math.max(reject * 0.01, 0.0001));
    return 0;
  }
  const reclaim = reclaimLevel(metrics);
  if (Number.isFinite(reclaim) && close < reclaim) {
    return Math.min(1, (reclaim - close) / Math.max(reclaim * 0.01, 0.0001));
  }
  return 0;
}

function maBreakScore(metrics = {}, signalKind = "pullback") {
  const close = num(metrics.close, 0);
  const ma = num(metrics.ma, 0);
  if (!close || !ma) return 0;
  const bear = signalKind === "pullback_bear";
  const distPct = ((close - ma) / ma) * 100;
  if (bear) {
    if (distPct > 0) return Math.min(1, distPct / 2);
    return 0;
  }
  if (distPct < 0) return Math.min(1, Math.abs(distPct) / 2);
  return 0;
}

function failedBounceFlag(metrics = {}, signalKind = "pullback") {
  const bear = signalKind === "pullback_bear";
  const close = num(metrics.close, 0);
  const open = num(metrics.open, close);
  const ma = num(metrics.ma, 0);
  if (bear) {
    if (metrics.rejection === false) return 1;
    if (close > open && ma && close > ma) return 1;
    return 0;
  }
  if (metrics.bounce === false) return 1;
  if (close <= open) return 1;
  if (ma && close < ma) return 1;
  return 0;
}

function wickRejectionOnSignalBar(bars, metrics = {}, signalKind = "pullback") {
  const last = bars?.length ? bars[bars.length - 1] : null;
  if (!last) return 0;
  const o = last.open ?? last.close;
  const c = last.close;
  const h = last.high ?? c;
  const l = last.low ?? c;
  const range = Math.max(h - l, 1e-12);
  const bear = signalKind === "pullback_bear";
  const wick = bear ? h - Math.max(o, c) : Math.min(o, c) - l;
  return Math.min(1, Math.max(0, wick / range));
}

function signalBodyRatio(bars) {
  const last = bars?.length ? bars[bars.length - 1] : null;
  if (!last) return 0;
  const o = last.open ?? last.close;
  const c = last.close;
  const h = last.high ?? c;
  const l = last.low ?? c;
  const range = Math.max(h - l, 1e-12);
  return Math.min(1, Math.abs(c - o) / range);
}

function corridorPosition(metrics = {}) {
  const close = num(metrics.close, 0);
  const lo = metrics.corridorLow;
  const hi = metrics.corridorHigh;
  if (!close || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return 0.5;
  return Math.min(1, Math.max(0, (close - lo) / (hi - lo)));
}

function estimateBarsSinceTouch(bars, metrics = {}, signalKind = "pullback") {
  const lookback = num(metrics.touchLookback, 12);
  const ma = num(metrics.ma, 0);
  if (!bars?.length || !ma) return 1;
  const bear = signalKind === "pullback_bear";
  const maxDist = num(metrics.maxDistPct, 0.35) / 100;
  const tail = bars.slice(-Math.max(lookback, 4));
  for (let i = tail.length - 1; i >= 0; i--) {
    const b = tail[i];
    const ref = bear ? b.high ?? b.close : b.low ?? b.close;
    if (!Number.isFinite(ref)) continue;
    const dist = Math.abs(ref - ma) / ma;
    if (dist <= maxDist) {
      return Math.min(1, (tail.length - 1 - i) / Math.max(1, lookback));
    }
  }
  return 1;
}

function patternMetricsFromSignal(metrics = {}, signalKind = "pullback") {
  const base = regimeMetricsFromSignal(metrics, signalKind) ?? {};
  const close = num(metrics.close, base.close);
  const lastBar = metrics.bars?.length ? metrics.bars[metrics.bars.length - 1] : null;
  return {
    ...base,
    close,
    open: num(metrics.open, lastBar?.open ?? close),
    corridorLow: metrics.corridorLow ?? base.corridorLow,
    corridorHigh: metrics.corridorHigh ?? base.corridorHigh,
    sweepLow: metrics.sweepLow,
    sweepHigh: metrics.sweepHigh,
    touchLookback: metrics.touchLookback ?? metrics.pullbackTouchLookback,
    maxDistPct: metrics.maxDistPct ?? metrics.pullbackMaxDistancePct,
  };
}

function patternMetricsFromTrade(trade) {
  const snap = trade?.signalSnapshot ?? {};
  const kind = trade?.signalKind ?? "pullback";
  return patternMetricsFromSignal(
    {
      corridorWidthPct: trade?.corridorWidthPct ?? snap.corridorWidthPct,
      corridorLow: trade?.corridorLow ?? snap.corridorLow,
      corridorHigh: trade?.corridorHigh ?? snap.corridorHigh,
      sweepLow: snap.sweepLow ?? trade?.sweepLow,
      sweepHigh: snap.sweepHigh ?? trade?.sweepHigh,
      ma: snap.ma ?? trade?.ma,
      distFromMaPct: snap.distFromMaPct ?? trade?.distFromMaPct,
      avgMovePct: snap.avgMovePct ?? trade?.avgMovePct,
      linearChangePct: snap.linearChangePct ?? trade?.linearChangePct,
      absLinearChangePct: snap.absLinearChangePct ?? trade?.absLinearChangePct,
      touchedMa: snap.touchedMa,
      bounce: snap.bounce,
      rejection: snap.rejection,
      nearMa: snap.nearMa,
      close: trade?.entryPrice ?? snap.close,
      open: snap.open,
    },
    kind
  );
}

function extractPullbackPatternBreakFeatures(bars, extras = {}) {
  const {
    metrics = null,
    tradeStats = null,
    signalKind = "pullback",
    btcBars = null,
    asOf = null,
  } = extras;
  const bear = signalKind === "pullback_bear";
  const btcLookbackHours = extras.btcLookbackHours ?? 12;
  const m = patternMetricsFromSignal(metrics ?? {}, signalKind);
  const corridorWidth =
    num(m.corridorWidthPct, 0) > 0 ? m.corridorWidthPct : rollingCorridorWidth(bars);
  const stats = symbolTradeStats(tradeStats ?? {});
  const dist = num(m.distFromMaPct, 0);
  const absDist = Math.abs(dist);
  const ma = num(m.ma, 0);
  const close = num(m.close, bars?.length ? bars[bars.length - 1].close : 0);
  const fastMove = Math.max(
    num(m.avgMovePct, 0),
    num(m.absLinearChangePct, Math.abs(num(m.linearChangePct, 0)))
  );
  const linear = num(m.linearChangePct, momentumBarsPct(bars, 30));
  const touchQuality = m.touchedMa ? 1 : 0;
  const bounceStrength = bear ? (m.rejection ? 1 : 0) : m.bounce ? 1 : 0;

  const btcFeat = extractBtcRegimeFeatures(btcBars ?? [], {
    asOf,
    btcLookbackHours,
    signalKind,
  });

  const mom30 = momentumBarsPct(bars, 30);
  const closeVsMa =
    ma > 0 && close ? Math.tanh((((close - ma) / ma) * 100) / (bear ? -2 : 2)) : 0;

  return {
    corridorBreakScore: corridorBreakScore(m, signalKind),
    reclaimBreakScore: Math.min(1, reclaimBreakScore(m, signalKind)),
    maBreakScore: maBreakScore(m, signalKind),
    failedBounce: failedBounceFlag(m, signalKind),
    closeVsMaPct: bear ? -closeVsMa : closeVsMa,
    touchQuality,
    bounceStrength,
    barsSinceTouchNorm: estimateBarsSinceTouch(bars, m, signalKind),
    wickRejectionScore: wickRejectionOnSignalBar(bars, m, signalKind),
    signalBodyRatio: signalBodyRatio(bars),
    distFromMaNorm: Math.min(1, absDist / 3),
    trendAlignment: bear ? Math.tanh((-linear) / 3) : Math.tanh(linear / 3),
    fastMoveStrength: Math.min(1, fastMove / 3),
    approachMomentum8: Math.tanh((bear ? -momentumBarsPct(bars, 8) : momentumBarsPct(bars, 8)) / 3),
    postTouchMomentum3: Math.tanh((bear ? -momentumBarsPct(bars, 3) : momentumBarsPct(bars, 3)) / 2),
    momentum30: Math.tanh((bear ? -mom30 : mom30) / 4),
    choppiness: choppinessScore(bars),
    corridorWidthPct: Math.min(1, corridorWidth / 25),
    corridorPosition: corridorPosition(m),
    recentVolPct: Math.min(1, recentVolatilityPct(bars) / 2),
    rangeExpansion: rangeExpansion(bars),
    wickImbalance: wickImbalance(bars),
    trendStrength: trendStrength(bars),
    symbolSlRate: stats.symbolSlRate,
    symbolWinRate: stats.symbolWinRate,
    btcMomentum12h: btcFeat.btcMomentum12h,
    btcTrendStrength12h: btcFeat.btcTrendStrength12h,
    _btcMomentumPct: btcFeat._btcMomentumPct,
  };
}

function featuresToVector(features, featureNames = FEATURE_NAMES) {
  return featureNames.map((name) => num(features[name], 0));
}

module.exports = {
  FEATURE_NAMES,
  extractPullbackPatternBreakFeatures,
  featuresToVector,
  patternMetricsFromSignal,
  patternMetricsFromTrade,
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
  recordPullbackTradeStats,
  tradeStatsRowForSymbol,
  buildSymbolTradeStatsMap,
  formatBtcTrendDetail,
};
