const {
  barsAtTime,
  smaClose,
  corridorWidthFromWindow,
} = require("./signal-metrics");

const HTF_DEFAULTS = {
  htfContraindicationEnabled: true,
  htfInterval: "15m",
  htfMaBars: 20,
  htfMinBars: 30,
};

function mergeHtfConfig(cfg = {}) {
  return {
    ...HTF_DEFAULTS,
    htfContraindicationEnabled: cfg.htfContraindicationEnabled !== false,
    htfMaBars: cfg.htfMaBars ?? HTF_DEFAULTS.htfMaBars,
    htfMinBars: cfg.htfMinBars ?? HTF_DEFAULTS.htfMinBars,
    htfInterval: cfg.htfInterval ?? HTF_DEFAULTS.htfInterval,
    maxCorridorWidthPct: cfg.maxCorridorWidthPct ?? 8,
    sfpMinSweepPct: cfg.sfpMinSweepPct ?? 0.02,
  };
}

function corridorWindow(bars, size = 120) {
  if (!bars?.length) return null;
  return corridorWidthFromWindow(bars.slice(-Math.min(size, bars.length)));
}

/** Bearish liquidity grab: wick above range high, close rejected back below high. */
function bearishSweepReclaim(bars, minSweepPct = 0.02) {
  const cw = corridorWindow(bars);
  if (!cw || !bars.length) return null;
  const { corridorHigh } = cw;
  const last = bars[bars.length - 1];
  const sweepThreshold = corridorHigh * (1 + minSweepPct / 100);
  const lookback = Math.min(30, bars.length - 1);
  const scan = bars.slice(-lookback - 1, -1);

  let sweepHigh = null;
  for (let i = scan.length - 1; i >= 0; i--) {
    if (Number.isFinite(scan[i].high) && scan[i].high >= sweepThreshold) {
      sweepHigh = scan[i].high;
      break;
    }
  }
  if (sweepHigh == null) return null;

  const rejected =
    Number.isFinite(last.close) &&
    last.close < corridorHigh &&
    last.close < sweepHigh * (1 - minSweepPct / 100);
  if (!rejected) return null;

  return {
    corridorHigh,
    sweepHigh,
    close: last.close,
  };
}

function linearChangePct(bars, n = 8) {
  if (!bars?.length || bars.length < n) return null;
  const slice = bars.slice(-n);
  const first = slice[0].close;
  const last = slice[slice.length - 1].close;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return ((last - first) / first) * 100;
}

/**
 * 15m higher-timeframe gate for LONG SFP / pullback entries.
 * pass=true means no contraindications (entry allowed).
 */
function evaluateHtfContraindications(htfBars, rawCfg = {}, atMs) {
  const cfg = mergeHtfConfig(rawCfg);
  if (!cfg.htfContraindicationEnabled) {
    return {
      enabled: false,
      pass: true,
      interval: cfg.htfInterval,
      label: "off",
      detail: "15m gate disabled",
      blocks: [],
    };
  }

  const window = atMs != null ? barsAtTime(htfBars, atMs) : htfBars ?? [];
  const minBars = cfg.htfMinBars;
  const maBars = cfg.htfMaBars;

  if (!window.length || window.length < minBars) {
    return {
      enabled: true,
      pass: false,
      waiting: true,
      interval: cfg.htfInterval,
      maBars,
      label: "waiting",
      detail: `${window.length}/${minBars} ${cfg.htfInterval} bars`,
      blocks: [
        {
          id: "htfHistory",
          label: `Enough ${cfg.htfInterval} history`,
          pass: false,
          detail: `${window.length} / ${minBars}`,
        },
      ],
    };
  }

  const last = window[window.length - 1];
  const ma = smaClose(window, maBars);
  const cw = corridorWindow(window);
  const blocks = [];

  if (Number.isFinite(ma) && Number.isFinite(last.close) && last.close < ma) {
    blocks.push({
      id: "htfBelowMa",
      label: `${cfg.htfInterval} close below MA${maBars}`,
      pass: false,
      detail: `${last.close.toFixed(6)} < ${ma.toFixed(6)}`,
    });
  }

  if (cw && Number.isFinite(last.close) && last.close < cw.corridorLow) {
    blocks.push({
      id: "htfBreakdown",
      label: `${cfg.htfInterval} close below corridor low`,
      pass: false,
      detail: `${last.close.toFixed(6)} < ${cw.corridorLow.toFixed(6)}`,
    });
  }

  const bearishSfp = bearishSweepReclaim(window, cfg.sfpMinSweepPct);
  if (bearishSfp) {
    blocks.push({
      id: "htfBearishSweep",
      label: `${cfg.htfInterval} bearish sweep-reclaim`,
      pass: false,
      detail: `sweep ${bearishSfp.sweepHigh.toFixed(6)} · close ${bearishSfp.close.toFixed(6)}`,
    });
  }

  const trendPct = linearChangePct(window, 8);
  if (trendPct != null && trendPct <= -1.5) {
    blocks.push({
      id: "htfDowntrend",
      label: `${cfg.htfInterval} downtrend (8 bars)`,
      pass: false,
      detail: `${trendPct.toFixed(2)}%`,
    });
  }

  const recent = window.slice(-5);
  const bearishCount = recent.filter(
    (b) => Number.isFinite(b.close) && Number.isFinite(b.open) && b.close < b.open
  ).length;
  if (bearishCount >= 4) {
    blocks.push({
      id: "htfBearishMomentum",
      label: `${cfg.htfInterval} bearish momentum`,
      pass: false,
      detail: `${bearishCount}/5 red candles`,
    });
  }

  const pass = blocks.length === 0;
  return {
    enabled: true,
    pass,
    interval: cfg.htfInterval,
    maBars,
    close: Number.isFinite(last.close) ? +last.close.toFixed(6) : null,
    ma: Number.isFinite(ma) ? +ma.toFixed(6) : null,
    trendPct: trendPct != null ? +trendPct.toFixed(2) : null,
    label: pass ? "15m clear" : "15m blocked",
    detail: pass
      ? `${cfg.htfInterval} MA${maBars} ok · no bearish structure`
      : blocks.map((b) => b.label).join("; "),
    blocks,
  };
}

function applyHtfGate(metrics, htf) {
  if (!metrics || !htf?.enabled) return metrics;
  return {
    ...metrics,
    passes: Boolean(metrics.passes && htf.pass),
    htfBlocked: Boolean(metrics.passes && !htf.pass),
    htf,
  };
}

module.exports = {
  HTF_DEFAULTS,
  mergeHtfConfig,
  evaluateHtfContraindications,
  applyHtfGate,
};
