/** Stop below the top corridor border (corridor high). */
function stopLossPrice(corridorHigh, pct) {
  if (!Number.isFinite(corridorHigh) || corridorHigh <= 0) return null;
  return corridorHigh * (1 - pct / 100);
}

function takeProfitPrice(entry, pct) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return entry * (1 + pct / 100);
}

/** LONG stop at entry − offset% (positive offset = below entry). */
function entryBasedStopPrice(entry, offsetPct) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return entry * (1 - offsetPct / 100);
}

/** LONG STOP_MARKET would fire when mark is at or below trigger. */
function wouldLongStopMarketTrigger(mark, triggerPrice) {
  return (
    Number.isFinite(mark) &&
    Number.isFinite(triggerPrice) &&
    mark <= triggerPrice
  );
}

/** Entry − loss% for LONG; nudged below mark if exchange would reject. */
function stopLossFallbackForLong(entry, lossPct, mark, tickSize) {
  let stop = entryBasedStopPrice(entry, lossPct);
  if (!Number.isFinite(stop)) return null;
  if (!wouldLongStopMarketTrigger(mark, stop)) return stop;
  if (!Number.isFinite(mark) || mark <= 0) return stop;
  const step =
    Number.isFinite(tickSize) && tickSize > 0 ? tickSize : mark * 0.0001;
  stop = mark - step;
  if (stop >= mark) stop = mark * (1 - lossPct / 100);
  return stop > 0 ? stop : null;
}

function resolveInitialStopLoss({
  corridorHigh,
  stopLossBelowCorridorPct,
  entry,
  mark,
  stopLossFallbackPnlPct,
  tickSize,
}) {
  const corridorSl = stopLossPrice(corridorHigh, stopLossBelowCorridorPct);
  if (!corridorSl) {
    return stopLossFallbackForLong(
      entry,
      stopLossFallbackPnlPct,
      mark,
      tickSize
    );
  }
  if (wouldLongStopMarketTrigger(mark, corridorSl)) {
    return stopLossFallbackForLong(
      entry,
      stopLossFallbackPnlPct,
      mark,
      tickSize
    );
  }
  return corridorSl;
}

module.exports = {
  stopLossPrice,
  takeProfitPrice,
  entryBasedStopPrice,
  wouldLongStopMarketTrigger,
  stopLossFallbackForLong,
  resolveInitialStopLoss,
};
