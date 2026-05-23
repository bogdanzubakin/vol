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

function applyBarConfig(cfg) {
  const { minutes, ms } = parseInterval(cfg.interval);
  const barsPerDay = (24 * 60) / minutes;
  cfg.barMs = ms;
  cfg.corridorBars = Math.ceil(cfg.corridorDays * barsPerDay);
  const prefetchDays = cfg.prefetchDays ?? cfg.corridorDays;
  const prefetchBars = Math.ceil(prefetchDays * barsPerDay);
  cfg.limit = Math.max(cfg.corridorBars, prefetchBars) + signalSpan(cfg);
}

function countBullish(bars) {
  return bars.filter((b) => b.close > b.open).length;
}

function createConfig(overrides = {}) {
  const cfg = {
    interval: "1m",
    corridorDays: 2,
    signalCandles: 3,
    bullishLookbackCandles: 10,
    minBullishCandles: 3,
    maxCorridorWidthPct: 1.5,
    minRangeMultiplier: 1.8,
    minCorridorRangePct: 0.02,
    ...overrides,
  };
  applyBarConfig(cfg);
  return cfg;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function candleRangePct(bar) {
  return ((bar.high - bar.low) / bar.close) * 100;
}

function volSpikeMetrics(ohlc, cfg) {
  const n = cfg.signalCandles;
  const bullishLookback = cfg.bullishLookbackCandles ?? 10;
  const minBullish = cfg.minBullishCandles ?? 3;
  const need = cfg.corridorBars + signalSpan(cfg);
  if (ohlc.length < need) return null;

  const corridor = ohlc.slice(-(cfg.corridorBars + n), -n);
  const signal = ohlc.slice(-n);
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
  let directionUp = true;
  for (let i = 1; i < signal.length; i++) {
    if (signal[i].close <= signal[i - 1].close) {
      directionUp = false;
      break;
    }
  }

  const last = signal[n - 1];
  const breaksCorridor = last.close > corridorHigh;
  const recentRange = signalRanges[n - 1];
  const rangeRatio = recentRange / avgCorridorRange;

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
    bullish,
    bullishCount,
    bullishLookback,
    minBullishCandles: minBullish,
    directionUp,
    corridorFlat,
    breaksCorridor,
    bars: ohlc.length,
    passes:
      corridorFlat && volSpike && bullish && directionUp && breaksCorridor,
  };
}

function analyzeVolSpike(ohlc, cfg) {
  const n = cfg.signalCandles;
  const need = cfg.corridorBars + signalSpan(cfg);
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

  const corridor = ohlc.slice(-(cfg.corridorBars + n), -n);
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
    label: `Avg corridor range ≥ ${cfg.minCorridorRangePct}%`,
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
      label: `Corridor width ≤ ${cfg.maxCorridorWidthPct}%`,
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
      id: "directionUp",
      label: "Signal closes rising",
      pass: m.directionUp,
    },
    {
      id: "breaksCorridor",
      label: "Close breaks corridor high",
      pass: m.breaksCorridor,
      detail: `${m.close} vs ${m.corridorHigh}`,
    }
  );

  return { passes: m.passes, metrics: m, checks };
}

function failedCheckLabels(checks) {
  return checks
    .filter((c) => !c.pass && !c.positiveOnly)
    .map((c) => c.label);
}

/** Parse ?at= ISO string or unix ms. */
function parseAtTime(atParam) {
  if (atParam == null || atParam === "") return null;
  const raw = String(atParam).trim();
  const t = /^\d{10,13}$/.test(raw) ? Number(raw) : Date.parse(raw);
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

function formatBarTime(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

const LIVE_CONFIG_KEYS = [
  "corridorDays",
  "signalCandles",
  "bullishLookbackCandles",
  "minBullishCandles",
  "maxCorridorWidthPct",
  "minRangeMultiplier",
  "minCorridorRangePct",
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
    signalCandles: { min: 2, max: 12, int: true },
    bullishLookbackCandles: { min: 3, max: 60, int: true },
    minBullishCandles: { min: 1, max: 60, int: true },
    maxCorridorWidthPct: { min: 0.1, max: 20, int: false },
    minRangeMultiplier: { min: 1, max: 10, int: false },
    minCorridorRangePct: { min: 0.001, max: 5, int: false },
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

  return out;
}

module.exports = {
  parseInterval,
  applyBarConfig,
  signalSpan,
  createConfig,
  mean,
  candleRangePct,
  volSpikeMetrics,
  analyzeVolSpike,
  failedCheckLabels,
  parseAtTime,
  barsAtTime,
  formatBarTime,
  LIVE_CONFIG_KEYS,
  pickLiveConfig,
  validateLiveConfigPatch,
};
