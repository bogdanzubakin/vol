const {
  stopLossPrice,
  takeProfitPrice,
  entryBasedStopPrice,
  resolveInitialStopLoss,
} = require("./bot-exit-prices");

/** Config caps: SL not wider than corridor/entry limits; TP not above takeProfitPct. */
function buildExitLimits(entry, corridorHigh, cfg) {
  const maxTp = takeProfitPrice(entry, cfg.takeProfitPct);
  const corridorSl = stopLossPrice(corridorHigh, cfg.stopLossBelowCorridorPct);
  const entrySlCap = entryBasedStopPrice(entry, cfg.stopLossFallbackPnlPct);
  let minStop = null;
  if (corridorSl != null && entrySlCap != null) {
    minStop = Math.min(corridorSl, entrySlCap);
  } else {
    minStop = corridorSl ?? entrySlCap;
  }
  return {
    maxTp,
    minStop,
    maxTpPct: cfg.takeProfitPct,
    corridorSl,
    entrySlCap,
  };
}

/** LONG stop: >= minStop (not wider than caps), strictly below entry. */
function clampStop(entry, smartSl, limits) {
  if (!Number.isFinite(entry) || entry <= 0) return limits.minStop;
  let sl = smartSl;
  if (!Number.isFinite(sl)) sl = limits.minStop;
  if (sl >= entry) {
    sl =
      limits.minStop != null && limits.minStop < entry
        ? limits.minStop
        : entry * (1 - (limits.maxTpPct ?? 10) / 100);
  }
  if (limits.minStop != null && sl < limits.minStop) sl = limits.minStop;
  return sl > 0 ? sl : limits.minStop;
}

/** LONG TP: above entry, not above configured takeProfitPct. */
function clampTp(entry, smartTp, limits) {
  if (!Number.isFinite(entry) || entry <= 0) return limits.maxTp;
  let tp = smartTp;
  if (!Number.isFinite(tp)) tp = limits.maxTp;
  const minTp = entry * 1.001;
  if (tp <= entry) tp = minTp;
  if (limits.maxTp != null && tp > limits.maxTp) tp = limits.maxTp;
  if (tp < minTp) tp = minTp;
  return tp;
}

/**
 * SFP: SL under sweep wick; TP toward corridor high / measured range.
 */
function resolveSfpExits(metrics, entry, limits) {
  const sweepLow =
    metrics.sweepLow ?? metrics.reclaimLevel ?? metrics.corridorLow;
  const corridorHigh = metrics.corridorHigh ?? entry;
  const corridorLow = metrics.corridorLow ?? sweepLow ?? entry;

  const sweepBufferPct = 0.05;
  let smartSl = sweepLow * (1 - sweepBufferPct / 100);

  const range = Math.max(corridorHigh - sweepLow, corridorHigh - corridorLow, 0);
  let smartTp = corridorHigh;
  if (range > 0) {
    const rangeTp = entry + range * 0.85;
    smartTp = Math.min(corridorHigh, rangeTp);
  }

  return {
    stopLoss: clampStop(entry, smartSl, limits),
    takeProfit: clampTp(entry, smartTp, limits),
    exitMethod: "sfp_sweep",
  };
}

/**
 * Pullback: SL under MA (pullback invalidation); TP corridor high / recent move.
 */
function resolvePullbackExits(metrics, entry, limits) {
  const ma = metrics.ma;
  const corridorHigh = metrics.corridorHigh ?? entry;
  const corridorLow = metrics.corridorLow;

  const maBufferPct = 0.25;
  let smartSl = ma ? ma * (1 - maBufferPct / 100) : corridorLow;
  if (Number.isFinite(corridorLow)) {
    const corrSl = corridorLow * (1 - 0.05 / 100);
    if (Number.isFinite(smartSl)) smartSl = Math.max(smartSl, corrSl);
    else smartSl = corrSl;
  }

  const linearPct = Math.abs(
    metrics.linearChangePct ?? metrics.absLinearChangePct ?? 0
  );
  const moveTp = entry * (1 + Math.min(linearPct * 0.4, limits.maxTpPct) / 100);
  let smartTp = Math.min(corridorHigh, moveTp);
  if (!Number.isFinite(smartTp) || smartTp <= entry) {
    smartTp = moveTp;
  }

  return {
    stopLoss: clampStop(entry, smartSl, limits),
    takeProfit: clampTp(entry, smartTp, limits),
    exitMethod: "pullback_ma",
  };
}

function resolveDefaultExits(metrics, entry, cfg, opts = {}) {
  const stopLoss = resolveInitialStopLoss({
    corridorHigh: metrics.corridorHigh,
    stopLossBelowCorridorPct: cfg.stopLossBelowCorridorPct,
    entry,
    mark: opts.mark ?? entry,
    stopLossFallbackPnlPct: cfg.stopLossFallbackPnlPct,
    tickSize: opts.tickSize,
  });
  const takeProfit = takeProfitPrice(entry, cfg.takeProfitPct);
  return {
    stopLoss,
    takeProfit,
    exitMethod: "corridor",
  };
}

function resolveExitLevels(signalKind, metrics, entry, cfg, opts = {}) {
  const limits = buildExitLimits(entry, metrics.corridorHigh, cfg);
  if (signalKind === "sfp") {
    return { ...resolveSfpExits(metrics, entry, limits), limits };
  }
  if (signalKind === "pullback") {
    return { ...resolvePullbackExits(metrics, entry, limits), limits };
  }
  return { ...resolveDefaultExits(metrics, entry, cfg, opts), limits };
}

module.exports = {
  buildExitLimits,
  clampStop,
  clampTp,
  resolveExitLevels,
  resolveSfpExits,
  resolvePullbackExits,
  resolveDefaultExits,
};
