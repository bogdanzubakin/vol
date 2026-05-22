function parseInterval(interval) {
  const m = /^(\d+)([mhd])$/.exec(interval);
  if (!m) throw new Error(`Invalid interval: ${interval}`);
  const n = Number(m[1]);
  const minutes = m[2] === "m" ? n : m[2] === "h" ? n * 60 : n * 24 * 60;
  return { minutes, ms: minutes * 60 * 1000 };
}

function applyBarConfig(cfg) {
  const { minutes, ms } = parseInterval(cfg.interval);
  const barsPerDay = (24 * 60) / minutes;
  cfg.barMs = ms;
  cfg.corridorBars = Math.ceil(cfg.corridorDays * barsPerDay);
  cfg.limit = cfg.corridorBars + cfg.signalCandles;
}

function createConfig(overrides = {}) {
  const cfg = {
    interval: "1m",
    corridorDays: 2,
    signalCandles: 3,
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
  const need = cfg.corridorBars + n;
  if (ohlc.length < need) return null;

  const corridor = ohlc.slice(-(cfg.corridorBars + n), -n);
  const signal = ohlc.slice(-n);

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

  const bullish = signal.every((b) => b.close > b.open);
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
    directionUp,
    corridorFlat,
    breaksCorridor,
    bars: ohlc.length,
    passes:
      corridorFlat &&
      volIncreasing &&
      volSpike &&
      bullish &&
      directionUp &&
      breaksCorridor,
  };
}

module.exports = {
  parseInterval,
  applyBarConfig,
  createConfig,
  mean,
  candleRangePct,
  volSpikeMetrics,
};
