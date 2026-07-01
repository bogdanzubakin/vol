const {
  isShort,
  favorableMovePct,
  positionPnl,
  peakMovePct,
  adverseMovePct,
} = require("./position-side");

const FEATURE_NAMES = [
  "sideShort",
  "favorableMove",
  "adverseMove",
  "barsInTrade",
  "unrealizedPnlPct",
  "slDistPct",
  "tpDistPct",
  "tpProgress",
  "corridorWidthPct",
  "corridorBreak",
  "recentVolPct",
  "momentum3",
  "signalSfp",
  "signalPullback",
  "signalLevelBreak",
  "givebackPct",
  "runnerMode",
];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pctDist(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0;
  return ((b - a) / a) * 100;
}

function signalOneHot(signalKind) {
  const k = String(signalKind || "");
  return {
    sfp: k === "sfp" || k === "sfp_bear" ? 1 : 0,
    pullback: k === "pullback" ? 1 : 0,
    levelBreak:
      k === "level_break" || k === "level_break_bear" ? 1 : 0,
  };
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

function momentum3Pct(bars) {
  if (!bars?.length) return 0;
  const tail = bars.slice(-4);
  if (tail.length < 2) return 0;
  const first = tail[0].close;
  const last = tail[tail.length - 1].close;
  if (!Number.isFinite(first) || first <= 0 || !Number.isFinite(last)) return 0;
  return ((last - first) / first) * 100;
}

function corridorWidthPct(pos) {
  const lo = pos.corridorLow;
  const hi = pos.corridorHigh;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return 0;
  return ((hi - lo) / lo) * 100;
}

function corridorBreakScore(pos, close) {
  if (!Number.isFinite(close)) return 0;
  if (isShort(pos)) {
    if (Number.isFinite(pos.corridorHigh) && close > pos.corridorHigh) return 1;
    const reject = pos.rejectLevel;
    if (Number.isFinite(reject) && close > reject) return 0.8;
    return 0;
  }
  if (Number.isFinite(pos.corridorLow) && close < pos.corridorLow) return 1;
  const reclaim = pos.reclaimLevel;
  if (Number.isFinite(reclaim) && close < reclaim) return 0.8;
  return 0;
}

function givebackFromExtremePct(pos, close) {
  const peak = peakMovePct(pos);
  const favNow = favorableMovePct(pos, close);
  if (peak == null || favNow == null || peak <= 0) return 0;
  return Math.max(0, peak - favNow);
}

function unrealizedPnlPct(pos, close) {
  const margin = num(pos.margin, 0);
  if (margin <= 0) return 0;
  return (positionPnl(pos, close) / margin) * 100;
}

function slDistPct(pos) {
  const entry = pos.entryPrice;
  const sl = pos.stopLoss;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(sl)) return 0;
  return Math.abs(pctDist(entry, sl));
}

function tpDistPct(pos) {
  const entry = pos.entryPrice;
  const tp = pos.takeProfit;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(tp)) return 0;
  return Math.abs(pctDist(entry, tp));
}

/**
 * Feature vector for early-exit model (values roughly in 0–1 scale where possible).
 */
function extractEarlyExitFeatures(pos, bar, recentBars = []) {
  const close = bar?.close;
  const fav = favorableMovePct(pos, close) ?? 0;
  const adv = adverseMovePct(pos) ?? 0;
  const tpDist = tpDistPct(pos);
  const sig = signalOneHot(pos.signalKind);
  const shortSide = isShort(pos) ? 1 : 0;
  const mom = momentum3Pct(recentBars);
  return {
    sideShort: shortSide,
    favorableMove: Math.tanh(fav / 5),
    adverseMove: Math.tanh(Math.abs(adv) / 5),
    barsInTrade: Math.min(1, num(pos.barsInTrade, 0) / 40),
    unrealizedPnlPct: Math.tanh(unrealizedPnlPct(pos, close) / 8),
    slDistPct: Math.min(1, slDistPct(pos) / 8),
    tpDistPct: Math.min(1, tpDist / 8),
    tpProgress: tpDist > 0 ? Math.min(1, Math.max(0, fav / tpDist)) : 0,
    corridorWidthPct: Math.min(1, corridorWidthPct(pos) / 25),
    corridorBreak: corridorBreakScore(pos, close),
    recentVolPct: Math.min(1, recentVolatilityPct(recentBars) / 2),
    momentum3: Math.tanh((shortSide ? -mom : mom) / 3),
    signalSfp: sig.sfp,
    signalPullback: sig.pullback,
    signalLevelBreak: sig.levelBreak,
    givebackPct: Math.min(1, givebackFromExtremePct(pos, close) / 4),
    runnerMode: pos.runnerMode ? 1 : 0,
  };
}

function featuresToVector(features) {
  return FEATURE_NAMES.map((name) => num(features[name], 0));
}

module.exports = {
  FEATURE_NAMES,
  extractEarlyExitFeatures,
  featuresToVector,
};
