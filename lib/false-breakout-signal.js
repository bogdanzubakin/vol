/**
 * False Breakout (FB) — body break beyond a range, then fail back inside.
 *
 * Differs from SFP (wick sweep + reclaim): requires a **close** beyond the
 * level (true break attempt), then a later close back inside the range.
 *
 *   false_breakout      → LONG  (failed breakdown below range low)
 *   false_breakout_bear → SHORT (failed breakout above range high)
 */
const { rangeHighLow, corridorWidthFromWindow } = require("./signal-metrics");

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const FALSE_BREAKOUT_DEFAULTS = {
  tradeFalseBreakoutSignals: false,
  tradeBearishFalseBreakoutSignals: false,
  /** Prior bars that define the range (excludes the signal bar). */
  fbRangeBars: 45,
  /** How far back to search for the break candle. */
  fbLookbackBars: 30,
  /** Max bars after the break for the fail/reclaim close. */
  fbFailBars: 5,
  /** Min % beyond the level required for the break close. */
  fbMinBreakPct: 0.12,
  /** Final close must be strictly inside [low, high]. */
  fbRequireInsideClose: true,
  /** Skip when local corridor width % exceeds this (0 = off). */
  fbMaxCorridorWidthPct: 18,
  /** Optional TP cap % (null = use takeProfitPct). */
  fbTakeProfitPct: 4.5,
};

function normalizeFalseBreakoutConfig(raw = {}) {
  const d = FALSE_BREAKOUT_DEFAULTS;
  return {
    tradeFalseBreakoutSignals: Boolean(
      raw.tradeFalseBreakoutSignals ?? d.tradeFalseBreakoutSignals
    ),
    tradeBearishFalseBreakoutSignals: Boolean(
      raw.tradeBearishFalseBreakoutSignals ?? d.tradeBearishFalseBreakoutSignals
    ),
    fbRangeBars: clamp(Math.round(num(raw.fbRangeBars, d.fbRangeBars)), 10, 240),
    fbLookbackBars: clamp(
      Math.round(num(raw.fbLookbackBars, d.fbLookbackBars)),
      5,
      120
    ),
    fbFailBars: clamp(Math.round(num(raw.fbFailBars, d.fbFailBars)), 1, 30),
    fbMinBreakPct: clamp(num(raw.fbMinBreakPct, d.fbMinBreakPct), 0, 5),
    fbRequireInsideClose:
      raw.fbRequireInsideClose !== undefined
        ? Boolean(raw.fbRequireInsideClose)
        : d.fbRequireInsideClose,
    fbMaxCorridorWidthPct: clamp(
      num(raw.fbMaxCorridorWidthPct, d.fbMaxCorridorWidthPct),
      0,
      100
    ),
    fbTakeProfitPct:
      raw.fbTakeProfitPct == null || raw.fbTakeProfitPct === ""
        ? d.fbTakeProfitPct
        : clamp(num(raw.fbTakeProfitPct, d.fbTakeProfitPct), 0.5, 50),
  };
}

function minHistoryBars(cfg) {
  const c = normalizeFalseBreakoutConfig(cfg);
  return c.fbRangeBars + c.fbFailBars + c.fbLookbackBars + 2;
}

function corridorOk(metrics, cfg) {
  const maxW = Number(cfg.fbMaxCorridorWidthPct) || 0;
  if (!(maxW > 0)) return true;
  const w = Number(metrics?.corridorWidthPct);
  return !Number.isFinite(w) || w <= maxW;
}

/**
 * Long: close broke below range low, then failed back above low (inside).
 */
