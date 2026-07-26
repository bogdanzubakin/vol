const {
  loadBotState,
  persistBotState,
  ensureConfigVersionForBot,
  appendBotEvent,
  persistClosedTrade,
  clearBotHistory,
  BOT_TYPE_PAPER,
} = require("./bot-db-persist");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  normalizeDrawdownConfig,
  drawdownStatus,
  evaluateDrawdownStop,
  closedTradesRealizedPnl,
  formatDrawdownTelegramMessage,
} = require("./bot-drawdown-guard");
const {
  stopLossPrice,
  takeProfitPrice,
  takeProfitPriceShort,
  entryBasedStopPrice,
  entryBasedStopPriceShort,
  wouldLongStopMarketTrigger,
  stopLossFallbackForLong,
  resolveInitialStopLoss,
} = require("./bot-exit-prices");
const { resolveExitLevels } = require("./signal-exit-levels");
const { evaluateEntryQuality } = require("./entry-quality-gate");
const {
  isShort,
  favorableMovePct,
  positionPnl,
  stopLossHit,
  takeProfitHit,
  updatePriceExtremes,
} = require("./position-side");
const {
  normalizeBlockedSymbols,
  isSymbolBlocked,
  recordTradeForSymbolBlocklist,
  normalizeSymbolSlStreak,
} = require("./bot-symbol-blocklist");
const {
  POSITION_EXIT_DEFAULTS,
  normalizePositionExitConfig,
  seedPositionExitContext,
  tickBarProgress,
  postEntryBarExtremes,
  evaluateEarlyAbort,
  processRunnerPhase,
  stopPricesCloseEnough,
} = require("./paper-bot-position-exits");
const { normalizeSideOverrides } = require("./side-config");
const { pickSignalSnapshot } = require("./signal-snapshot");
const {
  AI_EXIT_DEFAULTS,
  normalizeAiExitConfig,
  evaluateAiEarlyExit,
} = require("./early-exit-model");
const { trackExitPathOnBar, summarizeTradeExitPath } = require("./early-exit-path-oracle");
const {
  SFP_REGIME_DEFAULTS,
  normalizeSfpRegimeConfig,
} = require("./sfp-regime-model");
const {
  PULLBACK_REGIME_DEFAULTS,
  normalizePullbackRegimeConfig,
} = require("./pullback-regime-model");
const {
  PULLBACK_PATTERN_BREAK_DEFAULTS,
  normalizePullbackPatternBreakConfig,
} = require("./pullback-pattern-break-model");
const {
  PB_EARLY_INVALIDATION_DEFAULTS,
  normalizePullbackEarlyInvalidationConfig,
  evaluatePullbackEarlyInvalidation,
} = require("./pullback-early-invalidation");
const {
  PULLBACK_SIGNAL_DEFAULTS,
  normalizePullbackSignalConfig,
  evaluatePullbackSignalGate,
} = require("./pullback-signal-model");
const {
  AI_EXIT_LEVELS_DEFAULTS,
  normalizeAiExitLevelsConfig,
} = require("./ai-exit-levels");


/** AI model scope for every model evaluation in this bot (paper vs live weights). */
const MODEL_SCOPE = "paper";

const { FOI_DEFAULTS, normalizeFoiConfig, foiUtcHourAllows } = require("./foi-signal");
const {
  FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
  normalizeFoiFollowthroughRegimeConfig,
  createFoiFollowthroughRegimeTracker,
  isFoiSignalKind,
  applyFoiHotTpProtect,
} = require("./foi-followthrough-regime");
const {
  FOI_BTC_LOOKALIKE_DEFAULTS,
  normalizeFoiBtcLookalikeConfig,
  foiBtcLookalikeAllows,
} = require("./foi-btc-lookalike");
const {
  FOI_COLD_DAY_DEFAULTS,
  normalizeFoiColdDayConfig,
  createFoiColdDayTracker,
} = require("./foi-cold-day-regime");

