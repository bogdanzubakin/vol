const {
  normalizeConfig,
  stopLossPrice,
  takeProfitPrice,
  entryBasedStopPrice,
  moveStopAfterAddOn,
  movePctFromEntry,
  normalizeOpenPosition,
  shouldCloseFalseSpike,
} = require("./paper-bot");

function unrealizedFor(pos, mark) {
  if (!Number.isFinite(mark)) return 0;
  return pos.quantity * (mark - pos.entryPrice);
}

function pickSignalSnapshot(metrics) {
  if (!metrics || typeof metrics !== "object") return null;
  const snap = {
    corridorWidthPct: metrics.corridorWidthPct,
    aboveCorridorCount: metrics.aboveCorridorCount,
    minAboveCorridorCandles: metrics.minAboveCorridorCandles,
    breakVolumeRatio: metrics.breakVolumeRatio,
    minBreakVolumeMultiplier: metrics.minBreakVolumeMultiplier,
    rangeRatio: metrics.rangeRatio,
    recentRangePct: metrics.recentRangePct,
    bullishCount: metrics.bullishCount,
    minBullishCandles: metrics.minBullishCandles,
    breaksCorridor: metrics.breaksCorridor,
    nearBreak: metrics.nearBreak,
    breakGapPct: metrics.breakGapPct,
  };
  const hasValue = Object.values(snap).some((v) => v !== undefined && v !== null);
  return hasValue ? snap : null;
}

/**
 * In-memory paper bot for backtests (shared balance across symbols).
 */
