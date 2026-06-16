const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  normalizeDrawdownConfig,
  drawdownStatus,
  evaluateDrawdownStop,
  formatDrawdownTelegramMessage,
} = require("./bot-drawdown-guard");
const {
  stopLossPrice,
  takeProfitPrice,
  entryBasedStopPrice,
  wouldLongStopMarketTrigger,
  stopLossFallbackForLong,
  resolveInitialStopLoss,
} = require("./bot-exit-prices");
const { resolveExitLevels } = require("./signal-exit-levels");
const { evaluateEntryQuality } = require("./entry-quality-gate");
const {
  normalizeBlockedSymbols,
  isSymbolBlocked,
  recordTradeForSymbolBlocklist,
  normalizeSymbolSlStreak,
} = require("./bot-symbol-blocklist");

const STATE_FILE = () => dataPath("paper-bot-state.json");

const DEFAULT_CONFIG = {
  enabled: false,
  initialDeposit: 1000,
  leverage: 1,
  positionSizeUsdt: 6,
  stopLossBelowCorridorPct: 2,
  stopLossFallbackPnlPct: 2,
  takeProfitPct: 3,
  takeProfitMinPct: 1,
  /** Widen smart SL if closer than this % below entry (reduces noise stop-outs). */
  minSmartStopDistancePct: 0.8,
  /** Skip SFP entries when local corridor width exceeds this % (0 = off). */
  maxSfpCorridorWidthPct: 20,
  /** SFP take-profit cap % (uses takeProfitPct when unset). */
  sfpTakeProfitPct: 1.5,
  /** Skip pullback when local corridor width exceeds this % (0 = off). */
  maxPullbackCorridorWidthPct: 20,
  smartExitLevelsEnabled: true,
  extremalSpikeGateEnabled: true,
  tradeSfpSignals: true,
  tradePullbackSignals: false,
  addOnEnabled: false,
  addOnMarginUsdt: 6,
  addOnMovePct: 5,
  addOnLeverageBoost: 1,
  /** 0 = off. Require peak price (high) ≥ this % from initial entry before add-on. */
  addOnMinPeakPct: 0,
  /** Only add after move-stop has raised SL toward entry (moveStopEnabled required). */
  addOnOnlyAfterMoveStop: false,
  moveStopEnabled: false,
  moveStopAfterMovePct: 5,
  moveStopOffsetPct: 0,
  drawdownStopEnabled: true,
  drawdownStopPct: 4,
  /** Skip entries on these USDT-M symbols (manual + auto-blocked). */
  blockedSymbols: [],
  /** Auto-add symbol to blockedSymbols after this many consecutive SL exits (0 = off). */
  autoBlockAfterConsecutiveSl: 2,
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
  const deposit = num(raw.initialDeposit, DEFAULT_CONFIG.initialDeposit);
  const pct = num(raw.positionSizePct, 1);
  return clamp((deposit * pct) / 100, 1, 1_000_000);
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
function positionMarginFromConfig(balanceOrAvailable, positionSizeUsdt, minMargin = 1) {
  const configured = clamp(
    num(positionSizeUsdt, DEFAULT_CONFIG.positionSizeUsdt),
    1,
    1_000_000
  );
  const margin = Math.min(balanceOrAvailable, configured);
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
    tradePullbackSignals:
      raw.tradePullbackSignals !== undefined
        ? Boolean(raw.tradePullbackSignals)
        : DEFAULT_CONFIG.tradePullbackSignals,
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
    moveStopEnabled: Boolean(raw.moveStopEnabled),
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
    ...normalizeDrawdownConfig({ ...DEFAULT_CONFIG, ...raw }),
  };
}

function exitReasonLabel(reason) {
  if (reason === "take_profit") return "TP";
  if (reason === "stop_loss") return "SL";
  return reason || "—";
}

function movePctFromEntry(price, initialEntry) {
  if (!Number.isFinite(price) || !Number.isFinite(initialEntry) || initialEntry <= 0) {
    return null;
  }
  return ((price - initialEntry) / initialEntry) * 100;
}

