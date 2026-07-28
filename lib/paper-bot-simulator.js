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
const { processFoiVwapTrail } = require("./foi-vwap-trail");
const {
  seedPositionExitContext,
  tickBarProgress,
  postEntryBarExtremes,
  evaluateEarlyAbort,
  processRunnerPhase,
  stopPricesCloseEnough,
} = require("./paper-bot-position-exits");
const { evaluateAiEarlyExit } = require("./early-exit-model");
const { trackExitPathOnBar, summarizeTradeExitPath } = require("./early-exit-path-oracle");
const { evaluateSfpRegimeGate } = require("./sfp-regime-model");
const { evaluatePullbackRegimeGate } = require("./pullback-regime-model");
const { evaluatePullbackPatternBreakGate } = require("./pullback-pattern-break-model");
const { evaluatePullbackEarlyInvalidation } = require("./pullback-early-invalidation");
const { evaluatePullbackSignalGate } = require("./pullback-signal-model");
const { recordSfpTradeStats, tradeStatsRowForSymbol } = require("./sfp-regime-features");
const {
  recordPullbackTradeStats,
  tradeStatsRowForSymbol: pullbackTradeStatsRow,
} = require("./pullback-regime-features");
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
const {
  createFoiFollowthroughRegimeTracker,
  isFoiSignalKind,
  applyFoiHotTpProtect,
} = require("./foi-followthrough-regime");
const { foiUtcHourAllows } = require("./foi-signal");
const { foiBtcLookalikeAllows } = require("./foi-btc-lookalike");
const { createFoiColdDayTracker } = require("./foi-cold-day-regime");
const { createFoiMiddayColdPauseTracker } = require("./foi-midday-cold-pause");

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
  const getFundingOiAt = options.getFundingOiAt;
  const tradeStatsMap = options.tradeStatsMap ?? null;
  /** AI model scope for every model evaluation in this backtest (defaults to paper). */
  const MODEL_SCOPE = options.modelScope === "live" ? "live" : "paper";
  const config = normalizeConfig({ ...botConfig, enabled: true });
  const initialDeposit = config.initialDeposit;
  const foiFollowthroughTracker =
    options.foiFollowthroughTracker ?? createFoiFollowthroughRegimeTracker();
  const foiColdDayTracker =
    options.foiColdDayTracker ?? createFoiColdDayTracker();
  const foiMiddayColdPauseTracker =
    options.foiMiddayColdPauseTracker ?? createFoiMiddayColdPauseTracker();

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
      pullbackBearSignals: 0,
      foiSignals: 0,
      foiBearSignals: 0,
      falseBreakoutSignals: 0,
      falseBreakoutBearSignals: 0,
      skippedOpen: 0,
      foiFollowthroughSkips: 0,
      foiUtcHourSkips: 0,
      foiHotTpProtects: 0,
      foiBtcLookalikeSkips: 0,
      foiColdDaySkips: 0,
      foiMiddayColdPauseSkips: 0,
      foiSizeScaledOpens: 0,
      sfpRegimeSkips: 0,
      sfpRegimeSkipsBull: 0,
      sfpRegimeSkipsBear: 0,
      pullbackRegimeSkips: 0,
      pullbackRegimeSkipsBull: 0,
      pullbackRegimeSkipsBear: 0,
      pullbackPatternBreakSkips: 0,
      pullbackPatternBreakSkipsBull: 0,
      pullbackPatternBreakSkipsBear: 0,
      pullbackSignalSkips: 0,
      pullbackSignalSkipsBull: 0,
      pullbackSignalSkipsBear: 0,
      pbEarlyInvalidationExits: 0,
      pbEarlyInvalidationExitsInv: 0,
      pbEarlyInvalidationExitsAdverse: 0,
      aiExitLevelsRejects: 0,
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

    let sizeScale = 1;

    if (isFoiSignalKind(signalKind) && config.foiFollowthroughRegimeEnabled) {
      const ftGate = foiFollowthroughTracker.check(config, atMs);
      if (!ftGate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          ftGate.detail
            ? `FOI follow-through: ${ftGate.detail}`
            : "FOI follow-through: cold",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.foiFollowthroughSkips =
          (state.stats.foiFollowthroughSkips || 0) + 1;
        return false;
      }
      sizeScale = Math.min(sizeScale, ftGate.sizeScale || 1);
    }

    if (isFoiSignalKind(signalKind) && config.foiColdDayEnabled) {
      const coldGate = foiColdDayTracker.check(config, atMs);
      if (!coldGate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          coldGate.detail ? `FOI cold-day: ${coldGate.detail}` : "FOI cold-day",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.foiColdDaySkips = (state.stats.foiColdDaySkips || 0) + 1;
        return false;
      }
      sizeScale = Math.min(sizeScale, coldGate.sizeScale || 1);
    }

    if (isFoiSignalKind(signalKind) && config.foiMiddayColdPauseEnabled) {
      const midGate = foiMiddayColdPauseTracker.check(config, atMs);
      if (!midGate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          midGate.detail
            ? `FOI mid-day cold pause: ${midGate.detail}`
            : "FOI mid-day cold pause",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.foiMiddayColdPauseSkips =
          (state.stats.foiMiddayColdPauseSkips || 0) + 1;
        return false;
      }
      sizeScale = Math.min(sizeScale, midGate.sizeScale || 1);
    }

    if (isFoiSignalKind(signalKind) && config.foiBtcLookalikeEnabled) {
      const look = foiBtcLookalikeAllows(config, {
        symbol,
        asOfMs: atMs,
        getBarsForSymbol: (sym) =>
          getBarsForRegime?.(sym, atMs) ??
          getRecentBars?.(sym, atMs, 400) ??
          [],
        getBtcBars: () => getBtcBarsForRegime?.(atMs) ?? [],
      });
      if (!look.ok) {
        pushEvent("SKIP", symbol, look.detail || "FOI BTC lookalike", atMs);
        state.stats.skippedOpen++;
        state.stats.foiBtcLookalikeSkips =
          (state.stats.foiBtcLookalikeSkips || 0) + 1;
        return false;
      }
    }

    if (isFoiSignalKind(signalKind)) {
      const utcGate = foiUtcHourAllows(config, atMs);
      if (!utcGate.ok) {
        pushEvent(
          "SKIP",
          symbol,
          `FOI blocked UTC hour ${utcGate.hour}`,
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.foiUtcHourSkips = (state.stats.foiUtcHourSkips || 0) + 1;
        return false;
      }
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
        symbol,
        tradeStats: tradeStatsRowForSymbol(tradeStatsMap, symbol),
        btcBars: getBtcBarsForRegime?.(atMs) ?? [],
        asOf: atMs,
        modelScope: MODEL_SCOPE,
        getFundingOiAt,
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
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      config.aiPullbackRegimeEnabled
    ) {
      const bars =
        getBarsForRegime?.(symbol, atMs) ??
        getRecentBars?.(symbol, atMs, 120) ??
        [];
      const gate = evaluatePullbackRegimeGate(config, bars, {
        metrics,
        signalKind,
        tradeStats: pullbackTradeStatsRow(tradeStatsMap, symbol),
        btcBars: getBtcBarsForRegime?.(atMs) ?? [],
        asOf: atMs,
        modelScope: MODEL_SCOPE,
      });
      if (!gate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          gate.detail
            ? `Pullback regime: ${gate.detail}`
            : "Pullback regime: bad conditions",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.pullbackRegimeSkips++;
        if (signalKind === "pullback_bear") state.stats.pullbackRegimeSkipsBear++;
        else state.stats.pullbackRegimeSkipsBull++;
        return false;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      config.aiPullbackPatternBreakEnabled
    ) {
      const bars =
        getBarsForRegime?.(symbol, atMs) ??
        getRecentBars?.(symbol, atMs, 120) ??
        [];
      const gate = evaluatePullbackPatternBreakGate(config, bars, {
        metrics,
        signalKind,
        tradeStats: pullbackTradeStatsRow(tradeStatsMap, symbol),
        btcBars: getBtcBarsForRegime?.(atMs) ?? [],
        asOf: atMs,
        modelScope: MODEL_SCOPE,
      });
      if (!gate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          gate.detail
            ? `Pullback pattern break: ${gate.detail}`
            : "Pullback pattern break: setup invalidated",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.pullbackPatternBreakSkips++;
        if (signalKind === "pullback_bear") state.stats.pullbackPatternBreakSkipsBear++;
        else state.stats.pullbackPatternBreakSkipsBull++;
        return false;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      config.aiPullbackSignalEnabled
    ) {
      const bars =
        getBarsForRegime?.(symbol, atMs) ??
        getRecentBars?.(symbol, atMs, 120) ??
        [];
      const gate = evaluatePullbackSignalGate(config, bars, {
        metrics,
        signalKind,
        symbol,
        tradeStats: pullbackTradeStatsRow(tradeStatsMap, symbol),
        btcBars: getBtcBarsForRegime?.(atMs) ?? [],
        asOf: atMs,
        modelScope: MODEL_SCOPE,
        getFundingOiAt,
      });
      if (!gate.pass) {
        pushEvent(
          "SKIP",
          symbol,
          gate.detail
            ? `Pullback signal AI: ${gate.detail}`
            : "Pullback signal AI: weak setup",
          atMs
        );
        state.stats.skippedOpen++;
        state.stats.pullbackSignalSkips++;
        if (signalKind === "pullback_bear") state.stats.pullbackSignalSkipsBear++;
        else state.stats.pullbackSignalSkipsBull++;
        return false;
      }
    }

    const entry = metrics.close;
    let exits = resolveExitLevels(signalKind, metrics, entry, config, {
      mark: entry,
      modelScope: MODEL_SCOPE,
    });
    const short = require("./side-config").isBearSignal(signalKind);
    exits = applyFoiHotTpProtect(exits, {
      signalKind,
      entry,
      short,
      cfg: config,
      tracker: foiFollowthroughTracker,
      asOfMs: atMs,
    });
    if (exits?.foiHotTpScaled) {
      state.stats.foiHotTpProtects = (state.stats.foiHotTpProtects || 0) + 1;
    }
    const { stopLoss: sl, takeProfit: tp, rejectReason } = exits;
    if (rejectReason) {
      pushEvent("SKIP", symbol, rejectReason, atMs);
      state.stats.skippedOpen++;
      state.stats.aiExitLevelsRejects++;
      return false;
    }
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

    const margin = positionMarginFromConfig(
      state.balance,
      config.positionSizeUsdt,
      1,
      isFoiSignalKind(signalKind) ? sizeScale : 1
    );
    if (!margin) {
      pushEvent("SKIP", symbol, "insufficient deposit", atMs);
      state.stats.skippedOpen++;
      return false;
    }
    if (isFoiSignalKind(signalKind) && sizeScale < 1 - 1e-9) {
      state.stats.foiSizeScaledOpens =
        (state.stats.foiSizeScaledOpens || 0) + 1;
    }

    const leverage = config.leverage;
    const quantity = (margin * leverage) / entry;
    state.balance -= margin;
    const side = short ? "SHORT" : "LONG";
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
            foiVwapTrailArmed: false,
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
    else if (signalKind === "pullback_bear") state.stats.pullbackBearSignals++;
    else if (signalKind === "foi") state.stats.foiSignals++;
    else if (signalKind === "foi_bear") state.stats.foiBearSignals++;
    else if (signalKind === "false_breakout") state.stats.falseBreakoutSignals++;
    else if (signalKind === "false_breakout_bear")
      state.stats.falseBreakoutBearSignals++;
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

  function onPullbackBearSignal(symbol, metrics, atMs) {
    if (!config.tradeBearishPullbackSignals) return;
    tryOpen(symbol, "pullback_bear", metrics, atMs);
  }

  function onFoiSignal(symbol, metrics, atMs) {
    if (!config.tradeFoiSignals) return;
    tryOpen(symbol, "foi", metrics, atMs);
  }

  function onFoiBearSignal(symbol, metrics, atMs) {
    if (!config.tradeBearishFoiSignals) return;
    tryOpen(symbol, "foi_bear", metrics, atMs);
  }

  function onFalseBreakoutSignal(symbol, metrics, atMs) {
    if (!config.tradeFalseBreakoutSignals) return;
    tryOpen(symbol, "false_breakout", metrics, atMs);
  }

  function onFalseBreakoutBearSignal(symbol, metrics, atMs) {
    if (!config.tradeBearishFalseBreakoutSignals) return;
    tryOpen(symbol, "false_breakout_bear", metrics, atMs);
  }

  function onObiSignal(symbol, metrics, atMs) {
    if (!config.tradeObiSignals) return;
    tryOpen(symbol, "obi", metrics, atMs);
  }

  function onObiBearSignal(symbol, metrics, atMs) {
    if (!config.tradeBearishObiSignals) return;
    tryOpen(symbol, "obi_bear", metrics, atMs);
  }

  function onTapeSignal(symbol, metrics, atMs) {
    if (!config.tradeTapeSignals) return;
    tryOpen(symbol, "tape", metrics, atMs);
  }

  function onTapeBearSignal(symbol, metrics, atMs) {
    if (!config.tradeBearishTapeSignals) return;
    tryOpen(symbol, "tape_bear", metrics, atMs);
  }

  function onVwapSignal(symbol, metrics, atMs) {
    if (!config.tradeVwapSignals) return;
    tryOpen(symbol, "vwap", metrics, atMs);
  }

  function onVwapBearSignal(symbol, metrics, atMs) {
    if (!config.tradeBearishVwapSignals) return;
    tryOpen(symbol, "vwap_bear", metrics, atMs);
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
      recordPullbackTradeStats(tradeStatsMap, closed);
    }
    foiFollowthroughTracker.recordClosedTrade(
      state.closedTrades[state.closedTrades.length - 1]
    );
    foiColdDayTracker.recordClosedTrade(
      state.closedTrades[state.closedTrades.length - 1]
    );
    foiMiddayColdPauseTracker.recordClosedTrade(
      state.closedTrades[state.closedTrades.length - 1]
    );
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
    const ex = postEntryBarExtremes(pos, bar, high, low, close);

    pos.lastPrice = close;
    updatePriceExtremes(pos, ex.high, ex.low, ex.close);
    pos.movePctFromEntry = +(favorableMovePct(pos, close) ?? 0).toFixed(3);
    pos.unrealizedPnl = +unrealizedFor(pos, close).toFixed(4);
    trackExitPathOnBar(pos, bar);

    tickBarProgress(pos, bar, config);

    if (config.aiEarlyExitEnabled) {
      const recentBars = getRecentBars?.(symbol, bar.closeTime, 12) ?? [];
      const aiExit = evaluateAiEarlyExit(config, pos, bar, {
        recentBars,
        modelScope: MODEL_SCOPE,
      });
      if (aiExit) {
        pushEvent("CLOSE", pos.symbol, `${aiExit.reason} ${aiExit.detail}`, bar.closeTime);
        closePosition(pos, aiExit.exitPrice, aiExit.reason, bar.closeTime);
        state.openPositions.splice(idx, 1);
        return;
      }
    }

    const early = evaluateEarlyAbort(config, pos, bar);
    if (early) {
      pushEvent("CLOSE", pos.symbol, `${early.reason} ${early.detail}`, bar.closeTime);
      closePosition(pos, early.exitPrice, early.reason, bar.closeTime);
      state.openPositions.splice(idx, 1);
      return;
    }

    const pbEarly = evaluatePullbackEarlyInvalidation(config, pos, bar);
    if (pbEarly) {
      pushEvent("CLOSE", pos.symbol, `${pbEarly.reason} ${pbEarly.detail}`, bar.closeTime);
      closePosition(pos, pbEarly.exitPrice, pbEarly.reason, bar.closeTime);
      state.stats.pbEarlyInvalidationExits++;
      if (pbEarly.reason === "early_invalidation") state.stats.pbEarlyInvalidationExitsInv++;
      if (pbEarly.reason === "early_adverse") state.stats.pbEarlyInvalidationExitsAdverse++;
      state.openPositions.splice(idx, 1);
      return;
    }

    tryMoveStopLoss(pos, bar);
    tryAddToPosition(pos, bar);

    {
      const trailBars = getBarsForRegime?.(symbol, bar.closeTime) ?? [];
      const favPrice = isShort(pos)
        ? Number.isFinite(ex.low)
          ? ex.low
          : close
        : Number.isFinite(ex.high)
          ? ex.high
          : close;
      const vwapTrail = processFoiVwapTrail({
        cfg: config,
        pos,
        bars: Array.isArray(trailBars) ? trailBars : [],
        favPrice,
      });
      if (vwapTrail.trailed) {
        pushEvent(
          "MOVE_SL",
          pos.symbol,
          vwapTrail.detail || "FOI VWAP trail",
          bar.closeTime
        );
      }
    }

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

    if (stopLossHit(ex, pos)) {
      const trailedVwap =
        Boolean(pos.foiVwapTrailArmed) &&
        pos.initialStopLoss != null &&
        Math.abs((pos.stopLoss ?? 0) - pos.initialStopLoss) > 1e-10;
      closePosition(
        pos,
        pos.stopLoss,
        trailedVwap ? "foi_vwap_trail" : "stop_loss",
        bar.closeTime
      );
      state.openPositions.splice(idx, 1);
      return;
    }
    if (!pos.runnerMode && takeProfitHit(ex, pos)) {
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
    onPullbackBearSignal,
    onFoiSignal,
    onFoiBearSignal,
    onFalseBreakoutSignal,
    onFalseBreakoutBearSignal,
    onObiSignal,
    onObiBearSignal,
    onTapeSignal,
    onTapeBearSignal,
    onVwapSignal,
    onVwapBearSignal,
    processBar,
    hasOpen,
    closeAllAtBar,
  };
}

module.exports = { createPaperBotSimulator };
