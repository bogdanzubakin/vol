function normalizeSymbol(raw) {
  let sym = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!sym) return null;
  if (!sym.endsWith("USDT")) sym += "USDT";
  return sym;
}

function parseBlockedSymbolsInput(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).split(/[\s,;]+/);
}

function normalizeBlockedSymbols(raw, max = 500) {
  const out = [];
  const seen = new Set();
  for (const part of parseBlockedSymbolsInput(raw)) {
    const sym = normalizeSymbol(part);
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
    if (out.length >= max) break;
  }
  return out;
}

function isSymbolBlocked(symbol, blockedSymbols) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return false;
  return normalizeBlockedSymbols(blockedSymbols).includes(sym);
}

function formatBlockedSymbolsText(blockedSymbols) {
  return normalizeBlockedSymbols(blockedSymbols).join("\n");
}

/**
 * Worst net-PnL symbols from train-bot perSymbol stats.
 */
function worstPairsFromPerSymbol(perSymbol, options = {}) {
  const count = Math.max(1, Math.min(200, Number(options.count) || 20));
  const minTrades = Math.max(1, Number(options.minTrades) || 3);
  return (perSymbol ?? [])
    .filter(
      (r) =>
        !r.error &&
        !r.skipped &&
        (r.trades ?? 0) >= minTrades &&
        Number(r.pnl) < 0
    )
    .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
    .slice(0, count)
    .map((r) => ({
      symbol: r.symbol,
      trades: r.trades ?? 0,
      pnl: +(Number(r.pnl ?? 0).toFixed(4)),
      signals: r.signals ?? 0,
      sfpSignals: r.sfpSignals ?? 0,
      pullbackSignals: r.pullbackSignals ?? 0,
    }));
}

/**
 * Track consecutive stop-loss exits; auto-append to config.blockedSymbols when threshold hit.
 */
function recordTradeForSymbolBlocklist(ctx) {
  const { trade, config, symbolSlStreak, onAutoBlock } = ctx;
  if (!trade || !config || !symbolSlStreak) return false;

  const symbol = normalizeSymbol(trade.symbol);
  if (!symbol) return false;

  const threshold = Math.max(0, Math.round(Number(config.autoBlockAfterConsecutiveSl) || 0));
  let blocked = false;

  if (trade.exitReason === "stop_loss") {
    const next = (symbolSlStreak[symbol] ?? 0) + 1;
    symbolSlStreak[symbol] = next;
    if (
      threshold > 0 &&
      next >= threshold &&
      !isSymbolBlocked(symbol, config.blockedSymbols)
    ) {
      config.blockedSymbols = normalizeBlockedSymbols([
        ...(config.blockedSymbols ?? []),
        symbol,
      ]);
      symbolSlStreak[symbol] = 0;
      blocked = true;
      if (onAutoBlock) onAutoBlock(symbol, threshold);
    }
  } else if ((trade.pnl ?? 0) > 0 || trade.exitReason === "take_profit") {
    symbolSlStreak[symbol] = 0;
  }

  return blocked;
}

function normalizeSymbolSlStreak(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    const sym = normalizeSymbol(key);
    const n = Math.max(0, Math.round(Number(val) || 0));
    if (sym && n > 0) out[sym] = n;
  }
  return out;
}

module.exports = {
  normalizeSymbol,
  parseBlockedSymbolsInput,
  normalizeBlockedSymbols,
  isSymbolBlocked,
  formatBlockedSymbolsText,
  worstPairsFromPerSymbol,
  recordTradeForSymbolBlocklist,
  normalizeSymbolSlStreak,
};