function normalizeOpenPosition(pos) {
  if (pos.initialEntryPrice == null) pos.initialEntryPrice = pos.entryPrice;
  if (pos.addCount == null) pos.addCount = 0;
  if (pos.leverage == null) pos.leverage = 1;
  if (pos.moveStopRaised == null) pos.moveStopRaised = false;
  if (pos.initialStopLoss == null && pos.stopLoss != null) {
    pos.initialStopLoss = pos.stopLoss;
  }
  return pos;
}

function moveStopAfterAddOn(pos, offsetPct) {
  normalizeOpenPosition(pos);
  const targetSl = entryBasedStopPrice(pos.entryPrice, offsetPct);
  if (!Number.isFinite(targetSl)) return null;
  if (targetSl <= pos.stopLoss) return null;
  const prev = pos.stopLoss;
  pos.stopLoss = targetSl;
  return { prev, targetSl };
}

function takeProfitPctForSignal(signalKind, cfg) {
  const base = cfg.takeProfitPct ?? DEFAULT_CONFIG.takeProfitPct;
  if (signalKind === "sfp" && Number(cfg.sfpTakeProfitPct) > 0) {
    return Math.min(cfg.sfpTakeProfitPct, base);
  }
  return base;
}

/** Recalculate TP from average entry after add-on (LONG). Keeps prior TP if still above entry and higher. */
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

  let targetTp = takeProfitPrice(entry, usePct);
  if (!Number.isFinite(targetTp) || targetTp <= entry) {
    const minPct = floorPct > 0 ? floorPct : 0.1;
    targetTp = takeProfitPrice(entry, minPct);
  }
  if (!Number.isFinite(targetTp) || targetTp <= entry) return null;

  const prev = pos.takeProfit;
  if (Number.isFinite(prev) && prev > entry && prev > targetTp) {
    targetTp = prev;
  }
  if (Math.abs(targetTp - prev) <= Math.max(1e-8, entry * 1e-8)) return null;

  pos.takeProfit = targetTp;
  return { prev, targetTp };
}

function longTakeProfitHit(high, pos) {
  return (
    Number.isFinite(high) &&
    Number.isFinite(pos.takeProfit) &&
    Number.isFinite(pos.entryPrice) &&
    pos.takeProfit > pos.entryPrice &&
    high >= pos.takeProfit
  );
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

  const movePct = movePctFromEntry(price, pos.initialEntryPrice);
  if (movePct == null || movePct < 0) return { ok: false, reason: "below entry" };
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
  const raw = readJsonFile(STATE_FILE(), null);
  if (!raw || typeof raw !== "object") {
    return {
      config: { ...DEFAULT_CONFIG },
      balance: DEFAULT_CONFIG.initialDeposit,
      openPositions: [],
      closedTrades: [],
      log: [],
      symbolSlStreak: {},
      drawdownBaseline: null,
      drawdownTriggeredAt: null,
    };
  }
  const config = normalizeConfig(raw.config);
  return {
    config,
    balance: num(raw.balance, config.initialDeposit),
    openPositions: Array.isArray(raw.openPositions)
      ? raw.openPositions.map((p) => normalizeOpenPosition({ ...p }))
      : [],
    closedTrades: Array.isArray(raw.closedTrades) ? raw.closedTrades : [],
    log: Array.isArray(raw.log) ? raw.log.slice(0, 200) : [],
    symbolSlStreak: normalizeSymbolSlStreak(raw.symbolSlStreak),
    drawdownBaseline: raw.drawdownBaseline ?? null,
    drawdownTriggeredAt: raw.drawdownTriggeredAt ?? null,
  };
}

