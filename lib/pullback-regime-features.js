const {
  extractDualBtcRegimeFeatures,
  formatBtcTrendDetail,
} = require("./btc-regime-context");

const FEATURE_NAMES_V1 = [
  "corridorWidthPct",
  "recentVolPct",
  "momentum30",
  "choppiness",
  "rangeExpansion",
  "wickImbalance",
  "trendStrength",
  "symbolSlRate",
  "symbolWinRate",
  "symbolAvgPnlPct",
  "distFromMaNorm",
  "fastMoveStrength",
  "btcMomentum12h",
  "btcTrendStrength12h",
  "btcMomentum1h",
  "btcTrendStrength1h",
];

const FEATURE_NAMES = [
  ...FEATURE_NAMES_V1,
  "touchQuality",
  "bounceStrength",
  "trendAlignment",
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
  const avgPnlPct = num(tradeStats.avgPnlPct, 0);
  return {
    symbolSlRate: total > 0 ? sl / total : 0,
    symbolWinRate: total > 0 ? wins / total : 0.5,
    symbolAvgPnlPct: Math.tanh(avgPnlPct / 5),
  };
}

function regimeMetricsFromSignal(metrics = {}, signalKind = "pullback") {
  if (!metrics || typeof metrics !== "object") return {};
  const corridorLow = metrics.corridorLow;
  const corridorHigh = metrics.corridorHigh;
  let corridorWidthPct = num(metrics.corridorWidthPct, 0);
  if (corridorWidthPct <= 0 && corridorHigh != null && corridorLow != null) {
    const mid = (corridorHigh + corridorLow) / 2;
    if (mid > 0) corridorWidthPct = ((corridorHigh - corridorLow) / mid) * 100;
  }
  return {
    corridorWidthPct: corridorWidthPct > 0 ? corridorWidthPct : null,
    corridorLow,
    corridorHigh,
    ma: metrics.ma,
    distFromMaPct: metrics.distFromMaPct,
    avgMovePct: metrics.avgMovePct,
    linearChangePct: metrics.linearChangePct,
    absLinearChangePct: metrics.absLinearChangePct,
    touchedMa: metrics.touchedMa,
    bounce: metrics.bounce,
    rejection: metrics.rejection,
    nearMa: metrics.nearMa,
    close: metrics.close,
  };
}

function regimeMetricsFromTrade(trade) {
  const snap = trade?.signalSnapshot ?? {};
  const kind = trade?.signalKind ?? "pullback";
  return regimeMetricsFromSignal(
    {
      corridorWidthPct: trade?.corridorWidthPct ?? snap.corridorWidthPct,
      corridorLow: trade?.corridorLow ?? snap.corridorLow,
      corridorHigh: trade?.corridorHigh ?? snap.corridorHigh,
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
    },
    kind
  );
}

function setupQualityFeatures(metrics = {}, signalKind = "pullback") {
  const bear = signalKind === "pullback_bear";
  const linear = num(metrics?.linearChangePct, 0);
  return {
    touchQuality: metrics?.touchedMa ? 1 : 0,
    bounceStrength: bear
      ? metrics?.rejection
        ? 1
        : 0
      : metrics?.bounce
        ? 1
        : 0,
    trendAlignment: bear ? Math.tanh((-linear) / 3) : Math.tanh(linear / 3),
  };
}

