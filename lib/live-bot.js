const {
  loadBotState,
  persistBotState,
  appendBotEvent,
  persistClosedTrade,
  clearBotHistory,
  BOT_TYPE_LIVE,
} = require("./bot-db-persist");
const { isImmediateTriggerError } = require("./binance-futures-trade");
const { formatIsoUtcPlus3, OFFSET_MS } = require("./time-format");
const { dayKeyUtcPlus3, isArchivableBotTrade } = require("./live-bot-history");
const { resolveExchangeClose } = require("./live-bot-exchange-close");
const {
  normalizeConfig: normalizePaperConfig,
  normalizeOpenPosition,
  positionMarginFromConfig,
  nextLeverageAfterAddOn,
  entryBasedStopPrice,
  entryBasedStopPriceShort,
  moveStopAfterAddOn,
  takeProfitAfterAddOn,
  addOnEntryAllowed,
  movePctFromEntry,
} = require("./paper-bot");
const {
  stopLossFallbackForLong,
  stopLossFallbackForShort,
  wouldLongStopMarketTrigger,
  wouldShortStopMarketTrigger,
} = require("./bot-exit-prices");
const {
  isShort,
  favorableMovePct,
  peakMovePct,
  adverseMovePct,
  positionPnl,
  stopLossHit,
  takeProfitHit,
  updatePriceExtremes,
} = require("./position-side");
const { summarizeTradeExitPath } = require("./early-exit-path-oracle");
const { resolveExitLevels } = require("./signal-exit-levels");
const { evaluateEntryQuality } = require("./entry-quality-gate");
const { pickSignalSnapshot } = require("./signal-snapshot");
const {
  seedPositionExitContext,
  tickBarProgress,
} = require("./paper-bot-position-exits");
const { evaluateAiEarlyExit } = require("./early-exit-model");
const { evaluatePullbackEarlyInvalidation } = require("./pullback-early-invalidation");
const { evaluatePullbackRegimeGate } = require("./pullback-regime-model");
const { evaluatePullbackSignalGate } = require("./pullback-signal-model");
const {
  isSymbolBlocked,
  recordTradeForSymbolBlocklist,
  normalizeSymbolSlStreak,
  normalizeBlockedSymbols,
} = require("./bot-symbol-blocklist");
const {
  drawdownStatus,
  evaluateDrawdownStop,
  drawdownEquityFromClosed: equityFromClosedTrades,
} = require("./bot-drawdown-guard");


const LIVE_DEFAULTS = {
  leverage: 1,
  armed: false,
  maxOpenPositions: 4,
};

/** AI model scope for every model evaluation in this bot (paper vs live weights). */
const MODEL_SCOPE = "live";

const MIN_MARGIN_USDT = 5;
const EXIT_ORDER_ENSURE_MS = 45_000;
const EXIT_ORDER_PLACE_ATTEMPTS = 2;
const EXIT_ORDER_RETRY_MS = 400;
const POSITION_SYNC_MS = 20_000;
const DRAWDOWN_CHECK_MS = 30_000;
/** Exchange qty above bot-tracked qty by more than this ratio → external increase. */
const EXTERNAL_QTY_TOLERANCE_RATIO = 0.002;

function normalizeLiveOpenPosition(pos) {
  normalizeOpenPosition(pos);
  if (pos.botQuantity == null) pos.botQuantity = pos.quantity;
  return pos;
}

function qtyIncreaseTolerance(botQty) {
  const b = Number(botQty);
  if (!Number.isFinite(b) || b <= 0) return 0;
  return Math.max(b * EXTERNAL_QTY_TOLERANCE_RATIO, 1e-8);
}

function isExternalQuantityIncrease(pos, exchangeQty) {
  normalizeLiveOpenPosition(pos);
  const botQty = Number(pos.botQuantity ?? pos.quantity);
  const exQty = Math.abs(Number(exchangeQty));
  if (!Number.isFinite(botQty) || !Number.isFinite(exQty) || exQty <= 0) {
    return false;
  }
  return exQty > botQty + qtyIncreaseTolerance(botQty);
}

function pricesCloseEnough(a, b, tickSize) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tol = Number.isFinite(tickSize) && tickSize > 0 ? tickSize * 0.51 : 1e-8;
  return Math.abs(a - b) <= tol;
}

function closeSideForPos(pos) {
  return isShort(pos) ? "BUY" : "SELL";
}

