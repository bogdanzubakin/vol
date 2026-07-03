const { isShort } = require("./position-side");

const FEATURE_NAMES = [
  "sideShort",
  "corridorWidthPct",
  "entryAboveCorridorPct",
  "sweepDepthPct",
  "linearChangePct",
  "minAvgMovePct",
  "stopLossBelowCorridorPct",
  "stopLossFallbackPnlPct",
  "takeProfitPct",
  "takeProfitMinPct",
  "minSmartStopDistancePct",
  "sfpTakeProfitPct",
  "smartExitOn",
  "legacySlDistPct",
  "legacyTpDistPct",
];

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pctDist(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0;
  return ((b - a) / a) * 100;
}

function extractExitLevelsFeatures(metrics, entry, cfg, signalKind, opts = {}) {
  const snap = opts.signalSnapshot ?? metrics ?? {};
  const short =
    signalKind === "sfp_bear" ||
    signalKind === "level_break_bear" ||
    opts.side === "SHORT";
  const corridorLow = num(snap.corridorLow ?? metrics?.corridorLow);
  const corridorHigh = num(snap.corridorHigh ?? metrics?.corridorHigh);
  const corridorWidthPct = num(
    snap.corridorWidthPct,
    corridorLow > 0 && corridorHigh > corridorLow
      ? ((corridorHigh - corridorLow) / corridorLow) * 100
      : 0
  );

  const sweepLow = num(snap.sweepLow ?? metrics?.sweepLow, corridorLow);
  const sweepHigh = num(snap.sweepHigh ?? metrics?.sweepHigh, corridorHigh);
  const sweepDepthPct = short
    ? pctDist(entry, sweepHigh)
    : pctDist(sweepLow, entry);

  const refCorridor = short ? corridorHigh : corridorLow;
  const entryAboveCorridorPct = Number.isFinite(refCorridor)
    ? pctDist(refCorridor, entry)
    : 0;

  const legacySl = num(opts.legacySlDistPct, num(cfg.stopLossFallbackPnlPct, 2));
  const legacyTp = num(
    opts.legacyTpDistPct,
    (signalKind === "sfp" || signalKind === "sfp_bear") &&
      num(cfg.sfpTakeProfitPct, 0) > 0
      ? Math.min(num(cfg.sfpTakeProfitPct), num(cfg.takeProfitPct, 5))
      : num(cfg.takeProfitPct, 5)
  );

  return {
    sideShort: short ? 1 : 0,
    corridorWidthPct: corridorWidthPct / 25,
    entryAboveCorridorPct: entryAboveCorridorPct / 5,
    sweepDepthPct: sweepDepthPct / 3,
    linearChangePct: num(snap.linearChangePct ?? metrics?.linearChangePct) / 10,
    minAvgMovePct: num(cfg.minAvgMovePct, 0.4) / 2,
    stopLossBelowCorridorPct: num(cfg.stopLossBelowCorridorPct, 2) / 5,
    stopLossFallbackPnlPct: num(cfg.stopLossFallbackPnlPct, 2) / 5,
    takeProfitPct: num(cfg.takeProfitPct, 5) / 10,
    takeProfitMinPct: num(cfg.takeProfitMinPct, 1.5) / 5,
    minSmartStopDistancePct: num(cfg.minSmartStopDistancePct, 0.8) / 3,
    sfpTakeProfitPct: num(cfg.sfpTakeProfitPct, 4.5) / 10,
    smartExitOn: cfg.smartExitLevelsEnabled !== false ? 1 : 0,
    legacySlDistPct: legacySl / 5,
    legacyTpDistPct: legacyTp / 10,
    signalKind,
  };
}

function featuresToVector(features) {
  return FEATURE_NAMES.map((k) => num(features[k], 0));
}

module.exports = {
  FEATURE_NAMES,
  extractExitLevelsFeatures,
  featuresToVector,
};
