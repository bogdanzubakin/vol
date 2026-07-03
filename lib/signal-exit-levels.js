const {
  stopLossPrice,
  stopLossPriceShort,
  takeProfitPrice,
  takeProfitPriceShort,
  entryBasedStopPrice,
  entryBasedStopPriceShort,
  resolveInitialStopLoss,
  resolveInitialStopLossShort,
} = require("./bot-exit-prices");
const { isShort } = require("./position-side");

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

function buildExitLimitsShort(entry, corridorLow, cfg) {
  const maxTpPct = cfg.takeProfitPct;
  const maxTp = takeProfitPriceShort(entry, maxTpPct);
  const floorPct =
    cfg.takeProfitMinPct > 0
      ? Math.min(cfg.takeProfitMinPct, maxTpPct)
      : maxTpPct * 0.65;
  const minTp = takeProfitPriceShort(entry, floorPct);
  const corridorSl = stopLossPriceShort(corridorLow, cfg.stopLossBelowCorridorPct);
  const entrySlCap = entryBasedStopPriceShort(entry, cfg.stopLossFallbackPnlPct);
  let maxStop = null;
  if (corridorSl != null && entrySlCap != null) {
    maxStop = Math.max(corridorSl, entrySlCap);
  } else {
    maxStop = corridorSl ?? entrySlCap;
  }
  return {
    maxTp,
    minTp,
    maxTpPct,
    minTpPct: floorPct,
    maxStop,
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

/** SHORT stop: <= maxStop, strictly above entry. */
function clampStopShort(entry, smartSl, limits, cfg = {}) {
  if (!Number.isFinite(entry) || entry <= 0) return limits.maxStop;
  let sl = smartSl;
  if (!Number.isFinite(sl)) sl = limits.maxStop;
  if (sl <= entry) {
    sl =
      limits.maxStop != null && limits.maxStop > entry
        ? limits.maxStop
        : entry * (1 + (limits.maxTpPct ?? 10) / 100);
  }
  if (limits.maxStop != null && sl > limits.maxStop) sl = limits.maxStop;

  const minDist = Number(cfg.minSmartStopDistancePct);
  if (minDist > 0) {
    const widestAllowed = entry * (1 + minDist / 100);
    if (sl < widestAllowed) sl = widestAllowed;
  }

  return sl > 0 ? sl : limits.maxStop;
}

function maxFinite(...values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? Math.max(...nums) : null;
}

function minFinite(...values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  return nums.length ? Math.min(...nums) : null;
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

/** SHORT TP: between minTp floor and maxTp cap, below entry. */
function clampTpShort(entry, smartTp, limits) {
  if (!Number.isFinite(entry) || entry <= 0) return limits.maxTp;
  let tp = smartTp;
  if (!Number.isFinite(tp)) tp = limits.maxTp;
  const minTp = limits.minTp ?? entry * 0.999;
  if (tp > minTp) tp = minTp;
  if (limits.maxTp != null && tp < limits.maxTp) tp = limits.maxTp;
  if (tp >= entry) tp = minTp < entry ? minTp : entry * 0.999;
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
 * Bearish SFP: SL above sweep wick; TP below range / corridor low.
 */
function resolveBearishSfpExits(metrics, entry, limits, cfg = {}) {
  const sweepHigh =
    metrics.sweepHigh ?? metrics.rejectLevel ?? metrics.corridorHigh;
  const corridorHigh = metrics.corridorHigh ?? sweepHigh ?? entry;
  const corridorLow = metrics.corridorLow ?? entry;

  const sweepBufferPct = 0.05;
  let smartSl = sweepHigh * (1 + sweepBufferPct / 100);

  const range = Math.max(sweepHigh - corridorLow, corridorHigh - corridorLow, 0);
  const risk = Math.max(sweepHigh - entry, entry * 0.005, 0);
  const smartTp = minFinite(
    corridorLow,
    entry - range,
    entry - range * 1.15,
    entry - risk * 2,
    entry * (1 - limits.minTpPct / 100)
  );

  return {
    stopLoss: clampStopShort(entry, smartSl, limits, cfg),
    takeProfit: clampTpShort(entry, smartTp, limits),
    exitMethod: "sfp_bear_sweep",
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

/** Bearish pullback: SL above MA; TP uses corridor / downtrend move. */
function resolvePullbackBearExits(metrics, entry, limits, cfg = {}) {
  const ma = metrics.ma;
  const corridorHigh = metrics.corridorHigh ?? entry;
  const corridorLow = metrics.corridorLow ?? entry;
  const width = Math.max(corridorHigh - corridorLow, 0);

  const maBufferPct = 0.25;
  let smartSl = ma ? ma * (1 + maBufferPct / 100) : corridorHigh;
  if (Number.isFinite(corridorHigh)) {
    const corrSl = corridorHigh * (1 + 0.05 / 100);
    if (Number.isFinite(smartSl)) smartSl = Math.max(smartSl, corrSl);
    else smartSl = corrSl;
  }

  const linearPct = Math.abs(
    metrics.linearChangePct ?? metrics.absLinearChangePct ?? 0
  );
  const moveTp = entry * (1 - Math.min(linearPct * 0.85, limits.maxTpPct) / 100);
  const smartTp = minFinite(
    corridorLow,
    entry - width * 0.95,
    entry - width,
    moveTp,
    entry * (1 - limits.minTpPct / 100)
  );

  return {
    stopLoss: clampStopShort(entry, smartSl, limits, cfg),
    takeProfit: clampTpShort(entry, smartTp, limits),
    exitMethod: "pullback_bear_ma",
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

function resolveDefaultExitsShort(metrics, entry, cfg, opts = {}) {
  const stopLoss = resolveInitialStopLossShort({
    corridorLow: metrics.corridorLow,
    stopLossBelowCorridorPct: cfg.stopLossBelowCorridorPct,
    entry,
    mark: opts.mark ?? entry,
    stopLossFallbackPnlPct: cfg.stopLossFallbackPnlPct,
    tickSize: opts.tickSize,
  });
  const takeProfit = takeProfitPriceShort(entry, cfg.takeProfitPct);
  return {
    stopLoss,
    takeProfit,
    exitMethod: "corridor_short",
  };
}

function resolveLevelBreakExits(metrics, entry, limits, cfg = {}) {
  const level = metrics.levelPrice ?? metrics.corridorLow ?? entry;
  const corridorHigh = metrics.corridorHigh ?? entry;
  const corridorLow = metrics.corridorLow ?? level;

  const bufferPct = 0.05;
  let smartSl = level * (1 - bufferPct / 100);

  const range = Math.max(corridorHigh - level, corridorHigh - corridorLow, 0);
  const risk = Math.max(entry - level, entry * 0.005, 0);
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
    exitMethod: "level_break",
  };
}

function resolveLevelBreakBearExits(metrics, entry, limits, cfg = {}) {
  const level = metrics.levelPrice ?? metrics.corridorHigh ?? entry;
  const corridorHigh = metrics.corridorHigh ?? level;
  const corridorLow = metrics.corridorLow ?? entry;

  const bufferPct = 0.05;
  let smartSl = level * (1 + bufferPct / 100);

  const range = Math.max(level - corridorLow, corridorHigh - corridorLow, 0);
  const risk = Math.max(level - entry, entry * 0.005, 0);
  const smartTp = minFinite(
    corridorLow,
    entry - range,
    entry - range * 1.15,
    entry - risk * 2,
    entry * (1 - limits.minTpPct / 100)
  );

  return {
    stopLoss: clampStopShort(entry, smartSl, limits, cfg),
    takeProfit: clampTpShort(entry, smartTp, limits),
    exitMethod: "level_break_bear",
  };
}

function resolveLegacyExitLevels(signalKind, metrics, entry, cfg, opts = {}) {
  const short =
    signalKind === "sfp_bear" ||
    signalKind === "level_break_bear" ||
    signalKind === "pullback_bear" ||
    opts.side === "SHORT";
  const tpPct =
    (signalKind === "sfp" || signalKind === "sfp_bear") &&
    Number(cfg.sfpTakeProfitPct) > 0
      ? Math.min(cfg.sfpTakeProfitPct, cfg.takeProfitPct)
      : (signalKind === "level_break" || signalKind === "level_break_bear") &&
          Number(cfg.levelBreakTakeProfitPct) > 0
        ? Math.min(cfg.levelBreakTakeProfitPct, cfg.takeProfitPct)
        : cfg.takeProfitPct;

  if (short) {
    const limits = buildExitLimitsShort(entry, metrics.corridorLow, {
      ...cfg,
      takeProfitPct: tpPct,
    });
    const useSmart = Boolean(cfg.smartExitLevelsEnabled);
    if (useSmart && signalKind === "sfp_bear") {
      return { ...resolveBearishSfpExits(metrics, entry, limits, cfg), limits };
    }
    if (useSmart && signalKind === "level_break_bear") {
      return {
        ...resolveLevelBreakBearExits(metrics, entry, limits, cfg),
        limits,
      };
    }
    if (useSmart && signalKind === "pullback_bear") {
      return {
        ...resolvePullbackBearExits(metrics, entry, limits, cfg),
        limits,
      };
    }
    return { ...resolveDefaultExitsShort(metrics, entry, cfg, opts), limits };
  }

  const limits = buildExitLimits(entry, metrics.corridorHigh, {
    ...cfg,
    takeProfitPct: tpPct,
  });
  const useSmart = Boolean(cfg.smartExitLevelsEnabled);
  if (useSmart && signalKind === "sfp") {
    return { ...resolveSfpExits(metrics, entry, limits, cfg), limits };
  }
  if (useSmart && signalKind === "level_break") {
    return { ...resolveLevelBreakExits(metrics, entry, limits, cfg), limits };
  }
  if (useSmart && signalKind === "pullback") {
    return { ...resolvePullbackExits(metrics, entry, limits, cfg), limits };
  }
  return { ...resolveDefaultExits(metrics, entry, cfg, opts), limits };
}

function resolveExitLevels(signalKind, metrics, entry, cfg, opts = {}) {
  if (cfg?.aiExitLevelsEnabled) {
    const { resolveAiExitLevels } = require("./ai-exit-levels-model");
    const ai = resolveAiExitLevels(signalKind, metrics, entry, cfg, opts);
    if (ai?.stopLoss && ai?.takeProfit) return ai;
  }
  return resolveLegacyExitLevels(signalKind, metrics, entry, cfg, opts);
}

module.exports = {
  buildExitLimits,
  buildExitLimitsShort,
  clampStop,
  clampStopShort,
  clampTp,
  clampTpShort,
  resolveLevelBreakExits,
  resolveLevelBreakBearExits,
  resolveLegacyExitLevels,
  resolveExitLevels,
  resolveSfpExits,
  resolveBearishSfpExits,
  resolvePullbackExits,
  resolvePullbackBearExits,
  resolveDefaultExits,
  resolveDefaultExitsShort,
};