function openSideForPos(pos) {
  return isShort(pos) ? "SELL" : "BUY";
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
  const base = normalizePaperConfig({ ...raw, enabled: true });
  return {
    ...base,
    enabled: true,
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
  return loadBotState(BOT_TYPE_LIVE, () => ({
    config: normalizeLiveConfig({ armed: false }),
    openPositions: [],
    closedTrades: [],
    log: [],
    symbolSlStreak: {},
    drawdownBaseline: null,
    drawdownTriggeredAt: null,
    historyDayKey: dayKeyUtcPlus3(Date.now()),
  }));
}

function createLiveBot(options = {}) {
  const trader = options.trader;
  const {
    onDrawdownStop,
    onTradeClosed,
    onExitOrdersFailed,
    resolveExtremalSpikeGate,
    sfpRegimeMonitor,
    pullbackRegimeMonitor,
    pullbackPatternBreakMonitor,
    getRecentBars,
    getBarsForSymbol,
    getBtcBarsForRegime,
    getFundingOiAt,
    historyStore,
  } = options;
  if (!trader) throw new Error("live bot requires futures trader");

  let state = loadState();
  state.config = normalizeLiveConfig(state.config);
  state.openPositions = (state.openPositions ?? []).map((p) =>
    normalizeLiveOpenPosition({ ...p })
  );
  state.symbolSlStreak = normalizeSymbolSlStreak(state.symbolSlStreak);
  state.historyDayKey = String(state.historyDayKey || dayKeyUtcPlus3(Date.now()));
  let saveTimer = null;
  let busy = false;
  const pendingSymbols = new Set();
  const exitEnsureAt = new Map();
  const positionSyncAt = new Map();
  let lastDrawdownCheckAt = 0;
  let dailyResetTimer = null;

  function migrateDrawdownBaseline() {
    if (state.drawdownBaseline == null) return;
    const ref = drawdownReferenceCapital();
    if (state.drawdownBaseline > ref * 1.5) {
      state.drawdownBaseline = null;
    }
  }
  migrateDrawdownBaseline();

  let saveGen = 0;

  function nextUtcPlus3MidnightMs(now = Date.now()) {
    const shifted = new Date(now + OFFSET_MS);
    const next = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() + 1,
      0,
      0,
      0,
      0
    ) - OFFSET_MS;
    return next;
  }

  function clearDailyHistory(reason = "daily") {
    state.closedTrades = [];
    state.log = [];
    state.drawdownBaseline = null;
    state.drawdownTriggeredAt = null;
    state.historyDayKey = dayKeyUtcPlus3(Date.now());
    if (reason !== "daily") {
      pushLog(
        "RESET",
        "—",
        `History cleared · ${state.openPositions.length} open position(s) kept`
      );
    }
    if (state.config.armed && state.config.drawdownStopEnabled) {
      ensureDrawdownBaseline();
    }
    persistSoon();
    flush();
  }

  function maybeRollDailyHistory() {
    const todayKey = dayKeyUtcPlus3(Date.now());
    if (state.historyDayKey === todayKey) return false;
    clearDailyHistory("daily");
    return true;
  }

  function scheduleDailyReset() {
    if (dailyResetTimer) clearTimeout(dailyResetTimer);
    const waitMs = Math.max(1000, nextUtcPlus3MidnightMs(Date.now()) - Date.now() + 1000);
    dailyResetTimer = setTimeout(async () => {
      dailyResetTimer = null;
      try {
        maybeRollDailyHistory();
      } catch (e) {
        console.error(`live-bot daily reset failed: ${e.message || e}`);
      } finally {
        scheduleDailyReset();
      }
    }, waitMs);
  }

  function flushPersist() {
    const gen = saveGen;
    try {
      persistBotState(BOT_TYPE_LIVE, {
        config: state.config,
        openPositions: state.openPositions,
        symbolSlStreak: state.symbolSlStreak ?? {},
        drawdownBaseline: state.drawdownBaseline,
        drawdownTriggeredAt: state.drawdownTriggeredAt,
        historyDayKey: state.historyDayKey,
      });
    } catch (e) {
      console.error(`live-bot persist failed: ${e.message || e}`);
    }
    if (gen !== saveGen) flushPersist();
  }

  function persistSoon() {
    saveGen++;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPersist();
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
    appendBotEvent(BOT_TYPE_LIVE, type, symbol, detail);
  }

  function hasOpen(symbol) {
    return state.openPositions.some((p) => p.symbol === symbol);
  }

  function tryAcquireOpenSlot(symbol) {
    if (hasOpen(symbol)) return false;
    if (pendingSymbols.has(symbol)) return false;
    pendingSymbols.add(symbol);
    return true;
  }

  function canTrade() {
    if (!trader.enabled) return { ok: false, reason: "API keys not configured" };
    if (!state.config.armed) return { ok: false, reason: "not armed" };
    return { ok: true };
  }

  /** Max USDT at risk for drawdown % (position size × max slots). */
  function drawdownReferenceCapital() {
    const perSlot = num(state.config.positionSizeUsdt, MIN_MARGIN_USDT);
    const slots = clamp(
      Math.round(num(state.config.maxOpenPositions, LIVE_DEFAULTS.maxOpenPositions)),
      1,
      100
    );
    return Math.max(perSlot * slots, MIN_MARGIN_USDT);
  }

  function botRealizedPnl() {
    return state.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  }

  function botTradePnl() {
    let unrealized = 0;
    for (const p of state.openPositions) {
      normalizeLiveOpenPosition(p);
      unrealized += p.unrealizedPnl ?? 0;
    }
    return botRealizedPnl() + unrealized;
  }

  /** Drawdown uses closed-trade PnL only — open unrealized PnL is ignored. */
  function drawdownEquityFromTrades() {
    const ref = state.drawdownBaseline ?? drawdownReferenceCapital();
    return equityFromClosedTrades(ref, state.closedTrades);
  }

  async function fetchSummary() {
    maybeRollDailyHistory();
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
      normalizeLiveOpenPosition(p);
      locked += p.margin ?? 0;
      unrealized += p.unrealizedPnl ?? 0;
    }
    const realized = botRealizedPnl();
    const walletEquity =
      wallet != null ? wallet + unrealized : null;
    const tradePnl = realized + unrealized;
    const ddEquity = drawdownEquityFromTrades();
    const dd = drawdownStatus(state.config, state, ddEquity);
    return {
      walletUsdt: wallet != null ? +wallet.toFixed(4) : null,
      availableUsdt: available != null ? +available.toFixed(4) : null,
      equityUsdt: walletEquity != null ? +walletEquity.toFixed(4) : null,
      tradePnl: +tradePnl.toFixed(4),
      drawdownReferenceUsdt: state.drawdownBaseline != null
        ? +state.drawdownBaseline.toFixed(4)
        : null,
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

  function ensureDrawdownBaseline() {
    if (!state.config.drawdownStopEnabled) return;
    if (state.drawdownTriggeredAt) return;
    if (state.drawdownBaseline != null && Number.isFinite(state.drawdownBaseline)) return;
    const ref = drawdownReferenceCapital();
    if (!Number.isFinite(ref) || ref <= 0) return;
    state.drawdownBaseline = ref;
    pushLog(
      "DRAWDOWN",
      "—",
      `Baseline $${ref.toFixed(2)} on closed trades (max loss −${state.config.drawdownStopPct}%)`
    );
    persistSoon();
  }

  function applyDrawdownStop(trigger) {
    state.drawdownTriggeredAt = trigger.at;
    state.config.armed = false;
    pushLog(
      "DRAWDOWN_STOP",
      "—",
      `Disarmed: −${trigger.lossPct.toFixed(2)}% of bot trade capital $${trigger.baseline.toFixed(2)} (limit −${trigger.limitPct}%)`
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

  async function maybeCheckDrawdownStop(force = false) {
    const now = Date.now();
    if (!force && now - lastDrawdownCheckAt < DRAWDOWN_CHECK_MS) return false;
    lastDrawdownCheckAt = now;
    return checkDrawdownStop();
  }

  function checkDrawdownStop() {
    if (state.drawdownTriggeredAt) return false;
    if (!state.config.drawdownStopEnabled || !state.config.armed) return false;
    ensureDrawdownBaseline();
    const equity = drawdownEquityFromTrades();
    const trigger = evaluateDrawdownStop(state.config, state, equity, {
      disarm: true,
    });
    if (!trigger) return false;
    applyDrawdownStop(trigger);
    return true;
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
    const ddChanged = await maybeCheckDrawdownStop();
    if (ddChanged) {
      base.config = state.config;
      base.summary = await fetchSummary();
    }
    return base;
  }

  async function patchConfig(patch) {
    const prevArmed = state.config.armed;
    const prevDdEnabled = state.config.drawdownStopEnabled;
    const { initialDeposit: _i, armed: patchArmed, enabled: _enabled, ...rest } = patch ?? {};
    const next = { ...state.config, ...rest };
    if (patchArmed !== undefined) next.armed = Boolean(patchArmed);
    state.config = normalizeLiveConfig(next);
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
    if (state.config.armed && state.config.drawdownStopEnabled) {
      ensureDrawdownBaseline();
    }
    checkDrawdownStop();
    persistSoon();
    flush();
    return getPublicStateAsync();
  }

  async function arm() {
    state.config.armed = true;
    state.drawdownTriggeredAt = null;
    state.drawdownBaseline = null;
    pushLog("ARM", "—", `${state.config.leverage}x isolated margin`);
    if (state.config.drawdownStopEnabled) {
      ensureDrawdownBaseline();
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

  async function verifyExitOrders(pos) {
    const closeSide = closeSideForPos(pos);
    const orders = await trader.getAlgoOpenOrders(pos.symbol);
    const hasSl = trader.hasCloseStopLoss(orders, closeSide);
    const hasTp = trader.hasCloseTakeProfit(orders, closeSide);
    const missing = [];
    if (!hasSl) missing.push("SL");
    if (!hasTp) missing.push("TP");
    return {
      ok: hasSl && hasTp,
      hasSl,
      hasTp,
      detail: missing.length ? `missing ${missing.join(" & ")}` : "",
    };
  }

  async function placeExitOrdersWithRetry(pos) {
    let lastDetail = "SL/TP not on exchange";
    for (let attempt = 0; attempt < EXIT_ORDER_PLACE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(EXIT_ORDER_RETRY_MS);
      }
      try {
        await replaceExitOrders(pos);
      } catch (e) {
        lastDetail = e.message || String(e);
        continue;
      }
      try {
        const check = await verifyExitOrders(pos);
        if (check.ok) return { ok: true };
        lastDetail = check.detail || lastDetail;
      } catch (e) {
        lastDetail = e.message || String(e);
      }
    }
    return { ok: false, detail: lastDetail };
  }

  async function abortOpenWithoutExits(pos, detail) {
    pushLog(
      "ERROR",
      pos.symbol,
      `exit orders failed after ${EXIT_ORDER_PLACE_ATTEMPTS} attempts: ${detail} · closing`
    );
    if (onExitOrdersFailed) {
      void Promise.resolve(onExitOrdersFailed(pos, detail)).catch((e) => {
        console.error(`Live exit-order notify ${pos.symbol}: ${e.message}`);
      });
    }
    const mark = pos.lastPrice ?? pos.entryPrice;
    await closeOnExchange(pos, "exit_orders_failed", mark);
  }

  async function placeMissingStopLoss(pos, mark, meta, cfg) {
    const closeSide = closeSideForPos(pos);
    let rawSl = pos.stopLoss;
    const wouldTrigger = isShort(pos)
      ? wouldShortStopMarketTrigger(mark, rawSl)
      : wouldLongStopMarketTrigger(mark, rawSl);
    if (!Number.isFinite(rawSl) || rawSl <= 0 || wouldTrigger) {
      rawSl = isShort(pos)
        ? stopLossFallbackForShort(
            pos.entryPrice,
            cfg.stopLossFallbackPnlPct,
            mark,
            meta.tickSize
          )
        : stopLossFallbackForLong(
            pos.entryPrice,
            cfg.stopLossFallbackPnlPct,
            mark,
            meta.tickSize
          );
    }
    const sl = trader.formatPrice(rawSl, meta) ?? rawSl;
    if (!Number.isFinite(sl) || sl <= 0) return false;

    try {
      const slOrder = await trader.placeCloseStop(pos.symbol, sl, closeSide);
      pos.stopLoss = sl;
      pos.slOrderId = slOrder?.algoId ?? slOrder?.orderId ?? null;
      return true;
    } catch (e) {
      if (!isImmediateTriggerError(e)) {
        pushLog("WARN", pos.symbol, `place SL: ${e.message}`);
      }
      return false;
    }
  }

  async function placeMissingTakeProfit(pos, meta) {
    const closeSide = closeSideForPos(pos);
    const tp = trader.formatPrice(pos.takeProfit, meta) ?? pos.takeProfit;
    if (!Number.isFinite(tp) || tp <= 0) return false;
    try {
      const tpOrder = await trader.placeCloseTakeProfit(pos.symbol, tp, closeSide);
      pos.takeProfit = tp;
      pos.tpOrderId = tpOrder?.algoId ?? tpOrder?.orderId ?? null;
      return true;
    } catch (e) {
      pushLog("WARN", pos.symbol, `place TP: ${e.message}`);
      return false;
    }
  }

  /** Ensure SL/TP algo orders exist without canceling valid ones. */
  async function ensurePositionExitOrders(pos, { force = false, exPos = null } = {}) {
    if (!state.config.armed || !trader.enabled) return false;

    const now = Date.now();
    const last = exitEnsureAt.get(pos.id) ?? 0;
    if (!force && now - last < EXIT_ORDER_ENSURE_MS) return true;

    if (!exPos) {
      try {
        exPos = await trader.getPosition(pos.symbol);
      } catch (e) {
        pushLog("WARN", pos.symbol, `ensure exits position: ${e.message}`);
        return false;
      }
    }
    if (!exPos || Math.abs(exPos.positionAmt) < 1e-12) return false;

    const mark = exPos.markPrice ?? pos.lastPrice ?? pos.entryPrice;
    const meta = await trader.getSymbolMeta(pos.symbol);
    const cfg = state.config;
    const closeSide = closeSideForPos(pos);

    let orders = [];
    try {
      orders = await trader.getAlgoOpenOrders(pos.symbol);
    } catch (e) {
      pushLog("WARN", pos.symbol, `ensure exits list: ${e.message}`);
      return false;
    }

    const slOrder = trader.pickCloseStopAlgo(orders, closeSide);
    const tpOrder = trader.pickCloseTakeProfitAlgo(orders, closeSide);
    let changed = false;

    if (slOrder) {
      const trigger = Number(slOrder.triggerPrice);
      if (Number.isFinite(trigger)) {
        pos.stopLoss = trigger;
        pos.slOrderId = slOrder.algoId ?? null;
      }
    } else {
      changed = (await placeMissingStopLoss(pos, mark, meta, cfg)) || changed;
    }

    if (tpOrder) {
      const trigger = Number(tpOrder.triggerPrice);
      if (Number.isFinite(trigger)) {
        pos.takeProfit = trigger;
        pos.tpOrderId = tpOrder.algoId ?? null;
      }
    } else if (Number.isFinite(pos.takeProfit) && pos.takeProfit > 0) {
      changed = (await placeMissingTakeProfit(pos, meta)) || changed;
    }

    exitEnsureAt.set(pos.id, Date.now());
    if (changed) {
      pushLog(
        "ENSURE_EXITS",
        pos.symbol,
        `SL ${pos.stopLoss} · TP ${pos.takeProfit}`
      );
    }
    return true;
  }

  async function replaceExitOrders(pos) {
    const exPos = await trader.getPosition(pos.symbol);
    const mark = exPos?.markPrice ?? pos.lastPrice ?? pos.entryPrice;
    const meta = await trader.getSymbolMeta(pos.symbol);
    const cfg = state.config;
    const closeSide = closeSideForPos(pos);
    const desiredSlRaw = pos.stopLoss;
    const desiredTpRaw = pos.takeProfit;

    let orders = [];
    try {
      orders = await trader.getAlgoOpenOrders(pos.symbol);
    } catch (e) {
      orders = [];
    }

    const slOrder = trader.pickCloseStopAlgo(orders, closeSide);
    const tpOrder = trader.pickCloseTakeProfitAlgo(orders, closeSide);
    let sl = trader.formatPrice(desiredSlRaw, meta) ?? desiredSlRaw;
    let tp = trader.formatPrice(desiredTpRaw, meta) ?? desiredTpRaw;

    const slOk =
      slOrder &&
      pricesCloseEnough(Number(slOrder.triggerPrice), sl, meta.tickSize);
    const tpOk =
      tpOrder &&
      pricesCloseEnough(Number(tpOrder.triggerPrice), tp, meta.tickSize);

    if (slOk && tpOk) {
      pos.stopLoss = Number(slOrder.triggerPrice);
      pos.takeProfit = Number(tpOrder.triggerPrice);
      pos.slOrderId = slOrder.algoId ?? null;
      pos.tpOrderId = tpOrder.algoId ?? null;
      exitEnsureAt.set(pos.id, Date.now());
      return;
    }

    if (!slOk) {
      try {
        await trader.cancelStopOrders(pos.symbol);
      } catch (e) {
        pushLog("WARN", pos.symbol, `cancel SL: ${e.message}`);
      }
      try {
        const slOrderNew = await trader.placeCloseStop(pos.symbol, sl, closeSide);
        pos.stopLoss = sl;
        pos.slOrderId = slOrderNew?.algoId ?? slOrderNew?.orderId ?? null;
      } catch (e) {
        if (!isImmediateTriggerError(e)) throw e;
        const fallback = isShort(pos)
          ? stopLossFallbackForShort(
              pos.entryPrice,
              cfg.stopLossFallbackPnlPct,
              mark,
              meta.tickSize
            )
          : stopLossFallbackForLong(
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
        const slOrderNew = await trader.placeCloseStop(pos.symbol, sl, closeSide);
        pos.slOrderId = slOrderNew?.algoId ?? slOrderNew?.orderId ?? null;
      }
    }

    if (!tpOk) {
      try {
        await trader.cancelTakeProfitOrders(pos.symbol);
      } catch (e) {
        pushLog("WARN", pos.symbol, `cancel TP: ${e.message}`);
      }
      const tpOrderNew = await trader.placeCloseTakeProfit(pos.symbol, tp, closeSide);
      pos.takeProfit = tp;
      pos.tpOrderId = tpOrderNew?.algoId ?? tpOrderNew?.orderId ?? null;
    }

    exitEnsureAt.set(pos.id, Date.now());
  }

  async function closeOnExchange(pos, reason, exitPriceHint) {
    try {
      await trader.cancelAllOrders(pos.symbol);
    } catch (e) {
      pushLog("WARN", pos.symbol, `cancel orders: ${e.message}`);
    }
    const sideHint = isShort(pos) ? "SHORT" : "LONG";
    let result;
    try {
      result = await trader.closeMarketPosition(pos.symbol, {
        sideHint,
        markPrice: exitPriceHint,
      });
    } catch (e) {
      pushLog("ERROR", pos.symbol, `close failed (${reason}): ${e.message}`);
      throw e;
    }
    if (!result.closed) {
      const detail =
        result.reason === "reduce_only_rejected"
          ? "reduceOnly rejected (likely already flat)"
          : "already flat on exchange";
      pushLog("INFO", pos.symbol, `${detail} · ${reason}`);
    }
    let closeMeta = null;
    if (trader.enabled) {
      if (!result.closed) {
        closeMeta = await resolveExchangeClose(trader, pos);
      } else if (result.order?.orderId != null) {
        closeMeta = { exitOrderId: result.order.orderId };
      }
    }
    const exitPrice =
      closeMeta?.exitPrice ??
      exitPriceHint ??
      result.exPos?.markPrice ??
      pos.lastPrice ??
      pos.entryPrice;
    const exitReason = closeMeta?.exitReason ?? reason;
    recordClose(pos, exitPrice, exitReason, closeMeta);
  }

  function pctDist(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
    return +(((to - from) / from) * 100).toFixed(4);
  }

  function recordClose(pos, exitPrice, reason, closeMeta = null) {
    maybeRollDailyHistory();
    normalizeLiveOpenPosition(pos);
    const meta = closeMeta && typeof closeMeta === "object" ? closeMeta : {};
    const posSnap = {
      ...pos,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      corridorHigh: pos.corridorHigh,
      corridorLow: pos.corridorLow,
    };
    const pnl =
      meta.pnl != null
        ? meta.pnl
        : positionPnl(pos, exitPrice);
    const margin = pos.margin || 1;
    const initialEntry = pos.initialEntryPrice ?? pos.entryPrice;
    const corridorHigh = pos.corridorHigh;
    const closedAt = meta.closedAt ?? Date.now();
    const trade = {
      id: pos.id,
      symbol: pos.symbol,
      signalKind: pos.signalKind,
      side: pos.side,
      entryPrice: pos.entryPrice,
      initialEntryPrice: initialEntry,
      exitPrice,
      quantity: pos.quantity,
      margin,
      leverage: pos.leverage,
      marginType: pos.marginType ?? "ISOLATED",
      addCount: pos.addCount,
      corridorLow: pos.corridorLow,
      corridorHigh,
      sweepLow: pos.sweepLow ?? null,
      sweepHigh: pos.sweepHigh ?? null,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      initialStopLoss: pos.initialStopLoss,
      stopMoved:
        pos.initialStopLoss != null &&
        Math.abs((pos.stopLoss ?? 0) - pos.initialStopLoss) > 1e-10,
      pnl: +pnl.toFixed(4),
      pnlPct: +((pnl / margin) * 100).toFixed(2),
      exitReason: reason,
      openedAt: pos.openedAt,
      closedAt,
      decidedAt: pos.decidedAt ?? null,
      exchangeOpenedAt: pos.exchangeOpenedAt ?? pos.openedAt ?? null,
      openDelaySec: pos.openDelaySec ?? null,
      entryOrderId: pos.entryOrderId ?? null,
      exitOrderId: meta.exitOrderId ?? null,
      slOrderId: pos.slOrderId ?? null,
      tpOrderId: pos.tpOrderId ?? null,
      exchangeTradeFills: meta.exchangeTradeFills ?? null,
      exchangeMatchedEpisodeId: meta.matchedEpisodeId ?? null,
      peakPrice: pos.peakPrice ?? null,
      troughPrice: pos.troughPrice ?? null,
      lastPrice: pos.lastPrice ?? exitPrice,
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
    };
    if (isArchivableBotTrade(trade)) historyStore?.appendTrade(trade);
    persistClosedTrade(BOT_TYPE_LIVE, trade);
    state.closedTrades.unshift(trade);
    if (state.closedTrades.length > 500) state.closedTrades.length = 500;
    pushLog(
      "CLOSE",
      pos.symbol,
      `${reason} @ ${Number(exitPrice).toFixed(6)} · PnL $${pnl.toFixed(2)}`
    );
    recordTradeForSymbolBlocklist({
      trade,
      config: state.config,
      symbolSlStreak: state.symbolSlStreak,
      onAutoBlock: (sym, n) =>
        pushLog("BLOCK", sym, `auto-blocked after ${n} consecutive SL`),
    });
    state.openPositions = state.openPositions.filter((p) => p.id !== pos.id);
    exitEnsureAt.delete(pos.id);
    positionSyncAt.delete(pos.id);
    persistSoon();
    void maybeCheckDrawdownStop(true);
    if (onTradeClosed) {
      void Promise.resolve(onTradeClosed(trade, posSnap))
        .then((patch) => {
          if (patch?.snapshotId) {
            trade.snapshotId = patch.snapshotId;
            if (isArchivableBotTrade(trade)) historyStore?.appendTrade(trade);
            persistClosedTrade(BOT_TYPE_LIVE, trade);
            persistSoon();
          }
        })
        .catch((e) => {
          console.error(`Live trade snapshot ${trade.symbol}: ${e.message}`);
        });
    }
  }

  async function recordExchangeClose(pos, priceHint) {
    let closeMeta = null;
    if (trader.enabled) {
      try {
        closeMeta = await resolveExchangeClose(trader, pos);
      } catch (e) {
        pushLog("WARN", pos.symbol, `exchange close match: ${e.message}`);
      }
    }
    const exitPrice =
      closeMeta?.exitPrice ??
      priceHint ??
      pos.lastPrice ??
      pos.entryPrice;
    const reason = closeMeta?.exitReason ?? "exchange_fill";
    recordClose(pos, exitPrice, reason, closeMeta);
    if (closeMeta?.matchedEpisodeId) {
      pushLog(
        "INFO",
        pos.symbol,
        `Matched Binance episode ${closeMeta.matchedEpisodeId} · ${reason} · fill ${closeMeta.exitOrderId ?? "—"}`
      );
    }
  }

  async function tryOpen(symbol, signalKind, metrics) {
    maybeRollDailyHistory();
    const isBear =
      signalKind === "sfp_bear" ||
      signalKind === "pullback_bear";
    const side = isBear ? "SHORT" : "LONG";
    const openSide = isBear ? "SELL" : "BUY";

    const gate = canTrade();
    if (!gate.ok) {
      pushLog("SKIP", symbol, gate.reason);
      return;
    }
    if (!Number.isFinite(metrics?.close) || metrics.close <= 0) return;
    if (isBear) {
      if (!Number.isFinite(metrics?.corridorLow) || metrics.corridorLow <= 0) {
        pushLog("SKIP", symbol, "missing corridor low");
        return;
      }
    } else if (
      !Number.isFinite(metrics?.corridorHigh) ||
      metrics.corridorHigh <= 0
    ) {
      pushLog("SKIP", symbol, "missing corridor high");
      return;
    }
    if (hasOpen(symbol)) {
      pushLog("SKIP", symbol, "position already open");
      return;
    }
    if (isSymbolBlocked(symbol, state.config.blockedSymbols)) {
      pushLog("SKIP", symbol, "symbol blocked");
      return;
    }
    if (state.openPositions.length >= state.config.maxOpenPositions) {
      pushLog("SKIP", symbol, "max open positions reached");
      return;
    }
    if (!tryAcquireOpenSlot(symbol)) return;

    const cfg = state.config;
    const entryEst = metrics.close;
    const exitsEst = resolveExitLevels(signalKind, metrics, entryEst, cfg, {
      mark: entryEst,
      modelScope: MODEL_SCOPE,
    });
    if (exitsEst.rejectReason) {
      pushLog("SKIP", symbol, exitsEst.rejectReason);
      pendingSymbols.delete(symbol);
      return;
    }
    if (!exitsEst.stopLoss || !exitsEst.takeProfit) {
      pendingSymbols.delete(symbol);
      return;
    }

    const quality = evaluateEntryQuality(
      signalKind,
      metrics,
      entryEst,
      exitsEst.stopLoss,
      exitsEst.takeProfit,
      cfg
    );
    if (!quality.pass) {
      pushLog("SKIP", symbol, quality.detail || "entry quality");
      pendingSymbols.delete(symbol);
      return;
    }

    if (
      (signalKind === "sfp" || signalKind === "sfp_bear") &&
      sfpRegimeMonitor &&
      cfg.aiSfpRegimeEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const regimeGate = sfpRegimeMonitor.checkSymbol(
        symbol,
        cfg,
        bars,
        metrics,
        signalKind
      );
      if (!regimeGate.pass) {
        pushLog(
          "SKIP",
          symbol,
          regimeGate.detail
            ? `SFP regime AI: ${regimeGate.detail}`
            : "SFP regime AI: bad market conditions"
        );
        pendingSymbols.delete(symbol);
        return;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      pullbackRegimeMonitor &&
      cfg.aiPullbackRegimeEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const regimeGate = pullbackRegimeMonitor.checkSymbol(
        symbol,
        cfg,
        bars,
        metrics,
        signalKind
      );
      if (!regimeGate.pass) {
        pushLog(
          "SKIP",
          symbol,
          regimeGate.detail
            ? `Pullback regime AI: ${regimeGate.detail}`
            : "Pullback regime AI: bad market conditions"
        );
        pendingSymbols.delete(symbol);
        return;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      pullbackPatternBreakMonitor &&
      cfg.aiPullbackPatternBreakEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const breakGate = pullbackPatternBreakMonitor.checkSymbol(
        symbol,
        cfg,
        bars,
        metrics,
        signalKind
      );
      if (!breakGate.pass) {
        pushLog(
          "SKIP",
          symbol,
          breakGate.detail
            ? `Pullback pattern break AI: ${breakGate.detail}`
            : "Pullback pattern break AI: setup invalidated"
        );
        pendingSymbols.delete(symbol);
        return;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      cfg.aiPullbackSignalEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const signalGate = evaluatePullbackSignalGate(cfg, bars, {
        metrics,
        signalKind,
        symbol,
        modelScope: MODEL_SCOPE,
        btcBars: getBtcBarsForRegime?.(Date.now()) ?? [],
        asOf: Date.now(),
        getFundingOiAt,
      });
      if (!signalGate.pass) {
        pushLog(
          "SKIP",
          symbol,
          signalGate.detail
            ? `Pullback signal AI: ${signalGate.detail}`
            : "Pullback signal AI: weak setup"
        );
        pendingSymbols.delete(symbol);
        return;
      }
    }

    if (state.config?.extremalSpikeGateEnabled && resolveExtremalSpikeGate) {
      try {
        const spikeGate = await resolveExtremalSpikeGate(
          symbol,
          Date.now(),
          state.config,
          { positionSide: side }
        );
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

      const decidedAt = Date.now();
      const prep = await trader.prepareSymbol(symbol, cfg.leverage);
      const openPositionSide = isBear ? "SHORT" : "LONG";
      const order = await trader.marketOrder(symbol, openSide, quantity, {
        markPrice: entryEst,
        positionSide: openPositionSide,
      });

      let exPos = null;
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 200));
        exPos = await trader.getPosition(symbol, {
          force: true,
          sideHint: openPositionSide,
        });
        if (exPos && Math.abs(exPos.positionAmt) > 0) break;
      }
      const opened = exPos && Math.abs(exPos.positionAmt) > 0;
      if (!opened) {
        throw new Error(`Market ${openSide} did not open position on exchange`);
      }

      const exchangeOpenedAt =
        Number(exPos?.updateTime) ||
        Number(order?.updateTime) ||
        Number(order?.transactTime) ||
        Date.now();
      const openDelaySec = Math.max(0, (exchangeOpenedAt - decidedAt) / 1000);

      const entryPrice = exPos.entryPrice || entryEst;
      const qty = Math.abs(exPos.positionAmt);
      const mark = exPos.markPrice ?? entryPrice;
      const meta = await trader.getSymbolMeta(symbol);
      const exits = resolveExitLevels(signalKind, metrics, entryPrice, cfg, {
        mark,
        tickSize: meta.tickSize,
        modelScope: MODEL_SCOPE,
      });
      let sl = trader.formatPrice(exits.stopLoss, meta) ?? exits.stopLoss;
      let tp = trader.formatPrice(exits.takeProfit, meta) ?? exits.takeProfit;
      const pos = normalizeLiveOpenPosition({
        id: `${symbol}-${Date.now()}`,
        symbol,
        signalKind,
        side,
        entryPrice,
        initialEntryPrice: entryPrice,
        quantity: qty,
        botQuantity: qty,
        margin: notional / cfg.leverage,
        leverage: prep.leverage,
        marginType: "ISOLATED",
        addCount: 0,
        corridorLow: metrics.corridorLow,
        corridorHigh: metrics.corridorHigh,
        sweepLow: metrics.sweepLow ?? null,
        sweepHigh: metrics.sweepHigh ?? null,
        stopLoss: sl,
        initialStopLoss: sl,
        takeProfit: tp,
        lastPrice: entryPrice,
        peakPrice: entryPrice,
        troughPrice: entryPrice,
        unrealizedPnl: exPos.unrealizedProfit ?? 0,
        decidedAt,
        exchangeOpenedAt,
        openDelaySec: +openDelaySec.toFixed(2),
        openedAt: exchangeOpenedAt,
        entryOrderId: order?.orderId ?? null,
        exitMethod: exits.exitMethod ?? null,
        aiSlPct: exits.aiSlPct ?? null,
        aiTpPct: exits.aiTpPct ?? null,
        signalSnapshot: pickSignalSnapshot(metrics),
      });
      seedPositionExitContext(pos, metrics);

      const exitResult = await placeExitOrdersWithRetry(pos);
      if (!exitResult.ok) {
        await abortOpenWithoutExits(pos, exitResult.detail);
        return;
      }

      if (hasOpen(symbol)) {
        pushLog("SKIP", symbol, "position already open (race)");
        return;
      }
      if (state.openPositions.length >= state.config.maxOpenPositions) {
        pushLog("SKIP", symbol, "max open positions reached (race)");
        return;
      }

      state.openPositions.push(pos);
      pushLog(
        "OPEN",
        symbol,
        `${side} ${signalKind} · ${qty} @ ~${entryPrice.toFixed(6)} · ${prep.leverage}x isolated · margin ~$${pos.margin.toFixed(2)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)}${exits.exitMethod && exits.exitMethod !== "corridor" ? ` · ${exits.exitMethod}` : ""}`
      );
      persistSoon();
    } catch (e) {
      pushLog("ERROR", symbol, e.message || String(e));
      console.error(`Live bot OPEN ${symbol}:`, e.message);
    } finally {
      pendingSymbols.delete(symbol);
    }
  }

  function onSfpSignal(sym, metrics) {
    if (!state.config.tradeSfpSignals) return;
    void tryOpen(sym, "sfp", metrics);
  }

  function onSfpBearSignal(sym, metrics) {
    if (!state.config.tradeBearishSfpSignals) return;
    void tryOpen(sym, "sfp_bear", metrics);
  }

  function onPullbackSignal(sym, metrics) {
    if (!state.config.tradePullbackSignals) return;
    void tryOpen(sym, "pullback", metrics);
  }

  function onPullbackBearSignal(sym, metrics) {
    if (!state.config.tradeBearishPullbackSignals) return;
    void tryOpen(sym, "pullback_bear", metrics);
  }

  async function tryAddToPosition(pos, price) {
    const cfg = state.config;
    if (!cfg.armed) return false;
    if (isShort(pos)) return false;
    const gate = addOnEntryAllowed(cfg, pos, price);
    if (!gate.ok) return false;

    try {
      const bal = await trader.getUsdtBalance();
      const available = bal.available ?? bal.wallet ?? 0;
      const newLeverage = nextLeverageAfterAddOn(pos.leverage, cfg.addOnLeverageBoost);
      const addMargin = positionMarginFromConfig(
        available,
        cfg.addOnMarginUsdt,
        MIN_MARGIN_USDT
      );
      if (!addMargin) return false;
      const prep = await trader.prepareSymbol(pos.symbol, newLeverage);
      const addNotional = addMargin * prep.leverage;
      const addQty = addNotional / price;

      await trader.marketOrder(pos.symbol, "BUY", addQty, { markPrice: price });
      const exPos = await trader.getPosition(pos.symbol);
      if (!exPos) return false;

      pos.quantity = Math.abs(exPos.positionAmt);
      pos.botQuantity = pos.quantity;
      pos.entryPrice = exPos.entryPrice;
      pos.margin += addNotional / prep.leverage;
      pos.leverage = exPos.leverage ?? prep.leverage;
      pos.addCount = 1;
      pos.unrealizedPnl = exPos.unrealizedProfit ?? 0;

      const slMove = moveStopAfterAddOn(pos, cfg.moveStopOffsetPct);
      const tpMove = takeProfitAfterAddOn(pos, cfg);
      await replaceExitOrders(pos);
      pushLog(
        "ADD",
        pos.symbol,
        `+$${addMargin.toFixed(2)} @ ${pos.leverage}x @ ${price.toFixed(6)} · qty ${pos.quantity} · avg ${pos.entryPrice.toFixed(6)}`
      );
      if (slMove) {
        pushLog(
          "MOVE_SL",
          pos.symbol,
          `SL → ${slMove.targetSl.toFixed(6)} after add`
        );
      }
      if (tpMove) {
        pushLog(
          "MOVE_TP",
          pos.symbol,
          `TP → ${tpMove.targetTp.toFixed(6)} after add`
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
    normalizeLiveOpenPosition(pos);
    if (pos.moveStopRaised) return false;
    const movePct = favorableMovePct(pos, price);
    if (movePct == null || movePct < cfg.moveStopAfterMovePct) return false;

    const rawTarget = isShort(pos)
      ? entryBasedStopPriceShort(pos.initialEntryPrice, cfg.moveStopOffsetPct)
      : entryBasedStopPrice(pos.initialEntryPrice, cfg.moveStopOffsetPct);
    if (!Number.isFinite(rawTarget)) return false;

    let meta;
    try {
      meta = await trader.getSymbolMeta(pos.symbol);
    } catch (e) {
      pushLog("WARN", pos.symbol, `move SL meta: ${e.message}`);
      return false;
    }

    const targetSl = trader.formatPrice(rawTarget, meta) ?? rawTarget;
    if (!Number.isFinite(targetSl)) return false;
    if (pricesCloseEnough(targetSl, pos.stopLoss, meta.tickSize)) {
      pos.moveStopRaised = true;
      return false;
    }
    if (isShort(pos)) {
      if (targetSl >= pos.stopLoss) return false;
    } else if (targetSl <= pos.stopLoss) {
      return false;
    }

    const prev = pos.stopLoss;
    try {
      pos.stopLoss = targetSl;
      pos.moveStopRaised = true;
      await replaceExitOrders(pos);
      pushLog(
        "MOVE_SL",
        pos.symbol,
        `SL ${prev.toFixed(6)} → ${targetSl.toFixed(6)} after +${movePct.toFixed(2)}%`
      );
      return true;
    } catch (e) {
      pos.stopLoss = prev;
      pos.moveStopRaised = false;
      pushLog("ERROR", pos.symbol, `move SL: ${e.message}`);
      return false;
    }
  }

  async function reconcilePosition(pos, bar, opts = {}) {
    const { barClosed = false, forceSync = false } = opts;
    const close = bar?.close;
    const low = bar?.low ?? close;
    const high = bar?.high ?? close;

    if (Number.isFinite(close)) {
      pos.lastPrice = close;
      pos.movePctFromEntry = +(
        favorableMovePct(pos, close) ?? 0
      ).toFixed(3);
      pos.unrealizedPnl = +positionPnl(pos, close).toFixed(4);
    }
    if (Number.isFinite(high) || Number.isFinite(low)) {
      updatePriceExtremes(pos, high, low, close);
    }

    const now = Date.now();
    const lastSync = positionSyncAt.get(pos.id) ?? 0;
    const shouldSync =
      forceSync || barClosed || now - lastSync >= POSITION_SYNC_MS;

    let exPos = null;
    let syncOk = false;
    if (shouldSync) {
      const sideHint = isShort(pos) ? "SHORT" : "LONG";
      try {
        exPos = await trader.getPosition(pos.symbol, { sideHint });
        syncOk = true;
        positionSyncAt.set(pos.id, now);
      } catch (e) {
        pushLog("WARN", pos.symbol, `position sync: ${e.message}`);
      }

      if (syncOk && !exPos) {
        await recordExchangeClose(pos, close ?? pos.lastPrice ?? pos.entryPrice);
        return;
      }

      if (exPos) {
        const exQty = Math.abs(exPos.positionAmt);
        if (isExternalQuantityIncrease(pos, exQty)) {
          const botQty = pos.botQuantity ?? pos.quantity;
          forgetPositionsFromBot(
            [pos],
            `Auto-forgot: exchange qty ${exQty} > bot qty ${botQty} (increased outside) · symbol auto-blocked`
          );
          flush();
          return;
        }
        pos.quantity = exQty;
        pos.entryPrice = exPos.entryPrice;
        pos.lastPrice = exPos.markPrice ?? close ?? pos.lastPrice;
        pos.unrealizedPnl = +(exPos.unrealizedProfit ?? 0).toFixed(4);
        pos.leverage = exPos.leverage ?? pos.leverage;
        pos.movePctFromEntry = +(
          favorableMovePct(pos, pos.lastPrice) ?? 0
        ).toFixed(3);
      }

      if (syncOk) {
        await ensurePositionExitOrders(pos, { exPos });
      }
    }

    const favPrice = isShort(pos) ? low : high;
    if (Number.isFinite(favPrice)) await tryMoveStopLoss(pos, favPrice);
    if (Number.isFinite(high) && !isShort(pos)) await tryAddToPosition(pos, high);

    if (bar) {
      const tickBar = {
        openTime: bar.openTime,
        closeTime: bar.closeTime,
        open: bar.open,
        high,
        low,
        close,
        volume: bar.volume,
      };
      tickBarProgress(pos, tickBar, state.config);
      const recentBars = getRecentBars?.(pos.symbol, 12) ?? [];
      const aiExit = evaluateAiEarlyExit(state.config, pos, tickBar, {
        recentBars,
        modelScope: MODEL_SCOPE,
      });
      if (aiExit) {
        pushLog("CLOSE", pos.symbol, `${aiExit.reason}: ${aiExit.detail}`);
        await closeOnExchange(pos, aiExit.reason, aiExit.exitPrice);
        return;
      }

      const pbEarly = evaluatePullbackEarlyInvalidation(state.config, pos, tickBar);
      if (pbEarly) {
        pushLog("CLOSE", pos.symbol, `${pbEarly.reason}: ${pbEarly.detail}`);
        await closeOnExchange(pos, pbEarly.reason, pbEarly.exitPrice);
        return;
      }
    }

    const ohlc = { high, low, close };
    if (stopLossHit(ohlc, pos)) {
      await closeOnExchange(pos, "stop_loss", pos.stopLoss);
      return;
    }
    if (takeProfitHit(ohlc, pos)) {
      await closeOnExchange(pos, "take_profit", pos.takeProfit);
    }
  }

  async function updatePrices(getBar, symbolFilter = null, opts = {}) {
    maybeRollDailyHistory();
    if (!state.openPositions.length) return;
    if (busy) return;
    busy = true;
    let changed = false;
    try {
      const snapshot = [...state.openPositions];
      for (const pos of snapshot) {
        if (!state.openPositions.some((p) => p.id === pos.id)) continue;
        if (symbolFilter && pos.symbol !== symbolFilter) continue;
        const bar = getBar(pos.symbol);
        if (!bar?.close) continue;
        await reconcilePosition(pos, bar, opts);
        changed = true;
      }
    } finally {
      busy = false;
      if (changed) persistSoon();
      await maybeCheckDrawdownStop();
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

  function blockSymbolForForget(symbol) {
    const sym = String(symbol ?? "")
      .trim()
      .toUpperCase();
    if (!sym) return;
    const list = normalizeBlockedSymbols(state.config.blockedSymbols);
    if (list.includes(sym)) return;
    state.config.blockedSymbols = [...list, sym];
  }

  function forgetPositionsFromBot(positions, detail) {
    const forgottenIds = [];
    for (const pos of positions) {
      forgottenIds.push(pos.id);
      state.openPositions = state.openPositions.filter((p) => p.id !== pos.id);
      exitEnsureAt.delete(pos.id);
      positionSyncAt.delete(pos.id);
      pendingSymbols.delete(pos.symbol);
      blockSymbolForForget(pos.symbol);
      if (detail) pushLog("FORGET", pos.symbol, detail);
    }
    if (forgottenIds.length) {
      historyStore?.removeTradeIds?.(forgottenIds);
      persistSoon();
    }
    return forgottenIds;
  }

  /** Drop open position(s) from bot stats without closing on the exchange. */
  async function forgetOpenPositions(symbol = null) {
    const symFilter = symbol
      ? String(symbol).trim().toUpperCase()
      : null;
    const toForget = symFilter
      ? state.openPositions.filter((p) => p.symbol === symFilter)
      : [...state.openPositions];
    if (symFilter && !toForget.length) {
      throw new Error(`No bot position for ${symFilter}`);
    }
    if (!toForget.length) {
      return getPublicStateAsync();
    }

    const symbols = toForget.map((p) => p.symbol).join(", ");
    const detail = symFilter
      ? "Removed from bot stats (exchange unchanged) · symbol auto-blocked"
      : `Cleared ${toForget.length} open position(s) from bot stats: ${symbols} · auto-blocked`;

    if (symFilter) {
      forgetPositionsFromBot(toForget, detail);
    } else {
      forgetPositionsFromBot(toForget, null);
      pushLog("FORGET", "—", detail);
    }

    flush();
    return getPublicStateAsync();
  }

  async function syncFromExchange() {
    if (!trader.enabled) throw new Error("API not configured");
    trader.invalidateRestCache?.();
    const positionMap = trader.getPositionMap
      ? await trader.getPositionMap({ force: true })
      : null;
    const still = [];
    for (const pos of state.openPositions) {
      const exPos = positionMap?.get(pos.symbol) ?? (await trader.getPosition(pos.symbol, { force: true }));
      if (exPos && Math.abs(exPos.positionAmt) > 0) {
        const exQty = Math.abs(exPos.positionAmt);
        if (isExternalQuantityIncrease(pos, exQty)) {
          const botQty = pos.botQuantity ?? pos.quantity;
          forgetPositionsFromBot(
            [pos],
            `Auto-forgot: exchange qty ${exQty} > bot qty ${botQty} (increased outside) · symbol auto-blocked`
          );
          continue;
        }
        pos.quantity = exQty;
        pos.entryPrice = exPos.entryPrice;
        pos.unrealizedPnl = exPos.unrealizedProfit ?? 0;
        pos.leverage = exPos.leverage;
        pos.lastPrice = exPos.markPrice ?? pos.lastPrice;
        still.push(pos);
        positionSyncAt.set(pos.id, Date.now());
        await ensurePositionExitOrders(pos, { force: true, exPos });
      } else {
        await recordExchangeClose(pos, pos.lastPrice ?? pos.entryPrice);
      }
    }
    state.openPositions = still;
    persistSoon();
    return getPublicStateAsync();
  }

  async function resetHistory() {
    clearBotHistory(BOT_TYPE_LIVE);
    clearDailyHistory("manual");
    return getPublicStateAsync();
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistBotState(BOT_TYPE_LIVE, {
      config: state.config,
      openPositions: state.openPositions,
      symbolSlStreak: state.symbolSlStreak ?? {},
      drawdownBaseline: state.drawdownBaseline,
      drawdownTriggeredAt: state.drawdownTriggeredAt,
      historyDayKey: state.historyDayKey,
    });
  }

  void maybeRollDailyHistory();
  scheduleDailyReset();

  if (state.config.armed && state.config.drawdownStopEnabled) {
    ensureDrawdownBaseline();
    checkDrawdownStop();
  }

  function hasOpenPositions() {
    return state.openPositions.length > 0;
  }

  function hasOpenSymbol(symbol) {
    return state.openPositions.some((p) => p.symbol === symbol);
  }

  return {
    getPublicState: getPublicStateAsync,
    getConfig: () => ({ ...state.config }),
    getClosedTrades: () => state.closedTrades.slice(),
    getActivityLog: () => state.log.slice(),
    hasOpenPositions,
    hasOpenSymbol,
    patchConfig,
    arm,
    disarm,
    onSfpSignal,
    onSfpBearSignal,
    onPullbackSignal,
    onPullbackBearSignal,
    updatePrices,
    closeSymbol,
    closeAll,
    forgetOpenPositions,
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