function createPaperBotSimulator(botConfig) {
  const config = normalizeConfig({ ...botConfig, enabled: true });
  const initialDeposit = config.initialDeposit;

  const state = {
    config,
    balance: initialDeposit,
    openPositions: [],
    closedTrades: [],
    events: [],
    stats: {
      signalsOpened: 0,
      spikeSignals: 0,
      fcSignals: 0,
      skippedOpen: 0,
    },
  };

  function pushEvent(type, symbol, detail, atMs) {
    state.events.push({ type, symbol, detail, at: atMs });
    if (state.events.length > 5000) state.events.shift();
  }

  function lockedMargin() {
    return state.openPositions.reduce((s, p) => s + (p.margin ?? 0), 0);
  }

  function summarize() {
    let unrealized = 0;
    for (const p of state.openPositions) {
      normalizeOpenPosition(p);
      const mark = p.lastPrice;
      unrealized += Number.isFinite(mark)
        ? unrealizedFor(p, mark)
        : p.unrealizedPnl ?? 0;
    }
    const locked = lockedMargin();
    const cash = state.balance;
    const realized = state.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const equity = cash + locked + unrealized;
    return {
      initialDeposit,
      deposit: +cash.toFixed(4),
      lockedMargin: +locked.toFixed(4),
      equity: +equity.toFixed(4),
      unrealizedPnl: +unrealized.toFixed(4),
      realizedPnl: +realized.toFixed(4),
      totalPnl: +(equity - initialDeposit).toFixed(4),
      openCount: state.openPositions.length,
      closedCount: state.closedTrades.length,
      winCount: state.closedTrades.filter((t) => (t.pnl ?? 0) > 0).length,
      lossCount: state.closedTrades.filter((t) => (t.pnl ?? 0) < 0).length,
      ...state.stats,
    };
  }

  function hasOpen(symbol) {
    return state.openPositions.some((p) => p.symbol === symbol);
  }

  function tryOpen(symbol, signalKind, metrics, atMs) {
    if (!Number.isFinite(metrics?.close) || metrics.close <= 0) return false;
    if (!Number.isFinite(metrics?.corridorHigh) || metrics.corridorHigh <= 0) {
      pushEvent("SKIP", symbol, "missing corridor high", atMs);
      state.stats.skippedOpen++;
      return false;
    }
    if (hasOpen(symbol)) {
      state.stats.skippedOpen++;
      return false;
    }

    const entry = metrics.close;
    const sl = stopLossPrice(
      metrics.corridorHigh,
      config.stopLossBelowCorridorPct
    );
    const tp = takeProfitPrice(entry, config.takeProfitPct);
    if (!sl || !tp) return false;

    const margin = state.balance * (config.positionSizePct / 100);
    if (margin < 1) {
      pushEvent("SKIP", symbol, "insufficient deposit", atMs);
      state.stats.skippedOpen++;
      return false;
    }

    const quantity = margin / entry;
    state.balance -= margin;
    state.openPositions.push(
      normalizeOpenPosition({
        id: `${symbol}-${atMs}`,
        symbol,
        signalKind,
        side: "LONG",
        entryPrice: entry,
        initialEntryPrice: entry,
        quantity,
        margin,
        addCount: 0,
        corridorLow: metrics.corridorLow,
        corridorHigh: metrics.corridorHigh ?? null,
        stopLoss: sl,
        initialStopLoss: sl,
        takeProfit: tp,
        lastPrice: entry,
        peakPrice: entry,
        troughPrice: entry,
        signalSnapshot: pickSignalSnapshot(metrics),
        unrealizedPnl: 0,
        openedAt: atMs,
      })
    );
    state.stats.signalsOpened++;
    if (signalKind === "fast-corridor") state.stats.fcSignals++;
    else state.stats.spikeSignals++;
    pushEvent("OPEN", symbol, `${signalKind} @ ${entry.toFixed(6)}`, atMs);
    return true;
  }

  function onSpikeSignal(symbol, metrics, atMs) {
    if (!config.tradeSpikeSignals) return;
    tryOpen(symbol, "spike", metrics, atMs);
  }

  function onFastCorridorSignal(symbol, metrics, atMs) {
    if (!config.tradeFastCorridorSignals) return;
    tryOpen(symbol, "fast-corridor", metrics, atMs);
  }

  function tryAddToPosition(pos, bar) {
    if (!config.addOnEnabled) return false;
    const price = bar.high ?? bar.close;
    normalizeOpenPosition(pos);
    if (pos.addCount >= config.addOnMaxAdds) return false;

    const movePct = movePctFromEntry(price, pos.initialEntryPrice);
    if (movePct == null || movePct < 0) return false;

    const nextLevel = (pos.addCount + 1) * config.addOnMovePct;
    if (movePct < nextLevel) return false;

    const addMargin = state.balance * (config.addOnDepositPct / 100);
    if (addMargin < 1) return false;

    const addQty = addMargin / price;
    const oldQty = pos.quantity;
    pos.quantity = oldQty + addQty;
    pos.entryPrice =
      (pos.entryPrice * oldQty + price * addQty) / pos.quantity;
    pos.margin += addMargin;
    pos.addCount += 1;
    state.balance -= addMargin;
    pushEvent("ADD", pos.symbol, `+${config.addOnDepositPct}% @ ${price.toFixed(6)} · avg ${pos.entryPrice.toFixed(6)}`, bar.closeTime);
    const slMove = moveStopAfterAddOn(pos, config.moveStopOffsetPct);
    if (slMove) {
      pushEvent(
        "MOVE_SL",
        pos.symbol,
        `→ ${slMove.targetSl.toFixed(6)} (avg entry ${pos.entryPrice.toFixed(6)})`,
        bar.closeTime
      );
    }
    return true;
  }

  function tryMoveStopLoss(pos, bar) {
    if (!config.moveStopEnabled) return false;
    const price = bar.high ?? bar.close;
    normalizeOpenPosition(pos);

    const movePct = movePctFromEntry(price, pos.initialEntryPrice);
    if (movePct == null || movePct < config.moveStopAfterMovePct) return false;

    const targetSl = entryBasedStopPrice(
      pos.initialEntryPrice,
      config.moveStopOffsetPct
    );
    if (!Number.isFinite(targetSl) || targetSl <= pos.stopLoss) return false;

    pos.stopLoss = targetSl;
    pushEvent("MOVE_SL", pos.symbol, `→ ${targetSl.toFixed(6)}`, bar.closeTime);
    return true;
  }

  function pctDist(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
    return +(((to - from) / from) * 100).toFixed(4);
  }

  function closePosition(pos, exitPrice, reason, atMs) {
    normalizeOpenPosition(pos);
    const pnl = pos.quantity * (exitPrice - pos.entryPrice);
    const pnlPct = pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
    state.balance += pos.margin + pnl;
    const initialEntry = pos.initialEntryPrice ?? pos.entryPrice;
    const corridorHigh = pos.corridorHigh;
    state.closedTrades.push({
      id: pos.id,
      symbol: pos.symbol,
      signalKind: pos.signalKind,
      side: pos.side ?? "LONG",
      entryPrice: pos.entryPrice,
      initialEntryPrice: initialEntry,
      exitPrice,
      quantity: pos.quantity,
      margin: pos.margin,
      addCount: pos.addCount ?? 0,
      corridorLow: pos.corridorLow,
      corridorHigh,
      stopLoss: pos.stopLoss,
      initialStopLoss: pos.initialStopLoss ?? pos.stopLoss,
      stopMoved:
        pos.initialStopLoss != null &&
        Math.abs((pos.stopLoss ?? 0) - pos.initialStopLoss) > 1e-10,
      takeProfit: pos.takeProfit,
      pnl: +pnl.toFixed(4),
      pnlPct: +pnlPct.toFixed(2),
      exitReason: reason,
      openedAt: pos.openedAt,
      closedAt: atMs,
      movePctAtExit: +(movePctFromEntry(exitPrice, initialEntry) ?? 0).toFixed(3),
      peakMovePct: +(movePctFromEntry(pos.peakPrice ?? exitPrice, initialEntry) ?? 0).toFixed(3),
      troughMovePct: +(movePctFromEntry(pos.troughPrice ?? exitPrice, initialEntry) ?? 0).toFixed(3),
      corridorWidthPct:
        corridorHigh != null && pos.corridorLow != null && pos.corridorLow > 0
          ? +(((corridorHigh - pos.corridorLow) / pos.corridorLow) * 100).toFixed(4)
          : null,
      entryAboveCorridorPct: pctDist(corridorHigh, initialEntry),
      slDistancePct: pctDist(initialEntry, pos.stopLoss),
      tpDistancePct: pctDist(initialEntry, pos.takeProfit),
      signalSnapshot: pos.signalSnapshot ?? null,
    });
    pushEvent("CLOSE", pos.symbol, `${reason} ${fmtPnl(pnl)}`, atMs);
    return true;
  }

  function fmtPnl(pnl) {
    const sign = pnl >= 0 ? "+" : "";
    return `${sign}$${pnl.toFixed(2)}`;
  }

  function processBar(symbol, bar) {
    const idx = state.openPositions.findIndex((p) => p.symbol === symbol);
    if (idx < 0) return;

    const pos = state.openPositions[idx];
    const close = bar.close;
    const low = bar.low ?? close;
    const high = bar.high ?? close;

    pos.lastPrice = close;
    if (Number.isFinite(high)) {
      pos.peakPrice = Math.max(pos.peakPrice ?? high, high);
    }
    if (Number.isFinite(low)) {
      pos.troughPrice = Math.min(pos.troughPrice ?? low, low);
    }
    pos.movePctFromEntry = +(
      movePctFromEntry(close, pos.initialEntryPrice) ?? 0
    ).toFixed(3);
    pos.unrealizedPnl = +unrealizedFor(pos, close).toFixed(4);

    tryAddToPosition(pos, bar);
    tryMoveStopLoss(pos, bar);

    if (shouldCloseFalseSpike(pos, close, config, bar.closeTime)) {
      closePosition(pos, close, "false_spike", bar.closeTime);
      state.openPositions.splice(idx, 1);
      return;
    }

    if (Number.isFinite(low) && low <= pos.stopLoss) {
      closePosition(pos, pos.stopLoss, "stop_loss", bar.closeTime);
      state.openPositions.splice(idx, 1);
      return;
    }
    if (Number.isFinite(high) && high >= pos.takeProfit) {
      closePosition(pos, pos.takeProfit, "take_profit", bar.closeTime);
      state.openPositions.splice(idx, 1);
    }
  }

  function closeAllAtBar(bar, reason = "backtest_end") {
    const open = [...state.openPositions];
    for (const pos of open) {
      closePosition(pos, bar.close, reason, bar.closeTime);
    }
    state.openPositions.length = 0;
  }

  return {
    getSummary: summarize,
    getState: () => ({
      config: state.config,
      summary: summarize(),
      openPositions: [...state.openPositions],
      closedTrades: [...state.closedTrades],
      events: [...state.events],
    }),
    onSpikeSignal,
    onFastCorridorSignal,
    processBar,
    hasOpen,
    closeAllAtBar,
  };
}

module.exports = { createPaperBotSimulator };
