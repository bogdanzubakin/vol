const { isSymbolBlocked } = require("./bot-symbol-blocklist");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  buildSymbolTradeStatsMap,
} = require("./sfp-regime-features");
const {
  normalizeSfpRegimeConfig,
  evaluateSfpRegimeGate,
  predictSfpRegime,
} = require("./sfp-regime-model");

const MIN_BARS = 30;

function createSfpRegimeMonitor(options = {}) {
  const getClosedTrades = options.getClosedTrades ?? (() => []);
  const scores = new Map();
  let tradeStatsMap = new Map();
  let tradeStatsAt = 0;
  let lastBatchAt = 0;
  let batchCursor = 0;

  function refreshTradeStats() {
    const now = Date.now();
    if (now - tradeStatsAt < 60_000) return;
    tradeStatsMap = buildSymbolTradeStatsMap(getClosedTrades());
    tradeStatsAt = now;
  }

  function refreshSymbol(symbol, bars, cfg, metrics = null) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym || !bars?.length || bars.length < MIN_BARS) return null;
    refreshTradeStats();
    const regimeCfg = normalizeSfpRegimeConfig(cfg);
    if (!regimeCfg.aiSfpRegimeEnabled) {
      scores.delete(sym);
      return null;
    }
    const tradeStats = tradeStatsMap.get(sym) ?? null;
    const { probability, features } = predictSfpRegime(bars, {
      metrics,
      tradeStats,
    });
    const threshold = regimeCfg.aiSfpRegimeThreshold ?? 0.58;
    const bad = probability >= threshold;
    const row = {
      symbol: sym,
      probability: +probability.toFixed(4),
      bad,
      threshold,
      detail: bad
        ? `p=${(probability * 100).toFixed(0)}% · chop ${((features.choppiness ?? 0) * 100).toFixed(0)}%`
        : null,
      updatedAt: Date.now(),
      updatedAtIso: formatIsoUtcPlus3(Date.now()),
    };
    scores.set(sym, row);
    return row;
  }

  function checkSymbol(symbol, cfg, bars, metrics = null) {
    const sym = String(symbol || "").toUpperCase();
    const regimeCfg = normalizeSfpRegimeConfig(cfg);
    if (!regimeCfg.aiSfpRegimeEnabled) {
      return { pass: true, enabled: false };
    }
    if (isSymbolBlocked(sym, cfg.blockedSymbols)) {
      return { pass: true, enabled: true, blocked: true };
    }

    let row = scores.get(sym);
    const stale = !row || Date.now() - row.updatedAt > 5 * 60_000;
    if (stale && bars?.length >= MIN_BARS) {
      row = refreshSymbol(sym, bars, cfg, metrics);
    }
    if (!row && bars?.length >= MIN_BARS) {
      const gate = evaluateSfpRegimeGate(cfg, bars, {
        metrics,
        tradeStats: tradeStatsMap.get(sym) ?? null,
      });
      if (gate.waiting) return { pass: true, enabled: true, waiting: true };
      return gate;
    }
    if (!row) return { pass: true, enabled: true, waiting: true };

    if (!row.bad) return { pass: true, enabled: true, probability: row.probability };
    return {
      pass: false,
      enabled: true,
      probability: row.probability,
      detail: row.detail,
    };
  }

  function refreshBatch(symbols, getBars, cfg, batchSize = 40) {
    const regimeCfg = normalizeSfpRegimeConfig(cfg);
    if (!regimeCfg.aiSfpRegimeEnabled || !symbols?.length) return 0;
    const now = Date.now();
    if (now - lastBatchAt < 15_000) return 0;
    lastBatchAt = now;

    const list = symbols.filter(
      (s) => !isSymbolBlocked(s, cfg.blockedSymbols)
    );
    if (!list.length) return 0;

    let n = 0;
    for (let i = 0; i < batchSize; i++) {
      const sym = list[(batchCursor + i) % list.length];
      const bars = getBars(sym);
      if (bars?.length >= MIN_BARS && refreshSymbol(sym, bars, cfg)) n++;
    }
    batchCursor = (batchCursor + batchSize) % list.length;
    return n;
  }

  function getSnapshot(cfg, options = {}) {
    const limit = options.limit ?? 30;
    const onlyBad = options.onlyBad !== false;
    refreshTradeStats();
    const rows = [...scores.values()]
      .filter((r) => !isSymbolBlocked(r.symbol, cfg?.blockedSymbols))
      .filter((r) => (onlyBad ? r.bad : true))
      .sort((a, b) => b.probability - a.probability);
    const bad = rows.filter((r) => r.bad);
    return {
      ok: true,
      enabled: Boolean(cfg?.aiSfpRegimeEnabled),
      tracked: scores.size,
      badCount: bad.length,
      threshold: cfg?.aiSfpRegimeThreshold ?? 0.58,
      worst: bad.slice(0, limit),
      updatedAt: formatIsoUtcPlus3(Date.now()),
    };
  }

  return {
    refreshSymbol,
    refreshBatch,
    checkSymbol,
    getSnapshot,
    scores,
  };
}

module.exports = { createSfpRegimeMonitor, MIN_BARS };
