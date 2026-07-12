/**
 * Minimal bull/bear config overrides.
 *
 * Shared keys stay as today. Optional `*Bear` / `*Bull` fields override when set
 * (null/undefined/"" = inherit shared). Bear is the priority; Bull overrides are
 * supported for symmetry but optional.
 *
 *   cfgForSignal(cfg, "sfp_bear") → shared + Bear overrides applied
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isBearSignal(signalKind, opts = {}) {
  const k = String(signalKind || "");
  if (
    k === "sfp_bear" ||
    k === "pullback_bear" ||
    k === "level_break_bear" ||
    opts.side === "SHORT"
  ) {
    return true;
  }
  return false;
}

/** Exit / risk keys that may have Bull/Bear overrides. */
const EXIT_OVERRIDE_BASE_KEYS = [
  "takeProfitPct",
  "sfpTakeProfitPct",
  "takeProfitMinPct",
  "stopLossBelowCorridorPct",
  "minSmartStopDistancePct",
  "maxSfpCorridorWidthPct",
  "maxPullbackCorridorWidthPct",
  "aiExitLevelsSlScale",
  "aiExitLevelsTpScale",
  "earlyAbortEnabled",
  "earlyAbortBars",
  "earlyAbortInvalidateBars",
  "earlyAbortMinProgressPct",
  "earlyAbortMaxAdversePct",
];

/** Scanner detection geometry — optional *Bear / *Bull (null = inherit shared). */
const DETECTION_OVERRIDE_BASE_KEYS = [
  "sfpMinSweepPct",
  "sfpReclaimBars",
  "pullbackMaBars",
  "pullbackMaxDistancePct",
  "pullbackMaxBelowMaPct",
];

/** Base keys that may have Bull/Bear overrides. */
const SIDE_OVERRIDE_BASE_KEYS = [
  ...EXIT_OVERRIDE_BASE_KEYS,
  ...DETECTION_OVERRIDE_BASE_KEYS,
];

const BOOL_OVERRIDE_KEYS = new Set(["earlyAbortEnabled"]);

function sideSuffix(signalKind, opts = {}) {
  return isBearSignal(signalKind, opts) ? "Bear" : "Bull";
}

function hasOverride(value) {
  return value !== undefined && value !== null && value !== "";
}

function readOverride(cfg, baseKey, suffix) {
  const raw = cfg?.[`${baseKey}${suffix}`];
  if (!hasOverride(raw)) return null;
  if (BOOL_OVERRIDE_KEYS.has(baseKey)) return Boolean(raw);
  const n = num(raw);
  return n;
}

/**
 * Shallow clone of cfg with side-specific overrides applied onto shared keys.
 */
function cfgForSignal(cfg, signalKind, opts = {}) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const suffix = sideSuffix(signalKind, opts);
  let changed = false;
  const out = { ...cfg };
  for (const key of SIDE_OVERRIDE_BASE_KEYS) {
    const ov = readOverride(cfg, key, suffix);
    if (ov == null && !(BOOL_OVERRIDE_KEYS.has(key) && hasOverride(cfg[`${key}${suffix}`]))) {
      continue;
    }
    if (BOOL_OVERRIDE_KEYS.has(key)) {
      if (!hasOverride(cfg[`${key}${suffix}`])) continue;
      out[key] = Boolean(cfg[`${key}${suffix}`]);
      changed = true;
      continue;
    }
    if (ov == null) continue;
    out[key] = ov;
    changed = true;
  }
  return changed ? out : cfg;
}

function optionalSideNum(raw, key) {
  if (!hasOverride(raw?.[key])) return null;
  return num(raw[key]);
}

function optionalSideBool(raw, key) {
  if (!hasOverride(raw?.[key])) return null;
  return Boolean(raw[key]);
}

/**
 * Normalize optional *Bear / *Bull fields for persistence (null = inherit).
 */
function normalizeSideOverrides(raw = {}) {
  const out = {};
  for (const base of SIDE_OVERRIDE_BASE_KEYS) {
    for (const suffix of ["Bull", "Bear"]) {
      const key = `${base}${suffix}`;
      if (BOOL_OVERRIDE_KEYS.has(base)) {
        out[key] = optionalSideBool(raw, key);
      } else {
        out[key] = optionalSideNum(raw, key);
      }
    }
  }
  return out;
}

module.exports = {
  SIDE_OVERRIDE_BASE_KEYS,
  EXIT_OVERRIDE_BASE_KEYS,
  DETECTION_OVERRIDE_BASE_KEYS,
  isBearSignal,
  sideSuffix,
  cfgForSignal,
  normalizeSideOverrides,
  hasOverride,
};
