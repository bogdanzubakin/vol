/**
 * Live Order Book Imbalance runner — depth WS/REST → bot onObi* handlers.
 * Start only when paper/live has tradeObiSignals enabled.
 */
const {
  createOrderBookDepthProvider,
} = require("./binance-futures-depth");
const {
  evaluateObiLong,
  evaluateObiBear,
  createObiEdgeTracker,
  normalizeObiConfig,
} = require("./order-book-imbalance-signal");

function createObiLiveRunner(options = {}) {
  const {
    getConfig,
    getSymbols,
    onLong,
    onShort,
    maxSymbols = 40,
    preferWs = true,
  } = options;

  let provider = null;
  let tracker = null;
  let started = false;
  let throttleAt = new Map();

  function activeCfg() {
    return normalizeObiConfig(getConfig?.() ?? {});
  }

  function enabled(cfg) {
    return Boolean(cfg.tradeObiSignals || cfg.tradeBearishObiSignals);
  }

  function pickSymbols(cfg) {
    const all = (getSymbols?.() ?? []).map((s) => String(s).toUpperCase());
    return all.slice(0, maxSymbols);
  }

  function onBook(sym, book) {
    const cfg = activeCfg();
    if (!enabled(cfg)) return;
    const now = Date.now();
    const last = throttleAt.get(sym) || 0;
    if (now - last < 150) return; // ~6.6 Hz max eval per symbol
    throttleAt.set(sym, now);

    const long = cfg.tradeObiSignals ? evaluateObiLong(book, cfg) : { passes: false };
    const short = cfg.tradeBearishObiSignals
      ? evaluateObiBear(book, cfg)
      : { passes: false };
    const edge = tracker.note(sym, long.passes, short.passes, cfg);
    if (edge.fireLong && long.passes) onLong?.(sym, long);
    if (edge.fireShort && short.passes) onShort?.(sym, short);
  }

  function start() {
    const cfg = activeCfg();
    if (!enabled(cfg)) return { started: false, reason: "disabled" };
    if (started) return { started: true, reason: "already" };

    const symbols = pickSymbols(cfg);
    if (!symbols.length) return { started: false, reason: "no_symbols" };

    tracker = createObiEdgeTracker(cfg);
    provider = createOrderBookDepthProvider({
      levels: cfg.obiLevels,
      streamsPerSocket: 40,
    });
    provider.setSymbols(symbols);
    provider.onUpdate(onBook);
    provider.start({ ws: preferWs, poll: !preferWs });
    // seed via REST so first edges don't wait for WS
    void provider.refreshAll();
    started = true;
    return { started: true, symbols: symbols.length };
  }

  function stop() {
    provider?.stop?.();
    provider = null;
    tracker = null;
    started = false;
    throttleAt = new Map();
  }

  function status() {
    return {
      started,
      provider: provider?.status?.() ?? null,
    };
  }

  return { start, stop, status, onBook };
}

module.exports = { createObiLiveRunner };
