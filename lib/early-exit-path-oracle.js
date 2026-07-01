const { positionPnl } = require("./position-side");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pnlAtClose(pos, close) {
  return positionPnl(pos, close);
}

function positivePnlEpsilon(margin) {
  return Math.max(0.05, num(margin, 1) * 0.008);
}

function labelEpsilon(margin) {
  return Math.max(0.08, num(margin, 1) * 0.02);
}

/**
 * Forward-path oracle: classify whether exiting now is hold / hard / soft.
 * - hard: exit beats holding to final and future never recovers to positive PnL
 * - soft: exit beats final but positive recovery still possible (giveback trim)
 */
function classifyExitTier({
  currentPnl,
  finalPnl,
  maxFuturePnl,
  peakPnlSoFar,
  margin,
}) {
  const eps = labelEpsilon(margin);
  const posEps = positivePnlEpsilon(margin);

  if (currentPnl <= finalPnl + eps * 0.35) return "hold";
  if (maxFuturePnl > currentPnl + eps) return "hold";

  const exitBeatsFinal = currentPnl > finalPnl + eps;
  if (!exitBeatsFinal) return "hold";

  const willRecoverPositive = maxFuturePnl > posEps;
  const wasPositive = peakPnlSoFar > posEps;

  if (!willRecoverPositive) return "hard";

  if (currentPnl < posEps && willRecoverPositive) return "hold";

  if (
    wasPositive &&
    currentPnl < peakPnlSoFar - eps * 0.5 &&
    maxFuturePnl <= currentPnl + eps * 1.25
  ) {
    return "soft";
  }

  return "hold";
}

function futurePathFromBars(bars, startIdx, pos) {
  let maxFuturePnl = -Infinity;
  let minFuturePnl = Infinity;
  for (let j = startIdx + 1; j < bars.length; j++) {
    const pnl = pnlAtClose(pos, bars[j].close);
    maxFuturePnl = Math.max(maxFuturePnl, pnl);
    minFuturePnl = Math.min(minFuturePnl, pnl);
  }
  if (!Number.isFinite(maxFuturePnl)) {
    maxFuturePnl = pnlAtClose(pos, bars[startIdx]?.close ?? pos.entryPrice);
    minFuturePnl = maxFuturePnl;
  }
  return { maxFuturePnl, minFuturePnl };
}

function createExitPathTracker() {
  let peakUnrealizedPnl = -Infinity;
  let minUnrealizedPnl = Infinity;
  let positiveBarCount = 0;
  let barsTracked = 0;

  return {
    track(pos, bar) {
      const close = bar?.close;
      if (!Number.isFinite(close)) return;
      const margin = num(pos.margin, 1);
      const pnl = pnlAtClose(pos, close);
      peakUnrealizedPnl = Math.max(peakUnrealizedPnl, pnl);
      minUnrealizedPnl = Math.min(minUnrealizedPnl, pnl);
      if (pnl > positivePnlEpsilon(margin)) positiveBarCount++;
      barsTracked++;
    },
    summarize(pos, finalPnl) {
      const margin = num(pos.margin, 1);
      const posEps = positivePnlEpsilon(margin);
      const peak =
        Number.isFinite(peakUnrealizedPnl) && peakUnrealizedPnl > -Infinity
          ? peakUnrealizedPnl
          : 0;
      const trough =
        Number.isFinite(minUnrealizedPnl) && minUnrealizedPnl < Infinity
          ? minUnrealizedPnl
          : 0;
      const final = num(finalPnl, 0);
      const gaveBackUsd = peak > posEps ? Math.max(0, peak - final) : 0;

      return {
        peakUnrealizedPnl: +peak.toFixed(4),
        minUnrealizedPnl: +trough.toFixed(4),
        peakUnrealizedPct: margin > 0 ? +((peak / margin) * 100).toFixed(2) : null,
        hadPositiveUnrealized: peak > posEps,
        neverWentPositive: peak <= posEps,
        positiveBarCount,
        barsTracked,
        gaveBackFromPeak: gaveBackUsd > posEps,
        gaveBackFromPeakUsd: +gaveBackUsd.toFixed(4),
        recoveredToPositiveAtClose: final > posEps,
        exitEfficiency:
          peak > posEps ? +Math.min(1, Math.max(-1, final / peak)).toFixed(4) : null,
      };
    },
  };
}

function isExitPathTracker(tracker) {
  return (
    tracker &&
    typeof tracker.track === "function" &&
    typeof tracker.summarize === "function"
  );
}

function ensureExitPathTracker(pos) {
  if (!isExitPathTracker(pos.exitPathTracker)) {
    pos.exitPathTracker = createExitPathTracker();
  }
  return pos.exitPathTracker;
}

function trackExitPathOnBar(pos, bar) {
  ensureExitPathTracker(pos).track(pos, bar);
}

function summarizeTradeExitPath(pos, finalPnl) {
  if (!pos) return null;
  return ensureExitPathTracker(pos).summarize(pos, finalPnl);
}

function buildExitPathOracleFromBars(trade, bars) {
  if (!trade || !bars?.length) return null;
  const pos = {
    ...trade,
    peakPrice: trade.entryPrice,
    troughPrice: trade.entryPrice,
    entryPrice: trade.entryPrice,
    initialEntryPrice: trade.initialEntryPrice ?? trade.entryPrice,
  };
  const tracker = createExitPathTracker();
  const margin = num(trade.margin, 1);
  const finalPnl = num(trade.pnl, 0);
  let optimalExitPnl = -Infinity;
  let optimalExitBar = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    tracker.track(pos, bar);
    const pnl = pnlAtClose(pos, bar.close);
    if (pnl > optimalExitPnl) {
      optimalExitPnl = pnl;
      optimalExitBar = i;
    }
  }

  const summary = tracker.summarize(pos, finalPnl);
  const optimalDelta = optimalExitPnl - finalPnl;

  return {
    ...summary,
    optimalExitPnl: +optimalExitPnl.toFixed(4),
    optimalExitBar,
    optimalExitPnlDelta: +optimalDelta.toFixed(4),
    missedOptimalUsd: +Math.max(0, optimalDelta).toFixed(4),
    labelEpsilon: labelEpsilon(margin),
    positiveEpsilon: positivePnlEpsilon(margin),
  };
}

module.exports = {
  pnlAtClose,
  positivePnlEpsilon,
  labelEpsilon,
  classifyExitTier,
  futurePathFromBars,
  createExitPathTracker,
  ensureExitPathTracker,
  trackExitPathOnBar,
  summarizeTradeExitPath,
  buildExitPathOracleFromBars,
};
