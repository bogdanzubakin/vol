function pickSignalSnapshot(metrics) {
  if (!metrics || typeof metrics !== "object") return null;
  const snap = {
    corridorWidthPct: metrics.corridorWidthPct,
    sweepLow: metrics.sweepLow,
    sweepHigh: metrics.sweepHigh,
    sweepThreshold: metrics.sweepThreshold,
    barsSinceSweep: metrics.barsSinceSweep,
    distFromMaPct: metrics.distFromMaPct,
    levelPrice: metrics.levelPrice,
    levelTouches: metrics.levelTouches,
  };
  const hasValue = Object.values(snap).some((v) => v !== undefined && v !== null);
  return hasValue ? snap : null;
}

module.exports = { pickSignalSnapshot };
