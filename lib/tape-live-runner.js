/**
 * Live Tape Reading runner — aggTrade WS → absorption edges → bot handlers.
 */
const { createAggTradeProvider } = require("./binance-futures-aggtrade");
const {
  evaluateTapeLong,
  evaluateTapeBear,
  createTapeEdgeTracker,
  normalizeTapeConfig,
} = require("./tape-reading-signal");

function createTapeLiveRunner(options = {}) {
  const {
    getConfig,
    getSymbols,
    onLong,
    onShort,
    maxSymbols = 40,
  } = options;

  let provider = null;
  let tracker = null;
  let started = false;
  let throttleAt = new Map();

  function activeCfg() {
    return normalizeTapeConfig(getConfig?.() ?? {});
  }

  function enabled(cfg) {
    return Boolean(cfg.tradeTapeSignals || cfg.tradeBearishTapeSignals);
  }

  function onTape(sym, trades) {
    const cfg = activeCfg();
    if (!enabled(cfg)) return;
    const now = Date.now();
    const last = throttleAt.get(sym) || 0;
    if (now - last < 200) return;
    throttleAt.set(sym, now);

    const long = cfg.tradeTapeSignals
      ? evaluateTapeLong(trades, cfg)
      : { passes: false };
    const short = cfg.tradeBearishTapeSignals
      ? evaluateTapeBear(trades, cfg)
      : { passes: false };
    const edge = tracker.note(sym, long.passes, short.passes, cfg);
    if (edge.fireLong && long.passes) onLong?.(sym, long);
    if (edge.fireShort && short.passes) onShort?.(sym, short);
  }

  function start() {
    const cfg = activeCfg();
    if (!enabled(cfg)) return { started: false, reason: "disabled" };
    if (started) return { started: true, reason: "already" };

    const symbols = (getSymbols?.() ?? [])
      .map((s) => String(s).toUpperCase())
      .slice(0, maxSymbols);
    if (!symbols.length) return { started: false, reason: "no_symbols" };

    tracker = createTapeEdgeTracker();
    provider = createAggTradeProvider({
      bufferSize: Math.max(250, cfg.tapeTradeCount * 2),
    });
    provider.setSymbols(symbols);
    provider.onUpdate(onTape);
    provider.start();
    void provider.seedAll({ limit: cfg.tapeTradeCount }).then((r) => {
      // evaluate once after seed
      for (const sym of symbols) onTape(sym, provider.getTrades(sym));
      return r;
    });
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

  return {
    start,
    stop,
    status() {
      return { started, provider: provider?.status?.() ?? null };
    },
  };
}

module.exports = { createTapeLiveRunner };
