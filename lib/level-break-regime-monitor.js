const { isSymbolBlocked } = require("./bot-symbol-blocklist");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  buildSymbolTradeStatsMap,
  tradeStatsRowForSymbol,
} = require("./level-break-regime-features");
const { normalizeAiModelScope } = require("./ai-model-scope");
const {
  normalizeLevelBreakRegimeConfig,
  evaluateLevelBreakRegimeGate,
  predictLevelBreakRegime,
  thresholdForSignal,
  isBearSignal,
  getModel,
} = require("./level-break-regime-model");

const MIN_BARS = 30;

function createLevelBreakRegimeMonitor(options = {}) {
  const getClosedTrades = options.getClosedTrades ?? (() => []);
  const modelScope = normalizeAiModelScope(options.modelScope);
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
    const regimeCfg = normalizeLevelBreakRegimeConfig(cfg);
    if (!regimeCfg.aiLevelBreakRegimeEnabled) {
      scores.delete(sym);
      return null;
    }
    const tradeStats = tradeStatsRowForSymbol(tradeStatsMap, sym);
    const stored = getModel(modelScope);
    const bull = predictLevelBreakRegime(
      bars,
      {
        metrics,
        tradeStats,
        signalKind: "level_break",
        modelScope,
      },
      stored
    );
    const bear = predictLevelBreakRegime(
      bars,
      {
        metrics,
        tradeStats,
        signalKind: "level_break_bear",
        modelScope,
      },
      stored
    );
    const bullThreshold = thresholdForSignal(regimeCfg, "level_break", stored.bull);
    const bearThreshold = thresholdForSignal(
      regimeCfg,
      "level_break_bear",
      stored.bear
    );
    const bullBad = bull.probability >= bullThreshold;
    const bearBad = bear.probability >= bearThreshold;
    const bad = bullBad || bearBad;
    const worst = bear.probability >= bull.probability ? bear : bull;
    const row = {
      symbol: sym,
      probability: +worst.probability.toFixed(4),
      bullProbability: +bull.probability.toFixed(4),
      bearProbability: +bear.probability.toFixed(4),
      bullBad,
      bearBad,
      bad,
      bullThreshold,
      bearThreshold,
      detail: bad
        ? `bull ${(bull.probability * 100).toFixed(0)}% · bear ${(bear.probability * 100).toFixed(0)}% · chop ${((worst.features.choppiness ?? 0) * 100).toFixed(0)}%`
        : null,
      updatedAt: Date.now(),
      updatedAtIso: formatIsoUtcPlus3(Date.now()),
    };
    scores.set(sym, row);
    return row;
  }

  function checkSymbol(symbol, cfg, bars, metrics = null, signalKind = null) {
    const sym = String(symbol || "").toUpperCase();
    const regimeCfg = normalizeLevelBreakRegimeConfig(cfg);
    if (!regimeCfg.aiLevelBreakRegimeEnabled) {
      return { pass: true, enabled: false };
    }
    if (isSymbolBlocked(sym, cfg.blockedSymbols)) {
      return { pass: true, enabled: true, blocked: true };
    }

    refreshTradeStats();
    const kind = signalKind ?? "level_break_bear";
    if (bars?.length >= MIN_BARS) {
      return evaluateLevelBreakRegimeGate(cfg, bars, {
        metrics,
        signalKind: kind,
        tradeStats: tradeStatsRowForSymbol(tradeStatsMap, sym),
        modelScope,
      });
    }

    const row = scores.get(sym);
    if (!row) return { pass: true, enabled: true, waiting: true };

    const useBear = signalKind == null || isBearSignal(signalKind);
    const prob = useBear ? row.bearProbability : row.bullProbability;
    const isBad = useBear ? row.bearBad : row.bullBad;
    if (!isBad) return { pass: true, enabled: true, probability: prob };
    return {
      pass: false,
      enabled: true,
      probability: prob,
      detail: row.detail,
    };
  }

  function refreshBatch(symbols, getBars, cfg, batchSize = 40) {
    const regimeCfg = normalizeLevelBreakRegimeConfig(cfg);
    if (!regimeCfg.aiLevelBreakRegimeEnabled || !symbols?.length) return 0;
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
    const regimeCfg = normalizeLevelBreakRegimeConfig(cfg ?? {});
    return {
      ok: true,
      scope: modelScope,
      enabled: Boolean(cfg?.aiLevelBreakRegimeEnabled),
      tracked: scores.size,
      badCount: bad.length,
      threshold: regimeCfg.aiLevelBreakRegimeThreshold,
      bullThreshold: regimeCfg.aiLevelBreakRegimeBullThreshold,
      bearThreshold: regimeCfg.aiLevelBreakRegimeBearThreshold,
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

module.exports = { createLevelBreakRegimeMonitor, MIN_BARS };
