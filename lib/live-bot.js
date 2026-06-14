const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { isImmediateTriggerError } = require("./binance-futures-trade");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  normalizeConfig: normalizePaperConfig,
  normalizeOpenPosition,
  positionMarginFromConfig,
  entryBasedStopPrice,
  moveStopAfterAddOn,
  movePctFromEntry,
  shouldCloseFalseSpike,
} = require("./paper-bot");
const {
  stopLossFallbackForLong,
  stopLossFallbackForLongEscalated,
  wouldLongStopMarketTrigger,
} = require("./bot-exit-prices");
const { resolveExitLevels } = require("./signal-exit-levels");
const {
  drawdownStatus,
  evaluateDrawdownStop,
} = require("./bot-drawdown-guard");

const STATE_FILE = () => dataPath("live-bot-state.json");

const LIVE_DEFAULTS = {
  leverage: 1,
  armed: false,
  maxOpenPositions: 4,
};

const MIN_MARGIN_USDT = 5;
const MAX_SL_ENSURE_ATTEMPTS = 5;
const SL_ENSURE_VERIFY_MS = 350;

function resolveMarginUsdt(available, pct) {
  const calculated = available * (pct / 100);
  return Math.max(calculated, MIN_MARGIN_USDT);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function unrealizedPnlPctFor(pos) {
  const pnl = pos?.unrealizedPnl;
  if (!Number.isFinite(pnl)) return null;
  let margin = pos.margin;
  if (!Number.isFinite(margin) || margin <= 0) {
    const lev = num(pos.leverage, 1);
    margin = (num(pos.quantity, 0) * num(pos.entryPrice, 0)) / lev;
  }
  if (!Number.isFinite(margin) || margin <= 0) return null;
  return +((pnl / margin) * 100).toFixed(2);
}

function normalizeLiveConfig(raw = {}) {
  const base = normalizePaperConfig(raw);
  return {
    ...base,
    leverage: clamp(Math.round(num(raw.leverage, LIVE_DEFAULTS.leverage)), 1, 125),
    armed: Boolean(raw.armed),
    maxOpenPositions: clamp(
      Math.round(num(raw.maxOpenPositions, LIVE_DEFAULTS.maxOpenPositions)),
      1,
      100
    ),
  };
}

function loadState() {
  const raw = readJsonFile(STATE_FILE(), null);
  if (!raw || typeof raw !== "object") {
    return {
      config: normalizeLiveConfig({ enabled: false, armed: false }),
      openPositions: [],
      closedTrades: [],
      log: [],
      drawdownBaseline: null,
      drawdownTriggeredAt: null,
    };
  }
  return {
    config: normalizeLiveConfig(raw.config),
    openPositions: Array.isArray(raw.openPositions)
      ? raw.openPositions.map((p) => normalizeOpenPosition({ ...p }))
      : [],
    closedTrades: Array.isArray(raw.closedTrades) ? raw.closedTrades : [],
    log: Array.isArray(raw.log) ? raw.log.slice(0, 200) : [],
    drawdownBaseline: raw.drawdownBaseline ?? null,
    drawdownTriggeredAt: raw.drawdownTriggeredAt ?? null,
  };
}

function createLiveBot(options = {}) {
  const trader = options.trader;
  const { onDrawdownStop, resolveExtremalSpikeGate } = options;
  if (!trader) throw new Error("live bot requires futures trader");

  let state = loadState();
  let saveTimer = null;
  let busy = false;
  const pendingSymbols = new Set();

  function persistSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeJsonFile(STATE_FILE(), {
        config: state.config,
        openPositions: state.openPositions,
        closedTrades: state.closedTrades.slice(0, 500),
        log: state.log.slice(0, 200),
        drawdownBaseline: state.drawdownBaseline,
        drawdownTriggeredAt: state.drawdownTriggeredAt,
        savedAt: Date.now(),
      });
    }, 400);
  }

  function pushLog(type, symbol, detail) {
    state.log.unshift({
      at: Date.now(),
      atIso: formatIsoUtcPlus3(Date.now()),
      type,
      symbol,
      detail,
    });
    if (state.log.length > 200) state.log.length = 200;
  }

  function hasOpen(symbol) {
    return state.openPositions.some((p) => p.symbol === symbol);
  }

  function canTrade() {
    if (!trader.enabled) return { ok: false, reason: "API keys not configured" };
    if (!state.config.enabled) return { ok: false, reason: "bot disabled" };
    if (!state.config.armed) return { ok: false, reason: "not armed" };
    return { ok: true };
  }

  async function fetchSummary() {
    let wallet = null;
    let available = null;
    let exchangeError = null;
    if (trader.enabled) {
      try {
        const bal = await trader.getUsdtBalance();
        wallet = bal.wallet;
        available = bal.available;
      } catch (e) {
        exchangeError = e.message || String(e);
      }
    }
    let unrealized = 0;
    let locked = 0;
    for (const p of state.openPositions) {
      normalizeOpenPosition(p);
      locked += p.margin ?? 0;
      unrealized += p.unrealizedPnl ?? 0;
    }
    const realized = state.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const equity =
      wallet != null ? wallet + unrealized : null;
    const dd = drawdownStatus(state.config, state, equity);
    return {
      walletUsdt: wallet != null ? +wallet.toFixed(4) : null,
      availableUsdt: available != null ? +available.toFixed(4) : null,
      equityUsdt: equity != null ? +equity.toFixed(4) : null,
      lockedMarginEst: +locked.toFixed(4),
      unrealizedPnl: +unrealized.toFixed(4),
      realizedPnl: +realized.toFixed(4),
      totalPnl: +(realized + unrealized).toFixed(4),
      openCount: state.openPositions.length,
      closedCount: state.closedTrades.length,
      exchangeError,
      apiEnabled: trader.enabled,
      armed: state.config.armed,
      leverage: state.config.leverage,
      marginType: "ISOLATED",
      drawdown: dd,
    };
  }

  async function ensureDrawdownBaseline() {
    if (!state.config.drawdownStopEnabled) return;
    if (state.drawdownTriggeredAt) return;
    if (state.drawdownBaseline != null && Number.isFinite(state.drawdownBaseline)) return;
    if (!trader.enabled) return;
    try {
      const bal = await trader.getUsdtBalance();
      const wallet = bal.wallet ?? 0;
      let unrealized = 0;
      for (const p of state.openPositions) {
        unrealized += p.unrealizedPnl ?? 0;
      }
      const equity = wallet + unrealized;
      if (!Number.isFinite(equity) || equity <= 0) return;
      state.drawdownBaseline = equity;
      pushLog(
        "DRAWDOWN",
        "—",
        `Baseline set $${equity.toFixed(2)} (max loss −${state.config.drawdownStopPct}%)`
      );
      persistSoon();
    } catch (e) {
      pushLog("WARN", "—", `drawdown baseline: ${e.message}`);
    }
  }

  function applyDrawdownStop(trigger) {
    state.drawdownTriggeredAt = trigger.at;
    state.config.enabled = false;
    state.config.armed = false;
    pushLog(
      "DRAWDOWN_STOP",
      "—",
      `Bot off & disarmed: −${trigger.lossPct.toFixed(2)}% from $${trigger.baseline.toFixed(2)} (limit −${trigger.limitPct}%)`
    );
    persistSoon();
    if (onDrawdownStop) {
      void Promise.resolve(
        onDrawdownStop({
          bot: "live",
          ...trigger,
          disarmed: true,
        })
      ).catch((e) => {
        console.error(`Live drawdown notify: ${e.message}`);
      });
    }
  }

  async function checkDrawdownStop() {
    if (state.drawdownTriggeredAt) return false;
    if (!state.config.drawdownStopEnabled || !state.config.enabled) return false;
    await ensureDrawdownBaseline();
    if (!trader.enabled) return false;
    try {
      const bal = await trader.getUsdtBalance();
      const wallet = bal.wallet ?? 0;
      let unrealized = 0;
      for (const p of state.openPositions) {
        unrealized += p.unrealizedPnl ?? 0;
      }
      const equity = wallet + unrealized;
      const trigger = evaluateDrawdownStop(state.config, state, equity, {
        disarm: true,
      });
      if (!trigger) return false;
      applyDrawdownStop(trigger);
      return true;
    } catch (e) {
      pushLog("WARN", "—", `drawdown check: ${e.message}`);
      return false;
    }
  }

  function getPublicState() {
    return {
      ok: true,
      updatedAt: formatIsoUtcPlus3(Date.now()),
      config: state.config,
      summary: null,
      openPositions: state.openPositions.map((p) => ({
        ...p,
        openedAtIso: formatIsoUtcPlus3(p.openedAt),
        unrealizedPnlPct: unrealizedPnlPctFor(p),
      })),
      closedTrades: state.closedTrades.slice(0, 100).map((t) => ({
        ...t,
        openedAtIso: formatIsoUtcPlus3(t.openedAt),
        closedAtIso: formatIsoUtcPlus3(t.closedAt),
      })),
      log: state.log.slice(0, 50),
      busy,
    };
  }

  async function getPublicStateAsync() {
    const base = getPublicState();
    base.summary = await fetchSummary();
    await checkDrawdownStop();
    base.config = state.config;
    base.summary = await fetchSummary();
    return base;
  }

  async function patchConfig(patch) {
    const prevEnabled = state.config.enabled;
    const prevArmed = state.config.armed;
    const prevDdEnabled = state.config.drawdownStopEnabled;
    const { initialDeposit: _i, armed: patchArmed, ...rest } = patch ?? {};
    const next = { ...state.config, ...rest };
    if (patchArmed !== undefined) next.armed = Boolean(patchArmed);
    state.config = normalizeLiveConfig(next);
    if (state.config.enabled && !prevEnabled) {
      state.drawdownTriggeredAt = null;
      state.drawdownBaseline = null;
    }
    if (state.config.drawdownStopEnabled && !prevDdEnabled) {
      state.drawdownTriggeredAt = null;
      state.drawdownBaseline = null;
    }
    if (prevArmed !== state.config.armed && state.config.armed) {
      state.drawdownTriggeredAt = null;
      state.drawdownBaseline = null;
      pushLog(
        "ARM",
        "—",
        `${state.config.leverage}x isolated margin`
      );
    } else if (prevArmed !== state.config.armed) {
      pushLog("DISARM", "—", "No new exchange orders");
    }
    if (state.config.enabled && state.config.drawdownStopEnabled) {
      await ensureDrawdownBaseline();
    }
    await checkDrawdownStop();
    persistSoon();
    flush();
    return getPublicStateAsync();
  }

  async function arm() {
    state.config.armed = true;
    state.drawdownTriggeredAt = null;
    state.drawdownBaseline = null;
    pushLog("ARM", "—", `${state.config.leverage}x isolated margin`);
    if (state.config.enabled && state.config.drawdownStopEnabled) {
      await ensureDrawdownBaseline();
    }
    persistSoon();
    return getPublicStateAsync();
  }

  function disarm() {
    state.config.armed = false;
    pushLog("DISARM", "—", "No new exchange orders");
    persistSoon();
    return getPublicStateAsync();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensurePositionStopLoss(pos) {
    if (!state.config.armed || !trader.enabled) return false;

    let exPos;
    try {
      exPos = await trader.getPosition(pos.symbol);
    } catch (e) {
      pushLog("WARN", pos.symbol, `ensure SL position: ${e.message}`);
      return false;
    }
    if (!exPos || exPos.positionAmt <= 0) return false;

    const mark = exPos.markPrice ?? pos.lastPrice ?? pos.entryPrice;
    const meta = await trader.getSymbolMeta(pos.symbol);
    const cfg = state.config;
    const markDropPct = movePctFromEntry(mark, pos.entryPrice);
    const priceMovedDown = markDropPct != null && markDropPct < -0.01;
    let repaired = false;

    for (let attempt = 0; attempt < MAX_SL_ENSURE_ATTEMPTS; attempt++) {
      await sleep(attempt === 0 ? SL_ENSURE_VERIFY_MS : 250);
      let orders = [];
      try {
        orders = await trader.getAlgoOpenOrders(pos.symbol);
      } catch (e) {
        pushLog("WARN", pos.symbol, `ensure SL list: ${e.message}`);
      }

      const existing = trader.pickCloseStopAlgo(orders);
      if (existing) {
        const trigger = Number(existing.triggerPrice);
        if (Number.isFinite(trigger) && !wouldLongStopMarketTrigger(mark, trigger)) {
          pos.stopLoss = trigger;
          pos.slOrderId = existing.algoId ?? null;
          if (repaired) {
            pushLog("ENSURE_SL", pos.symbol, `SL @ ${pos.stopLoss}`);
          }
          return true;
        }
        repaired = true;
        try {
          await trader.cancelStopOrders(pos.symbol);
        } catch (e) {
          pushLog("WARN", pos.symbol, `cancel stale SL: ${e.message}`);
        }
      }

      const escalate = priceMovedDown ? attempt + 1 : attempt;
      let rawSl = null;
      if (
        attempt === 0 &&
        Number.isFinite(pos.stopLoss) &&
        pos.stopLoss > 0 &&
        !wouldLongStopMarketTrigger(mark, pos.stopLoss)
      ) {
        rawSl = pos.stopLoss;
      } else {
        rawSl = stopLossFallbackForLongEscalated(
          pos.entryPrice,
          cfg.stopLossFallbackPnlPct,
          mark,
          meta.tickSize,
          escalate
        );
      }
      const sl = trader.formatPrice(rawSl, meta) ?? rawSl;
      if (!Number.isFinite(sl) || sl <= 0) continue;

      try {
        const slOrder = await trader.placeCloseStop(pos.symbol, sl);
        pos.stopLoss = sl;
        pos.slOrderId = slOrder?.algoId ?? slOrder?.orderId ?? null;
        repaired = true;
        continue;
      } catch (e) {
        if (!isImmediateTriggerError(e)) {
          pushLog(
            "WARN",
            pos.symbol,
            `ensure SL attempt ${attempt + 1}: ${e.message}`
          );
        }
        continue;
      }
    }

    pushLog("ERROR", pos.symbol, "stop loss missing on exchange after retries");
    return false;
  }

  async function replaceExitOrders(pos) {
    await trader.cancelAllOrders(pos.symbol);
    const exPos = await trader.getPosition(pos.symbol);
    const mark =
      exPos?.markPrice ?? pos.lastPrice ?? pos.entryPrice;
    const meta = await trader.getSymbolMeta(pos.symbol);
    const cfg = state.config;
    let sl = pos.stopLoss;
    let slOrder;
    try {
      slOrder = await trader.placeCloseStop(pos.symbol, sl);
    } catch (e) {
      if (!isImmediateTriggerError(e)) throw e;
      const fallback = stopLossFallbackForLong(
        pos.entryPrice,
        cfg.stopLossFallbackPnlPct,
        mark,
        meta.tickSize
      );
      const formatted = trader.formatPrice(fallback, meta);
      if (!formatted) throw e;
      sl = formatted;
      pos.stopLoss = sl;
      pushLog(
        "WARN",
        pos.symbol,
        `corridor SL rejected; fallback −${cfg.stopLossFallbackPnlPct}% PnL @ ${sl}`
      );
      slOrder = await trader.placeCloseStop(pos.symbol, sl);
    }
    const tpOrder = await trader.placeCloseTakeProfit(pos.symbol, pos.takeProfit);
    pos.slOrderId = slOrder?.algoId ?? slOrder?.orderId ?? null;
    pos.tpOrderId = tpOrder?.algoId ?? tpOrder?.orderId ?? null;
    await ensurePositionStopLoss(pos);
  }

  async function closeOnExchange(pos, reason, exitPriceHint) {
    try {
      await trader.cancelAllOrders(pos.symbol);
    } catch (e) {
      pushLog("WARN", pos.symbol, `cancel orders: ${e.message}`);
    }
    const exPos = await trader.getPosition(pos.symbol);
    const qty = exPos ? Math.abs(exPos.positionAmt) : pos.quantity;
    if (qty > 0) {
      await trader.marketOrder(pos.symbol, "SELL", qty, {
        reduceOnly: true,
        markPrice: exitPriceHint,
      });
    }
    const mark =
      exitPriceHint ??
      exPos?.markPrice ??
      pos.lastPrice ??
      pos.entryPrice;
    recordClose(pos, mark, reason);
  }

  function recordClose(pos, exitPrice, reason) {
    normalizeOpenPosition(pos);
    const pnl =
      pos.unrealizedPnl != null && reason === "exchange_sync"
        ? pos.unrealizedPnl
        : pos.quantity * (exitPrice - pos.entryPrice);
    const margin = pos.margin || 1;
    const trade = {
      id: pos.id,
      symbol: pos.symbol,
      signalKind: pos.signalKind,
      side: pos.side,
      entryPrice: pos.entryPrice,
      initialEntryPrice: pos.initialEntryPrice,
      exitPrice,
      quantity: pos.quantity,
      margin,
      leverage: pos.leverage,
      addCount: pos.addCount,
      pnl: +pnl.toFixed(4),
      pnlPct: +((pnl / margin) * 100).toFixed(2),
      exitReason: reason,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
    };
    state.closedTrades.unshift(trade);
    if (state.closedTrades.length > 500) state.closedTrades.length = 500;
    pushLog(
      "CLOSE",
      pos.symbol,
      `${reason} @ ${Number(exitPrice).toFixed(6)} · PnL $${pnl.toFixed(2)}`
    );
    state.openPositions = state.openPositions.filter((p) => p.id !== pos.id);
    persistSoon();
    void checkDrawdownStop();
  }

  async function tryOpen(symbol, signalKind, metrics) {
    const gate = canTrade();
    if (!gate.ok) {
      pushLog("SKIP", symbol, gate.reason);
      return;
    }
    if (!Number.isFinite(metrics?.close) || metrics.close <= 0) return;
    if (!Number.isFinite(metrics?.corridorHigh) || metrics.corridorHigh <= 0) {
      pushLog("SKIP", symbol, "missing corridor high");
      return;
    }
    if (hasOpen(symbol)) {
      pushLog("SKIP", symbol, "position already open");
      return;
    }
    if (state.openPositions.length >= state.config.maxOpenPositions) {
      pushLog("SKIP", symbol, "max open positions reached");
      return;
    }
    if (pendingSymbols.has(symbol)) return;
    pendingSymbols.add(symbol);

    const cfg = state.config;
    const entryEst = metrics.close;
    const exitsEst = resolveExitLevels(signalKind, metrics, entryEst, cfg, {
      mark: entryEst,
    });
    if (!exitsEst.stopLoss || !exitsEst.takeProfit) {
      pendingSymbols.delete(symbol);
      return;
    }

    if (state.config.extremalSpikeGateEnabled && resolveExtremalSpikeGate) {
      try {
        const spikeGate = await resolveExtremalSpikeGate(symbol, Date.now());
        if (spikeGate?.enabled !== false && !spikeGate.pass) {
          pushLog(
            "SKIP",
            symbol,
            spikeGate.waiting
              ? `30m spike check: ${spikeGate.detail}`
              : `30m extremal spike: ${spikeGate.detail}`
          );
          pendingSymbols.delete(symbol);
          return;
        }
      } catch (e) {
        pushLog("WARN", symbol, `30m spike check: ${e.message}`);
        pendingSymbols.delete(symbol);
        return;
      }
    }

    try {
      const bal = await trader.getUsdtBalance();
      const available = bal.available ?? bal.wallet ?? 0;
      if (available < MIN_MARGIN_USDT) {
        pushLog(
          "SKIP",
          symbol,
          `insufficient USDT ($${available.toFixed(2)} avail, min $${MIN_MARGIN_USDT})`
        );
        return;
      }
      const margin = positionMarginFromConfig(
        available,
        cfg.positionSizeUsdt,
        MIN_MARGIN_USDT
      );
      if (!margin) {
        pushLog(
          "SKIP",
          symbol,
          `insufficient USDT for $${cfg.positionSizeUsdt} margin ($${available.toFixed(2)} avail, min $${MIN_MARGIN_USDT})`
        );
        return;
      }
      const notional = margin * cfg.leverage;
      const quantity = notional / entryEst;

      const prep = await trader.prepareSymbol(symbol, cfg.leverage);
      const order = await trader.marketOrder(symbol, "BUY", quantity, {
        markPrice: entryEst,
      });

      let exPos = null;
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 200));
        exPos = await trader.getPosition(symbol);
        if (exPos?.positionAmt > 0) break;
      }
      if (!exPos?.positionAmt) {
        throw new Error("Market buy did not open position on exchange");
      }

      const entryPrice = exPos.entryPrice || entryEst;
      const qty = Math.abs(exPos.positionAmt);
      const mark = exPos.markPrice ?? entryPrice;
      const meta = await trader.getSymbolMeta(symbol);
      const exits = resolveExitLevels(signalKind, metrics, entryPrice, cfg, {
        mark,
        tickSize: meta.tickSize,
      });
      let sl = trader.formatPrice(exits.stopLoss, meta) ?? exits.stopLoss;
      let tp = trader.formatPrice(exits.takeProfit, meta) ?? exits.takeProfit;
      const pos = normalizeOpenPosition({
        id: `${symbol}-${Date.now()}`,
        symbol,
        signalKind,
        side: "LONG",
        entryPrice,
        initialEntryPrice: entryPrice,
        quantity: qty,
        margin: notional / cfg.leverage,
        leverage: prep.leverage,
        marginType: "ISOLATED",
        addCount: 0,
        corridorLow: metrics.corridorLow,
        corridorHigh: metrics.corridorHigh,
        stopLoss: sl,
        initialStopLoss: sl,
        takeProfit: tp,
        lastPrice: entryPrice,
        unrealizedPnl: exPos.unrealizedProfit ?? 0,
        openedAt: Date.now(),
        entryOrderId: order?.orderId ?? null,
      });

      await replaceExitOrders(pos);
      state.openPositions.push(pos);
      pushLog(
        "OPEN",
        symbol,
        `LONG ${signalKind} · ${qty} @ ~${entryPrice.toFixed(6)} · ${prep.leverage}x isolated · margin ~$${pos.margin.toFixed(2)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)}${exits.exitMethod && exits.exitMethod !== "corridor" ? ` · ${exits.exitMethod}` : ""}`
      );
      persistSoon();
    } catch (e) {
      pushLog("ERROR", symbol, e.message || String(e));
      console.error(`Live bot OPEN ${symbol}:`, e.message);
    } finally {
      pendingSymbols.delete(symbol);
    }
  }

  function onSpikeSignal(sym, metrics) {
    if (!state.config.tradeSpikeSignals) return;
    void tryOpen(sym, "spike", metrics);
  }

  function onFastCorridorSignal(sym, metrics) {
    if (!state.config.tradeFastCorridorSignals) return;
    void tryOpen(sym, "fast-corridor", metrics);
  }

  function onSfpSignal(sym, metrics) {
    if (!state.config.tradeSfpSignals) return;
    void tryOpen(sym, "sfp", metrics);
  }

  function onPullbackSignal(sym, metrics) {
    if (!state.config.tradePullbackSignals) return;
    void tryOpen(sym, "pullback", metrics);
  }

  async function tryAddToPosition(pos, price) {
    const cfg = state.config;
    if (!cfg.addOnEnabled || !cfg.armed) return false;
    normalizeOpenPosition(pos);
    if (pos.addCount >= cfg.addOnMaxAdds) return false;

    const movePct = movePctFromEntry(price, pos.initialEntryPrice);
    if (movePct == null || movePct < 0) return false;
    const nextLevel = (pos.addCount + 1) * cfg.addOnMovePct;
    if (movePct < nextLevel) return false;

    try {
      const bal = await trader.getUsdtBalance();
      const available = bal.available ?? bal.wallet ?? 0;
      if (available < MIN_MARGIN_USDT) return false;
      const addMargin = resolveMarginUsdt(available, cfg.addOnDepositPct);
      const addNotional = addMargin * cfg.leverage;
      const addQty = addNotional / price;

      await trader.marketOrder(pos.symbol, "BUY", addQty, { markPrice: price });
      const exPos = await trader.getPosition(pos.symbol);
      if (!exPos) return false;

      pos.quantity = Math.abs(exPos.positionAmt);
      pos.entryPrice = exPos.entryPrice;
      pos.margin += addNotional / cfg.leverage;
      pos.addCount += 1;
      pos.unrealizedPnl = exPos.unrealizedProfit ?? 0;

      const slMove = moveStopAfterAddOn(pos, cfg.moveStopOffsetPct);
      await replaceExitOrders(pos);
      pushLog(
        "ADD",
        pos.symbol,
        `+${cfg.addOnDepositPct}% @ ${price.toFixed(6)} · qty ${pos.quantity} · avg ${pos.entryPrice.toFixed(6)}`
      );
      if (slMove) {
        pushLog(
          "MOVE_SL",
          pos.symbol,
          `SL → ${slMove.targetSl.toFixed(6)} after add`
        );
      }
      return true;
    } catch (e) {
      pushLog("ERROR", pos.symbol, `add-on: ${e.message}`);
      return false;
    }
  }

  async function tryMoveStopLoss(pos, price) {
    const cfg = state.config;
    if (!cfg.moveStopEnabled) return false;
    normalizeOpenPosition(pos);
    const movePct = movePctFromEntry(price, pos.initialEntryPrice);
    if (movePct == null || movePct < cfg.moveStopAfterMovePct) return false;

    const targetSl = entryBasedStopPrice(
      pos.initialEntryPrice,
      cfg.moveStopOffsetPct
    );
    if (!Number.isFinite(targetSl) || targetSl <= pos.stopLoss) return false;

    try {
      const prev = pos.stopLoss;
      pos.stopLoss = targetSl;
      await replaceExitOrders(pos);
      pushLog(
        "MOVE_SL",
        pos.symbol,
        `SL ${prev.toFixed(6)} → ${targetSl.toFixed(6)} after +${movePct.toFixed(2)}%`
      );
      return true;
    } catch (e) {
      pushLog("ERROR", pos.symbol, `move SL: ${e.message}`);
      return false;
    }
  }

  async function reconcilePosition(pos, bar) {
    const close = bar?.close;
    const low = bar?.low ?? close;
    const high = bar?.high ?? close;

    let exPos = null;
    try {
      exPos = await trader.getPosition(pos.symbol);
    } catch (e) {
      pushLog("WARN", pos.symbol, `position sync: ${e.message}`);
      return;
    }

    if (!exPos || Math.abs(exPos.positionAmt) < 1e-12) {
      recordClose(pos, close ?? pos.lastPrice ?? pos.entryPrice, "exchange_sync");
      return;
    }

    pos.quantity = Math.abs(exPos.positionAmt);
    pos.entryPrice = exPos.entryPrice;
    pos.lastPrice = exPos.markPrice ?? close;
    pos.unrealizedPnl = +(exPos.unrealizedProfit ?? 0).toFixed(4);
    pos.leverage = exPos.leverage ?? pos.leverage;
    pos.movePctFromEntry = +(
      movePctFromEntry(pos.lastPrice, pos.initialEntryPrice) ?? 0
    ).toFixed(3);

    await ensurePositionStopLoss(pos);

    if (Number.isFinite(high)) await tryAddToPosition(pos, high);
    if (Number.isFinite(high)) await tryMoveStopLoss(pos, high);

    if (shouldCloseFalseSpike(pos, close, state.config)) {
      await closeOnExchange(pos, "false_spike", close);
      return;
    }

    if (Number.isFinite(low) && low <= pos.stopLoss) {
      /* exchange STOP_MARKET should handle; sync if still open */
      if (exPos) await closeOnExchange(pos, "stop_loss", pos.stopLoss);
      return;
    }
    if (Number.isFinite(high) && high >= pos.takeProfit) {
      if (exPos) await closeOnExchange(pos, "take_profit", pos.takeProfit);
    }
  }

  async function updatePrices(getBar) {
    if (!state.openPositions.length) return;
    if (busy) return;
    busy = true;
    let changed = false;
    try {
      const snapshot = [...state.openPositions];
      for (const pos of snapshot) {
        if (!state.openPositions.some((p) => p.id === pos.id)) continue;
        const bar = getBar(pos.symbol);
        if (!bar?.close) continue;
        await reconcilePosition(pos, bar);
        changed = true;
      }
    } finally {
      busy = false;
      if (changed) persistSoon();
      await checkDrawdownStop();
    }
  }

  async function closeSymbol(symbol, reason = "manual") {
    const pos = state.openPositions.find((p) => p.symbol === symbol);
    if (!pos) throw new Error(`No bot position for ${symbol}`);
    const bar = pos.lastPrice;
    await closeOnExchange(pos, reason, bar);
    return getPublicStateAsync();
  }

  async function closeAll(reason = "manual_all") {
    for (const pos of [...state.openPositions]) {
      await closeOnExchange(pos, reason, pos.lastPrice);
    }
    return getPublicStateAsync();
  }

  async function syncFromExchange() {
    if (!trader.enabled) throw new Error("API not configured");
    const still = [];
    for (const pos of state.openPositions) {
      const exPos = await trader.getPosition(pos.symbol);
      if (exPos && Math.abs(exPos.positionAmt) > 0) {
        pos.quantity = Math.abs(exPos.positionAmt);
        pos.entryPrice = exPos.entryPrice;
        pos.unrealizedPnl = exPos.unrealizedProfit ?? 0;
        pos.leverage = exPos.leverage;
        pos.lastPrice = exPos.markPrice ?? pos.lastPrice;
        still.push(pos);
        await ensurePositionStopLoss(pos);
      } else {
        recordClose(pos, pos.lastPrice ?? pos.entryPrice, "exchange_sync");
      }
    }
    state.openPositions = still;
    persistSoon();
    return getPublicStateAsync();
  }

  async function resetHistory() {
    state.closedTrades = [];
    state.log = [];
    state.drawdownBaseline = null;
    state.drawdownTriggeredAt = null;
    pushLog(
      "RESET",
      "—",
      `History cleared · ${state.openPositions.length} open position(s) kept`
    );
    if (state.config.enabled && state.config.drawdownStopEnabled) {
      await ensureDrawdownBaseline();
    }
    persistSoon();
    flush();
    return getPublicStateAsync();
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeJsonFile(STATE_FILE(), {
      config: state.config,
      openPositions: state.openPositions,
      closedTrades: state.closedTrades.slice(0, 500),
      log: state.log.slice(0, 200),
      drawdownBaseline: state.drawdownBaseline,
      drawdownTriggeredAt: state.drawdownTriggeredAt,
      savedAt: Date.now(),
    });
  }

  if (state.config.enabled && state.config.drawdownStopEnabled) {
    void ensureDrawdownBaseline().then(() => checkDrawdownStop());
  }

  function hasOpenPositions() {
    return state.openPositions.length > 0;
  }

  return {
    getPublicState: getPublicStateAsync,
    hasOpenPositions,
    patchConfig,
    arm,
    disarm,
    onSpikeSignal,
    onFastCorridorSignal,
    onSfpSignal,
    onPullbackSignal,
    updatePrices,
    closeSymbol,
    closeAll,
    syncFromExchange,
    resetHistory,
    flush,
  };
}

module.exports = {
  createLiveBot,
  normalizeLiveConfig,
  LIVE_DEFAULTS,
};
