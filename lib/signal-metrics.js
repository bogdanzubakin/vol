const ALLOWED_INTERVALS = ["1m", "5m", "15m"];

function parseInterval(interval) {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) throw new Error(`Invalid interval: ${interval}`);
  const n = Number(m[1]);
  const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 24 * 60;
  return { minutes, ms: minutes * 60 * 1000 };
}

function sfpRangeBars(cfg) {
  return cfg.sfpRangeBars ?? cfg.sfpLookbackBars ?? 60;
}

function minHistoryBars(cfg) {
  const sfp = sfpRangeBars(cfg) + (cfg.sfpReclaimBars ?? 5) + 5;
  const pb =
    (cfg.pullbackMaBars ?? 7) + (cfg.pullbackTouchLookback ?? 12) + 5;
  const fm = (cfg.fastMoveLookbackCandles ?? 10) + 5;
  return Math.max(sfp, pb, fm, 120);
}

function applyBarConfig(cfg) {
  const signalIv = cfg.interval ?? "1m";
  const { minutes, ms } = parseInterval(signalIv);
  cfg.signalBarMs = ms;
  const signalBarsPerDay = (24 * 60) / minutes;
  const need = minHistoryBars(cfg);
  const prefetchDays = cfg.prefetchDays ?? 3;
  cfg.signalLimit = Math.max(
    need + 30,
    Math.ceil(prefetchDays * signalBarsPerDay)
  );

  // Live pipeline (bots, movers, snapshots, gates) always uses 1m bars.
  cfg.barMs = 60_000;
  const primaryDayBars = 24 * 60;
  const headroom = Math.max(cfg.fastMoveLookbackCandles ?? 10, 120) + 20;
  cfg.limit = Math.min(
    cfg.cacheMaxBars,
    Math.max(
      Math.ceil(prefetchDays * primaryDayBars),
      primaryDayBars + headroom
    )
  );
}

