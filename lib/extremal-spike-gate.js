const {
  applyBarConfig,
  barsAtTime,
  candleSizePct,
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

/** Any H-L candle in window ≥ excludeMult × preliminary average range. */
function findExtremalCandles(bars, excludeMult) {
  const ranges = bars
    .map((bar, i) => ({ bar, i, r: candleSizePct(bar) }))
    .filter((x) => x.r != null && x.r >= 0);
  if (ranges.length < 2) return { extremal: [], prelimAvg: null, threshold: null };

  const prelimAvg = mean(ranges.map((x) => x.r));
  const threshold = prelimAvg * excludeMult;
  const extremal = ranges.filter((x) => x.r >= threshold);
  return { extremal, prelimAvg, threshold };
}

/**
 * Live-entry gate: block when instrument had extremal H-L spikes recently.
 * pass=true → no extremal candles in the lookback window.
 */
function evaluateExtremalSpikeGate(bars, rawCfg = {}, atMs) {
  const cfg = mergeGateConfig(rawCfg);
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

  const { extremal, prelimAvg, threshold } = findExtremalCandles(
    recent,
    cfg.fastMoveExcludeMult
  );

  if (!extremal.length) {
    return {
      enabled: true,
      pass: true,
      windowMinutes: cfg.extremalSpikeWindowMinutes,
      windowBars: recent.length,
      excludeMult: cfg.fastMoveExcludeMult,
      avgRangePct: prelimAvg != null ? +prelimAvg.toFixed(3) : null,
      label: "clear",
      detail: `no extremal H-L candles in last ${cfg.extremalSpikeWindowMinutes}m`,
    };
  }

  const worst = extremal.reduce((a, b) => (a.r > b.r ? a : b));
  return {
    enabled: true,
    pass: false,
    windowMinutes: cfg.extremalSpikeWindowMinutes,
    windowBars: recent.length,
    extremalCount: extremal.length,
    excludeMult: cfg.fastMoveExcludeMult,
    avgRangePct: prelimAvg != null ? +prelimAvg.toFixed(3) : null,
    maxRangePct: +worst.r.toFixed(3),
    thresholdPct: threshold != null ? +threshold.toFixed(3) : null,
    label: "blocked",
    detail:
      `${extremal.length} extremal candle(s) in last ${cfg.extremalSpikeWindowMinutes}m ` +
      `(max H-L ${worst.r.toFixed(2)}% ≥ ${cfg.fastMoveExcludeMult}× ${prelimAvg.toFixed(2)}%)`,
  };
}

module.exports = {
  GATE_DEFAULTS,
  mergeGateConfig,
  findExtremalCandles,
  evaluateExtremalSpikeGate,
};
