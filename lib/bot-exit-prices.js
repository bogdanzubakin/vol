/** Stop below the top corridor border (corridor high). */
function stopLossPrice(corridorHigh, pct) {
  if (!Number.isFinite(corridorHigh) || corridorHigh <= 0) return null;
  return corridorHigh * (1 - pct / 100);
}

/** Stop above the bottom corridor border (corridor low) — SHORT mirror. */
function stopLossPriceShort(corridorLow, pct) {
  if (!Number.isFinite(corridorLow) || corridorLow <= 0) return null;
  return corridorLow * (1 + pct / 100);
}

function takeProfitPrice(entry, pct) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return entry * (1 + pct / 100);
}

function takeProfitPriceShort(entry, pct) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return entry * (1 - pct / 100);
}

/** LONG stop at entry − offset% (positive offset = below entry). */
function entryBasedStopPrice(entry, offsetPct) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return entry * (1 - offsetPct / 100);
}

/** SHORT stop at entry + offset% (positive offset = above entry). */
function entryBasedStopPriceShort(entry, offsetPct) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return entry * (1 + offsetPct / 100);
}

/** LONG STOP_MARKET would fire when mark is at or below trigger. */
function wouldLongStopMarketTrigger(mark, triggerPrice) {
  return (
    Number.isFinite(mark) &&
    Number.isFinite(triggerPrice) &&
    mark <= triggerPrice
  );
}

/** SHORT STOP_MARKET would fire when mark is at or above trigger. */
function wouldShortStopMarketTrigger(mark, triggerPrice) {
  return (
    Number.isFinite(mark) &&
    Number.isFinite(triggerPrice) &&
    mark >= triggerPrice
  );
}

/** LONG TAKE_PROFIT_MARKET would fire when mark is at or above trigger. */
function wouldLongTakeProfitTrigger(mark, triggerPrice) {
  return (
    Number.isFinite(mark) &&
    Number.isFinite(triggerPrice) &&
    mark >= triggerPrice
  );
}

/** SHORT TAKE_PROFIT_MARKET would fire when mark is at or below trigger. */
function wouldShortTakeProfitTrigger(mark, triggerPrice) {
  return (
    Number.isFinite(mark) &&
    Number.isFinite(triggerPrice) &&
    mark <= triggerPrice
  );
}

/** Entry + tp% for LONG; nudged above mark if exchange would reject. */
function takeProfitFallbackForLong(entry, tpPct, mark, tickSize) {
  let tp = takeProfitPrice(entry, tpPct);
  if (!Number.isFinite(tp)) return null;
  if (!wouldLongTakeProfitTrigger(mark, tp)) return tp;
  if (!Number.isFinite(mark) || mark <= 0) return tp;
  const step =
    Number.isFinite(tickSize) && tickSize > 0 ? tickSize : mark * 0.0001;
  tp = mark + step;
  if (tp <= mark) tp = mark * (1 + tpPct / 100);
  return tp > 0 ? tp : null;
}

/** Entry − tp% for SHORT; nudged below mark if exchange would reject. */
function takeProfitFallbackForShort(entry, tpPct, mark, tickSize) {
  let tp = takeProfitPriceShort(entry, tpPct);
  if (!Number.isFinite(tp)) return null;
  if (!wouldShortTakeProfitTrigger(mark, tp)) return tp;
  if (!Number.isFinite(mark) || mark <= 0) return tp;
  const step =
    Number.isFinite(tickSize) && tickSize > 0 ? tickSize : mark * 0.0001;
  tp = mark - step;
  if (tp >= mark) tp = mark * (1 - tpPct / 100);
  return tp > 0 ? tp : null;
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

/** Widen LONG fallback on retries (lower trigger) when mark is below entry stop. */
function stopLossFallbackForLongEscalated(entry, lossPct, mark, tickSize, attempt = 0) {
  const bump = attempt * Math.max(0.5, lossPct * 0.25);
  let stop = stopLossFallbackForLong(entry, lossPct + bump, mark, tickSize);
  if (attempt > 0 && Number.isFinite(mark) && mark > 0) {
    const step =
      Number.isFinite(tickSize) && tickSize > 0 ? tickSize : mark * 0.0001;
    const markStop = mark - step * (attempt + 1);
    if (markStop > 0) {
      if (!Number.isFinite(stop) || wouldLongStopMarketTrigger(mark, stop)) {
        stop = markStop;
      } else if (markStop < stop) {
        stop = markStop;
      }
    }
  }
  return stop > 0 ? stop : null;
}

/** Entry + loss% for SHORT; nudged above mark if exchange would reject. */
function stopLossFallbackForShort(entry, lossPct, mark, tickSize) {
  let stop = entryBasedStopPriceShort(entry, lossPct);
  if (!Number.isFinite(stop)) return null;
  if (!wouldShortStopMarketTrigger(mark, stop)) return stop;
  if (!Number.isFinite(mark) || mark <= 0) return stop;
  const step =
    Number.isFinite(tickSize) && tickSize > 0 ? tickSize : mark * 0.0001;
  stop = mark + step;
  if (stop <= mark) stop = mark * (1 + lossPct / 100);
  return stop > 0 ? stop : null;
}

function stopLossFallbackForShortEscalated(entry, lossPct, mark, tickSize, attempt = 0) {
  const bump = attempt * Math.max(0.5, lossPct * 0.25);
  let stop = stopLossFallbackForShort(entry, lossPct + bump, mark, tickSize);
  if (attempt > 0 && Number.isFinite(mark) && mark > 0) {
    const step =
      Number.isFinite(tickSize) && tickSize > 0 ? tickSize : mark * 0.0001;
    const markStop = mark + step * (attempt + 1);
    if (markStop > 0) {
      if (!Number.isFinite(stop) || wouldShortStopMarketTrigger(mark, stop)) {
        stop = markStop;
      } else if (markStop > stop) {
        stop = markStop;
      }
    }
  }
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

function resolveInitialStopLossShort({
  corridorLow,
  stopLossBelowCorridorPct,
  entry,
  mark,
  stopLossFallbackPnlPct,
  tickSize,
}) {
  const corridorSl = stopLossPriceShort(corridorLow, stopLossBelowCorridorPct);
  if (!corridorSl) {
    return stopLossFallbackForShort(
      entry,
      stopLossFallbackPnlPct,
      mark,
      tickSize
    );
  }
  if (wouldShortStopMarketTrigger(mark, corridorSl)) {
    return stopLossFallbackForShort(
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
  stopLossPriceShort,
  takeProfitPrice,
  takeProfitPriceShort,
  entryBasedStopPrice,
  entryBasedStopPriceShort,
  wouldLongStopMarketTrigger,
  wouldShortStopMarketTrigger,
  wouldLongTakeProfitTrigger,
  wouldShortTakeProfitTrigger,
  takeProfitFallbackForLong,
  takeProfitFallbackForShort,
  stopLossFallbackForLong,
  stopLossFallbackForLongEscalated,
  stopLossFallbackForShort,
  stopLossFallbackForShortEscalated,
  resolveInitialStopLoss,
  resolveInitialStopLossShort,
};
