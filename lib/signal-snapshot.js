function pickSignalSnapshot(metrics) {
  if (!metrics || typeof metrics !== "object") return null;
  const snap = {
    corridorWidthPct: metrics.corridorWidthPct,
    corridorLow: metrics.corridorLow,
    corridorHigh: metrics.corridorHigh,
    sweepLow: metrics.sweepLow,
    sweepHigh: metrics.sweepHigh,
    sweepThreshold: metrics.sweepThreshold,
    barsSinceSweep: metrics.barsSinceSweep,
    distFromMaPct: metrics.distFromMaPct,
    levelPrice: metrics.levelPrice,
    levelTouches: metrics.levelTouches,
    ma: metrics.ma,
    touchedMa: metrics.touchedMa,
    bounce: metrics.bounce,
    rejection: metrics.rejection,
    nearMa: metrics.nearMa,
    avgMovePct: metrics.avgMovePct,
    linearChangePct: metrics.linearChangePct,
    absLinearChangePct: metrics.absLinearChangePct,
    touchLookback: metrics.touchLookback ?? metrics.pullbackTouchLookback,
    maxDistPct: metrics.maxDistPct ?? metrics.pullbackMaxDistancePct,
    close: metrics.close,
    open: metrics.open,
    // FOI / funding–OI at entry (when present on metrics)
    fundingRate: metrics.fundingRate,
    fundingTrend: metrics.fundingTrend,
    oiDelta1h: metrics.oiDelta1h,
    confirmKind: metrics.confirmKind,
    foi: metrics.foi,
  };
  const hasValue = Object.values(snap).some((v) => v !== undefined && v !== null);
  return hasValue ? snap : null;
}

module.exports = { pickSignalSnapshot };