function createPaperBot(options = {}) {
  const { onTradeClosed, onDrawdownStop, resolveExtremalSpikeGate } = options;
  let state = loadState();
  let saveTimer = null;

  function reconcileBalance() {
    const initial = state.config.initialDeposit;
    const realized = state.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const locked = lockedMargin();
    state.balance = initial + realized - locked;
  }

  reconcileBalance();

  function persistSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeJsonFile(STATE_FILE(), {
        config: state.config,
        balance: state.balance,
        openPositions: state.openPositions,
        closedTrades: state.closedTrades.slice(0, 500),
        log: state.log.slice(0, 200),
        symbolSlStreak: state.symbolSlStreak ?? {},
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

  function unrealizedFor(pos, mark) {
    if (!Number.isFinite(mark)) return 0;
    return pos.quantity * (mark - pos.entryPrice);
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
    const realized = state.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const initial = state.config.initialDeposit;
    const equity = cash + locked + unrealized;
    const dd = drawdownStatus(state.config, state, equity);
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
    const equity = currentEquity();
    if (!Number.isFinite(equity) || equity <= 0) return;
    state.drawdownBaseline = equity;
    pushLog(
      "DRAWDOWN",
      "—",
      `Baseline set $${equity.toFixed(2)} (max loss −${state.config.drawdownStopPct}%)`
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
    const equity = currentEquity();
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
      state.drawdownTriggeredAt = null;
      state.drawdownBaseline = null;
    }
    if (state.config.drawdownStopEnabled && !prevDdEnabled) {
      state.drawdownTriggeredAt = null;
      state.drawdownBaseline = null;
    }
    if (state.config.enabled && state.config.drawdownStopEnabled) {
      ensureDrawdownBaseline();
    }
    checkDrawdownStop();
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
    state.drawdownBaseline = null;
    state.drawdownTriggeredAt = null;
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

  function tryOpen(symbol, signalKind, metrics) {
    if (!state.config.enabled) return;
    if (!Number.isFinite(metrics?.close) || metrics.close <= 0) return;
    if (!Number.isFinite(metrics?.corridorHigh) || metrics.corridorHigh <= 0) {
      pushLog("SKIP", symbol, "missing corridor high (top border)");
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

    const entry = metrics.close;
    const exits = resolveExitLevels(signalKind, metrics, entry, state.config, {
      mark: entry,
    });
    const { stopLoss: sl, takeProfit: tp, exitMethod } = exits;
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

    const margin = positionMarginFromConfig(state.balance, state.config.positionSizeUsdt);
    if (!margin) {
      pushLog("SKIP", symbol, "insufficient balance for margin");
      return;
    }

    const leverage = state.config.leverage;
    const quantity = (margin * leverage) / entry;
    const pos = normalizeOpenPosition({
      id: `${symbol}-${Date.now()}`,
      symbol,
      signalKind,
      side: "LONG",
      entryPrice: entry,
      initialEntryPrice: entry,
      quantity,
      margin,
      leverage,
      addCount: 0,
      corridorLow: metrics.corridorLow,
      corridorHigh: metrics.corridorHigh ?? null,
      stopLoss: sl,
      initialStopLoss: sl,
      takeProfit: tp,
      lastPrice: entry,
      peakPrice: entry,
      unrealizedPnl: 0,
      openedAt: Date.now(),
    });
    state.balance -= margin;
    state.openPositions.push(pos);
    pushLog(
      "OPEN",
      symbol,
      `LONG ${signalKind} @ ${entry.toFixed(6)} · ${leverage}x · margin $${margin.toFixed(2)} · deposit $${state.balance.toFixed(2)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)}${exitMethod && exitMethod !== "corridor" ? ` · ${exitMethod}` : ""}`
    );
    persistSoon();
  }

  async function tryOpenWithGates(symbol, signalKind, metrics) {
    const botCfg = state.config ?? {};
    if (botCfg.extremalSpikeGateEnabled && resolveExtremalSpikeGate) {
      try {
        const spikeGate = await resolveExtremalSpikeGate(symbol, Date.now(), botCfg);
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
    tryOpen(symbol, signalKind, metrics);
  }

  function onSfpSignal(sym, metrics) {
    if (!state.config.tradeSfpSignals) return;
    void tryOpenWithGates(sym, "sfp", metrics);
  }

  function onPullbackSignal(sym, metrics) {
    if (!state.config.tradePullbackSignals) return;
    void tryOpenWithGates(sym, "pullback", metrics);
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

  /** Raise stop toward entry after favorable move (LONG only). */
  function tryMoveStopLoss(pos, price) {
    const cfg = state.config;
    if (!cfg.moveStopEnabled) return false;
    normalizeOpenPosition(pos);

    const movePct = movePctFromEntry(price, pos.initialEntryPrice);
    if (movePct == null || movePct < cfg.moveStopAfterMovePct) return false;

    const targetSl = entryBasedStopPrice(
      pos.initialEntryPrice,
      cfg.moveStopOffsetPct
    );
    if (!Number.isFinite(targetSl)) return false;
    const tol = Math.max(1e-8, Math.abs(pos.initialEntryPrice) * 1e-6);
    if (Math.abs(targetSl - pos.stopLoss) <= tol || targetSl <= pos.stopLoss) {
      return false;
    }

    const prev = pos.stopLoss;
    pos.stopLoss = targetSl;
    pos.moveStopRaised = true;
    pushLog(
      "MOVE_SL",
      pos.symbol,
      `SL ${prev.toFixed(6)} → ${targetSl.toFixed(6)} (entry ${pos.initialEntryPrice.toFixed(6)} ${cfg.moveStopOffsetPct >= 0 ? "−" : "+"}${Math.abs(cfg.moveStopOffsetPct)}%) after +${movePct.toFixed(2)}% move`
    );
    return true;
  }

  function closePosition(pos, exitPrice, reason) {
    normalizeOpenPosition(pos);
    const posSnap = {
      ...pos,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      corridorHigh: pos.corridorHigh,
      corridorLow: pos.corridorLow,
    };
    const pnl = pos.quantity * (exitPrice - pos.entryPrice);
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
    };
    state.closedTrades.unshift(trade);
    if (state.closedTrades.length > 500) state.closedTrades.length = 500;
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
    if (onTradeClosed) {
      void Promise.resolve(onTradeClosed(trade, posSnap))
        .then((patch) => {
          if (patch?.snapshotId) {
            trade.snapshotId = patch.snapshotId;
            persistSoon();
          }
        })
        .catch((e) => {
          console.error(`Trade snapshot ${trade.symbol}: ${e.message}`);
        });
    }
    checkDrawdownStop();
  }

  function updatePrices(getBar) {
    if (!state.openPositions.length) return;
    let changed = false;
    const stillOpen = [];
    for (const pos of state.openPositions) {
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
      if (close !== prevLast || pos.unrealizedPnl !== prevUnr) changed = true;

      const addPrice = Number.isFinite(high) ? high : close;
      if (tryMoveStopLoss(pos, addPrice)) changed = true;
      if (tryAddToPosition(pos, addPrice)) changed = true;

      if (Number.isFinite(low) && low <= pos.stopLoss) {
        closePosition(pos, pos.stopLoss, "stop_loss");
        changed = true;
        continue;
      }
      if (Number.isFinite(high) && longTakeProfitHit(high, pos)) {
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

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writeJsonFile(STATE_FILE(), {
      config: state.config,
      balance: state.balance,
      openPositions: state.openPositions,
      closedTrades: state.closedTrades.slice(0, 500),
      log: state.log.slice(0, 200),
      symbolSlStreak: state.symbolSlStreak ?? {},
      drawdownBaseline: state.drawdownBaseline,
      drawdownTriggeredAt: state.drawdownTriggeredAt,
      savedAt: Date.now(),
    });
  }

  return {
    getPublicState,
    patchConfig,
    reset,
    onSfpSignal,
    onPullbackSignal,
    updatePrices,
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
  moveStopAfterAddOn,
  takeProfitAfterAddOn,
  longTakeProfitHit,
  addOnEntryAllowed,
  positionPeakMovePct,
  movePctFromEntry,
  exitReasonLabel,
};
