const { barsAtTime } = require("./signal-metrics");

function smaFromBars(bars, n) {
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
 * BTC trend gate for spike entries: close at or above N-bar SMA on regime interval.
 */
function evaluateRegime(btcBars, cfg) {
  const enabled = Boolean(cfg.regimeFilterEnabled);
  if (!enabled) {
    return {
      enabled: false,
      pass: true,
      label: "off",
      detail: "Regime filter disabled — spikes not gated",
    };
  }

  const maBars = cfg.regimeMaBars ?? 20;
  const symbol = cfg.regimeSymbol ?? "BTCUSDT";
  const interval = cfg.regimeInterval ?? "1h";

  if (!btcBars?.length || btcBars.length < maBars) {
    return {
      enabled: true,
      pass: false,
      label: "waiting",
      symbol,
      interval,
      maBars,
      detail: `${btcBars?.length ?? 0}/${maBars} ${symbol} bars`,
      btcClose: null,
      btcMa: null,
      bullish: false,
    };
  }

  const btcClose = btcBars[btcBars.length - 1].close;
  const btcMa = smaFromBars(btcBars, maBars);
  if (!Number.isFinite(btcClose) || !Number.isFinite(btcMa)) {
    return {
      enabled: true,
      pass: false,
      label: "invalid",
      symbol,
      interval,
      maBars,
      detail: "Invalid BTC bar data",
      btcClose: null,
      btcMa: null,
      bullish: false,
    };
  }

  const bullish = btcClose >= btcMa;
  return {
    enabled: true,
    pass: bullish,
    bullish,
    symbol,
    interval,
    maBars,
    btcClose: +btcClose.toFixed(2),
    btcMa: +btcMa.toFixed(2),
    label: bullish ? "bullish" : "bearish",
    detail: `${symbol} ${btcClose.toFixed(0)} ${bullish ? "≥" : "<"} MA${maBars} ${btcMa.toFixed(0)} (${interval})`,
  };
}

function regimeAtTime(btcBars, atMs, cfg) {
  const window = atMs != null ? barsAtTime(btcBars, atMs) : btcBars ?? [];
  return evaluateRegime(window, cfg);
}

function applyRegimeToSpike(metrics, regime) {
  if (!metrics) return metrics;
  if (!regime?.enabled) return metrics;
  return {
    ...metrics,
    passes: Boolean(metrics.passes && regime.pass),
    regimeBlocked: Boolean(metrics.passes && !regime.pass),
    regime,
  };
}

module.exports = {
  evaluateRegime,
  regimeAtTime,
  applyRegimeToSpike,
};
