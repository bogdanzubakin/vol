function db() {
  return require("./db").getDb();
}
const { formatIsoUtcPlus3, OFFSET_MS } = require("./time-format");
const { resolveBinanceCredentials } = require("./binance-positions");
const { signedFuturesGet } = require("./binance-signed");
const {
  isArchivableTrade,
  upsertClosedTrade,
  listClosedTrades,
  deleteTradesByIds,
  clearBotTrades,
} = require("./db/repos/trades");

const BOT_TYPE_LIVE = "live";
const LIVE_SIGNAL_KINDS = [
  "sfp",
  "sfp_bear",
  "pullback",
  "pullback_bear",
  "foi",
  "foi_bear",
  "false_breakout",
  "false_breakout_bear",
  "obi",
  "obi_bear",
  "tape",
  "tape_bear",
  "vwap",
  "vwap_bear",
];
const AUDIT_TYPES = new Set(["REALIZED_PNL", "COMMISSION", "FUNDING_FEE"]);
const AUDIT_MATCH_MS = 45 * 60 * 1000;
const TRADE_FETCH_PAD_MS = 6 * 60 * 60 * 1000;
const FUNDING_PAD_MS = 2 * 60 * 60 * 1000;

function dayKeyUtcPlus3(ms) {
  const d = new Date(Number(ms) + OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function hourKeyUtcPlus3(ms) {
  const d = new Date(Number(ms) + OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:00`;
}

function parseFromDate(searchParams) {
  const raw = String(searchParams?.get("fromDate") || "").trim();
  if (!raw) return null;
  const ms = Date.parse(`${raw}T00:00:00+03:00`);
  return Number.isFinite(ms) ? ms : null;
}

function isArchivableBotTrade(trade) {
  return isArchivableTrade(trade);
}

function num(n, fallback = null) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function round4(n) {
  return +((Number(n) || 0).toFixed(4));
}

function signedGet(pathName, params, apiKey, apiSecret) {
  return signedFuturesGet(pathName, params, apiKey, apiSecret);
}

function normalizeIncomeEvent(row) {
  const time = num(row?.time, 0);
  const income = num(row?.income, 0);
  const symbol = String(row?.symbol || "").toUpperCase();
  const incomeType = String(row?.incomeType || "").toUpperCase();
  const tranId = row?.tranId ?? null;
  const tradeId = row?.tradeId ?? null;
  return {
    id:
      tranId != null
        ? `${symbol}:${incomeType}:${tranId}`
        : `${symbol}:${incomeType}:${time}:${income}`,
    symbol,
    incomeType,
    income,
    asset: row?.asset ?? null,
    info: row?.info ?? null,
    tradeId,
    tranId,
    time,
    timeIso: time ? formatIsoUtcPlus3(time) : null,
  };
}

function normalizeTradeFill(row) {
  const time = num(row?.time, 0);
  return {
    id:
      row?.id != null
        ? `${row.symbol}:${row.id}`
        : `${row.symbol}:${time}:${row.side}:${row.qty}`,
    symbol: String(row?.symbol || "").toUpperCase(),
    side: row?.side ?? null,
    positionSide: row?.positionSide ?? null,
    orderId: row?.orderId ?? null,
    price: num(row?.price),
    qty: num(row?.qty),
    quoteQty: num(row?.quoteQty),
    realizedPnl: num(row?.realizedPnl, 0),
    commission: num(row?.commission, 0),
    commissionAsset: row?.commissionAsset ?? null,
    maker: Boolean(row?.maker),
    buyer: Boolean(row?.buyer),
    time,
    timeIso: time ? formatIsoUtcPlus3(time) : null,
  };
}

function sideDelta(side, qty) {
  return String(side).toUpperCase() === "BUY" ? qty : -qty;
}

function bucketDelta(positionSide, side, qty) {
  const ps = String(positionSide || "BOTH").toUpperCase();
  if (ps === "LONG") return { bucket: "LONG", delta: sideDelta(side, qty) };
  if (ps === "SHORT") return { bucket: "SHORT", delta: sideDelta(side, qty) * -1 };
  return { bucket: "BOTH", delta: sideDelta(side, qty) };
}

function finalizeEpisode(symbol, state, closedAt) {
  const openedAt = state.openAt || closedAt;
  const exchangeTradeFills = state.fills.map(normalizeTradeFill);
  return {
    id: `${symbol}:${state.direction}:${openedAt}:${closedAt}`,
    symbol,
    direction: state.direction,
    openedAt,
    closedAt,
    openedAtIso: formatIsoUtcPlus3(openedAt),
    closedAtIso: formatIsoUtcPlus3(closedAt),
    durationSec: Math.max(0, Math.round((closedAt - openedAt) / 1000)),
    grossPnlFromFills: round4(state.realizedPnl),
    commissionFromFills: round4(-Math.abs(state.commission)),
    exchangeTradeFills,
    exchangeIncomeEvents: [],
  };
}

function buildEpisodesFromTrades(symbol, trades) {
  const rows = [];
  const state = {
    LONG: { qty: 0, openAt: null, realizedPnl: 0, commission: 0, direction: "LONG", fills: [] },
    SHORT: { qty: 0, openAt: null, realizedPnl: 0, commission: 0, direction: "SHORT", fills: [] },
    BOTH: { qty: 0, openAt: null, realizedPnl: 0, commission: 0, direction: null, fills: [] },
  };
  const sorted = [...(trades || [])].sort((a, b) => Number(a.time) - Number(b.time));

  for (const t of sorted) {
    const qty = num(t.qty);
    const tm = num(t.time);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(tm)) continue;
    const { bucket, delta } = bucketDelta(t.positionSide, t.side, qty);
    const s = state[bucket];
    const prev = s.qty;
    const next = prev + delta;
    const fill = normalizeTradeFill(t);
    const realized = num(t.realizedPnl, 0);
    const commission = num(t.commission, 0);

    if (bucket === "BOTH") {
      const prevSign = Math.sign(prev);
      const nextSign = Math.sign(next);

      if (prev === 0 && next !== 0) {
        s.openAt = tm;
        s.direction = next > 0 ? "LONG" : "SHORT";
        s.realizedPnl = realized;
        s.commission = commission;
        s.fills = [fill];
      } else if (prev !== 0 && next === 0) {
        s.realizedPnl += realized;
        s.commission += commission;
        s.fills.push(fill);
        rows.push(finalizeEpisode(symbol, s, tm));
        s.openAt = null;
        s.direction = null;
        s.realizedPnl = 0;
        s.commission = 0;
        s.fills = [];
      } else if (prev !== 0 && next !== 0 && prevSign !== nextSign) {
        s.realizedPnl += realized;
        s.commission += commission;
        s.fills.push(fill);
        rows.push(finalizeEpisode(symbol, s, tm));
        s.openAt = tm;
        s.direction = next > 0 ? "LONG" : "SHORT";
        s.realizedPnl = 0;
        s.commission = 0;
        s.fills = [];
      } else if (prev !== 0) {
        s.realizedPnl += realized;
        s.commission += commission;
        s.fills.push(fill);
      }
      s.qty = next;
      continue;
    }

    if (prev <= 0 && next > 0) {
      s.openAt = tm;
      s.realizedPnl = realized;
      s.commission = commission;
      s.fills = [fill];
    } else if (prev > 0 && next <= 0) {
      s.realizedPnl += realized;
      s.commission += commission;
      s.fills.push(fill);
      rows.push(finalizeEpisode(symbol, s, tm));
      s.openAt = next > 0 ? tm : null;
      s.realizedPnl = 0;
      s.commission = 0;
      s.fills = [];
    } else if (prev > 0) {
      s.realizedPnl += realized;
      s.commission += commission;
      s.fills.push(fill);
    }
    s.qty = Math.max(0, next);
  }

  return rows;
}

function attachIncomeToEpisodes(episodes, incomes) {
  for (const ep of episodes) {
    const from = (ep.openedAt || ep.closedAt) - 60_000;
    const to = ep.closedAt + 60_000;
    const matched = incomes.filter((row) => row.time >= from && row.time <= to);
    const realizedRows = matched.filter((row) => row.incomeType === "REALIZED_PNL");
    const commissionRows = matched.filter((row) => row.incomeType === "COMMISSION");
    const fundingRows = matched.filter((row) => row.incomeType === "FUNDING_FEE");
    const grossPnl = realizedRows.length
      ? round4(realizedRows.reduce((sum, row) => sum + row.income, 0))
      : round4(ep.grossPnlFromFills);
    const commission = commissionRows.length
      ? round4(commissionRows.reduce((sum, row) => sum + row.income, 0))
      : round4(ep.commissionFromFills);
    const fundingFee = round4(fundingRows.reduce((sum, row) => sum + row.income, 0));
    ep.exchangeIncomeEvents = matched;
    ep.grossPnl = grossPnl;
    ep.commission = commission;
    ep.fundingFee = fundingFee;
    ep.netPnl = round4(grossPnl + commission + fundingFee);
  }
  return episodes;
}

function tradeAuditFallback(trade, incomeRows, fillRows) {
  const openAt = num(trade.exchangeOpenedAt ?? trade.openedAt, 0);
  const closeAt = num(trade.closedAt, 0);
  const from = Math.max(0, openAt - FUNDING_PAD_MS);
  const to = closeAt + FUNDING_PAD_MS;
  const exchangeIncomeEvents = incomeRows.filter((row) => row.time >= from && row.time <= to);
  const exchangeTradeFills = fillRows.filter(
    (row) => row.time >= Math.max(0, openAt - TRADE_FETCH_PAD_MS) && row.time <= to
  );
  const grossPnl = exchangeIncomeEvents.some((row) => row.incomeType === "REALIZED_PNL")
    ? round4(
        exchangeIncomeEvents
          .filter((row) => row.incomeType === "REALIZED_PNL")
          .reduce((sum, row) => sum + row.income, 0)
      )
    : round4(num(trade.pnl, 0));
  const commission = round4(
    exchangeIncomeEvents
      .filter((row) => row.incomeType === "COMMISSION")
      .reduce((sum, row) => sum + row.income, 0)
  );
  const fundingFee = round4(
    exchangeIncomeEvents
      .filter((row) => row.incomeType === "FUNDING_FEE")
      .reduce((sum, row) => sum + row.income, 0)
  );
  return {
    grossPnl,
    commission,
    fundingFee,
    netPnl: round4(grossPnl + commission + fundingFee),
    exchangeIncomeEvents,
    exchangeTradeFills,
  };
}

function applyAuditToTrade(trade, audit) {
  return {
    ...trade,
    grossPnl: audit.grossPnl,
    commission: audit.commission,
    fundingFee: audit.fundingFee,
    netPnl: audit.netPnl,
    exchangeIncomeEvents: audit.exchangeIncomeEvents ?? [],
    exchangeTradeFills: audit.exchangeTradeFills ?? [],
    auditEnrichedAt: Date.now(),
  };
}

function hasExchangeAudit(trade) {
  return (
    Number.isFinite(num(trade.grossPnl)) &&
    Array.isArray(trade.exchangeIncomeEvents) &&
    Array.isArray(trade.exchangeTradeFills)
  );
}

function matchTradeToEpisode(trade, episodes, usedIds) {
  const side = String(trade.side || "").toUpperCase();
  let best = null;
  let bestScore = Infinity;
  for (const ep of episodes) {
    if (usedIds.has(ep.id)) continue;
    const gap = Math.abs((ep.closedAt || 0) - (trade.closedAt || 0));
    if (gap > AUDIT_MATCH_MS) continue;
    let score = gap;
    if (side && ep.direction && side !== ep.direction) score += 5 * 60 * 1000;
    const qtyGap = Math.abs((num(trade.quantity, 0) || 0) - (num(ep.exchangeTradeFills[0]?.qty, 0) || 0));
    score += qtyGap;
    if (score < bestScore) {
      bestScore = score;
      best = ep;
    }
  }
  if (best) usedIds.add(best.id);
  return best;
}

async function fetchAllPages(pathName, baseParams, credentials) {
  let endTime = baseParams.endTime != null ? Number(baseParams.endTime) : null;
  const out = [];
  for (let i = 0; i < 10; i++) {
    const params = {
      ...baseParams,
      limit: String(baseParams.limit ?? 1000),
    };
    if (endTime != null) params.endTime = String(endTime);
    const rows = await signedGet(
      pathName,
      params,
      credentials.apiKey,
      credentials.apiSecret
    );
    const batch = Array.isArray(rows) ? rows : [];
    out.push(...batch);
    if (batch.length < Number(params.limit)) break;
    const oldest = Math.min(...batch.map((row) => num(row.time, Number.POSITIVE_INFINITY)));
    if (!Number.isFinite(oldest)) break;
    endTime = oldest - 1;
    if (baseParams.startTime != null && endTime <= Number(baseParams.startTime)) break;
  }
  const uniq = new Map();
  for (const row of out) {
    const key =
      row?.id != null
        ? `id:${row.id}`
        : row?.tranId != null
          ? `tran:${row.tranId}`
          : `${row?.time}:${row?.symbol}:${row?.incomeType ?? row?.side ?? ""}`;
    if (!uniq.has(key)) uniq.set(key, row);
  }
  return [...uniq.values()].sort((a, b) => num(a.time, 0) - num(b.time, 0));
}

async function enrichTradesWithExchangeAudit(trades, credentials) {
  if (!credentials.enabled || !trades.length) return trades;
  const bySymbol = new Map();
  for (const trade of trades) {
    const symbol = String(trade.symbol || "").toUpperCase();
    if (!symbol) continue;
    const openAt = num(trade.exchangeOpenedAt ?? trade.openedAt, trade.closedAt);
    const closeAt = num(trade.closedAt, trade.openedAt);
    const prev = bySymbol.get(symbol) ?? {
      symbol,
      startTime: openAt,
      endTime: closeAt,
      trades: [],
    };
    prev.startTime = Math.min(prev.startTime, openAt);
    prev.endTime = Math.max(prev.endTime, closeAt);
    prev.trades.push(trade);
    bySymbol.set(symbol, prev);
  }

  const updates = new Map();
  for (const group of bySymbol.values()) {
    const tradeRows = await fetchAllPages(
      "/fapi/v1/userTrades",
      {
        symbol: group.symbol,
        startTime: Math.max(0, group.startTime - TRADE_FETCH_PAD_MS),
        endTime: group.endTime + TRADE_FETCH_PAD_MS,
        limit: 1000,
      },
      credentials
    );
    const incomeRows = (
      await fetchAllPages(
        "/fapi/v1/income",
        {
          symbol: group.symbol,
          startTime: Math.max(0, group.startTime - FUNDING_PAD_MS),
          endTime: group.endTime + FUNDING_PAD_MS,
          limit: 1000,
        },
        credentials
      )
    )
      .map(normalizeIncomeEvent)
      .filter((row) => AUDIT_TYPES.has(row.incomeType));
    const episodes = attachIncomeToEpisodes(
      buildEpisodesFromTrades(group.symbol, tradeRows),
      incomeRows
    );
    const fillRows = tradeRows.map(normalizeTradeFill);
    const usedIds = new Set();
    for (const trade of group.trades) {
      const matched = matchTradeToEpisode(trade, episodes, usedIds);
      const audit = matched
        ? {
            grossPnl: matched.grossPnl,
            commission: matched.commission,
            fundingFee: matched.fundingFee,
            netPnl: matched.netPnl,
            exchangeIncomeEvents: matched.exchangeIncomeEvents,
            exchangeTradeFills: matched.exchangeTradeFills,
          }
        : tradeAuditFallback(trade, incomeRows, fillRows);
      updates.set(trade.id, applyAuditToTrade(trade, audit));
    }
  }
  return trades.map((trade) => updates.get(trade.id) ?? trade);
}

function normalizeTrade(trade) {
  const grossPnl = trade.grossPnl ?? trade.pnl ?? 0;
  const commission = trade.commission ?? 0;
  const fundingFee = trade.fundingFee ?? 0;
  const netPnl = trade.netPnl ?? grossPnl + commission + fundingFee;
  return {
    id: trade.id,
    symbol: trade.symbol,
    signalKind: trade.signalKind,
    side: trade.side,
    entryPrice: trade.entryPrice,
    initialEntryPrice: trade.initialEntryPrice,
    exitPrice: trade.exitPrice,
    quantity: trade.quantity,
    margin: trade.margin,
    leverage: trade.leverage,
    marginType: trade.marginType ?? null,
    addCount: trade.addCount,
    corridorLow: trade.corridorLow,
    corridorHigh: trade.corridorHigh,
    sweepLow: trade.sweepLow ?? null,
    sweepHigh: trade.sweepHigh ?? null,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    initialStopLoss: trade.initialStopLoss,
    stopMoved: trade.stopMoved ?? null,
    pnl: Number(trade.pnl) || 0,
    pnlPct: Number(trade.pnlPct) || 0,
    grossPnl: round4(grossPnl),
    commission: round4(commission),
    fundingFee: round4(fundingFee),
    netPnl: round4(netPnl),
    exitReason: trade.exitReason,
    openedAt: Number(trade.openedAt) || null,
    closedAt: Number(trade.closedAt) || null,
    openedAtIso: trade.openedAt ? formatIsoUtcPlus3(trade.openedAt) : trade.openedAtIso ?? null,
    closedAtIso: trade.closedAt ? formatIsoUtcPlus3(trade.closedAt) : trade.closedAtIso ?? null,
    decidedAt: trade.decidedAt ?? null,
    exchangeOpenedAt: trade.exchangeOpenedAt ?? null,
    openDelaySec: trade.openDelaySec ?? null,
    entryOrderId: trade.entryOrderId ?? null,
    exitOrderId: trade.exitOrderId ?? null,
    slOrderId: trade.slOrderId ?? null,
    tpOrderId: trade.tpOrderId ?? null,
    exchangeMatchedEpisodeId: trade.exchangeMatchedEpisodeId ?? null,
    peakPrice: trade.peakPrice ?? null,
    troughPrice: trade.troughPrice ?? null,
    lastPrice: trade.lastPrice ?? null,
    movePctAtExit: trade.movePctAtExit ?? null,
    peakMovePct: trade.peakMovePct ?? null,
    troughMovePct: trade.troughMovePct ?? null,
    corridorWidthPct: trade.corridorWidthPct ?? null,
    entryAboveCorridorPct: trade.entryAboveCorridorPct ?? null,
    slDistancePct: trade.slDistancePct ?? null,
    tpDistancePct: trade.tpDistancePct ?? null,
    exitMethod: trade.exitMethod ?? null,
    aiSlPct: trade.aiSlPct ?? null,
    aiTpPct: trade.aiTpPct ?? null,
    signalSnapshot: trade.signalSnapshot ?? null,
    exitPathOracle: trade.exitPathOracle ?? null,
    exchangeIncomeEvents: Array.isArray(trade.exchangeIncomeEvents)
      ? trade.exchangeIncomeEvents
      : [],
    exchangeTradeFills: Array.isArray(trade.exchangeTradeFills)
      ? trade.exchangeTradeFills
      : [],
    auditEnrichedAt: trade.auditEnrichedAt ?? null,
    snapshotId: trade.snapshotId ?? null,
    configVersionId: trade.configVersionId ?? null,
  };
}

function buildSummary(trades) {
  const realizedPnl = trades.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  const grossPnl = trades.reduce((sum, t) => sum + (Number(t.grossPnl) || 0), 0);
  const commission = trades.reduce((sum, t) => sum + (Number(t.commission) || 0), 0);
  const fundingFee = trades.reduce((sum, t) => sum + (Number(t.fundingFee) || 0), 0);
  const netPnl = trades.reduce((sum, t) => sum + (Number(t.netPnl) || 0), 0);
  const winCount = trades.filter((t) => (Number(t.netPnl ?? t.pnl) || 0) > 0).length;
  const lossCount = trades.filter((t) => (Number(t.netPnl ?? t.pnl) || 0) < 0).length;
  const tpCount = trades.filter((t) => t.exitReason === "take_profit").length;
  const slCount = trades.filter((t) => t.exitReason === "stop_loss").length;
  return {
    realizedPnl: round4(realizedPnl),
    grossPnl: round4(grossPnl),
    commission: round4(commission),
    fundingFee: round4(fundingFee),
    netPnl: round4(netPnl),
    closedCount: trades.length,
    winCount,
    lossCount,
    tpCount,
    slCount,
    winRate: trades.length ? +((100 * winCount) / trades.length).toFixed(1) : 0,
    tpRate: trades.length ? +((100 * tpCount) / trades.length).toFixed(1) : 0,
    slRate: trades.length ? +((100 * slCount) / trades.length).toFixed(1) : 0,
  };
}

function buildPnlSeries(trades, keyFn, pnlKey = "pnl") {
  const buckets = new Map();
  for (const trade of [...trades].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0))) {
    const closedAt = Number(trade.closedAt) || 0;
    if (!closedAt) continue;
    const key = keyFn(closedAt);
    const prev = buckets.get(key) ?? { bucket: key, pnl: 0, trades: 0 };
    prev.pnl += Number(trade[pnlKey]) || 0;
    prev.trades += 1;
    buckets.set(key, prev);
  }
  let cumulative = 0;
  return [...buckets.values()].map((row) => {
    cumulative += row.pnl;
    return {
      bucket: row.bucket,
      pnl: round4(row.pnl),
      cumulativePnl: round4(cumulative),
      trades: row.trades,
    };
  });
}

function writeLiveClosedTrade(trade) {
  if (!isArchivableBotTrade(trade)) return null;
  const dbConn = db();
  const normalized = normalizeTrade(trade);
  upsertClosedTrade(dbConn, BOT_TYPE_LIVE, normalized);
  return normalized;
}

function createLiveBotHistoryStore(options = {}) {
  const credentials = resolveBinanceCredentials(options.kv ?? new Map());

  function appendTrade(trade) {
    return writeLiveClosedTrade(trade);
  }

  function removeTradeIds(ids = []) {
    if (!ids.length) return;
    deleteTradesByIds(db(), ids.map(String));
  }

  function clear() {
    clearBotTrades(db(), BOT_TYPE_LIVE);
  }

  async function list(searchParams, currentTrades = []) {
    const fromDateMs = parseFromDate(searchParams);
    const dbConn = db();
    const currentById = new Map();
    for (const trade of currentTrades || []) {
      if (!isArchivableBotTrade(trade)) continue;
      const normalized = normalizeTrade(trade);
      currentById.set(normalized.id, normalized);
    }

    const dbTrades = listClosedTrades(dbConn, {
      botType: BOT_TYPE_LIVE,
      fromMs: fromDateMs,
      signalKinds: LIVE_SIGNAL_KINDS,
    });

    let merged = [...currentById.values()];
    for (const trade of dbTrades) {
      if (!currentById.has(trade.id)) merged.push(normalizeTrade(trade));
    }

    merged = merged
      .filter((t) => {
        const closedAt = Number(t.closedAt) || 0;
        return fromDateMs == null ? true : closedAt >= fromDateMs;
      })
      .sort((a, b) => (Number(b.closedAt) || 0) - (Number(a.closedAt) || 0));

    let auditError = null;
    const needAudit = merged.filter((trade) => !hasExchangeAudit(trade));
    if (needAudit.length && credentials.enabled) {
      try {
        const enriched = await enrichTradesWithExchangeAudit(needAudit, credentials);
        const byId = new Map(enriched.map((trade) => [trade.id, normalizeTrade(trade)]));
        merged = merged.map((trade) => byId.get(trade.id) ?? trade);
        for (const trade of enriched) {
          if (!trade?.id) continue;
          upsertClosedTrade(dbConn, BOT_TYPE_LIVE, normalizeTrade(trade));
        }
      } catch (e) {
        auditError = e.message || String(e);
      }
    }

    return {
      enabled: true,
      exchangeAuditEnabled: credentials.enabled,
      exchangeAuditError: auditError,
      updatedAt: formatIsoUtcPlus3(Date.now()),
      fromDate: fromDateMs != null ? formatIsoUtcPlus3(fromDateMs) : null,
      summary: buildSummary(merged),
      byHour: buildPnlSeries(merged, hourKeyUtcPlus3, "netPnl"),
      byDay: buildPnlSeries(merged, dayKeyUtcPlus3, "netPnl"),
      trades: merged,
    };
  }

  return { appendTrade, removeTradeIds, clear, list };
}

module.exports = {
  createLiveBotHistoryStore,
  writeLiveClosedTrade,
  dayKeyUtcPlus3,
  isArchivableBotTrade,
  buildEpisodesFromTrades,
  normalizeTradeFill,
};
