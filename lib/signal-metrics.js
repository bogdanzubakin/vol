function parseInterval(interval) {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) throw new Error(`Invalid interval: ${interval}`);
  const n = Number(m[1]);
  const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 24 * 60;
  return { minutes, ms: minutes * 60 * 1000 };
}

function signalSpan(cfg) {
  return Math.max(
    cfg.signalCandles,
    cfg.bullishLookbackCandles ?? cfg.signalCandles
  );
}

function corridorExcludeBars(cfg) {
  const excludeMin = cfg.corridorExcludeMinutes ?? 40;
  const { minutes } = parseInterval(cfg.interval);
  return Math.max(0, Math.ceil(excludeMin / minutes));
}

function minHistoryBars(cfg) {
  const n = cfg.signalCandles;
  const exclude = corridorExcludeBars(cfg);
  return Math.max(signalSpan(cfg), cfg.corridorBars + n + exclude);
}

function sliceCorridorSignal(ohlc, cfg) {
  const n = cfg.signalCandles;
  const exclude = corridorExcludeBars(cfg);
  const corridorEnd = n + exclude;
  const corridorStart = corridorEnd + cfg.corridorBars;
  return {
    signal: ohlc.slice(-n),
    corridor: ohlc.slice(-corridorStart, -corridorEnd),
    excludeBars: exclude,
  };
}

function applyBarConfig(cfg) {
  const { minutes, ms } = parseInterval(cfg.interval);
  const barsPerDay = (24 * 60) / minutes;
  cfg.barMs = ms;
  cfg.corridorBars = Math.ceil(cfg.corridorDays * barsPerDay);
  cfg.corridorExcludeBars = corridorExcludeBars(cfg);
  const prefetchDays = cfg.prefetchDays ?? cfg.corridorDays;
  const prefetchBars = Math.ceil(prefetchDays * barsPerDay);
  cfg.limit = Math.max(cfg.corridorBars + cfg.corridorExcludeBars, prefetchBars) + signalSpan(cfg);
}

function countBullish(bars) {
  return bars.filter((b) => b.close > b.open).length;
}

function createConfig(overrides = {}) {
  const cfg = {
    interval: "1m",
    corridorDays: 2,
    corridorExcludeMinutes: 40,
    signalCandles: 3,
    bullishLookbackCandles: 10,
    minBullishCandles: 3,
    maxCorridorWidthPct: 40,
    minRangeMultiplier: 1.8,
    minCorridorRangePct: 0.02,
    minBreakVolumeMultiplier: 5,
    breakVolumeNearBars: 3,
    ...overrides,
  };
  applyBarConfig(cfg);
  return cfg;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function candleRangePct(bar) {
  return candleSizePct(bar) ?? 0;
}

/** Candle size = high − low, as % of close (not open−close). */
function candleSizePct(bar) {
  const { high, low, close } = bar ?? {};
  if (!Number.isFinite(high) || !Number.isFinite(low) || !close || close <= 0) {
    return null;
  }
  return ((high - low) / close) * 100;
}

/** Avg H−L % over lookback, excluding candles ≥ excludeMult × preliminary average. */
function fastMoverMetrics(bars, options = {}) {
  const lookback = options.fastMoveLookbackCandles ?? 10;
  const minAvgMovePct = options.minAvgMovePct ?? 0.5;
  const excludeMult = options.fastMoveExcludeMult ?? 3;
  if (!bars?.length || bars.length < lookback) return null;

  const window = bars.slice(-lookback);
  const ranges = window.map(candleSizePct).filter((r) => r != null && r >= 0);
  if (!ranges.length) return null;

  const prelimAvg = mean(ranges);
  const threshold = prelimAvg * excludeMult;
  const trimmed = ranges.filter((r) => r <= threshold);
  const used = trimmed.length ? trimmed : ranges;
  const avgMovePct = mean(used);
  const last = window[window.length - 1];
  if (!last?.close || last.close <= 0) return null;

  return {
    avgMovePct: +avgMovePct.toFixed(4),
    close: last.close,
    fastMover: avgMovePct >= minAvgMovePct,
    fastMoveLookbackCandles: lookback,
    minAvgMovePct,
    fastMoveExcludeMult: excludeMult,
    candlesUsed: used.length,
    candlesExcluded: ranges.length - used.length,
  };
}

/** Swing legs of at least fraction × corridor range (default 0.5 = half wave). */
function countHalfWaves(bars, corridorLow, corridorHigh, options = {}) {
  if (!bars?.length || corridorHigh <= corridorLow) return 0;
  const range = corridorHigh - corridorLow;
  const minMove = range * (options.halfWaveFraction ?? 0.5);
  if (minMove <= 0) return 0;

  let halfWaves = 0;
  let extreme = bars[0].close;
  let dir = null;

  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].close;
    if (!Number.isFinite(c)) continue;

    if (dir === null) {
      const up = c - extreme;
      const down = extreme - c;
      if (up >= minMove) {
        dir = "up";
        extreme = c;
      } else if (down >= minMove) {
        dir = "down";
        extreme = c;
      } else if (c > extreme) {
        extreme = c;
      } else if (c < extreme) {
        extreme = c;
      }
      continue;
    }

    if (dir === "up") {
      if (c >= extreme) extreme = c;
      else if (extreme - c >= minMove) {
        halfWaves++;
        dir = "down";
        extreme = c;
      }
    } else if (c <= extreme) {
      extreme = c;
    } else if (c - extreme >= minMove) {
      halfWaves++;
      dir = "up";
      extreme = c;
    }
  }

  return halfWaves;
}

