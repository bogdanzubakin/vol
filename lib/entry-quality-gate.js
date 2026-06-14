function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function stopDistancePct(entry, stopLoss) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(stopLoss)) {
    return null;
  }
  return +(((stopLoss - entry) / entry) * 100).toFixed(4);
}

function takeDistancePct(entry, takeProfit) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(takeProfit)) {
    return null;
  }
  return +(((takeProfit - entry) / entry) * 100).toFixed(4);
}

/**
 * Post-exit-resolution entry filter: skip trades with stops too tight or poor SFP context.
 */
function evaluateEntryQuality(signalKind, metrics, entry, stopLoss, takeProfit, cfg = {}) {
  const reasons = [];
  const slDist = stopDistancePct(entry, stopLoss);
  const minSl = num(cfg.minSmartStopDistancePct, 0);

  if (minSl > 0 && slDist != null && slDist > -minSl) {
    reasons.push(`SL ${Math.abs(slDist).toFixed(2)}% < min ${minSl}%`);
  }

  if (signalKind === "sfp") {
    const maxCw = num(cfg.maxSfpCorridorWidthPct, 0);
    const cw = metrics?.corridorWidthPct;
    if (maxCw > 0 && Number.isFinite(cw) && cw > maxCw) {
      reasons.push(`corridor ${cw}% > max ${maxCw}%`);
    }
  }

  if (signalKind === "pullback") {
    const maxCw = num(cfg.maxPullbackCorridorWidthPct, 0);
    const cw = metrics?.corridorWidthPct;
    if (maxCw > 0 && Number.isFinite(cw) && cw > maxCw) {
      reasons.push(`corridor ${cw}% > max ${maxCw}%`);
    }
  }

  const minRr = num(cfg.minEntryRiskReward, 0);
  if (minRr > 0 && slDist != null && slDist < 0) {
    const tpDist = takeDistancePct(entry, takeProfit);
    if (tpDist != null && tpDist > 0) {
      const rr = tpDist / Math.abs(slDist);
      if (rr < minRr) {
        reasons.push(`R:R ${rr.toFixed(2)} < min ${minRr}`);
      }
    }
  }

  return {
    pass: reasons.length === 0,
    slDistancePct: slDist,
    tpDistancePct: takeDistancePct(entry, takeProfit),
    detail: reasons.join("; ") || null,
    reasons,
  };
}

module.exports = {
  stopDistancePct,
  takeDistancePct,
  evaluateEntryQuality,
};
