const { formatBtcTrendDetail } = require("./btc-regime-context");
const { isSymbolBlocked } = require("./bot-symbol-blocklist");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  buildSymbolTradeStatsMap,
  tradeStatsRowForSymbol,
} = require("./pullback-regime-features");
const { normalizeAiModelScope } = require("./ai-model-scope");
const {
  normalizePullbackPatternBreakConfig,
  evaluatePullbackPatternBreakGate,
  predictPullbackPatternBreak,
  thresholdForSignal,
  isBearSignal,
  isHeadActive,
  getModel,
} = require("./pullback-pattern-break-model");

const MIN_BARS = 30;

function createPullbackPatternBreakMonitor(options = {}) {
  const getClosedTrades = options.getClosedTrades ?? (() => []);
  const getBtcBars = options.getBtcBars ?? (() => []);
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

  function btcExtras(cfg, asOf = Date.now()) {
    const patternBreakCfg = normalizePullbackPatternBreakConfig(cfg);
    return {
      btcBars: getBtcBars(asOf) ?? [],
      asOf,
      btcLookbackHours: patternBreakCfg.aiPullbackPatternBreakBtcLookbackHours,
      patternBreakCfg,
    };
  }

  function refreshSymbol(symbol, bars, cfg, metrics = null) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym || !bars?.length || bars.length < MIN_BARS) return null;
    refreshTradeStats();
    const patternBreakCfg = normalizePullbackPatternBreakConfig(cfg);
    if (!patternBreakCfg.aiPullbackPatternBreakEnabled) {
      scores.delete(sym);
      return null;
    }
    const tradeStats = tradeStatsRowForSymbol(tradeStatsMap, sym);
    const stored = getModel(modelScope);
    const asOf = Date.now();
    const btc = btcExtras(cfg, asOf);
    const bull = predictPullbackPatternBreak(
      bars,
      {
        metrics,
        tradeStats,
        signalKind: "pullback",
        modelScope,
        ...btc,
      },
      stored
    );
    const bear = predictPullbackPatternBreak(
      bars,
      {
        metrics,
        tradeStats,
        signalKind: "pullback_bear",
        modelScope,
        ...btc,
      },
      stored
    );
    const bullThreshold = thresholdForSignal(patternBreakCfg, "pullback", stored.bull);
    const bearThreshold = thresholdForSignal(
      patternBreakCfg,
      "pullback_bear",
      stored.bear
    );
    const bullHeadOn = isHeadActive(stored.bull);
    const bearHeadOn = isHeadActive(stored.bear);
    const broken = bullHeadOn && bull.probability >= bullThreshold;
    const bearBroken = bearHeadOn && bear.probability >= bearThreshold;
    const bad = broken || bearBroken;
    const worst = bear.probability >= bull.probability ? bear : bull;
    const row = {
      symbol: sym,
      probability: +worst.probability.toFixed(4),
      bullProbability: +bull.probability.toFixed(4),
      bearProbability: +bear.probability.toFixed(4),
      bullBroken: broken,
      bearBroken,
      bullHeadOn,
      bearHeadOn,
      bad,
      bullThreshold,
      bearThreshold,
      detail: bad
        ? `bull ${(bull.probability * 100).toFixed(0)}% · bear ${(bear.probability * 100).toFixed(0)}% · corridor ${((worst.features.corridorBreakScore ?? 0) * 100).toFixed(0)}%${
            formatBtcTrendDetail(worst.features)
              ? ` · ${formatBtcTrendDetail(worst.features)}`
              : ""
          }`
        : null,
      updatedAt: Date.now(),
      updatedAtIso: formatIsoUtcPlus3(Date.now()),
    };
    scores.set(sym, row);
    return row;
  }

  function checkSymbol(symbol, cfg, bars, metrics = null, signalKind = null) {
    const sym = String(symbol || "").toUpperCase();
    const patternBreakCfg = normalizePullbackPatternBreakConfig(cfg);
    if (!patternBreakCfg.aiPullbackPatternBreakEnabled) {
      return { pass: true, enabled: false };
    }
    if (isSymbolBlocked(sym, cfg.blockedSymbols)) {
      return { pass: true, enabled: true, blocked: true };
    }

    refreshTradeStats();
    const kind = signalKind ?? "pullback_bear";
    if (bars?.length >= MIN_BARS) {
      return evaluatePullbackPatternBreakGate(cfg, bars, {
        metrics,
        signalKind: kind,
        tradeStats: tradeStatsRowForSymbol(tradeStatsMap, sym),
        modelScope,
        ...btcExtras(cfg),
      });
    }

    const useBear = signalKind == null || isBearSignal(signalKind);
    const row = scores.get(sym);
    if (!row) return { pass: true, enabled: true, waiting: true };

    const headOn = useBear ? row.bearHeadOn : row.bullHeadOn;
    if (!headOn) return { pass: true, enabled: true, headDisabled: true };

    const prob = useBear ? row.bearProbability : row.bullProbability;
    const isBroken = useBear ? row.bearBroken : row.bullBroken;
    if (!isBroken) return { pass: true, enabled: true, probability: prob };
    return {
      pass: false,
      enabled: true,
      probability: prob,
      detail: row.detail,
    };
  }

  function refreshBatch(symbols, getBars, cfg, batchSize = 40) {
    const patternBreakCfg = normalizePullbackPatternBreakConfig(cfg);
    if (!patternBreakCfg.aiPullbackPatternBreakEnabled || !symbols?.length) return 0;
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
    const patternBreakCfg = normalizePullbackPatternBreakConfig(cfg ?? {});
    return {
      ok: true,
      scope: modelScope,
      enabled: Boolean(cfg?.aiPullbackPatternBreakEnabled),
      tracked: scores.size,
      badCount: bad.length,
      threshold: patternBreakCfg.aiPullbackPatternBreakThreshold,
      bullThreshold: patternBreakCfg.aiPullbackPatternBreakBullThreshold,
      bearThreshold: patternBreakCfg.aiPullbackPatternBreakBearThreshold,
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

module.exports = { createPullbackPatternBreakMonitor, MIN_BARS };
