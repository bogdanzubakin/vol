const {
  buildEpisodesFromTrades,
  normalizeTradeFill,
} = require("./live-bot-history");

const OPEN_MATCH_MS = 3 * 60 * 1000;
const CLOSE_MATCH_MS = 30 * 60 * 1000;
const TRADE_PAD_MS = 5 * 60 * 1000;

function num(n, fallback = null) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function round4(n) {
  return +((Number(n) || 0).toFixed(4));
}

function positionDirection(pos) {
  const side = String(pos?.side || "LONG").toUpperCase();
  return side === "SHORT" ? "SHORT" : "LONG";
}

function priceTolerance(refPrice, tickSize = null) {
  const ref = Math.abs(num(refPrice, 0)) || 1;
  const tick = num(tickSize, 0);
  return Math.max(ref * 0.002, tick > 0 ? tick * 2 : 0, 1e-8);
}

function inferExitReasonFromPrices(pos, exitPrice, tickSize = null) {
  const px = num(exitPrice);
  if (!Number.isFinite(px)) return "exchange_fill";
  const sl = num(pos.stopLoss);
  const tp = num(pos.takeProfit);
  const tol = priceTolerance(pos.entryPrice ?? px, tickSize);
  const slDist = Number.isFinite(sl) ? Math.abs(px - sl) : Number.POSITIVE_INFINITY;
  const tpDist = Number.isFinite(tp) ? Math.abs(px - tp) : Number.POSITIVE_INFINITY;
  if (slDist <= tol && slDist <= tpDist) return "stop_loss";
  if (tpDist <= tol && tpDist < slDist) return "take_profit";
  if (slDist < tpDist) return "stop_loss";
  if (tpDist < slDist) return "take_profit";
  return "exchange_fill";
}

async function inferExitReasonFromAlgoOrders(trader, pos, exitPrice, tickSize) {
  const priceReason = inferExitReasonFromPrices(pos, exitPrice, tickSize);
  if (!trader.getAlgoOrder) return priceReason;
  const slId = pos.slOrderId;
  const tpId = pos.tpOrderId;
  let slFilled = false;
  let tpFilled = false;
  const filledStatuses = new Set(["TRIGGERED", "FINISHED", "FILLED", "EXECUTED"]);
  for (const [id, kind] of [
    [slId, "sl"],
    [tpId, "tp"],
  ]) {
    if (id == null) continue;
    try {
      const row = await trader.getAlgoOrder(id);
      const status = String(row?.algoStatus ?? row?.status ?? "").toUpperCase();
      if (filledStatuses.has(status)) {
        if (kind === "sl") slFilled = true;
        if (kind === "tp") tpFilled = true;
      }
    } catch {
      /* ignore */
    }
  }
  if (tpFilled && !slFilled) return "take_profit";
  if (slFilled && !tpFilled) return "stop_loss";
  if (tpFilled && slFilled) return priceReason;
  return priceReason;
}

function episodeMatchesPosition(ep, pos, now) {
  const wantDir = positionDirection(pos);
  if (ep.direction !== wantDir) return false;
  const openAt = num(pos.exchangeOpenedAt ?? pos.openedAt, 0);
  const closedAt = num(ep.closedAt, 0);
  if (!closedAt || closedAt > now + 60_000) return false;
  if (openAt && closedAt < openAt - 60_000) return false;
  if (openAt && Math.abs((ep.openedAt || 0) - openAt) > OPEN_MATCH_MS) {
    const entryOrderId =
      pos.entryOrderId != null ? String(pos.entryOrderId) : null;
    if (
      !entryOrderId ||
      !ep.exchangeTradeFills?.some((f) => String(f.orderId) === entryOrderId)
    ) {
      return false;
    }
  }
  if (now - closedAt > CLOSE_MATCH_MS) return false;
  return true;
}

function pickMatchingEpisode(episodes, pos, now = Date.now()) {
  const candidates = (episodes || []).filter((ep) =>
    episodeMatchesPosition(ep, pos, now)
  );
  if (!candidates.length) return null;

  const entryOrderId =
    pos.entryOrderId != null ? String(pos.entryOrderId) : null;
  if (entryOrderId) {
    const byEntry = candidates.find((ep) =>
      ep.exchangeTradeFills?.some((f) => String(f.orderId) === entryOrderId)
    );
    if (byEntry) return byEntry;
  }

  const openAt = num(pos.exchangeOpenedAt ?? pos.openedAt, 0);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const ep of candidates) {
    const timeGap = openAt ? Math.abs((ep.openedAt || 0) - openAt) : 0;
    const closeGap = now - (ep.closedAt || 0);
    const score = timeGap + closeGap * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = ep;
    }
  }
  return best ?? candidates[candidates.length - 1];
}

function episodeExitPrice(episode) {
  const fills = episode?.exchangeTradeFills || [];
  if (!fills.length) return null;
  const last = fills[fills.length - 1];
  return num(last?.price);
}

/**
 * Match a bot open position to Binance userTrades episode (open → flat).
 * Returns exit price, realized PnL, inferred SL/TP reason, and fill ids.
 */
async function resolveExchangeClose(trader, pos) {
  if (!trader?.enabled || !pos?.symbol) return null;

  const symbol = String(pos.symbol).toUpperCase();
  const openAt = num(pos.exchangeOpenedAt ?? pos.openedAt, Date.now() - 24 * 60 * 60 * 1000);
  const now = Date.now();

  let rows = [];
  try {
    rows = await trader.getUserTrades(symbol, {
      startTime: Math.max(0, openAt - TRADE_PAD_MS),
      endTime: now + 60_000,
      limit: 1000,
    });
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;

  const episodes = buildEpisodesFromTrades(symbol, rows);
  const episode = pickMatchingEpisode(episodes, pos, now);
  if (!episode) return null;

  const exitPrice = episodeExitPrice(episode);
  if (!Number.isFinite(exitPrice)) return null;

  let tickSize = null;
  try {
    const meta = await trader.getSymbolMeta(symbol);
    tickSize = meta?.tickSize ?? null;
  } catch {
    /* ignore */
  }

  const exitReason = await inferExitReasonFromAlgoOrders(
    trader,
    pos,
    exitPrice,
    tickSize
  );
  const closingFills = episode.exchangeTradeFills || [];
  const exitOrderId = closingFills.length
    ? closingFills[closingFills.length - 1]?.orderId ?? null
    : null;

  return {
    exitPrice,
    pnl: round4(episode.grossPnlFromFills),
    exitReason,
    closedAt: episode.closedAt || now,
    exitOrderId,
    entryOrderId: pos.entryOrderId ?? null,
    slOrderId: pos.slOrderId ?? null,
    tpOrderId: pos.tpOrderId ?? null,
    exchangeTradeFills: closingFills,
    matchedEpisodeId: episode.id,
  };
}

module.exports = {
  resolveExchangeClose,
  inferExitReasonFromPrices,
  pickMatchingEpisode,
  normalizeTradeFill,
};
