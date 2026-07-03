const {
  normalizeConfig,
  stopLossPrice,
  takeProfitPrice,
  resolveInitialStopLoss,
  entryBasedStopPrice,
  entryBasedStopPriceShort,
  moveStopAfterAddOn,
  takeProfitAfterAddOn,
  longTakeProfitHit,
  movePctFromEntry,
  normalizeOpenPosition,
  positionMarginFromConfig,
  nextLeverageAfterAddOn,
  addOnEntryAllowed,
} = require("./paper-bot");
const {
  seedPositionExitContext,
  tickBarProgress,
  evaluateEarlyAbort,
  processRunnerPhase,
  stopPricesCloseEnough,
} = require("./paper-bot-position-exits");
const { evaluateAiEarlyExit } = require("./early-exit-model");
const { trackExitPathOnBar, summarizeTradeExitPath } = require("./early-exit-path-oracle");
const { evaluateSfpRegimeGate } = require("./sfp-regime-model");
const { evaluateLevelBreakRegimeGate } = require("./level-break-regime-model");
const { evaluateLevelBreakSignalGate } = require("./level-break-signal-model");
const { recordSfpTradeStats, tradeStatsRowForSymbol } = require("./sfp-regime-features");
const {
  recordLevelBreakTradeStats,
  tradeStatsRowForSymbol: levelBreakTradeStatsRow,
} = require("./level-break-regime-features");
const { resolveExitLevels } = require("./signal-exit-levels");
const { evaluateEntryQuality } = require("./entry-quality-gate");
const {
  isShort,
  favorableMovePct,
  positionPnl,
  stopLossHit,
  takeProfitHit,
  updatePriceExtremes,
  peakMovePct,
  adverseMovePct,
} = require("./position-side");
const {
  isSymbolBlocked,
  recordTradeForSymbolBlocklist,
} = require("./bot-symbol-blocklist");
const { pickSignalSnapshot } = require("./signal-snapshot");

function unrealizedFor(pos, mark) {
  return positionPnl(pos, mark);
}

/**
 * In-memory paper bot for backtests (shared balance across symbols).
 */
