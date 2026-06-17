function isShort(pos) {
  return String(pos?.side || "LONG").toUpperCase() === "SHORT";
}

function movePctFromEntry(price, initialEntry) {
  if (!Number.isFinite(price) || !Number.isFinite(initialEntry) || initialEntry <= 0) {
    return null;
  }
  return ((price - initialEntry) / initialEntry) * 100;
}

/** Positive % when the position is in profit at `price`. */
function favorableMovePct(pos, price) {
  const raw = movePctFromEntry(price, pos.initialEntryPrice ?? pos.entryPrice);
  if (raw == null) return null;
  return isShort(pos) ? -raw : raw;
}

/** Best favorable move % during the trade (up for LONG, down for SHORT). */
function peakMovePct(pos) {
  const entry = pos.initialEntryPrice ?? pos.entryPrice;
  if (isShort(pos)) {
    const trough = pos.troughPrice ?? pos.entryPrice;
    const raw = movePctFromEntry(trough, entry);
    return raw == null ? null : -raw;
  }
  const peak = pos.peakPrice ?? pos.entryPrice;
  return movePctFromEntry(peak, entry);
}

/** Worst adverse move % during the trade. */
function adverseMovePct(pos) {
  const entry = pos.initialEntryPrice ?? pos.entryPrice;
  if (isShort(pos)) {
    const peak = pos.peakPrice ?? pos.entryPrice;
    return movePctFromEntry(peak, entry);
  }
  const trough = pos.troughPrice ?? pos.entryPrice;
  return movePctFromEntry(trough, entry);
}

function positionPnl(pos, exitPrice) {
  const q = pos.quantity;
  const entry = pos.entryPrice;
  if (!Number.isFinite(exitPrice) || !Number.isFinite(entry) || !Number.isFinite(q)) {
    return 0;
  }
  return isShort(pos) ? q * (entry - exitPrice) : q * (exitPrice - entry);
}

function stopLossHit(bar, pos) {
  if (!Number.isFinite(pos.stopLoss)) return false;
  if (isShort(pos)) {
    const high = bar.high ?? bar.close;
    return Number.isFinite(high) && high >= pos.stopLoss;
  }
  const low = bar.low ?? bar.close;
  return Number.isFinite(low) && low <= pos.stopLoss;
}

function takeProfitHit(bar, pos) {
  const entry = pos.entryPrice;
  if (!Number.isFinite(entry) || !Number.isFinite(pos.takeProfit)) return false;
  if (isShort(pos)) {
    const low = bar.low ?? bar.close;
    return (
      pos.takeProfit < entry && Number.isFinite(low) && low <= pos.takeProfit
    );
  }
  const high = bar.high ?? bar.close;
  return (
    pos.takeProfit > entry && Number.isFinite(high) && high >= pos.takeProfit
  );
}

function updatePriceExtremes(pos, high, low, close) {
  const hi = Number.isFinite(high) ? high : close;
  const lo = Number.isFinite(low) ? low : close;
  if (Number.isFinite(hi)) {
    pos.peakPrice = Math.max(pos.peakPrice ?? hi, hi);
  }
  if (Number.isFinite(lo)) {
    pos.troughPrice = Math.min(pos.troughPrice ?? lo, lo);
  }
}

module.exports = {
  isShort,
  movePctFromEntry,
  favorableMovePct,
  peakMovePct,
  adverseMovePct,
  positionPnl,
  stopLossHit,
  takeProfitHit,
  updatePriceExtremes,
};