function corridorWidthFromBars(ohlc, cfg) {
  const need = minHistoryBars(cfg);
  if (!ohlc?.length || ohlc.length < need) return null;
  const { corridor } = sliceCorridorSignal(ohlc, cfg);
  if (!corridor.length) return null;

  const corridorHigh = Math.max(...corridor.map((b) => b.high));
  const corridorLow = Math.min(...corridor.map((b) => b.low));
  const mid = (corridorHigh + corridorLow) / 2;
  if (mid <= 0) return null;

  const corridorWidthPct = ((corridorHigh - corridorLow) / mid) * 100;
  return {
    corridorHigh,
    corridorLow,
    corridorWidthPct: +corridorWidthPct.toFixed(2),
  };
}

function corridorWidthFromWindow(bars) {
  if (!bars?.length) return null;
  const corridorHigh = Math.max(...bars.map((b) => b.high));
  const corridorLow = Math.min(...bars.map((b) => b.low));
  const mid = (corridorHigh + corridorLow) / 2;
  if (mid <= 0) return null;
  const corridorWidthPct = ((corridorHigh - corridorLow) / mid) * 100;
  return {
    corridorHigh,
    corridorLow,
    corridorWidthPct: +corridorWidthPct.toFixed(2),
  };
}

/**
 * Fast mover in a target corridor width band with enough half-wave oscillations.
 */
function fastCorridorMetrics(ohlc, cfg, options = {}) {
  const fm = fastMoverMetrics(ohlc, {
    fastMoveLookbackCandles: options.fastMoveLookbackCandles ?? 10,
    minAvgMovePct: options.minAvgMovePct ?? 0.5,
    fastMoveExcludeMult: options.fastMoveExcludeMult ?? 3,
  });
  if (!fm?.fastMover) return null;

  const waveLookback = Math.max(
    2,
    Math.min(ohlc.length, options.halfWaveLookbackCandles ?? 180)
  );
  const waveBars = ohlc.slice(-waveLookback);
  const localCw = corridorWidthFromWindow(waveBars);
  if (!localCw) return null;

  const tol = options.corridorWidthTolerancePct ?? 10;
  const minW = options.minCorridorWidthPct ?? 1;
  const maxW = options.maxCorridorWidthPct ?? 5;
  const effMin = minW * (1 - tol / 100);
  const effMax = maxW * (1 + tol / 100);
  if (localCw.corridorWidthPct < effMin || localCw.corridorWidthPct > effMax)
    return null;

  const minHalfWaves = options.minHalfWaves ?? 3;
  const halfWaveFraction = options.halfWaveFraction ?? 0.5;
  const halfWaves = countHalfWaves(
    waveBars,
    localCw.corridorLow,
    localCw.corridorHigh,
    { halfWaveFraction }
  );
  if (halfWaves < minHalfWaves) return null;

  return {
    ...fm,
    ...localCw,
    halfWaves,
    halfWaveFraction,
    halfWaveLookbackCandles: waveLookback,
    minHalfWaves,
    minCorridorWidthPct: minW,
    maxCorridorWidthPct: maxW,
    corridorWidthTolerancePct: tol,
    effCorridorMinPct: +effMin.toFixed(3),
    effCorridorMaxPct: +effMax.toFixed(3),
    fastCorridor: true,
  };
}