const DEFAULT_CONFIG = {
  enabled: false,
  initialDeposit: 1000,
  leverage: 1,
  positionSizeUsdt: 70,
  stopLossBelowCorridorPct: 2,
  stopLossFallbackPnlPct: 2,
  takeProfitPct: 5,
  takeProfitMinPct: 1.5,
  /** Widen smart SL if closer than this % below entry (reduces noise stop-outs). */
  minSmartStopDistancePct: 0.8,
  /** Skip SFP entries when local corridor width exceeds this % (0 = off). */
  maxSfpCorridorWidthPct: 13,
  /** SFP take-profit cap % (uses takeProfitPct when unset). */
  sfpTakeProfitPct: 4.5,
  /** Skip pullback when local corridor width exceeds this % (0 = off). */
  maxPullbackCorridorWidthPct: 20,
  smartExitLevelsEnabled: true,
  extremalSpikeGateEnabled: false,
  tradeSfpSignals: true,
  tradeBearishSfpSignals: true,
  tradePullbackSignals: true,
  tradeBearishPullbackSignals: true,
  ...FOI_DEFAULTS,
  ...FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
  ...FOI_BTC_LOOKALIKE_DEFAULTS,
  ...FOI_COLD_DAY_DEFAULTS,
  addOnEnabled: false,
  addOnMarginUsdt: 6,
  addOnMovePct: 5,
  addOnLeverageBoost: 1,
  /** 0 = off. Require peak price (high) ≥ this % from initial entry before add-on. */
  addOnMinPeakPct: 0,
  /** Only add after move-stop has raised SL toward entry (moveStopEnabled required). */
  addOnOnlyAfterMoveStop: false,
  moveStopEnabled: true,
  moveStopAfterMovePct: 1.2,
  moveStopOffsetPct: 0,
  drawdownStopEnabled: false,
  drawdownStopPct: 4,
  /** Skip entries on these USDT-M symbols (manual + auto-blocked). */
  blockedSymbols: [],
  /** Auto-add symbol to blockedSymbols after this many consecutive SL exits (0 = off). */
  autoBlockAfterConsecutiveSl: 2,
  /** Cap simultaneous open positions (null = no cap; live bot always enforces). */
  maxOpenPositions: null,
  ...POSITION_EXIT_DEFAULTS,
  ...AI_EXIT_DEFAULTS,
  ...SFP_REGIME_DEFAULTS,
  ...PULLBACK_REGIME_DEFAULTS,
  ...PULLBACK_PATTERN_BREAK_DEFAULTS,
  ...PB_EARLY_INVALIDATION_DEFAULTS,
  ...PULLBACK_SIGNAL_DEFAULTS,
  ...AI_EXIT_LEVELS_DEFAULTS,
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function migratePositionSizeUsdt(raw) {
  if (raw.positionSizeUsdt !== undefined) {
    return clamp(num(raw.positionSizeUsdt, DEFAULT_CONFIG.positionSizeUsdt), 1, 1_000_000);
  }
  if (raw.positionSizePct !== undefined) {
    const deposit = num(raw.initialDeposit, DEFAULT_CONFIG.initialDeposit);
    const pct = num(raw.positionSizePct, 1);
    return clamp((deposit * pct) / 100, 1, 1_000_000);
  }
  return DEFAULT_CONFIG.positionSizeUsdt;
}

function migrateAddOnMarginUsdt(raw) {
  if (raw.addOnMarginUsdt !== undefined) {
    return clamp(num(raw.addOnMarginUsdt, DEFAULT_CONFIG.addOnMarginUsdt), 1, 1_000_000);
  }
  if (raw.addOnDepositPct !== undefined) {
    const deposit = num(raw.initialDeposit, DEFAULT_CONFIG.initialDeposit);
    return clamp((deposit * num(raw.addOnDepositPct, 1)) / 100, 1, 1_000_000);
  }
  return DEFAULT_CONFIG.addOnMarginUsdt;
}

function nextLeverageAfterAddOn(currentLev, boost) {
  return clamp(
    Math.round(num(currentLev, 1) + Math.round(num(boost, 0))),
    1,
    125
  );
}

/** Fixed USDT margin per entry, capped by free balance / available USDT. */
function positionMarginFromConfig(balanceOrAvailable, positionSizeUsdt, minMargin = 1, sizeScale = 1) {
  const configured = clamp(
    num(positionSizeUsdt, DEFAULT_CONFIG.positionSizeUsdt),
    1,
    1_000_000
  );
  const scale = clamp(num(sizeScale, 1), 0, 1);
  const margin = Math.min(balanceOrAvailable, configured * scale);
  return margin >= minMargin ? margin : 0;
}

function normalizeConfig(rawInput) {
  const raw = rawInput ?? {};
  return {
    enabled: Boolean(raw.enabled),
    initialDeposit: clamp(num(raw.initialDeposit, DEFAULT_CONFIG.initialDeposit), 10, 1_000_000),
    leverage: clamp(Math.round(num(raw.leverage, DEFAULT_CONFIG.leverage)), 1, 125),
    positionSizeUsdt: migratePositionSizeUsdt(raw),
    stopLossBelowCorridorPct: clamp(
      num(raw.stopLossBelowCorridorPct, DEFAULT_CONFIG.stopLossBelowCorridorPct),
      0.1,
      50
    ),
    stopLossFallbackPnlPct: clamp(
      num(raw.stopLossFallbackPnlPct, DEFAULT_CONFIG.stopLossFallbackPnlPct),
      0.1,
      50
    ),
    takeProfitPct: clamp(num(raw.takeProfitPct, DEFAULT_CONFIG.takeProfitPct), 0.1, 200),
    takeProfitMinPct: clamp(
      num(raw.takeProfitMinPct, DEFAULT_CONFIG.takeProfitMinPct),
      0,
      200
    ),
    minSmartStopDistancePct: clamp(
      num(raw.minSmartStopDistancePct, DEFAULT_CONFIG.minSmartStopDistancePct),
      0,
      10
    ),
    maxSfpCorridorWidthPct: clamp(
      num(raw.maxSfpCorridorWidthPct, DEFAULT_CONFIG.maxSfpCorridorWidthPct),
      0,
      100
    ),
    sfpTakeProfitPct: clamp(
      num(raw.sfpTakeProfitPct, DEFAULT_CONFIG.sfpTakeProfitPct),
      0.1,
      200
    ),
    maxPullbackCorridorWidthPct: (() => {
      const sfpCw = clamp(
        num(raw.maxSfpCorridorWidthPct, DEFAULT_CONFIG.maxSfpCorridorWidthPct),
        0,
        100
      );
      let pbCw = num(
        raw.maxPullbackCorridorWidthPct,
        raw.maxPullbackCorridorWidthPct !== undefined
          ? DEFAULT_CONFIG.maxPullbackCorridorWidthPct
          : sfpCw
      );
      // Pullback cap was not exposed in UI; old saves kept default 10 while SFP was raised.
      if (
        raw.maxPullbackCorridorWidthPct !== undefined &&
        pbCw === 10 &&
        sfpCw > 10
      ) {
        pbCw = sfpCw;
      }
      return clamp(pbCw, 0, 100);
    })(),
    smartExitLevelsEnabled:
      raw.smartExitLevelsEnabled !== undefined
        ? Boolean(raw.smartExitLevelsEnabled)
        : DEFAULT_CONFIG.smartExitLevelsEnabled,
    extremalSpikeGateEnabled:
      raw.extremalSpikeGateEnabled !== undefined
        ? Boolean(raw.extremalSpikeGateEnabled)
        : DEFAULT_CONFIG.extremalSpikeGateEnabled,
    tradeSfpSignals:
      raw.tradeSfpSignals !== undefined
        ? Boolean(raw.tradeSfpSignals)
        : DEFAULT_CONFIG.tradeSfpSignals,
    tradeBearishSfpSignals:
      raw.tradeBearishSfpSignals !== undefined
        ? Boolean(raw.tradeBearishSfpSignals)
        : DEFAULT_CONFIG.tradeBearishSfpSignals,
    tradePullbackSignals:
      raw.tradePullbackSignals !== undefined
        ? Boolean(raw.tradePullbackSignals)
        : DEFAULT_CONFIG.tradePullbackSignals,
    tradeBearishPullbackSignals:
      raw.tradeBearishPullbackSignals !== undefined
        ? Boolean(raw.tradeBearishPullbackSignals)
        : DEFAULT_CONFIG.tradeBearishPullbackSignals,
    ...normalizeFoiConfig(raw),
    ...normalizeFoiFollowthroughRegimeConfig({
      ...FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
      ...raw,
    }),
    ...normalizeFoiBtcLookalikeConfig({
      ...FOI_BTC_LOOKALIKE_DEFAULTS,
      ...raw,
    }),
    ...normalizeFoiColdDayConfig({
      ...FOI_COLD_DAY_DEFAULTS,
      ...raw,
    }),
    addOnEnabled: Boolean(raw.addOnEnabled),
    addOnMarginUsdt: migrateAddOnMarginUsdt(raw),
    addOnMovePct: clamp(num(raw.addOnMovePct, DEFAULT_CONFIG.addOnMovePct), 0.1, 100),
    addOnLeverageBoost: clamp(
      Math.round(num(raw.addOnLeverageBoost, DEFAULT_CONFIG.addOnLeverageBoost)),
      0,
      124
    ),
    addOnMinPeakPct: clamp(num(raw.addOnMinPeakPct, DEFAULT_CONFIG.addOnMinPeakPct), 0, 100),
    addOnOnlyAfterMoveStop: Boolean(raw.addOnOnlyAfterMoveStop),
    moveStopEnabled:
      raw.moveStopEnabled !== undefined
        ? Boolean(raw.moveStopEnabled)
        : DEFAULT_CONFIG.moveStopEnabled,
    moveStopAfterMovePct: clamp(
      num(raw.moveStopAfterMovePct, DEFAULT_CONFIG.moveStopAfterMovePct),
      0.1,
      100
    ),
    moveStopOffsetPct: clamp(
      num(raw.moveStopOffsetPct, DEFAULT_CONFIG.moveStopOffsetPct),
      -20,
      20
    ),
    blockedSymbols: normalizeBlockedSymbols(raw.blockedSymbols),
    autoBlockAfterConsecutiveSl: clamp(
      Math.round(num(raw.autoBlockAfterConsecutiveSl, DEFAULT_CONFIG.autoBlockAfterConsecutiveSl)),
      0,
      50
    ),
    maxOpenPositions:
      raw.maxOpenPositions === undefined ||
      raw.maxOpenPositions === null ||
      raw.maxOpenPositions === ""
        ? DEFAULT_CONFIG.maxOpenPositions
        : clamp(Math.round(num(raw.maxOpenPositions, 12)), 1, 100),
    ...normalizePositionExitConfig({ ...POSITION_EXIT_DEFAULTS, ...raw }),
    ...normalizeAiExitConfig({ ...AI_EXIT_DEFAULTS, ...raw }),
    ...normalizeSfpRegimeConfig({ ...SFP_REGIME_DEFAULTS, ...raw }),
    ...normalizePullbackRegimeConfig({ ...PULLBACK_REGIME_DEFAULTS, ...raw }),
    ...normalizePullbackPatternBreakConfig({ ...PULLBACK_PATTERN_BREAK_DEFAULTS, ...raw }),
    ...normalizePullbackEarlyInvalidationConfig({ ...PB_EARLY_INVALIDATION_DEFAULTS, ...raw }),
    ...normalizePullbackSignalConfig({ ...PULLBACK_SIGNAL_DEFAULTS, ...raw }),
    ...normalizeAiExitLevelsConfig({ ...AI_EXIT_LEVELS_DEFAULTS, ...raw }),
    ...normalizeDrawdownConfig({ ...DEFAULT_CONFIG, ...raw }),
    ...normalizeSideOverrides(raw),
  };
}

function exitReasonLabel(reason) {
  if (reason === "take_profit") return "TP";
  if (reason === "stop_loss") return "SL";
  if (reason === "early_invalidation") return "early inv";
  if (reason === "early_stall") return "early stall";
  if (reason === "early_adverse") return "early adv";
  if (reason === "runner_exit") return "runner";
  if (reason === "ai_early_exit" || reason === "ai_early_exit_hard") return "AI hard";
  if (reason === "ai_early_exit_soft") return "AI soft";
  if (reason === "manual") return "manual";
  return reason || "—";
}

function movePctFromEntry(price, initialEntry) {
  if (!Number.isFinite(price) || !Number.isFinite(initialEntry) || initialEntry <= 0) {
    return null;
  }
  return ((price - initialEntry) / initialEntry) * 100;
}

function openPositionForPersist(pos) {
  const { exitPathTracker, ...rest } = pos;
  return rest;
}

function normalizeOpenPosition(pos) {
  if (pos.initialEntryPrice == null) pos.initialEntryPrice = pos.entryPrice;
  if (pos.addCount == null) pos.addCount = 0;
  if (pos.leverage == null) pos.leverage = 1;
  if (pos.moveStopRaised == null) pos.moveStopRaised = false;
  if (pos.initialStopLoss == null && pos.stopLoss != null) {
    pos.initialStopLoss = pos.stopLoss;
  }
  seedPositionExitContext(pos);
  return pos;
}

function moveStopAfterAddOn(pos, offsetPct) {
  normalizeOpenPosition(pos);
  const targetSl = isShort(pos)
    ? entryBasedStopPriceShort(pos.entryPrice, offsetPct)
    : entryBasedStopPrice(pos.entryPrice, offsetPct);
  if (!Number.isFinite(targetSl)) return null;
  if (isShort(pos)) {
    if (
      targetSl >= pos.stopLoss ||
      stopPricesCloseEnough(targetSl, pos.stopLoss, pos.entryPrice)
    ) {
      return null;
    }
  } else if (
    targetSl <= pos.stopLoss ||
    stopPricesCloseEnough(targetSl, pos.stopLoss, pos.entryPrice)
  ) {
    return null;
  }
  const prev = pos.stopLoss;
  pos.stopLoss = targetSl;
  pos.moveStopRaised = true;
  return { prev, targetSl };
}

function takeProfitPctForSignal(signalKind, cfg) {
  const { cfgForSignal } = require("./side-config");
  cfg = cfgForSignal(cfg, signalKind);
  const base = cfg.takeProfitPct ?? DEFAULT_CONFIG.takeProfitPct;
  if (
    (signalKind === "sfp" ||
      signalKind === "sfp_bear" ||
      signalKind === "foi" ||
      signalKind === "foi_bear") &&
    Number(cfg.sfpTakeProfitPct) > 0
  ) {
    // FOI with SFP confirm uses sfp TP cap; pullback confirm still benefits from tighter cap.
    return Math.min(cfg.sfpTakeProfitPct, base);
  }
  return base;
}

/** Recalculate TP from average entry after add-on. */
function takeProfitAfterAddOn(pos, cfg) {
  normalizeOpenPosition(pos);
  const entry = pos.entryPrice;
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const tpPct = takeProfitPctForSignal(pos.signalKind, cfg);
  const floorPct =
    cfg.takeProfitMinPct > 0
      ? Math.min(cfg.takeProfitMinPct, tpPct)
      : tpPct * 0.65;
  const usePct = Math.max(tpPct, floorPct);

  let targetTp = isShort(pos)
    ? takeProfitPriceShort(entry, usePct)
    : takeProfitPrice(entry, usePct);
  if (!Number.isFinite(targetTp)) return null;
  if (isShort(pos)) {
    if (targetTp >= entry) {
      const minPct = floorPct > 0 ? floorPct : 0.1;
      targetTp = takeProfitPriceShort(entry, minPct);
    }
    if (!Number.isFinite(targetTp) || targetTp >= entry) return null;
    const prev = pos.takeProfit;
    if (Number.isFinite(prev) && prev < entry && prev < targetTp) {
      targetTp = prev;
    }
  } else {
    if (targetTp <= entry) {
      const minPct = floorPct > 0 ? floorPct : 0.1;
      targetTp = takeProfitPrice(entry, minPct);
    }
    if (!Number.isFinite(targetTp) || targetTp <= entry) return null;
    const prev = pos.takeProfit;
    if (Number.isFinite(prev) && prev > entry && prev > targetTp) {
      targetTp = prev;
    }
  }
  if (Math.abs(targetTp - pos.takeProfit) <= Math.max(1e-8, entry * 1e-8)) {
    return null;
  }

  const prev = pos.takeProfit;
  pos.takeProfit = targetTp;
  return { prev, targetTp };
}

function longTakeProfitHit(high, pos) {
  return takeProfitHit({ high, low: high, close: high }, pos);
}

function positionPeakMovePct(pos, price) {
  normalizeOpenPosition(pos);
  const peak = pos.peakPrice ?? price;
  return movePctFromEntry(peak, pos.initialEntryPrice);
}

/** Gate checks before scaling into a LONG (add-on). */
function addOnEntryAllowed(cfg, pos, price) {
  if (!cfg?.addOnEnabled) return { ok: false, reason: "disabled" };
  normalizeOpenPosition(pos);
  if (pos.addCount >= 1) return { ok: false, reason: "already added" };

  const movePct = favorableMovePct(pos, price);
  if (movePct == null || movePct < 0) return { ok: false, reason: "against entry" };
  if (movePct < cfg.addOnMovePct) return { ok: false, reason: "move threshold" };

  const minPeak = num(cfg.addOnMinPeakPct, 0);
  if (minPeak > 0) {
    const peakPct = positionPeakMovePct(pos, price);
    if (peakPct == null || peakPct < minPeak) {
      return { ok: false, reason: `peak ${peakPct?.toFixed(2) ?? "?"}% < ${minPeak}%` };
    }
  }

  if (cfg.addOnOnlyAfterMoveStop) {
    if (!cfg.moveStopEnabled) return { ok: false, reason: "move stop disabled" };
    if (!pos.moveStopRaised) return { ok: false, reason: "move stop not raised" };
  }

  return { ok: true, movePct };
}

function loadState() {
  return loadBotState(BOT_TYPE_PAPER, () => ({
    config: { ...DEFAULT_CONFIG },
    balance: DEFAULT_CONFIG.initialDeposit,
    openPositions: [],
    closedTrades: [],
    log: [],
    symbolSlStreak: {},
    drawdownBaseline: null,
    drawdownPnlAnchor: 0,
    drawdownTriggeredAt: null,
  }));
}

function createPaperBot(options = {}) {
  const {
    onTradeClosed,
    onDrawdownStop,
    resolveExtremalSpikeGate,
    getRecentBars,
    sfpRegimeMonitor,
    pullbackRegimeMonitor,
    pullbackPatternBreakMonitor,
    getBarsForSymbol,
    getBtcBarsForRegime,
    getFundingOiAt,
  } = options;
  let state = loadState();
  state.config = normalizeConfig(state.config);
  state.balance = num(state.balance, state.config.initialDeposit);
  state.openPositions = (state.openPositions ?? []).map((p) =>
    normalizeOpenPosition({ ...p })
  );
  state.symbolSlStreak = normalizeSymbolSlStreak(state.symbolSlStreak);
  const foiFollowthroughTracker = createFoiFollowthroughRegimeTracker();
  const foiColdDayTracker = createFoiColdDayTracker();
  // Seed from recent closed FOI trades (oldest → newest).
  for (const t of [...(state.closedTrades ?? [])].reverse()) {
    foiFollowthroughTracker.recordClosedTrade(t);
    foiColdDayTracker.recordClosedTrade(t);
  }
  let saveTimer = null;
  let saveGen = 0;
  const pendingSymbols = new Set();
  /** Prevent double close / FOI double-count. */
  const recordedCloseIds = new Set();

  function reconcileBalance() {
    const initial = state.config.initialDeposit;
    const realized = realizedPnl();
    const locked = lockedMargin();
    state.balance = initial + realized - locked;
  }

  reconcileBalance();

  function migrateDrawdownBaseline() {
    if (state.drawdownTriggeredAt) return;
    const ref = state.config.initialDeposit;
    if (
      state.drawdownBaseline != null &&
      Math.abs(state.drawdownBaseline - ref) > 0.01
    ) {
      state.drawdownBaseline = null;
    }
  }
  migrateDrawdownBaseline();

  function realizedPnl() {
    return state.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  }

  function paperDrawdownRealizedSinceAnchor() {
    const anchor = Number(state.drawdownPnlAnchor) || 0;
    return closedTradesRealizedPnl(state.closedTrades, { normalizeLeverage: true }) - anchor;
  }

  function resetDrawdownTracking() {
    state.drawdownTriggeredAt = null;
    state.drawdownBaseline = null;
    state.drawdownPnlAnchor = closedTradesRealizedPnl(state.closedTrades, {
      normalizeLeverage: true,
    });
  }

  function maybeTrailDrawdownBaseline() {
    if (!state.config.drawdownStopEnabled || state.drawdownTriggeredAt) return;
    if (state.drawdownBaseline == null) return;
    const delta = paperDrawdownRealizedSinceAnchor();
    if (delta <= 0) return;
    const equity = state.drawdownBaseline + delta;
    if (equity > state.drawdownBaseline + 1e-6) {
      state.drawdownBaseline = equity;
      state.drawdownPnlAnchor = closedTradesRealizedPnl(state.closedTrades, {
        normalizeLeverage: true,
      });
      pushLog(
        "DRAWDOWN",
        "—",
        `Baseline raised to $${equity.toFixed(2)} after closed-trade profit`
      );
      persistSoon();
    }
  }

  function paperDrawdownEquity() {
    const ref = state.drawdownBaseline ?? state.config.initialDeposit;
    return ref + paperDrawdownRealizedSinceAnchor();
  }

  function persistSoon() {
    saveGen++;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushPersist();
    }, 400);
  }

  function ensureRuntimeConfigVersion() {
    if (state.configVersionId != null) return state.configVersionId;
    state.configVersionId =
      ensureConfigVersionForBot(BOT_TYPE_PAPER, state.config) ?? state.configVersionId;
    return state.configVersionId;
  }

  function flushPersist() {
    const gen = saveGen;
    try {
      const versionId = persistBotState(
        BOT_TYPE_PAPER,
        {
          config: state.config,
          openPositions: state.openPositions.map(openPositionForPersist),
          symbolSlStreak: state.symbolSlStreak ?? {},
          drawdownBaseline: state.drawdownBaseline,
          drawdownPnlAnchor: state.drawdownPnlAnchor ?? 0,
          drawdownTriggeredAt: state.drawdownTriggeredAt,
        },
        { balance: state.balance }
      );
      if (versionId != null) state.configVersionId = versionId;
    } catch (e) {
      console.error(`paper-bot persist failed: ${e.message || e}`);
    }
    if (gen !== saveGen) flushPersist();
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
    appendBotEvent(BOT_TYPE_PAPER, type, symbol, detail);
  }

  function unrealizedFor(pos, mark) {
    return positionPnl(pos, mark);
  }

  function lockedMargin() {
    let locked = 0;
    for (const p of state.openPositions) {
      locked += p.margin ?? 0;
    }
    return locked;
  }

  function currentEquity() {
    const s = summarize();
    return s.equity;
  }

  function summarize() {
    const open = state.openPositions;
    let unrealized = 0;
    for (const p of open) {
      normalizeOpenPosition(p);
      const mark = p.lastPrice;
      unrealized += Number.isFinite(mark)
        ? unrealizedFor(p, mark)
        : p.unrealizedPnl ?? 0;
    }
    const locked = lockedMargin();
    const cash = state.balance;
    const realized = realizedPnl();
    const initial = state.config.initialDeposit;
    const equity = cash + locked + unrealized;
    const ddEquity = paperDrawdownEquity();
    const dd = drawdownStatus(state.config, state, ddEquity);
    return {
      initialDeposit: initial,
      deposit: +cash.toFixed(4),
      balance: +cash.toFixed(4),
      lockedMargin: +locked.toFixed(4),
      equity: +equity.toFixed(4),
      unrealizedPnl: +unrealized.toFixed(4),
      realizedPnl: +realized.toFixed(4),
      totalPnl: +(equity - initial).toFixed(4),
      openCount: open.length,
      closedCount: state.closedTrades.length,
      drawdown: dd,
    };
  }

  function ensureDrawdownBaseline() {
    if (!state.config.drawdownStopEnabled) return;
    if (state.drawdownTriggeredAt) return;
    if (state.drawdownBaseline != null && Number.isFinite(state.drawdownBaseline)) return;
    const ref = state.config.initialDeposit;
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
    state.config.enabled = false;
    pushLog(
      "DRAWDOWN_STOP",
      "—",
      `Bot off: −${trigger.lossPct.toFixed(2)}% from $${trigger.baseline.toFixed(2)} (limit −${trigger.limitPct}%)`
    );
    persistSoon();
    if (onDrawdownStop) {
      void Promise.resolve(
        onDrawdownStop({
          bot: "paper",
          ...trigger,
          disarmed: false,
        })
      ).catch((e) => {
        console.error(`Paper drawdown notify: ${e.message}`);
      });
    }
  }

  function checkDrawdownStop() {
    if (state.drawdownTriggeredAt) return false;
    if (!state.config.drawdownStopEnabled || !state.config.enabled) return false;
    ensureDrawdownBaseline();
    const equity = paperDrawdownEquity();
    const trigger = evaluateDrawdownStop(state.config, state, equity);
    if (!trigger) return false;
    applyDrawdownStop(trigger);
    return true;
  }

  function getPublicState() {
    return {
      ok: true,
      updatedAt: formatIsoUtcPlus3(Date.now()),
      config: state.config,
      summary: summarize(),
      openPositions: state.openPositions.map((p) => ({
        ...p,
        openedAtIso: formatIsoUtcPlus3(p.openedAt),
      })),
      closedTrades: state.closedTrades.slice(0, 100).map((t) => ({
        ...t,
        openedAtIso: formatIsoUtcPlus3(t.openedAt),
        closedAtIso: formatIsoUtcPlus3(t.closedAt),
      })),
      log: state.log.slice(0, 50),
    };
  }

  function patchConfig(patch) {
    const { initialDeposit: _ignore, ...rest } = patch ?? {};
    const prevEnabled = state.config.enabled;
    const prevDdEnabled = state.config.drawdownStopEnabled;
    state.config = normalizeConfig({ ...state.config, ...rest });
    if (state.config.enabled && !prevEnabled) {
      resetDrawdownTracking();
    }
    if (state.config.drawdownStopEnabled && !prevDdEnabled) {
      resetDrawdownTracking();
    }
    if (state.config.enabled && state.config.drawdownStopEnabled) {
      ensureDrawdownBaseline();
    }
    checkDrawdownStop();
    state.configVersionId =
      ensureConfigVersionForBot(BOT_TYPE_PAPER, state.config) ?? state.configVersionId;
    persistSoon();
    flush();
    return getPublicState();
  }

  function reset() {
    const initial = state.config.initialDeposit;
    state.balance = initial;
    state.openPositions = [];
    state.closedTrades = [];
    state.log = [];
    state.symbolSlStreak = {};
    state.drawdownBaseline = null;
    state.drawdownPnlAnchor = 0;
    state.drawdownTriggeredAt = null;
    clearBotHistory(BOT_TYPE_PAPER);
    pushLog("RESET", "—", `Balance reset to $${initial}`);
    if (state.config.enabled && state.config.drawdownStopEnabled) {
      ensureDrawdownBaseline();
    }
    persistSoon();
    return getPublicState();
  }

  function hasOpen(symbol) {
    return state.openPositions.some((p) => p.symbol === symbol);
  }

  function tryAcquireOpenSlot(symbol) {
    if (hasOpen(symbol)) return false;
    if (pendingSymbols.has(symbol)) return false;
    const max = state.config.maxOpenPositions;
    if (
      Number.isFinite(max) &&
      state.openPositions.length + pendingSymbols.size >= max
    ) {
      return false;
    }
    pendingSymbols.add(symbol);
    return true;
  }

  function evaluateFoiOpenGates(botCfg, signalKind, symbol) {
    let sizeScale = 1;
    if (!isFoiSignalKind(signalKind)) {
      return { ok: true, sizeScale: 1, detail: null };
    }
    if (botCfg.foiFollowthroughRegimeEnabled) {
      const ftGate = foiFollowthroughTracker.check(botCfg, Date.now());
      if (!ftGate.pass) {
        return {
          ok: false,
          sizeScale: 0,
          detail: ftGate.detail
            ? `FOI follow-through regime: ${ftGate.detail}`
            : "FOI follow-through regime: cold",
        };
      }
      sizeScale = Math.min(sizeScale, ftGate.sizeScale || 1);
    }
    if (botCfg.foiColdDayEnabled) {
      const coldGate = foiColdDayTracker.check(botCfg, Date.now());
      if (!coldGate.pass) {
        return {
          ok: false,
          sizeScale: 0,
          detail: coldGate.detail
            ? `FOI cold-day: ${coldGate.detail}`
            : "FOI cold-day block",
        };
      }
      sizeScale = Math.min(sizeScale, coldGate.sizeScale || 1);
    }
    if (botCfg.foiBtcLookalikeEnabled) {
      const look = foiBtcLookalikeAllows(botCfg, {
        symbol,
        asOfMs: Date.now(),
        getBarsForSymbol: (sym) =>
          getBarsForSymbol?.(sym) ?? getRecentBars?.(sym, 400) ?? [],
        getBtcBars: () => getBtcBarsForRegime?.(Date.now()) ?? [],
      });
      if (!look.ok) {
        return {
          ok: false,
          sizeScale: 0,
          detail: look.detail || "FOI BTC lookalike",
        };
      }
    }
    const utcGate = foiUtcHourAllows(botCfg, Date.now());
    if (!utcGate.ok) {
      return {
        ok: false,
        sizeScale: 0,
        detail: `FOI blocked UTC hour ${utcGate.hour}`,
      };
    }
    return { ok: true, sizeScale, detail: null };
  }

  function tryOpen(symbol, signalKind, metrics, options = {}) {
    if (!state.config.enabled) return;
    if (!Number.isFinite(metrics?.close) || metrics.close <= 0) return;
    const sizeScale = clamp(num(options.sizeScale, 1), 0, 1);
    const { isBearSignal } = require("./side-config");
    const short = isBearSignal(signalKind);
    if (!Number.isFinite(metrics?.corridorHigh) || metrics.corridorHigh <= 0) {
      pushLog("SKIP", symbol, "missing corridor high (top border)");
      return;
    }
    if (!Number.isFinite(metrics?.corridorLow) || metrics.corridorLow <= 0) {
      pushLog("SKIP", symbol, "missing corridor low (bottom border)");
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
    const maxOpen = state.config.maxOpenPositions;
    if (Number.isFinite(maxOpen) && state.openPositions.length >= maxOpen) {
      pushLog("SKIP", symbol, "max open positions reached");
      return;
    }

    const entry = metrics.close;
    let exits = resolveExitLevels(signalKind, metrics, entry, state.config, {
      mark: entry,
      modelScope: MODEL_SCOPE,
    });
    exits = applyFoiHotTpProtect(exits, {
      signalKind,
      entry,
      short,
      cfg: state.config,
      tracker: foiFollowthroughTracker,
      asOfMs: Date.now(),
    });
    const { stopLoss: sl, takeProfit: tp, exitMethod, rejectReason } = exits;
    if (rejectReason) {
      pushLog("SKIP", symbol, rejectReason);
      return;
    }
    if (!sl || !tp) return;

    const quality = evaluateEntryQuality(
      signalKind,
      metrics,
      entry,
      sl,
      tp,
      state.config
    );
    if (!quality.pass) {
      pushLog("SKIP", symbol, quality.detail || "entry quality");
      return;
    }

    const margin = positionMarginFromConfig(
      state.balance,
      state.config.positionSizeUsdt,
      1,
      isFoiSignalKind(signalKind) ? sizeScale : 1
    );
    if (!margin) {
      pushLog("SKIP", symbol, "insufficient balance for margin");
      return;
    }

    const leverage = state.config.leverage;
    const quantity = (margin * leverage) / entry;
    const side = short ? "SHORT" : "LONG";
    const pos = normalizeOpenPosition({
      id: `${symbol}-${Date.now()}`,
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
      lastPrice: entry,
      peakPrice: entry,
      troughPrice: entry,
      unrealizedPnl: 0,
      openedAt: Date.now(),
      configVersionId: ensureRuntimeConfigVersion(),
      signalSnapshot: pickSignalSnapshot(metrics),
    });
    seedPositionExitContext(pos, metrics);

    if (hasOpen(symbol)) {
      pushLog("SKIP", symbol, "position already open (race)");
      return;
    }
    if (Number.isFinite(maxOpen) && state.openPositions.length >= maxOpen) {
      pushLog("SKIP", symbol, "max open positions reached (race)");
      return;
    }

    state.balance -= margin;
    state.openPositions.push(pos);
    pushLog(
      "OPEN",
      symbol,
      `${side} ${signalKind} @ ${entry.toFixed(6)} · ${leverage}x · margin $${margin.toFixed(2)} · deposit $${state.balance.toFixed(2)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)}${exitMethod && !exitMethod.startsWith("corridor") ? ` · ${exitMethod}` : ""}`
    );
    persistSoon();
  }

  async function tryOpenWithGates(symbol, signalKind, metrics) {
    if (!tryAcquireOpenSlot(symbol)) {
      if (hasOpen(symbol)) {
        pushLog("SKIP", symbol, "position already open");
      } else {
        pushLog("SKIP", symbol, "max open positions reached");
      }
      return;
    }

    try {
      const botCfg = state.config ?? {};
    const { isBearSignal } = require("./side-config");
    const positionSide = isBearSignal(signalKind) ? "SHORT" : "LONG";
    let sizeScale = 1;

    if (
      (signalKind === "sfp" || signalKind === "sfp_bear") &&
      sfpRegimeMonitor &&
      botCfg.aiSfpRegimeEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const regimeGate = sfpRegimeMonitor.checkSymbol(
        symbol,
        botCfg,
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
        return;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      pullbackRegimeMonitor &&
      botCfg.aiPullbackRegimeEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const regimeGate = pullbackRegimeMonitor.checkSymbol(
        symbol,
        botCfg,
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
        return;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      pullbackPatternBreakMonitor &&
      botCfg.aiPullbackPatternBreakEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const breakGate = pullbackPatternBreakMonitor.checkSymbol(
        symbol,
        botCfg,
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
        return;
      }
    }

    if (
      (signalKind === "pullback" || signalKind === "pullback_bear") &&
      botCfg.aiPullbackSignalEnabled
    ) {
      const bars =
        getBarsForSymbol?.(symbol) ?? getRecentBars?.(symbol, 120) ?? [];
      const gate = evaluatePullbackSignalGate(botCfg, bars, {
        metrics,
        signalKind,
        symbol,
        tradeStats: null,
        btcBars: getBtcBarsForRegime?.(Date.now()) ?? [],
        asOf: Date.now(),
        modelScope: MODEL_SCOPE,
        getFundingOiAt,
      });
      if (!gate.pass) {
        pushLog(
          "SKIP",
          symbol,
          gate.detail
            ? `Pullback signal AI: ${gate.detail}`
            : "Pullback signal AI: weak setup"
        );
        return;
      }
    }

    if (isFoiSignalKind(signalKind)) {
      const foiGate = evaluateFoiOpenGates(botCfg, signalKind, symbol);
      if (!foiGate.ok) {
        pushLog("SKIP", symbol, foiGate.detail || "FOI gate");
        return;
      }
      sizeScale = foiGate.sizeScale;
    }

    if (botCfg.extremalSpikeGateEnabled && resolveExtremalSpikeGate) {
      try {
        const spikeGate = await resolveExtremalSpikeGate(
          symbol,
          Date.now(),
          botCfg,
          { positionSide }
        );
        if (spikeGate?.enabled !== false && !spikeGate.pass) {
          pushLog(
            "SKIP",
            symbol,
            spikeGate.waiting
              ? `30m spike check: ${spikeGate.detail}`
              : `30m extremal spike: ${spikeGate.detail}`
          );
          return;
        }
      } catch (e) {
        pushLog("WARN", symbol, `30m spike check: ${e.message}`);
        return;
      }
    }
    tryOpen(symbol, signalKind, metrics, { sizeScale });
    } finally {
      pendingSymbols.delete(symbol);
    }
  }

  function onSfpSignal(sym, metrics) {
    if (!state.config.tradeSfpSignals) return;
    void tryOpenWithGates(sym, "sfp", metrics);
  }

  function onSfpBearSignal(sym, metrics) {
    if (!state.config.tradeBearishSfpSignals) return;
    void tryOpenWithGates(sym, "sfp_bear", metrics);
  }

  function onPullbackSignal(sym, metrics) {
    if (!state.config.tradePullbackSignals) return;
    void tryOpenWithGates(sym, "pullback", metrics);
  }

  function onPullbackBearSignal(sym, metrics) {
    if (!state.config.tradeBearishPullbackSignals) return;
    void tryOpenWithGates(sym, "pullback_bear", metrics);
  }

  function onFoiSignal(sym, metrics) {
    if (!state.config.tradeFoiSignals) return;
    void tryOpenWithGates(sym, "foi", metrics);
  }

  function onFoiBearSignal(sym, metrics) {
    if (!state.config.tradeBearishFoiSignals) return;
    void tryOpenWithGates(sym, "foi_bear", metrics);
  }

  function tryAddToPosition(pos, price) {
    const cfg = state.config;
    const gate = addOnEntryAllowed(cfg, pos, price);
    if (!gate.ok) return false;

    const movePct = gate.movePct;
    const newLeverage = nextLeverageAfterAddOn(pos.leverage, cfg.addOnLeverageBoost);
    const addMargin = positionMarginFromConfig(state.balance, cfg.addOnMarginUsdt);
    if (!addMargin) {
      pushLog("SKIP", pos.symbol, "insufficient balance for add-on");
      return false;
    }

    const addQty = (addMargin * newLeverage) / price;
    const oldQty = pos.quantity;
    const oldAvg = pos.entryPrice;
    pos.quantity = oldQty + addQty;
    pos.entryPrice = (oldAvg * oldQty + price * addQty) / pos.quantity;
    pos.margin += addMargin;
    pos.leverage = newLeverage;
    pos.addCount = 1;
    state.balance -= addMargin;
    pushLog(
      "ADD",
      pos.symbol,
      `+$${addMargin.toFixed(2)} @ ${newLeverage}x @ ${price.toFixed(6)} · avg entry ${pos.entryPrice.toFixed(6)} · deposit $${state.balance.toFixed(2)} · move +${movePct.toFixed(2)}% (≥${cfg.addOnMovePct}%)`
    );
    const slMove = moveStopAfterAddOn(pos, cfg.moveStopOffsetPct);
    const tpMove = takeProfitAfterAddOn(pos, cfg);
    if (slMove) {
      pushLog(
        "MOVE_SL",
        pos.symbol,
        `SL ${slMove.prev.toFixed(6)} → ${slMove.targetSl.toFixed(6)} (avg entry ${pos.entryPrice.toFixed(6)} ${cfg.moveStopOffsetPct >= 0 ? "−" : "+"}${Math.abs(cfg.moveStopOffsetPct)}%) after add-on`
      );
    }
    if (tpMove) {
      pushLog(
        "MOVE_TP",
        pos.symbol,
        `TP ${tpMove.prev.toFixed(6)} → ${tpMove.targetTp.toFixed(6)} (avg entry ${pos.entryPrice.toFixed(6)}) after add-on`
      );
    }
    return true;
  }

  /** Tighten stop toward entry after favorable move. */
  function tryMoveStopLoss(pos, price) {
    const cfg = state.config;
    if (!cfg.moveStopEnabled) return false;
    normalizeOpenPosition(pos);
    if (pos.moveStopRaised) return false;

    const movePct = favorableMovePct(pos, price);
    if (movePct == null || movePct < cfg.moveStopAfterMovePct) return false;

    const targetSl = isShort(pos)
      ? entryBasedStopPriceShort(pos.initialEntryPrice, cfg.moveStopOffsetPct)
      : entryBasedStopPrice(pos.initialEntryPrice, cfg.moveStopOffsetPct);
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

    const prev = pos.stopLoss;
    pos.stopLoss = targetSl;
    pos.moveStopRaised = true;
    const offsetLabel = isShort(pos)
      ? cfg.moveStopOffsetPct >= 0
        ? "+"
        : "−"
      : cfg.moveStopOffsetPct >= 0
        ? "−"
        : "+";
    pushLog(
      "MOVE_SL",
      pos.symbol,
      `SL ${prev.toFixed(6)} → ${targetSl.toFixed(6)} (entry ${pos.initialEntryPrice.toFixed(6)} ${offsetLabel}${Math.abs(cfg.moveStopOffsetPct)}%) after +${movePct.toFixed(2)}% move`
    );
    return true;
  }

  function closePosition(pos, exitPrice, reason) {
    if (!pos?.id || recordedCloseIds.has(pos.id)) return false;
    if (!state.openPositions.some((p) => p.id === pos.id)) return false;
    recordedCloseIds.add(pos.id);
    if (recordedCloseIds.size > 2000) {
      const drop = recordedCloseIds.size - 1500;
      let i = 0;
      for (const id of recordedCloseIds) {
        recordedCloseIds.delete(id);
        if (++i >= drop) break;
      }
    }
    normalizeOpenPosition(pos);
    const posSnap = {
      ...pos,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      corridorHigh: pos.corridorHigh,
      corridorLow: pos.corridorLow,
    };
    const pnl = positionPnl(pos, exitPrice);
    const pnlPct = (pnl / pos.margin) * 100;
    state.balance += pos.margin + pnl;
    const trade = {
      id: pos.id,
      symbol: pos.symbol,
      signalKind: pos.signalKind,
      side: pos.side,
      entryPrice: pos.entryPrice,
      initialEntryPrice: pos.initialEntryPrice,
      exitPrice,
      quantity: pos.quantity,
      margin: pos.margin,
      leverage: pos.leverage,
      addCount: pos.addCount,
      corridorLow: pos.corridorLow,
      corridorHigh: pos.corridorHigh,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      pnl: +pnl.toFixed(4),
      pnlPct: +pnlPct.toFixed(2),
      exitReason: reason,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      configVersionId: pos.configVersionId ?? state.configVersionId ?? null,
      exitPathOracle: summarizeTradeExitPath(pos, pnl),
    };
    state.closedTrades.unshift(trade);
    if (state.closedTrades.length > 500) state.closedTrades.length = 500;
    foiFollowthroughTracker.recordClosedTrade(trade);
    foiColdDayTracker.recordClosedTrade(trade);
    maybeTrailDrawdownBaseline();
    persistClosedTrade(BOT_TYPE_PAPER, trade);
    pushLog(
      "CLOSE",
      pos.symbol,
      `${reason} @ ${exitPrice.toFixed(6)} · PnL $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) · deposit $${state.balance.toFixed(2)}`
    );
    recordTradeForSymbolBlocklist({
      trade,
      config: state.config,
      symbolSlStreak: state.symbolSlStreak,
      onAutoBlock: (sym, n) =>
        pushLog("BLOCK", sym, `auto-blocked after ${n} consecutive SL`),
    });
    state.openPositions = state.openPositions.filter((p) => p.id !== pos.id);
    if (onTradeClosed) {
      void Promise.resolve(onTradeClosed(trade, posSnap))
        .then((patch) => {
          if (patch?.snapshotId) {
            trade.snapshotId = patch.snapshotId;
            persistClosedTrade(BOT_TYPE_PAPER, trade);
            persistSoon();
          }
        })
        .catch((e) => {
          console.error(`Trade snapshot ${trade.symbol}: ${e.message}`);
        });
    }
    checkDrawdownStop();
    return true;
  }

  function updatePrices(getBar) {
    if (!state.openPositions.length) return;
    let changed = false;
    const stillOpen = [];
    const snapshot = [...state.openPositions];
    for (const pos of snapshot) {
      if (!state.openPositions.some((p) => p.id === pos.id)) continue;
      if (recordedCloseIds.has(pos.id)) continue;
      normalizeOpenPosition(pos);
      const bar = getBar(pos.symbol);
      const close = bar?.close;
      const low = bar?.low ?? close;
      const high = bar?.high ?? close;
      if (!Number.isFinite(close)) {
        stillOpen.push(pos);
        continue;
      }
      const prevLast = pos.lastPrice;
      const prevUnr = pos.unrealizedPnl;
      const tickBar = {
        openTime: bar?.openTime,
        closeTime: bar?.closeTime,
        open: bar?.open,
        high,
        low,
        close,
        volume: bar?.volume,
      };
      const ex = postEntryBarExtremes(pos, tickBar, high, low, close);
      pos.lastPrice = close;
      updatePriceExtremes(pos, ex.high, ex.low, ex.close);
      pos.movePctFromEntry = +(
        favorableMovePct(pos, close) ?? 0
      ).toFixed(3);
      pos.unrealizedPnl = +unrealizedFor(pos, close).toFixed(4);
      if (close !== prevLast || pos.unrealizedPnl !== prevUnr) changed = true;

      tickBarProgress(pos, tickBar, state.config);
      trackExitPathOnBar(pos, tickBar);

      const recentBars = getRecentBars?.(pos.symbol, 12) ?? [];
      const aiExit = evaluateAiEarlyExit(state.config, pos, tickBar, {
        recentBars,
        modelScope: MODEL_SCOPE,
      });
      if (aiExit) {
        pushLog("CLOSE", pos.symbol, `${aiExit.reason}: ${aiExit.detail}`);
        closePosition(pos, aiExit.exitPrice, aiExit.reason);
        changed = true;
        continue;
      }

      const early = evaluateEarlyAbort(state.config, pos, tickBar);
      if (early) {
        pushLog("CLOSE", pos.symbol, `${early.reason}: ${early.detail}`);
        closePosition(pos, early.exitPrice, early.reason);
        changed = true;
        continue;
      }

      const pbEarly = evaluatePullbackEarlyInvalidation(state.config, pos, tickBar);
      if (pbEarly) {
        pushLog("CLOSE", pos.symbol, `${pbEarly.reason}: ${pbEarly.detail}`);
        closePosition(pos, pbEarly.exitPrice, pbEarly.reason);
        changed = true;
        continue;
      }

      const favPrice = isShort(pos)
        ? Number.isFinite(ex.low)
          ? ex.low
          : close
        : Number.isFinite(ex.high)
          ? ex.high
          : close;
      if (tryMoveStopLoss(pos, favPrice)) changed = true;
      if (tryAddToPosition(pos, favPrice)) changed = true;

      const runner = processRunnerPhase(state.config, pos, tickBar);
      if (runner.activated) {
        pushLog("RUNNER", pos.symbol, `runner on · ${runner.detail ?? ""}`);
        changed = true;
      }
      if (runner.trailedSl) {
        pushLog(
          "MOVE_SL",
          pos.symbol,
          `runner trail ${runner.prevSl?.toFixed(6)} → ${pos.stopLoss.toFixed(6)}`
        );
        changed = true;
      }
      if (runner.exit) {
        pushLog("CLOSE", pos.symbol, `${runner.reason}: ${runner.detail}`);
        closePosition(pos, runner.exitPrice, runner.reason);
        changed = true;
        continue;
      }

      if (stopLossHit(ex, pos)) {
        closePosition(pos, pos.stopLoss, "stop_loss");
        changed = true;
        continue;
      }
      if (!pos.runnerMode && takeProfitHit(ex, pos)) {
        closePosition(pos, pos.takeProfit, "take_profit");
        changed = true;
        continue;
      }
      stillOpen.push(pos);
    }
    state.openPositions = stillOpen;
    if (checkDrawdownStop()) changed = true;
    if (changed) persistSoon();
  }

  if (state.config.enabled && state.config.drawdownStopEnabled) {
    ensureDrawdownBaseline();
    checkDrawdownStop();
  }

  function closeSymbol(symbol, reason = "manual") {
    const sym = String(symbol || "").toUpperCase();
    const pos = state.openPositions.find((p) => p.symbol === sym);
    if (!pos) throw new Error(`No paper position for ${sym}`);
    normalizeOpenPosition(pos);
    const exitPrice = Number.isFinite(pos.lastPrice)
      ? pos.lastPrice
      : pos.entryPrice;
    // closePosition already removes from openPositions — do not splice.
    closePosition(pos, exitPrice, reason);
    persistSoon();
    return getPublicState();
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const versionId = persistBotState(
      BOT_TYPE_PAPER,
      {
        config: state.config,
        openPositions: state.openPositions.map(openPositionForPersist),
        symbolSlStreak: state.symbolSlStreak ?? {},
        drawdownBaseline: state.drawdownBaseline,
        drawdownPnlAnchor: state.drawdownPnlAnchor ?? 0,
        drawdownTriggeredAt: state.drawdownTriggeredAt,
      },
      { balance: state.balance }
    );
    if (versionId != null) state.configVersionId = versionId;
  }

  return {
    getPublicState,
    getClosedTrades: () => state.closedTrades.map((t) => ({ ...t })),
    patchConfig,
    reset,
    onSfpSignal,
    onSfpBearSignal,
    onPullbackSignal,
    onPullbackBearSignal,
    onFoiSignal,
    onFoiBearSignal,
    updatePrices,
    closeSymbol,
    flush,
  };
}

module.exports = {
  createPaperBot,
  DEFAULT_CONFIG,
  normalizeConfig,
  migratePositionSizeUsdt,
  positionMarginFromConfig,
  migrateAddOnMarginUsdt,
  nextLeverageAfterAddOn,
  normalizeOpenPosition,
  stopLossPrice,
  stopLossFallbackForLong,
  resolveInitialStopLoss,
  wouldLongStopMarketTrigger,
  takeProfitPrice,
  entryBasedStopPrice,
  entryBasedStopPriceShort,
  moveStopAfterAddOn,
  takeProfitAfterAddOn,
  longTakeProfitHit,
  addOnEntryAllowed,
  positionPeakMovePct,
  movePctFromEntry,
  exitReasonLabel,
};