function rangeHighLow(ohlc, barCount) {
  const slice = ohlc.slice(-Math.max(2, barCount));
  if (!slice.length) return null;
  const corridorHigh = Math.max(...slice.map((b) => b.high));
  const corridorLow = Math.min(...slice.map((b) => b.low));
  if (!Number.isFinite(corridorHigh) || !Number.isFinite(corridorLow)) {
    return null;
  }
  return { corridorHigh, corridorLow };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Candle size = high − low, as % of close. */
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
  const minLinearChangePct = options.minLinearChangePct ?? 0;
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
  const first = window[0];
  const last = window[window.length - 1];
  if (!last?.close || last.close <= 0) return null;
  if (!first?.close || first.close <= 0) return null;

  const linearChangePct = ((last.close - first.close) / first.close) * 100;
  const absLinearChangePct = Math.abs(linearChangePct);
  const avgOk = avgMovePct >= minAvgMovePct;
  const linearOk =
    minLinearChangePct <= 0 || absLinearChangePct >= minLinearChangePct;

  return {
    avgMovePct: +avgMovePct.toFixed(4),
    linearChangePct: +linearChangePct.toFixed(4),
    absLinearChangePct: +absLinearChangePct.toFixed(4),
    close: last.close,
    fastMover: avgOk && linearOk,
    avgOk,
    linearOk,
    fastMoveLookbackCandles: lookback,
    minAvgMovePct,
    minLinearChangePct,
    fastMoveExcludeMult: excludeMult,
    candlesUsed: used.length,
    candlesExcluded: ranges.length - used.length,
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

function barVolume(bar) {
  const v = bar?.volume ?? bar?.quoteVolume;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function smaClose(bars, n) {
  if (!bars?.length || n <= 0) return null;
  const slice = bars.slice(-n);
  if (slice.length < n) return null;
  let sum = 0;
  for (const b of slice) {
    if (!Number.isFinite(b.close)) return null;
    sum += b.close;
  }
  return sum / n;
}

/**
 * SFP / sweep-reclaim: wick below range low, then close reclaims within N bars.
 */
function sweepReclaimMetrics(ohlc, cfg) {
  const need = minHistoryBars(cfg);
  if (!ohlc?.length || ohlc.length < need) return null;

  const rangeBars = sfpRangeBars(cfg);
  const range = rangeHighLow(ohlc, rangeBars);
  if (!range || range.corridorHigh <= range.corridorLow) return null;
  const { corridorHigh, corridorLow } = range;

  const lookback = cfg.sfpLookbackBars ?? 30;
  const reclaimBars = cfg.sfpReclaimBars ?? 5;
  const minSweepPct = cfg.sfpMinSweepPct ?? 0.02;
  const scan = ohlc.slice(-Math.max(lookback, reclaimBars + 2));
  const last = ohlc[ohlc.length - 1];
  const sweepThreshold = corridorLow * (1 - minSweepPct / 100);

  let sweepIdx = -1;
  let sweepLow = null;
  for (let i = scan.length - 2; i >= 0; i--) {
    const bar = scan[i];
    if (!Number.isFinite(bar.low)) continue;
    if (bar.low < sweepThreshold) {
      sweepIdx = i;
      sweepLow = bar.low;
      break;
    }
  }

  const barsSinceSweep = sweepIdx >= 0 ? scan.length - 1 - sweepIdx : null;
  const timely =
    sweepIdx >= 0 && barsSinceSweep != null && barsSinceSweep <= reclaimBars;
  const reclaimLevel =
    sweepLow != null ? Math.max(corridorLow, sweepLow) : corridorLow;
  const reclaimed =
    sweepIdx >= 0 &&
    Number.isFinite(last.close) &&
    last.close > reclaimLevel &&
    last.close > corridorLow;
  const passes = Boolean(reclaimed && timely);

  const localCw = corridorWidthFromWindow(
    ohlc.slice(-Math.min(120, ohlc.length))
  );

  return {
    corridorHigh,
    corridorLow,
    close: last.close,
    sweepLow,
    sweepThreshold: +sweepThreshold.toFixed(6),
    barsSinceSweep,
    reclaimBars,
    reclaimed,
    timely,
    sfp: passes,
    passes,
    bars: ohlc.length,
    corridorWidthPct: localCw?.corridorWidthPct ?? null,
  };
}

function analyzeSweepReclaim(ohlc, cfg) {
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

  checks.push({
    id: "bars",
    label: "Enough history",
    pass: true,
    detail: `${ohlc.length} bars`,
  });

  const m = sweepReclaimMetrics(ohlc, cfg);
  if (!m) {
    return { passes: false, metrics: null, checks };
  }

  const swept = m.sweepLow != null;
  checks.push(
    {
      id: "sfpSweep",
      label: `Sweep below range low (≥${cfg.sfpMinSweepPct ?? 0.02}% wick)`,
      pass: swept,
      detail: swept
        ? `low ${m.sweepLow?.toFixed(6)} < ${m.sweepThreshold?.toFixed(6)}`
        : "no sweep in lookback",
    },
    {
      id: "sfpReclaim",
      label: "Close reclaims above sweep / range low",
      pass: m.reclaimed,
      detail: m.reclaimed
        ? `${m.close} > ${Math.max(m.corridorLow, m.sweepLow ?? 0).toFixed(6)}`
        : `${m.close} vs low ${m.corridorLow}`,
    },
    {
      id: "sfpTimely",
      label: `Reclaim within ${m.reclaimBars} bars of sweep`,
      pass: m.timely,
      detail:
        m.barsSinceSweep != null
          ? `${m.barsSinceSweep} bars since sweep`
          : "—",
    }
  );

  return { passes: m.passes, metrics: m, checks };
}

/** Fast-mover pullback: fast mover (1m) + MA touch + bullish bounce on signal bars. */
function fastMoverPullbackMetrics(ohlc, cfg, fmOpts = {}, moverBars = null) {
  const fmSource = moverBars ?? ohlc;
  const fm = fastMoverMetrics(fmSource, {
    fastMoveLookbackCandles:
      fmOpts.fastMoveLookbackCandles ?? cfg.fastMoveLookbackCandles,
    minAvgMovePct: fmOpts.minAvgMovePct ?? cfg.minAvgMovePct,
    minLinearChangePct:
      fmOpts.minLinearChangePct ?? cfg.minLinearChangePct,
    fastMoveExcludeMult:
      fmOpts.fastMoveExcludeMult ?? cfg.fastMoveExcludeMult,
  });
  if (!fm?.fastMover) return null;

  const maBars = cfg.pullbackMaBars ?? 7;
  const touchLookback = cfg.pullbackTouchLookback ?? 12;
  const maxDistPct = cfg.pullbackMaxDistancePct ?? 0.35;
  const maxAboveMaPct = cfg.pullbackMaxAboveMaPct ?? 1.5;
  const need = Math.max(maBars, touchLookback) + 5;
  if (ohlc.length < need) return null;

  const ma = smaClose(ohlc, maBars);
  const last = ohlc[ohlc.length - 1];
  if (!Number.isFinite(ma) || !last?.close) return null;

  const touchWindow = ohlc.slice(-touchLookback);
  const touchedMa = touchWindow.some((b) => {
    if (!Number.isFinite(b.low)) return false;
    const distPct = (Math.abs(b.low - ma) / ma) * 100;
    return distPct <= maxDistPct;
  });

  const distFromMaPct = ((last.close - ma) / ma) * 100;
  const bounce = last.close > last.open;
  const nearMa = distFromMaPct >= 0 && distFromMaPct <= maxAboveMaPct;
  const passes = Boolean(touchedMa && bounce && nearMa);

  const localCw = corridorWidthFromWindow(
    ohlc.slice(-Math.min(120, ohlc.length))
  );
  if (!localCw) return null;

  return {
    ...fm,
    ...localCw,
    ma: +ma.toFixed(6),
    distFromMaPct: +distFromMaPct.toFixed(3),
    touchedMa,
    bounce,
    nearMa,
    pullback: passes,
    passes,
    maBars,
    touchLookback,
    maxDistPct,
    maxAboveMaPct,
    bars: ohlc.length,
  };
}

function analyzePullback(ohlc, cfg, fmOpts = {}, moverBars = null) {
  const maBars = cfg.pullbackMaBars ?? 7;
  const touchLookback = cfg.pullbackTouchLookback ?? 12;
  const need = Math.max(minHistoryBars(cfg), maBars + touchLookback);
  const checks = [];
  const fmSource = moverBars ?? ohlc;

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

  checks.push({
    id: "bars",
    label: "Enough history",
    pass: true,
    detail: `${ohlc.length} bars`,
  });

  const fm = fastMoverMetrics(fmSource, {
    fastMoveLookbackCandles:
      fmOpts.fastMoveLookbackCandles ?? cfg.fastMoveLookbackCandles,
    minAvgMovePct: fmOpts.minAvgMovePct ?? cfg.minAvgMovePct,
    minLinearChangePct:
      fmOpts.minLinearChangePct ?? cfg.minLinearChangePct,
    fastMoveExcludeMult:
      fmOpts.fastMoveExcludeMult ?? cfg.fastMoveExcludeMult,
  });

  checks.push({
    id: "fastMover",
    label: `Fast mover (avg H−L ≥ ${fm?.minAvgMovePct ?? cfg.minAvgMovePct}%)`,
    pass: Boolean(fm?.fastMover),
    detail: fm
      ? `${fm.avgMovePct}% avg · linear ${fm.linearChangePct}%`
      : "not a fast mover",
  });

  if (!fm?.fastMover) {
    return { passes: false, metrics: null, checks };
  }

  const m = fastMoverPullbackMetrics(ohlc, cfg, fmOpts, moverBars);
  if (!m) {
    return { passes: false, metrics: null, checks };
  }

  checks.push(
    {
      id: "pullbackTouch",
      label: `Touched MA${maBars} within ${cfg.pullbackMaxDistancePct ?? 0.35}% (last ${touchLookback} bars)`,
      pass: m.touchedMa,
      detail: m.touchedMa ? `MA ${m.ma}` : "no touch",
    },
    {
      id: "pullbackBounce",
      label: "Bullish bounce bar (close > open)",
      pass: m.bounce,
      detail: m.bounce ? "yes" : "no",
    },
    {
      id: "pullbackNearMa",
      label: `Close within 0–${cfg.pullbackMaxAboveMaPct ?? 1.5}% above MA`,
      pass: m.nearMa,
      detail: `${m.distFromMaPct}% from MA`,
    }
  );

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
  "fastMoveLookbackCandles",
  "minAvgMovePct",
  "minLinearChangePct",
  "fastMoveExcludeMult",
  "sfpLookbackBars",
  "sfpReclaimBars",
  "sfpMinSweepPct",
  "sfpRangeBars",
  "pullbackMaBars",
  "pullbackTouchLookback",
  "pullbackMaxDistancePct",
  "pullbackMaxAboveMaPct",
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

  if (patch.interval !== undefined) {
    const iv = String(patch.interval).trim();
    if (!ALLOWED_INTERVALS.includes(iv)) {
      throw new Error(`interval must be one of: ${ALLOWED_INTERVALS.join(", ")}`);
    }
    out.interval = iv;
  }

  const rules = {
    fastMoveLookbackCandles: { min: 2, max: 120, int: true },
    minAvgMovePct: { min: 0.01, max: 20, int: false },
    minLinearChangePct: { min: 0, max: 100, int: false },
    fastMoveExcludeMult: { min: 1.5, max: 20, int: false },
    sfpLookbackBars: { min: 5, max: 120, int: true },
    sfpReclaimBars: { min: 1, max: 30, int: true },
    sfpMinSweepPct: { min: 0, max: 5, int: false },
    sfpRangeBars: { min: 10, max: 500, int: true },
    pullbackMaBars: { min: 3, max: 60, int: true },
    pullbackTouchLookback: { min: 3, max: 60, int: true },
    pullbackMaxDistancePct: { min: 0.05, max: 5, int: false },
    pullbackMaxAboveMaPct: { min: 0.1, max: 20, int: false },
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
    throw new Error(
      `Provide interval or at least one of: ${LIVE_CONFIG_KEYS.join(", ")}`
    );
  }

  return out;
}

/** Fast-mover options for pullback tab / API. */
function fastMoverLookbackFor1m(cfg, candleLookback) {
  const raw = candleLookback ?? cfg.fastMoveLookbackCandles ?? 10;
  const signalMs = cfg.signalBarMs ?? cfg.barMs ?? 60_000;
  return Math.max(
    2,
    Math.min(120, Math.round(raw * (signalMs / 60_000)))
  );
}

function fastMoverOptsFromCfg(cfg, candleLookback) {
  return {
    fastMoveLookbackCandles: fastMoverLookbackFor1m(cfg, candleLookback),
    minAvgMovePct: cfg.minAvgMovePct,
    minLinearChangePct: cfg.minLinearChangePct,
    fastMoveExcludeMult: cfg.fastMoveExcludeMult,
  };
}

module.exports = {
  ALLOWED_INTERVALS,
  parseInterval,
  applyBarConfig,
  minHistoryBars,
  sfpRangeBars,
  rangeHighLow,
  mean,
  candleSizePct,
  fastMoverMetrics,
  corridorWidthFromWindow,
  barVolume,
  sweepReclaimMetrics,
  analyzeSweepReclaim,
  fastMoverPullbackMetrics,
  analyzePullback,
  smaClose,
  failedCheckLabels,
  serializeChecks,
  mergeCriteriaCatalog,
  parseAtTime,
  barsAtTime,
  formatBarTime,
  LIVE_CONFIG_KEYS,
  pickLiveConfig,
  validateLiveConfigPatch,
  fastMoverOptsFromCfg,
  fastMoverLookbackFor1m,
};
