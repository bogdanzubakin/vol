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
 * BTC trend gate for spike entries on regime interval.
 * regimeMode "bullish": pass when close ≥ MA (default — long alts in BTC uptrend).
 * regimeMode "bearish": pass when close < MA (fade spikes when BTC is weak).
 */
function normalizeRegimeMode(raw) {
  const s = String(raw ?? "bullish").toLowerCase();
  return s === "bearish" ? "bearish" : "bullish";
}

function evaluateRegime(btcBars, cfg) {
  const enabled = Boolean(cfg.regimeFilterEnabled);
  const mode = normalizeRegimeMode(cfg.regimeMode);
  if (!enabled) {
    return {
      enabled: false,
      pass: true,
      mode,
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
      mode,
      label: "waiting",
      symbol,
      interval,
      maBars,
      detail: `${btcBars?.length ?? 0}/${maBars} ${symbol} bars`,
      btcClose: null,
      btcMa: null,
      marketAboveMa: null,
    };
  }

  const btcClose = btcBars[btcBars.length - 1].close;
  const btcMa = smaFromBars(btcBars, maBars);
  if (!Number.isFinite(btcClose) || !Number.isFinite(btcMa)) {
    return {
      enabled: true,
      pass: false,
      mode,
      label: "invalid",
      symbol,
      interval,
      maBars,
      detail: "Invalid BTC bar data",
      btcClose: null,
      btcMa: null,
      marketAboveMa: null,
    };
  }

  const marketAboveMa = btcClose >= btcMa;
  const pass = mode === "bearish" ? !marketAboveMa : marketAboveMa;
  const marketLabel = marketAboveMa ? "above MA" : "below MA";
  return {
    enabled: true,
    pass,
    mode,
    marketAboveMa,
    symbol,
    interval,
    maBars,
    btcClose: +btcClose.toFixed(2),
    btcMa: +btcMa.toFixed(2),
    label: pass ? `${mode} ok` : `${mode} blocked`,
    detail: `${symbol} ${btcClose.toFixed(0)} ${marketAboveMa ? "≥" : "<"} MA${maBars} ${btcMa.toFixed(0)} (${marketLabel}, gate ${mode}, ${interval})`,
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
  normalizeRegimeMode,
};
