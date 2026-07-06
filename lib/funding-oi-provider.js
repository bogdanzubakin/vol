const {
  loadFundingOiCache,
  ensureSymbolFundingOi,
  lookupFundingOiSeries,
} = require("./funding-oi-cache");

const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 8;

/**
 * In-memory funding/OI lookup for live/paper bots. Refreshes symbols on a timer.
 */
function createFundingOiProvider(options = {}) {
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const restGapMs = options.restGapMs ?? 80;
  let bySymbol = {};
  let symbolList = [];
  let refreshTimer = null;
  let refreshInflight = null;

  function loadFromDisk(symbols = symbolList) {
    const loaded = loadFundingOiCache(symbols);
    bySymbol = { ...bySymbol, ...loaded.bySymbol };
  }

  function getFundingOiAt(symbol, asOfMs = Date.now()) {
    const sym = String(symbol || "").toUpperCase();
    const row = bySymbol[sym];
    if (!row) {
      return { fundingRate: null, fundingTrend: null, oiDelta1h: null, asOfMs };
    }
    return lookupFundingOiSeries(row.funding ?? [], row.oi ?? [], asOfMs);
  }

  async function refreshSymbol(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return null;
    const endTime = Date.now();
    const startTime = endTime - lookbackDays * 24 * 60 * 60 * 1000;
    const row = await ensureSymbolFundingOi(sym, { startTime, endTime, restGapMs });
    bySymbol[sym] = row;
    return row;
  }

  async function refreshAll({ onProgress } = {}) {
    if (!symbolList.length) return { ok: 0, fail: 0 };
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < symbolList.length; i++) {
      const sym = symbolList[i];
      try {
        await refreshSymbol(sym);
        ok++;
      } catch (e) {
        fail++;
        onProgress?.({ symbol: sym, error: e.message, fail });
      }
      if (i % 50 === 0) {
        onProgress?.({ done: i + 1, total: symbolList.length, symbol: sym });
      }
    }
    return { ok, fail };
  }

  function setSymbols(symbols) {
    symbolList = [...new Set((symbols ?? []).map((s) => String(s).toUpperCase()))].sort();
    loadFromDisk(symbolList);
  }

  function startAutoRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      if (refreshInflight) return;
      refreshInflight = refreshAll().finally(() => {
        refreshInflight = null;
      });
    }, refreshMs);
    refreshTimer.unref?.();
  }

  function stopAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  return {
    getFundingOiAt,
    setSymbols,
    loadFromDisk,
    refreshSymbol,
    refreshAll,
    startAutoRefresh,
    stopAutoRefresh,
    status() {
      return {
        symbols: symbolList.length,
        cached: Object.keys(bySymbol).length,
        refreshMs,
        lookbackDays,
      };
    },
  };
}

module.exports = { createFundingOiProvider, DEFAULT_REFRESH_MS };
