const {
  stopLossPrice,
  takeProfitPrice,
  entryBasedStopPrice,
  resolveInitialStopLoss,
} = require("./bot-exit-prices");

/** Config caps: SL not wider than corridor/entry limits; TP between floor and takeProfitPct max. */
function buildExitLimits(entry, corridorHigh, cfg) {
  const maxTpPct = cfg.takeProfitPct;
  const maxTp = takeProfitPrice(entry, maxTpPct);
  const floorPct =
    cfg.takeProfitMinPct > 0
      ? Math.min(cfg.takeProfitMinPct, maxTpPct)
      : maxTpPct * 0.65;
  const minTp = takeProfitPrice(entry, floorPct);
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
    minTp,
    maxTpPct,
    minTpPct: floorPct,
    minStop,
    corridorSl,
    entrySlCap,
  };
}

/** LONG stop: >= minStop (not wider than caps), strictly below entry. */
function clampStop(entry, smartSl, limits, cfg = {}) {
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

  const minDist = Number(cfg.minSmartStopDistancePct);
  if (minDist > 0) {
    const widestAllowed = entry * (1 - minDist / 100);
    if (sl > widestAllowed) sl = widestAllowed;
  }

  return sl > 0 ? sl : limits.minStop;
}

function maxFinite(...values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? Math.max(...nums) : null;
}

/** LONG TP: between minTp floor (65% of max by default) and maxTp cap. */
function clampTp(entry, smartTp, limits) {
  if (!Number.isFinite(entry) || entry <= 0) return limits.maxTp;
  let tp = smartTp;
  if (!Number.isFinite(tp)) tp = limits.maxTp;
  const minTp = limits.minTp ?? entry * 1.001;
  if (tp < minTp) tp = minTp;
  if (limits.maxTp != null && tp > limits.maxTp) tp = limits.maxTp;
  if (tp <= entry) tp = minTp > entry ? minTp : entry * 1.001;
  return tp;
}

/**
 * SFP: SL under sweep wick; TP uses best of range extension / 2R / corridor high.
 */
function resolveSfpExits(metrics, entry, limits, cfg = {}) {
  const sweepLow =
    metrics.sweepLow ?? metrics.reclaimLevel ?? metrics.corridorLow;
  const corridorHigh = metrics.corridorHigh ?? entry;
  const corridorLow = metrics.corridorLow ?? sweepLow ?? entry;

  const sweepBufferPct = 0.05;
  let smartSl = sweepLow * (1 - sweepBufferPct / 100);

  const range = Math.max(corridorHigh - sweepLow, corridorHigh - corridorLow, 0);
  const risk = Math.max(entry - sweepLow, entry * 0.005, 0);
  const smartTp = maxFinite(
    corridorHigh,
    entry + range,
    entry + range * 1.15,
    entry + risk * 2,
    entry * (1 + limits.minTpPct / 100)
  );

  return {
    stopLoss: clampStop(entry, smartSl, limits, cfg),
    takeProfit: clampTp(entry, smartTp, limits),
    exitMethod: "sfp_sweep",
  };
}

/**
 * Pullback: SL under MA; TP uses best of corridor width / trend move / floor.
 */
function resolvePullbackExits(metrics, entry, limits, cfg = {}) {
  const ma = metrics.ma;
  const corridorHigh = metrics.corridorHigh ?? entry;
  const corridorLow = metrics.corridorLow ?? entry;
  const width = Math.max(corridorHigh - corridorLow, 0);

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
  const moveTp = entry * (1 + Math.min(linearPct * 0.85, limits.maxTpPct) / 100);
  const smartTp = maxFinite(
    corridorHigh,
    entry + width * 0.95,
    entry + width,
    moveTp,
    entry * (1 + limits.minTpPct / 100)
  );

  return {
    stopLoss: clampStop(entry, smartSl, limits, cfg),
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
  const tpPct =
    signalKind === "sfp" && Number(cfg.sfpTakeProfitPct) > 0
      ? Math.min(cfg.sfpTakeProfitPct, cfg.takeProfitPct)
      : cfg.takeProfitPct;
  const limits = buildExitLimits(entry, metrics.corridorHigh, {
    ...cfg,
    takeProfitPct: tpPct,
  });
  const useSmart = Boolean(cfg.smartExitLevelsEnabled);
  if (useSmart && signalKind === "sfp") {
    return { ...resolveSfpExits(metrics, entry, limits, cfg), limits };
  }
  if (useSmart && signalKind === "pullback") {
    return { ...resolvePullbackExits(metrics, entry, limits, cfg), limits };
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
