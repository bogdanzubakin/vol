const { formatIsoUtcPlus3 } = require("./time-format");

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const DRAWDOWN_DEFAULTS = {
  drawdownStopEnabled: true,
  drawdownStopPct: 4,
};

function normalizeDrawdownConfig(raw = {}) {
  return {
    drawdownStopEnabled:
      raw.drawdownStopEnabled !== undefined
        ? Boolean(raw.drawdownStopEnabled)
        : DRAWDOWN_DEFAULTS.drawdownStopEnabled,
    drawdownStopPct: clamp(
      num(raw.drawdownStopPct, DRAWDOWN_DEFAULTS.drawdownStopPct),
      1,
      100
    ),
  };
}

function lossPctFromBaseline(baseline, equity) {
  if (!Number.isFinite(baseline) || baseline <= 0 || !Number.isFinite(equity)) {
    return 0;
  }
  return Math.max(0, ((baseline - equity) / baseline) * 100);
}

function isBotTradingActive(cfg) {
  if (cfg.armed !== undefined) return Boolean(cfg.armed);
  return Boolean(cfg.enabled);
}

function drawdownStatus(cfg, state, equity) {
  const baseline = state.drawdownBaseline;
  const lossPct = lossPctFromBaseline(baseline, equity);
  const tradingActive = isBotTradingActive(cfg);
  return {
    enabled: Boolean(cfg.drawdownStopEnabled),
    limitPct: cfg.drawdownStopPct ?? DRAWDOWN_DEFAULTS.drawdownStopPct,
    baseline: baseline != null ? +baseline.toFixed(4) : null,
    equity: equity != null ? +equity.toFixed(4) : null,
    lossPct: +lossPct.toFixed(2),
    remainingPct:
      baseline != null && cfg.drawdownStopEnabled
        ? +Math.max(0, (cfg.drawdownStopPct ?? DRAWDOWN_DEFAULTS.drawdownStopPct) - lossPct).toFixed(2)
        : null,
    triggeredAt: state.drawdownTriggeredAt ?? null,
    triggeredAtIso: state.drawdownTriggeredAt
      ? formatIsoUtcPlus3(state.drawdownTriggeredAt)
      : null,
    active: Boolean(
      cfg.drawdownStopEnabled && tradingActive && !state.drawdownTriggeredAt
    ),
  };
}

function formatDrawdownTelegramMessage(botLabel, payload) {
  const lines = [
    `⚠️ ${botLabel} stopped`,
    `Drawdown limit: −${payload.lossPct.toFixed(2)}% (max −${payload.limitPct}%)`,
    `Baseline $${payload.baseline.toFixed(2)} → bot trades $${payload.equity.toFixed(2)}`,
    payload.disarmed ? "Live bot disarmed · no new orders" : "Bot disabled",
  ];
  return lines.join("\n");
}

/**
 * Returns trigger payload if drawdown limit hit (once per session until baseline reset).
 */
function evaluateDrawdownStop(cfg, state, equity, options = {}) {
  if (state.drawdownTriggeredAt) return null;
  if (!cfg.drawdownStopEnabled || !isBotTradingActive(cfg)) return null;
  if (!Number.isFinite(equity) || equity <= 0) return null;

  const baseline = state.drawdownBaseline;
  if (!Number.isFinite(baseline) || baseline <= 0) return null;

  const lossPct = lossPctFromBaseline(baseline, equity);
  const limitPct = cfg.drawdownStopPct ?? DRAWDOWN_DEFAULTS.drawdownStopPct;
  if (lossPct < limitPct) return null;

  return {
    baseline,
    equity,
    lossPct,
    limitPct,
    disarm: Boolean(options.disarm),
    at: Date.now(),
  };
}

module.exports = {
  DRAWDOWN_DEFAULTS,
  normalizeDrawdownConfig,
  lossPctFromBaseline,
  isBotTradingActive,
  drawdownStatus,
  formatDrawdownTelegramMessage,
  evaluateDrawdownStop,
};