function barVolume(bar) {
  const v = bar?.volume ?? bar?.quoteVolume;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function corridorAvgVolume(corridor) {
  const vols = corridor.map(barVolume).filter((v) => v > 0);
  return vols.length ? mean(vols) : 0;
}

/** Max quote volume within ±nearBars of the corridor top break (or last bar if not broken yet). */
function breakVolumeSpikeNear(ohlc, cfg, corridorHigh, corridor) {
  const n = cfg.signalCandles;
  const exclude = corridorExcludeBars(cfg);
  const postCorridor = ohlc.slice(-(n + exclude));
  const avgVol = corridorAvgVolume(corridor);
  const mult = cfg.minBreakVolumeMultiplier ?? 5;
  const nearBars = cfg.breakVolumeNearBars ?? Math.max(2, n);

  if (!postCorridor.length || avgVol <= 0) {
    return {
      breakVolumeSpike: false,
      breakVolumeRatio: 0,
      avgCorridorVolume: avgVol,
      maxNearBreakVolume: 0,
      breakVolumeNearBars: nearBars,
      minBreakVolumeMultiplier: mult,
    };
  }

  let breakRelIdx = -1;
  for (let i = 0; i < postCorridor.length; i++) {
    if (postCorridor[i].close > corridorHigh) breakRelIdx = i;
  }
  const anchorRel = breakRelIdx >= 0 ? breakRelIdx : postCorridor.length - 1;
  const winStart = Math.max(0, anchorRel - nearBars);
  const winEnd = Math.min(postCorridor.length, anchorRel + nearBars + 1);
  const windowBars = postCorridor.slice(winStart, winEnd);
  const maxNearVol = windowBars.length
    ? Math.max(...windowBars.map(barVolume))
    : 0;
  const ratio = maxNearVol / avgVol;

  return {
    breakVolumeSpike: ratio >= mult,
    breakVolumeRatio: +ratio.toFixed(2),
    avgCorridorVolume: avgVol,
    maxNearBreakVolume: maxNearVol,
    breakVolumeNearBars: nearBars,
    minBreakVolumeMultiplier: mult,
  };
}

function volSpikeMetrics(ohlc, cfg) {
  const n = cfg.signalCandles;
  const bullishLookback = cfg.bullishLookbackCandles ?? 10;
  const minBullish = cfg.minBullishCandles ?? 3;
  const need = minHistoryBars(cfg);
  if (ohlc.length < need) return null;

  const { signal, corridor } = sliceCorridorSignal(ohlc, cfg);
  const bullishWindow = ohlc.slice(-bullishLookback);

  const corridorHigh = Math.max(...corridor.map((b) => b.high));
  const corridorLow = Math.min(...corridor.map((b) => b.low));
  const mid = (corridorHigh + corridorLow) / 2;
  if (mid <= 0) return null;

  const corridorWidthPct = ((corridorHigh - corridorLow) / mid) * 100;
  const corridorFlat = corridorWidthPct <= cfg.maxCorridorWidthPct;

  const corridorRanges = corridor.map(candleRangePct);
  const avgCorridorRange = mean(corridorRanges);
  if (avgCorridorRange < cfg.minCorridorRangePct) return null;

  const signalRanges = signal.map(candleRangePct);
  let volIncreasing = true;
  for (let i = 1; i < signalRanges.length; i++) {
    if (signalRanges[i] <= signalRanges[i - 1]) {
      volIncreasing = false;
      break;
    }
  }

  const volSpike = signalRanges.every(
    (r) => r >= avgCorridorRange * cfg.minRangeMultiplier
  );

  const bullishCount = countBullish(bullishWindow);
  const bullish = bullishCount >= minBullish;

  const last = signal[n - 1];
  const breaksCorridor = last.close > corridorHigh;
  const recentRange = signalRanges[n - 1];
  const rangeRatio = recentRange / avgCorridorRange;

  const volNearBreak = breakVolumeSpikeNear(ohlc, cfg, corridorHigh, corridor);

  const passesExceptBreak =
    corridorFlat && volSpike && bullish && volNearBreak.breakVolumeSpike;
  const breakGap = corridorHigh - last.close;
  const breakGapPct =
    breakGap > 0 ? +((breakGap / corridorHigh) * 100).toFixed(4) : 0;
  const nearBreakMaxGapPct = cfg.nearBreakMaxGapPct ?? 0.1;
  const nearBreak =
    passesExceptBreak &&
    !breaksCorridor &&
    breakGap > 0 &&
    breakGapPct <= nearBreakMaxGapPct;

  return {
    corridorHigh,
    corridorLow,
    corridorWidthPct: +corridorWidthPct.toFixed(2),
    avgCorridorRange,
    close: last.close,
    recentRangePct: +recentRange.toFixed(3),
    rangeRatio: +rangeRatio.toFixed(2),
    volIncreasing,
    volSpike,
    ...volNearBreak,
    bullish,
    bullishCount,
    bullishLookback,
    minBullishCandles: minBullish,
    corridorFlat,
    breaksCorridor,
    passesExceptBreak,
    nearBreak,
    breakGapPct,
    bars: ohlc.length,
    passes:
      corridorFlat &&
      volSpike &&
      bullish &&
      volNearBreak.breakVolumeSpike &&
      breaksCorridor,
  };
}

function analyzeVolSpike(ohlc, cfg) {
  const n = cfg.signalCandles;
  const excludeMin = cfg.corridorExcludeMinutes ?? 40;
  const need = minHistoryBars(cfg);
  const checks = [];

  if (!ohlc?.length || ohlc.length < need) {
    return {
      passes: false,
      metrics: null,
      checks: [
        {
          id: "bars",
          label: "Enough history",
          pass: false,
          detail: `${ohlc?.length ?? 0} / ${need} bars`,
        },
      ],
    };
  }

  const { corridor } = sliceCorridorSignal(ohlc, cfg);
  const corridorRanges = corridor.map(candleRangePct);
  const avgCorridorRange = mean(corridorRanges);

  checks.push({
    id: "bars",
    label: "Enough history",
    pass: true,
    detail: `${ohlc.length} bars`,
  });
  checks.push({
    id: "minCorridorRange",
    label: `Avg corridor range ≥ ${cfg.minCorridorRangePct}% (excl. last ${excludeMin}m)`,
    pass: avgCorridorRange >= cfg.minCorridorRangePct,
    detail: `${avgCorridorRange.toFixed(4)}%`,
  });

  if (avgCorridorRange < cfg.minCorridorRangePct) {
    return { passes: false, metrics: null, checks };
  }

  const m = volSpikeMetrics(ohlc, cfg);
  if (!m) {
    return { passes: false, metrics: null, checks };
  }

  checks.push(
    {
      id: "corridorFlat",
      label: `Corridor width ≤ ${cfg.maxCorridorWidthPct}% (excl. last ${excludeMin}m)`,
      pass: m.corridorFlat,
      detail: `${m.corridorWidthPct}% wide`,
    },
    {
      id: "volIncreasing",
      label: "Signal ranges strictly increasing (bonus)",
      pass: m.volIncreasing,
      positiveOnly: true,
    },
    {
      id: "volSpike",
      label: `Each signal range ≥ ${cfg.minRangeMultiplier}× corridor avg`,
      pass: m.volSpike,
      detail: `last ${m.rangeRatio}×`,
    },
    {
      id: "bullish",
      label: `≥${m.minBullishCandles} bullish of last ${m.bullishLookback} (close > open)`,
      pass: m.bullish,
      detail: `${m.bullishCount} / ${m.bullishLookback}`,
    },
    {
      id: "breakVolumeSpike",
      label: `Volume ≥${m.minBreakVolumeMultiplier}× corridor avg near break (±${m.breakVolumeNearBars} bars)`,
      pass: m.breakVolumeSpike,
      detail: `${m.breakVolumeRatio}× peak`,
    },
    {
      id: "breaksCorridor",
      label: "Breaks corridor top (close > high)",
      pass: m.breaksCorridor,
      detail: m.nearBreak
        ? `${m.close} · ${m.breakGapPct}% below high`
        : `${m.close} vs ${m.corridorHigh}`,
    }
  );

  if (m.nearBreak) {
    checks.push({
      id: "nearBreak",
      label: "Near corridor break (setup)",
      pass: true,
      detail: `${m.breakGapPct}% below high`,
      positiveOnly: true,
    });
  }

  return { passes: m.passes, metrics: m, checks };
}

function failedCheckLabels(checks) {
  return checks
    .filter((c) => !c.pass && !c.positiveOnly)
    .map((c) => c.label);
}

function serializeChecks(checks) {
  if (!checks?.length) return [];
  return checks.map((c) => ({
    id: c.id,
    label: c.label,
    pass: Boolean(c.pass),
    detail: c.detail ?? null,
    positiveOnly: Boolean(c.positiveOnly),
  }));
}

function mergeCriteriaCatalog(catalog, checks) {
  for (const c of checks ?? []) {
    if (!catalog.has(c.id)) {
      catalog.set(c.id, {
        id: c.id,
        label: c.label,
        positiveOnly: Boolean(c.positiveOnly),
      });
    }
  }
}

/** Parse ?at= ISO string or unix ms. */
function parseAtTime(atParam) {
  if (atParam == null || atParam === "") return null;
  const raw = String(atParam).trim();
  let t;
  if (/^\d{10,13}$/.test(raw)) {
    t = Number(raw.length === 10 ? Number(raw) * 1000 : raw);
  } else {
    t = Date.parse(raw);
  }
  if (!Number.isFinite(t)) {
    throw new Error(`Invalid at time: ${atParam}`);
  }
  return raw.length === 10 ? t * 1000 : t;
}

/** Bars up to last candle closed at or before atMs (inclusive). */
function barsAtTime(bars, atMs) {
  if (atMs == null) return bars ?? [];
  if (!bars?.length) return [];

  let endIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].closeTime <= atMs) endIdx = i;
    else break;
  }
  if (endIdx < 0) return [];
  return bars.slice(0, endIdx + 1);
}