function extractPullbackRegimeFeatures(bars, extras = {}) {
  const {
    metrics = null,
    tradeStats = null,
    signalKind = "pullback",
    btcBars = null,
    asOf = null,
  } = extras;
  const bear = signalKind === "pullback_bear";
  const btcLookbackHours = extras.btcLookbackHours ?? 12;
  const btcFastLookbackHours = extras.btcFastLookbackHours ?? 1;
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

  const btcFeat = extractDualBtcRegimeFeatures(btcBars ?? [], {
    asOf,
    btcLookbackHours,
    btcFastLookbackHours,
    signalKind,
  });

  const mom = momentumBarsPct(bars, 30);
  const setup = setupQualityFeatures(metrics ?? {}, signalKind);
  return {
    corridorWidthPct: Math.min(1, corridorWidth / 25),
    recentVolPct: Math.min(1, recentVolatilityPct(bars) / 2),
    momentum30: Math.tanh((bear ? -mom : mom) / 4),
    choppiness: choppinessScore(bars),
    rangeExpansion: rangeExpansion(bars),
    wickImbalance: wickImbalance(bars),
    trendStrength: trendStrength(bars),
    symbolSlRate: stats.symbolSlRate,
    symbolWinRate: 1 - stats.symbolWinRate,
    symbolAvgPnlPct: (1 - stats.symbolAvgPnlPct) / 2,
    distFromMaNorm: Math.min(1, absDist / 3),
    fastMoveStrength: Math.min(1, fastMove / 3),
    btcMomentum12h: btcFeat.btcMomentum12h,
    btcTrendStrength12h: btcFeat.btcTrendStrength12h,
    btcMomentum1h: btcFeat.btcMomentum1h,
    btcTrendStrength1h: btcFeat.btcTrendStrength1h,
    touchQuality: setup.touchQuality,
    bounceStrength: setup.bounceStrength,
    trendAlignment: setup.trendAlignment,
    _btcMomentumPct: btcFeat._btcMomentumPct,
    _btcMomentumSlowPct: btcFeat._btcMomentumSlowPct,
    _btcMomentumFastPct: btcFeat._btcMomentumFastPct,
  };
}

function featuresToVector(features, featureNames = FEATURE_NAMES) {
  return featureNames.map((name) => num(features[name], 0));
}

function buildSymbolTradeStatsMap(closedTrades = []) {
  const map = new Map();
  for (const t of closedTrades) {
    const kind = t.signalKind;
    if (kind !== "pullback" && kind !== "pullback_bear") continue;
    const sym = String(t.symbol || "").toUpperCase();
    if (!sym) continue;
    const row = map.get(sym) ?? {
      total: 0,
      slCount: 0,
      winCount: 0,
      pnlPctSum: 0,
    };
    row.total++;
    if (t.exitReason === "stop_loss") row.slCount++;
    if ((t.pnl ?? 0) > 0) row.winCount++;
    row.pnlPctSum += num(t.pnlPct, 0);
    map.set(sym, row);
  }
  const out = new Map();
  for (const [sym, row] of map) {
    out.set(sym, {
      total: row.total,
      slCount: row.slCount,
      winCount: row.winCount,
      avgPnlPct: row.total > 0 ? row.pnlPctSum / row.total : 0,
    });
  }
  return out;
}

function recordPullbackTradeStats(map, trade) {
  if (!map || !trade) return map;
  const kind = trade.signalKind;
  if (kind !== "pullback" && kind !== "pullback_bear") return map;
  const sym = String(trade.symbol || "").toUpperCase();
  if (!sym) return map;

  const row = map.get(sym) ?? {
    total: 0,
    slCount: 0,
    winCount: 0,
    pnlPctSum: 0,
  };
  row.total++;
  if (trade.exitReason === "stop_loss") row.slCount++;
  if ((trade.pnl ?? 0) > 0) row.winCount++;
  row.pnlPctSum += num(trade.pnlPct, 0);
  map.set(sym, row);
  return map;
}

function tradeStatsRowForSymbol(map, symbol) {
  const row = map?.get(String(symbol || "").toUpperCase());
  if (!row || row.total <= 0) return null;
  const avgPnlPct =
    row.avgPnlPct != null
      ? row.avgPnlPct
      : row.pnlPctSum != null
        ? row.pnlPctSum / row.total
        : 0;
  return {
    total: row.total,
    slCount: row.slCount,
    winCount: row.winCount,
    avgPnlPct,
  };
}

module.exports = {
  FEATURE_NAMES,
  FEATURE_NAMES_V1,
  extractPullbackRegimeFeatures,
  featuresToVector,
  buildSymbolTradeStatsMap,
  recordPullbackTradeStats,
  tradeStatsRowForSymbol,
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
  formatBtcTrendDetail,
};