function createPaperBotSimulator(botConfig, options = {}) {
  const maxEvents = options.maxEvents ?? 5000;
  const getRecentBars = options.getRecentBars;
  const getBarsForRegime = options.getBarsForRegime;
  const getBtcBarsForRegime = options.getBtcBarsForRegime;
  const tradeStatsMap = options.tradeStatsMap ?? null;
  const config = normalizeConfig({ ...botConfig, enabled: true });
  const initialDeposit = config.initialDeposit;

  const state = {
    config,
    balance: initialDeposit,
    openPositions: [],
    closedTrades: [],
    events: [],
    symbolSlStreak: {},
    stats: {
      signalsOpened: 0,
      sfpSignals: 0,
      sfpBearSignals: 0,
      pullbackSignals: 0,
      levelBreakSignals: 0,
      levelBreakBearSignals: 0,
      skippedOpen: 0,
      sfpRegimeSkips: 0,
      sfpRegimeSkipsBull: 0,
      sfpRegimeSkipsBear: 0,
      levelBreakRegimeSkips: 0,
      levelBreakRegimeSkipsBull: 0,
      levelBreakRegimeSkipsBear: 0,
      levelBreakSignalSkips: 0,
      levelBreakSignalSkipsBull: 0,
      levelBreakSignalSkipsBear: 0,
    },
  };

  function pushEvent(type, symbol, detail, atMs) {
    state.events.push({ type, symbol, detail, at: atMs });
    if (maxEvents > 0 && state.events.length > maxEvents) state.events.shift();
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
    if (!Number.isFinite(metrics?.corridorLow) || metrics.corridorLow <= 0) {
      pushEvent("SKIP", symbol, "missing corridor low", atMs);
      state.stats.skippedOpen++;
      return false;
    }
    if (hasOpen(symbol)) {
      state.stats.skippedOpen++;
      return false;
    }
    if (isSymbolBlocked(symbol, config.blockedSymbols)) {
      pushEvent("SKIP", symbol, "symbol blocked", atMs);
      state.stats.skippedOpen++;
      return false;
    }

    if (
      (signalKind === "sfp" || signalKind === "sfp_bear") &&
      config.aiSfpRegimeEnabled
    ) {
      const bars =
        getBarsForRegime?.(symbol, atMs) ??
        getRecentBars?.(symbol, atMs, 120) ??
        [];
      const gate = evaluateSfpRegimeGate(config, bars, {
        metrics,
        signalKind,
        tradeStats: tradeStatsRowForSymbol(tradeStatsMap, symbol),
        btcBars: getBtcBarsForRegime?.(atMs) ?? [],
        asOf: atMs,
      });
      if (!gate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          gate.detail ? `SFP regime: ${gate.detail}` : "SFP regime: bad conditions",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.sfpRegimeSkips++;
        if (signalKind === "sfp_bear") state.stats.sfpRegimeSkipsBear++;
        else state.stats.sfpRegimeSkipsBull++;
        return false;
      }
    }

    if (
      (signalKind === "level_break" || signalKind === "level_break_bear") &&
      config.aiLevelBreakRegimeEnabled
    ) {
      const bars =
        getBarsForRegime?.(symbol, atMs) ??
        getRecentBars?.(symbol, atMs, 120) ??
        [];
      const gate = evaluateLevelBreakRegimeGate(config, bars, {
        metrics,
        signalKind,
        tradeStats: levelBreakTradeStatsRow(tradeStatsMap, symbol),
        btcBars: getBtcBarsForRegime?.(atMs) ?? [],
        asOf: atMs,
      });
      if (!gate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          gate.detail
            ? `Level-break regime: ${gate.detail}`
            : "Level-break regime: bad conditions",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.levelBreakRegimeSkips++;
        if (signalKind === "level_break_bear") state.stats.levelBreakRegimeSkipsBear++;
        else state.stats.levelBreakRegimeSkipsBull++;
        return false;
      }
    }

    if (
      (signalKind === "level_break" || signalKind === "level_break_bear") &&
      config.aiLevelBreakSignalEnabled
    ) {
      const bars =
        getBarsForRegime?.(symbol, atMs) ??
        getRecentBars?.(symbol, atMs, 120) ??
        [];
      const gate = evaluateLevelBreakSignalGate(config, bars, {
        metrics,
        signalKind,
        tradeStats: levelBreakTradeStatsRow(tradeStatsMap, symbol),
        btcBars: getBtcBarsForRegime?.(atMs) ?? [],
        asOf: atMs,
      });
      if (!gate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          gate.detail
            ? `Level-break signal AI: ${gate.detail}`
            : "Level-break signal AI: weak setup",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.levelBreakSignalSkips++;
        if (signalKind === "level_break_bear") state.stats.levelBreakSignalSkipsBear++;
        else state.stats.levelBreakSignalSkipsBull++;
        return false;
      }
    }

    const entry = metrics.close;
    const exits = resolveExitLevels(signalKind, metrics, entry, config, {
      mark: entry,
    });
    const { stopLoss: sl, takeProfit: tp } = exits;
    if (!sl || !tp) return false;

    const quality = evaluateEntryQuality(
      signalKind,
      metrics,
      entry,
      sl,
      tp,
      config
    );
    if (!quality.pass) {
      pushEvent("SKIP", symbol, quality.detail || "entry quality", atMs);
      state.stats.skippedOpen++;
      return false;
    }

    const margin = positionMarginFromConfig(state.balance, config.positionSizeUsdt);
    if (!margin) {
      pushEvent("SKIP", symbol, "insufficient deposit", atMs);
      state.stats.skippedOpen++;
      return false;
    }

    const leverage = config.leverage;
    const quantity = (margin * leverage) / entry;
    state.balance -= margin;
    const side =
      signalKind === "sfp_bear" || signalKind === "level_break_bear"
        ? "SHORT"
        : "LONG";
    state.openPositions.push(
      normalizeOpenPosition(
        seedPositionExitContext(
          {
            id: `${symbol}-${atMs}`,
            symbol,
            signalKind,
            side,
            entryPrice: entry,
            initialEntryPrice: entry,
            quantity,
            margin,
            leverage,
            addCount: 0,
            corridorLow: metrics.corridorLow,
            corridorHigh: metrics.corridorHigh ?? null,
            sweepLow: metrics.sweepLow ?? null,
            sweepHigh: metrics.sweepHigh ?? null,
            levelPrice: metrics.levelPrice ?? null,
            stopLoss: sl,
            initialStopLoss: sl,
            takeProfit: tp,
            exitMethod: exits.exitMethod ?? null,
            aiSlPct: exits.aiSlPct ?? null,
            aiTpPct: exits.aiTpPct ?? null,
            lastPrice: entry,
            peakPrice: entry,
            troughPrice: entry,
            signalSnapshot: pickSignalSnapshot(metrics),
            unrealizedPnl: 0,
            openedAt: atMs,
          },
          metrics
        )
      )
    );
    state.stats.signalsOpened++;
    if (signalKind === "sfp") state.stats.sfpSignals++;
    else if (signalKind === "sfp_bear") state.stats.sfpBearSignals++;
    else if (signalKind === "pullback") state.stats.pullbackSignals++;
    else if (signalKind === "level_break") state.stats.levelBreakSignals++;
    else if (signalKind === "level_break_bear") state.stats.levelBreakBearSignals++;
    pushEvent("OPEN", symbol, `${side} ${signalKind} @ ${entry.toFixed(6)}`, atMs);
    return true;
  }

  function onSfpSignal(symbol, metrics, atMs) {
    if (!config.tradeSfpSignals) return;
    tryOpen(symbol, "sfp", metrics, atMs);
  }

  function onSfpBearSignal(symbol, metrics, atMs) {
    if (!config.tradeBearishSfpSignals) return;
    tryOpen(symbol, "sfp_bear", metrics, atMs);
  }

  function onPullbackSignal(symbol, metrics, atMs) {
    if (!config.tradePullbackSignals) return;
    tryOpen(symbol, "pullback", metrics, atMs);
  }

  function onLevelBreakSignal(symbol, metrics, atMs) {
    if (!config.tradeLevelBreakSignals) return;
    tryOpen(symbol, "level_break", metrics, atMs);
  }

  function onLevelBreakBearSignal(symbol, metrics, atMs) {
    if (!config.tradeLevelBreakBearSignals) return;
    tryOpen(symbol, "level_break_bear", metrics, atMs);
  }

  function tryAddToPosition(pos, bar) {
    const price = isShort(pos) ? (bar.low ?? bar.close) : (bar.high ?? bar.close);
    const gate = addOnEntryAllowed(config, pos, price);
    if (!gate.ok) return false;

    const newLeverage = nextLeverageAfterAddOn(pos.leverage, config.addOnLeverageBoost);
    const addMargin = positionMarginFromConfig(state.balance, config.addOnMarginUsdt);
    if (!addMargin) return false;

    const addQty = (addMargin * newLeverage) / price;
    const oldQty = pos.quantity;
    pos.quantity = oldQty + addQty;
    pos.entryPrice =
      (pos.entryPrice * oldQty + price * addQty) / pos.quantity;
    pos.margin += addMargin;
    pos.leverage = newLeverage;
    pos.addCount = 1;
    state.balance -= addMargin;
    pushEvent(
      "ADD",
      pos.symbol,
      `+$${addMargin.toFixed(2)} @ ${newLeverage}x @ ${price.toFixed(6)} · avg ${pos.entryPrice.toFixed(6)}`,
      bar.closeTime
    );
    const slMove = moveStopAfterAddOn(pos, config.moveStopOffsetPct);
    const tpMove = takeProfitAfterAddOn(pos, config);
    if (slMove) {
      pushEvent(
        "MOVE_SL",
        pos.symbol,
        `→ ${slMove.targetSl.toFixed(6)} (avg entry ${pos.entryPrice.toFixed(6)})`,
        bar.closeTime
      );
    }
    if (tpMove) {
      pushEvent(
        "MOVE_TP",
        pos.symbol,
        `→ ${tpMove.targetTp.toFixed(6)} (avg entry ${pos.entryPrice.toFixed(6)})`,
        bar.closeTime
      );
    }
    return true;
  }

  function tryMoveStopLoss(pos, bar) {
    if (!config.moveStopEnabled) return false;
    const price = isShort(pos) ? (bar.low ?? bar.close) : (bar.high ?? bar.close);
    normalizeOpenPosition(pos);
    if (pos.moveStopRaised) return false;

    const movePct = favorableMovePct(pos, price);
    if (movePct == null || movePct < config.moveStopAfterMovePct) return false;

    const targetSl = isShort(pos)
      ? entryBasedStopPriceShort(pos.initialEntryPrice, config.moveStopOffsetPct)
      : entryBasedStopPrice(pos.initialEntryPrice, config.moveStopOffsetPct);
    if (!Number.isFinite(targetSl)) return false;
    if (isShort(pos)) {
      if (
        targetSl >= pos.stopLoss ||
        stopPricesCloseEnough(targetSl, pos.stopLoss, pos.initialEntryPrice)
      ) {
        if (stopPricesCloseEnough(targetSl, pos.stopLoss, pos.initialEntryPrice)) {
          pos.moveStopRaised = true;
        }
        return false;
      }
    } else if (
      targetSl <= pos.stopLoss ||
      stopPricesCloseEnough(targetSl, pos.stopLoss, pos.initialEntryPrice)
    ) {
      if (stopPricesCloseEnough(targetSl, pos.stopLoss, pos.initialEntryPrice)) {
        pos.moveStopRaised = true;
      }
      return false;
    }

    pos.stopLoss = targetSl;
    pos.moveStopRaised = true;
    pushEvent("MOVE_SL", pos.symbol, `→ ${targetSl.toFixed(6)}`, bar.closeTime);
    return true;
  }

  function pctDist(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
    return +(((to - from) / from) * 100).toFixed(4);
  }

  function closePosition(pos, exitPrice, reason, atMs) {
    normalizeOpenPosition(pos);
    const pnl = positionPnl(pos, exitPrice);
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
      movePctAtExit: +(favorableMovePct(pos, exitPrice) ?? 0).toFixed(3),
      peakMovePct: +(peakMovePct(pos) ?? 0).toFixed(3),
      troughMovePct: +(adverseMovePct(pos) ?? 0).toFixed(3),
      corridorWidthPct:
        corridorHigh != null && pos.corridorLow != null && pos.corridorLow > 0
          ? +(((corridorHigh - pos.corridorLow) / pos.corridorLow) * 100).toFixed(4)
          : null,
      entryAboveCorridorPct: pctDist(corridorHigh, initialEntry),
      slDistancePct: pctDist(initialEntry, pos.stopLoss),
      tpDistancePct: pctDist(initialEntry, pos.takeProfit),
      exitMethod: pos.exitMethod ?? null,
      aiSlPct: pos.aiSlPct ?? null,
      aiTpPct: pos.aiTpPct ?? null,
      signalSnapshot: pos.signalSnapshot ?? null,
      exitPathOracle: summarizeTradeExitPath(pos, pnl),
    });
    recordTradeForSymbolBlocklist({
      trade: state.closedTrades[state.closedTrades.length - 1],
      config: state.config,
      symbolSlStreak: state.symbolSlStreak,
      onAutoBlock: (sym, n) =>
        pushEvent("BLOCK", sym, `auto-blocked after ${n} consecutive SL`, atMs),
    });
    if (tradeStatsMap) {
      const closed = state.closedTrades[state.closedTrades.length - 1];
      recordSfpTradeStats(tradeStatsMap, closed);
      recordLevelBreakTradeStats(tradeStatsMap, closed);
    }
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
    updatePriceExtremes(pos, high, low, close);
    pos.movePctFromEntry = +(favorableMovePct(pos, close) ?? 0).toFixed(3);
    pos.unrealizedPnl = +unrealizedFor(pos, close).toFixed(4);
    trackExitPathOnBar(pos, bar);

    tickBarProgress(pos, bar, config);

    const recentBars = getRecentBars?.(symbol, bar.closeTime, 12) ?? [];
    const aiExit = evaluateAiEarlyExit(config, pos, bar, { recentBars });
    if (aiExit) {
      pushEvent("CLOSE", pos.symbol, `${aiExit.reason} ${aiExit.detail}`, bar.closeTime);
      closePosition(pos, aiExit.exitPrice, aiExit.reason, bar.closeTime);
      state.openPositions.splice(idx, 1);
      return;
    }

    const early = evaluateEarlyAbort(config, pos, bar);
    if (early) {
      pushEvent("CLOSE", pos.symbol, `${early.reason} ${early.detail}`, bar.closeTime);
      closePosition(pos, early.exitPrice, early.reason, bar.closeTime);
      state.openPositions.splice(idx, 1);
      return;
    }

    tryMoveStopLoss(pos, bar);
    tryAddToPosition(pos, bar);

    const runner = processRunnerPhase(config, pos, bar);
    if (runner.activated) {
      pushEvent("RUNNER", pos.symbol, runner.detail ?? "on", bar.closeTime);
    }
    if (runner.trailedSl) {
      pushEvent(
        "MOVE_SL",
        pos.symbol,
        `runner trail → ${pos.stopLoss.toFixed(6)}`,
        bar.closeTime
      );
    }
    if (runner.exit) {
      pushEvent("CLOSE", pos.symbol, `${runner.reason} ${runner.detail}`, bar.closeTime);
      closePosition(pos, runner.exitPrice, runner.reason, bar.closeTime);
      state.openPositions.splice(idx, 1);
      return;
    }

    if (stopLossHit(bar, pos)) {
      closePosition(pos, pos.stopLoss, "stop_loss", bar.closeTime);
      state.openPositions.splice(idx, 1);
      return;
    }
    if (!pos.runnerMode && takeProfitHit(bar, pos)) {
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
    getClosedTrades: () => state.closedTrades,
    getState: () => ({
      config: state.config,
      summary: summarize(),
      openPositions: [...state.openPositions],
      closedTrades: [...state.closedTrades],
      events: [...state.events],
    }),
    onSfpSignal,
    onSfpBearSignal,
    onPullbackSignal,
    onLevelBreakSignal,
    onLevelBreakBearSignal,
    processBar,
    hasOpen,
    closeAllAtBar,
  };
}

module.exports = { createPaperBotSimulator };
