const { normalizeAiModelScope } = require("./ai-model-scope");

function tradeDedupeKey(trade) {
  return trade.id ?? `${trade.symbol}-${trade.openedAt}-${trade.closedAt}`;
}

function mergeDedupedTrades(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const trade of list ?? []) {
      const key = tradeDedupeKey(trade);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trade);
    }
  }
  return out;
}

/**
 * Collect closed trades for AI model training.
 *
 * Paper scope: auto = train-bot backtest + paper history.
 * Live scope: auto = train-bot backtest + live bot fills.
 */
function collectAiTrainingTrades(source = "auto", scope = "paper", deps = {}, filter) {
  const apply = typeof filter === "function" ? filter : (list) => list ?? [];
  const mode = String(source || "auto").toLowerCase();
  const normalizedScope = normalizeAiModelScope(scope);
  const backtest = apply(deps.backtestTrades);
  const paper = apply(deps.paperTrades);
  const live = apply(deps.liveTrades);

  if (normalizedScope === "live") {
    if (mode === "live") return live;
    if (mode === "backtest") return backtest;
    return mergeDedupedTrades([backtest, live]);
  }

  if (mode === "paper") return paper;
  if (mode === "backtest") return backtest;
  return mergeDedupedTrades([backtest, paper]);
}

module.exports = {
  tradeDedupeKey,
  mergeDedupedTrades,
  collectAiTrainingTrades,
};