const { formatChartAxis: formatBarTime } = require("./time-format");

const LIVE_CONFIG_KEYS = [
  "corridorDays",
  "corridorExcludeMinutes",
  "signalCandles",
  "bullishLookbackCandles",
  "minBullishCandles",
  "maxCorridorWidthPct",
  "minRangeMultiplier",
  "minCorridorRangePct",
  "minBreakVolumeMultiplier",
  "breakVolumeNearBars",
  "fastMoveLookbackCandles",
  "minAvgMovePct",
  "fastMoveExcludeMult",
  "fastCorridorMinWidthPct",
  "fastCorridorMaxWidthPct",
  "fastCorridorWidthTolerancePct",
  "fastCorridorMinHalfWaves",
  "fastCorridorHalfWaveFraction",
  "fastCorridorHalfWaveLookback",
  "topMoveMinPct",
];

function pickLiveConfig(cfg) {
  const out = { interval: cfg.interval };
  for (const k of LIVE_CONFIG_KEYS) out[k] = cfg[k];
  return out;
}

function validateLiveConfigPatch(patch) {
  if (!patch || typeof patch !== "object") {
    throw new Error("Config body must be a JSON object");
  }

  const out = {};
  const rules = {
    corridorDays: { min: 0.25, max: 30, int: false },
    corridorExcludeMinutes: { min: 0, max: 240, int: true },
    signalCandles: { min: 2, max: 12, int: true },
    bullishLookbackCandles: { min: 3, max: 60, int: true },
    minBullishCandles: { min: 1, max: 60, int: true },
    maxCorridorWidthPct: { min: 0.1, max: 40, int: false },
    minRangeMultiplier: { min: 1, max: 10, int: false },
    minCorridorRangePct: { min: 0.001, max: 5, int: false },
    minBreakVolumeMultiplier: { min: 1.1, max: 20, int: false },
    breakVolumeNearBars: { min: 1, max: 30, int: true },
    fastMoveLookbackCandles: { min: 2, max: 120, int: true },
    minAvgMovePct: { min: 0.01, max: 20, int: false },
    fastMoveExcludeMult: { min: 1.5, max: 20, int: false },
    fastCorridorMinWidthPct: { min: 0.1, max: 50, int: false },
    fastCorridorMaxWidthPct: { min: 0.1, max: 50, int: false },
    fastCorridorWidthTolerancePct: { min: 0, max: 50, int: true },
    fastCorridorMinHalfWaves: { min: 1, max: 50, int: true },
    fastCorridorHalfWaveFraction: { min: 0.1, max: 1, int: false },
    fastCorridorHalfWaveLookback: { min: 2, max: 2000, int: true },
    topMoveMinPct: { min: 0.1, max: 1000, int: false },
  };

  for (const key of LIVE_CONFIG_KEYS) {
    if (patch[key] === undefined) continue;
    const rule = rules[key];
    let v = Number(patch[key]);
    if (!Number.isFinite(v)) throw new Error(`${key} must be a number`);
    if (rule.int) v = Math.round(v);
    if (v < rule.min || v > rule.max) {
      throw new Error(`${key} must be between ${rule.min} and ${rule.max}`);
    }
    out[key] = v;
  }

  if (!Object.keys(out).length) {
    throw new Error(`Provide at least one of: ${LIVE_CONFIG_KEYS.join(", ")}`);
  }

  if (out.minBullishCandles != null || out.bullishLookbackCandles != null) {
    const lookback = out.bullishLookbackCandles ?? patch.bullishLookbackCandles ?? 10;
    const minBull = out.minBullishCandles ?? patch.minBullishCandles ?? 3;
    if (minBull > lookback) {
      throw new Error(
        `minBullishCandles cannot exceed bullishLookbackCandles (${lookback})`
      );
    }
  }

  if (
    out.fastCorridorMinWidthPct != null ||
    out.fastCorridorMaxWidthPct != null
  ) {
    const minW =
      out.fastCorridorMinWidthPct ??
      patch.fastCorridorMinWidthPct ??
      1;
    const maxW =
      out.fastCorridorMaxWidthPct ??
      patch.fastCorridorMaxWidthPct ??
      5;
    if (maxW < minW) {
      throw new Error("fastCorridorMaxWidthPct must be >= fastCorridorMinWidthPct");
    }
  }

  return out;
}

module.exports = {
  parseInterval,
  applyBarConfig,
  signalSpan,
  corridorExcludeBars,
  minHistoryBars,
  sliceCorridorSignal,
  createConfig,
  mean,
  candleRangePct,
  candleSizePct,
  fastMoverMetrics,
  countHalfWaves,
  corridorWidthFromBars,
  fastCorridorMetrics,
  barVolume,
  corridorAvgVolume,
  breakVolumeSpikeNear,
  volSpikeMetrics,
  analyzeVolSpike,
  failedCheckLabels,
  serializeChecks,
  mergeCriteriaCatalog,
  parseAtTime,
  barsAtTime,
  formatBarTime,
  LIVE_CONFIG_KEYS,
  pickLiveConfig,
  validateLiveConfigPatch,
};
