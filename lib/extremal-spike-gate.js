const {
  applyBarConfig,
  barsAtTime,
  mean,
} = require("./signal-metrics");

const GATE_DEFAULTS = {
  extremalSpikeGateEnabled: true,
  extremalSpikeWindowMinutes: 30,
  extremalSpikeMinBars: 5,
  fastMoveExcludeMult: 3,
  interval: "1m",
};

function mergeGateConfig(rawInput) {
  const raw = rawInput ?? {};
  const cfg = {
    ...GATE_DEFAULTS,
    ...raw,
    extremalSpikeGateEnabled: raw.extremalSpikeGateEnabled !== false,
    extremalSpikeWindowMinutes:
      raw.extremalSpikeWindowMinutes ?? GATE_DEFAULTS.extremalSpikeWindowMinutes,
    extremalSpikeMinBars:
      raw.extremalSpikeMinBars ?? GATE_DEFAULTS.extremalSpikeMinBars,
    fastMoveExcludeMult:
      raw.fastMoveExcludeMult ?? GATE_DEFAULTS.fastMoveExcludeMult,
    interval: raw.interval ?? GATE_DEFAULTS.interval,
  };
  applyBarConfig(cfg);
  return cfg;
}

function windowBarCount(cfg) {
  return Math.max(
    1,
    Math.ceil((cfg.extremalSpikeWindowMinutes * 60_000) / cfg.barMs)
  );
}

/** Candle body size = |close − open|, as % of close (no wicks). */
function candleBodySizePct(bar) {
  const { open, close } = bar ?? {};
  if (!Number.isFinite(open) || !Number.isFinite(close) || !close || close <= 0) {
    return null;
  }
  return (Math.abs(close - open) / close) * 100;
}

/** 1 = bullish body, −1 = bearish, 0 = doji. */
function candleBodyDirection(bar) {
  const { open, close } = bar ?? {};
  if (!Number.isFinite(open) || !Number.isFinite(close)) return 0;
  if (close > open) return 1;
  if (close < open) return -1;
  return 0;
}

function bodyDirectionOpposesSide(direction, side) {
  if (!direction) return false;
  const s = String(side || "LONG").toUpperCase();
  if (s === "SHORT") return direction > 0;
  return direction < 0;
}

function sideDirectionLabel(side) {
  return String(side || "LONG").toUpperCase() === "SHORT" ? "bullish" : "bearish";
}

/** Any open-close body in window ≥ excludeMult × preliminary average body size. */
function findExtremalBodyCandles(bars, excludeMult) {
  const items = bars
    .map((bar, i) => ({
      bar,
      i,
      r: candleBodySizePct(bar),
      direction: candleBodyDirection(bar),
    }))
    .filter((x) => x.r != null && x.r > 0);
  if (items.length < 2) return { extremal: [], prelimAvg: null, threshold: null };

  const prelimAvg = mean(items.map((x) => x.r));
  const threshold = prelimAvg * excludeMult;
  const extremal = items.filter((x) => x.r >= threshold);
  return { extremal, prelimAvg, threshold };
}

/**
 * Live-entry gate: block when recent extremal bodies oppose the trade direction.
 * pass=true → no opposing extremal bodies in the lookback window.
 */
function evaluateExtremalSpikeGate(bars, rawCfg = {}, atMs, options = {}) {
  const cfg = mergeGateConfig(rawCfg);
  const positionSide = options.positionSide ?? rawCfg.positionSide ?? "LONG";
  if (!cfg.extremalSpikeGateEnabled) {
    return {
      enabled: false,
      pass: true,
      label: "off",
      detail: "extremal spike gate disabled",
    };
  }

  const window = atMs != null ? barsAtTime(bars, atMs) : bars ?? [];
  const need = windowBarCount(cfg);
  const recent = window.slice(-need);
  const minBars = cfg.extremalSpikeMinBars;

  if (recent.length < minBars) {
    return {
      enabled: true,
      pass: false,
      waiting: true,
      windowMinutes: cfg.extremalSpikeWindowMinutes,
      label: "waiting",
      detail: `${recent.length}/${minBars} bars in last ${cfg.extremalSpikeWindowMinutes}m`,
    };
  }

  const { extremal, prelimAvg, threshold } = findExtremalBodyCandles(
    recent,
    cfg.fastMoveExcludeMult
  );

  const opposing = extremal.filter((x) =>
    bodyDirectionOpposesSide(x.direction, positionSide)
  );

  if (!opposing.length) {
    const aligned = extremal.length;
    return {
      enabled: true,
      pass: true,
      positionSide,
      windowMinutes: cfg.extremalSpikeWindowMinutes,
      windowBars: recent.length,
      excludeMult: cfg.fastMoveExcludeMult,
      avgBodyPct: prelimAvg != null ? +prelimAvg.toFixed(3) : null,
      extremalCount: extremal.length,
      label: "clear",
      detail: aligned
        ? `no opposing extremal bodies for ${positionSide} (${aligned} aligned/neutral in last ${cfg.extremalSpikeWindowMinutes}m)`
        : `no extremal bodies in last ${cfg.extremalSpikeWindowMinutes}m`,
    };
  }

  const worst = opposing.reduce((a, b) => (a.r > b.r ? a : b));
  return {
    enabled: true,
    pass: false,
    positionSide,
    windowMinutes: cfg.extremalSpikeWindowMinutes,
    windowBars: recent.length,
    extremalCount: opposing.length,
    excludeMult: cfg.fastMoveExcludeMult,
    avgBodyPct: prelimAvg != null ? +prelimAvg.toFixed(3) : null,
    maxBodyPct: +worst.r.toFixed(3),
    thresholdPct: threshold != null ? +threshold.toFixed(3) : null,
    label: "blocked",
    detail:
      `${opposing.length} opposing extremal body candle(s) for ${positionSide} ` +
      `(${sideDirectionLabel(positionSide)} in last ${cfg.extremalSpikeWindowMinutes}m · ` +
      `max body ${worst.r.toFixed(2)}% ≥ ${cfg.fastMoveExcludeMult}× ${prelimAvg.toFixed(2)}%)`,
  };
}

module.exports = {
  GATE_DEFAULTS,
  mergeGateConfig,
  candleBodySizePct,
  candleBodyDirection,
  findExtremalBodyCandles,
  evaluateExtremalSpikeGate,
};