function evaluateFalseBreakoutLong(ohlc, cfgInput = {}) {
  const cfg = normalizeFalseBreakoutConfig(cfgInput);
  if (!ohlc?.length || ohlc.length < minHistoryBars(cfg)) return null;

  // Range must exclude the break/fail window, otherwise the break candle
  // sets corridorLow and a body-break can never clear the threshold.
  const failBars = cfg.fbFailBars;
  const rangeEnd = ohlc.length - 1 - failBars;
  if (rangeEnd < cfg.fbRangeBars + 2) return null;
  const range = rangeHighLow(ohlc.slice(0, rangeEnd), cfg.fbRangeBars);
  if (!range || range.corridorHigh <= range.corridorLow) return null;
  const { corridorHigh, corridorLow } = range;

  const lookback = Math.max(cfg.fbLookbackBars, failBars + 2);
  const scan = ohlc.slice(-lookback);
  const last = ohlc[ohlc.length - 1];
  const signalOffset = scan.length - 1;
  const breakLevel = corridorLow * (1 - cfg.fbMinBreakPct / 100);

  let breakIdx = -1;
  let breakClose = null;
  // Break must be before the signal bar, within failBars.
  for (let i = signalOffset - 1; i >= Math.max(0, signalOffset - failBars); i--) {
    const bar = scan[i];
    if (!Number.isFinite(bar.close)) continue;
    if (bar.close < breakLevel) {
      breakIdx = i;
      breakClose = bar.close;
      break;
    }
  }

  const barsSinceBreak = breakIdx >= 0 ? signalOffset - breakIdx : null;
  const timely =
    breakIdx >= 0 &&
    barsSinceBreak != null &&
    barsSinceBreak >= 1 &&
    barsSinceBreak <= failBars;
  const failed =
    breakIdx >= 0 &&
    Number.isFinite(last.close) &&
    last.close > corridorLow &&
    (!cfg.fbRequireInsideClose || last.close < corridorHigh);

  const localCw = corridorWidthFromWindow(
    ohlc.slice(-Math.min(120, ohlc.length))
  );
  const metrics = {
    corridorHigh,
    corridorLow,
    close: last.close,
    breakClose,
    breakLevel: +breakLevel.toFixed(6),
    barsSinceBreak,
    failBars,
    failed,
    timely,
    falseBreakout: Boolean(failed && timely),
    passes: Boolean(failed && timely),
    bars: ohlc.length,
    corridorWidthPct: localCw?.corridorWidthPct ?? null,
    signalKind: "false_breakout",
  };
  metrics.passes = Boolean(metrics.passes && corridorOk(metrics, cfg));
  metrics.falseBreakout = metrics.passes;
  return metrics;
}

/**
 * Short: close broke above range high, then failed back below high (inside).
 */
function evaluateFalseBreakoutBear(ohlc, cfgInput = {}) {
  const cfg = normalizeFalseBreakoutConfig(cfgInput);
  if (!ohlc?.length || ohlc.length < minHistoryBars(cfg)) return null;

  const failBars = cfg.fbFailBars;
  const rangeEnd = ohlc.length - 1 - failBars;
  if (rangeEnd < cfg.fbRangeBars + 2) return null;
  const range = rangeHighLow(ohlc.slice(0, rangeEnd), cfg.fbRangeBars);
  if (!range || range.corridorHigh <= range.corridorLow) return null;
  const { corridorHigh, corridorLow } = range;

  const lookback = Math.max(cfg.fbLookbackBars, failBars + 2);
  const scan = ohlc.slice(-lookback);
  const last = ohlc[ohlc.length - 1];
  const signalOffset = scan.length - 1;
  const breakLevel = corridorHigh * (1 + cfg.fbMinBreakPct / 100);

  let breakIdx = -1;
  let breakClose = null;
  for (let i = signalOffset - 1; i >= Math.max(0, signalOffset - failBars); i--) {
    const bar = scan[i];
    if (!Number.isFinite(bar.close)) continue;
    if (bar.close > breakLevel) {
      breakIdx = i;
      breakClose = bar.close;
      break;
    }
  }

  const barsSinceBreak = breakIdx >= 0 ? signalOffset - breakIdx : null;
  const timely =
    breakIdx >= 0 &&
    barsSinceBreak != null &&
    barsSinceBreak >= 1 &&
    barsSinceBreak <= failBars;
  const failed =
    breakIdx >= 0 &&
    Number.isFinite(last.close) &&
    last.close < corridorHigh &&
    (!cfg.fbRequireInsideClose || last.close > corridorLow);

  const localCw = corridorWidthFromWindow(
    ohlc.slice(-Math.min(120, ohlc.length))
  );
  const metrics = {
    corridorHigh,
    corridorLow,
    close: last.close,
    breakClose,
    breakLevel: +breakLevel.toFixed(6),
    barsSinceBreak,
    failBars,
    failed,
    timely,
    falseBreakoutBear: Boolean(failed && timely),
    passes: Boolean(failed && timely),
    bars: ohlc.length,
    corridorWidthPct: localCw?.corridorWidthPct ?? null,
    signalKind: "false_breakout_bear",
  };
  metrics.passes = Boolean(metrics.passes && corridorOk(metrics, cfg));
  metrics.falseBreakoutBear = metrics.passes;
  return metrics;
}

module.exports = {
  FALSE_BREAKOUT_DEFAULTS,
  normalizeFalseBreakoutConfig,
  minHistoryBars,
  evaluateFalseBreakoutLong,
  evaluateFalseBreakoutBear,
};
