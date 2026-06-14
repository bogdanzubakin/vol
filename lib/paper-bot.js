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

const STATE_FILE = () => dataPath("paper-bot-state.json");

const DEFAULT_CONFIG = {
  enabled: false,
  initialDeposit: 1000,
  positionSizePct: 1,
  stopLossBelowCorridorPct: 2,
  stopLossFallbackPnlPct: 2,
  takeProfitPct: 10,
  takeProfitMinPct: 0,
  smartExitLevelsEnabled: false,
  htfContraindicationEnabled: true,
  htfMaBars: 20,
  tradeSpikeSignals: true,
  tradeFastCorridorSignals: false,
  tradeSfpSignals: false,
  tradePullbackSignals: false,
  addOnEnabled: false,
  addOnDepositPct: 1,
  addOnMovePct: 5,
  addOnMaxAdds: 10,
  moveStopEnabled: false,
  moveStopAfterMovePct: 5,
  moveStopOffsetPct: 0,
  falseSpikeEnabled: false,
  falseSpikeAfterMinutes: 30,
  falseSpikeBelowEntryPct: 0,
  drawdownStopEnabled: false,
  drawdownStopPct: 10,
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const SHARED_BOT_PATCH_KEYS = Object.keys(DEFAULT_CONFIG).filter(
  (k) => k !== "enabled" && k !== "initialDeposit"
);

function pickSharedBotPatch(patch = {}) {
  const out = {};
  for (const k of SHARED_BOT_PATCH_KEYS) {
    if (patch[k] !== undefined) out[k] = patch[k];
  }
  return out;
}

function normalizeConfig(raw = {}) {
  return {
    enabled: Boolean(raw.enabled),
    initialDeposit: clamp(num(raw.initialDeposit, DEFAULT_CONFIG.initialDeposit), 10, 1_000_000),
    positionSizePct: clamp(num(raw.positionSizePct, DEFAULT_CONFIG.positionSizePct), 0.1, 100),
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
    smartExitLevelsEnabled:
      raw.smartExitLevelsEnabled !== undefined
        ? Boolean(raw.smartExitLevelsEnabled)
        : DEFAULT_CONFIG.smartExitLevelsEnabled,
    htfContraindicationEnabled:
      raw.htfContraindicationEnabled !== undefined
        ? Boolean(raw.htfContraindicationEnabled)
        : DEFAULT_CONFIG.htfContraindicationEnabled,
    htfMaBars: clamp(
      Math.round(num(raw.htfMaBars, DEFAULT_CONFIG.htfMaBars)),
      5,
      200
    ),
    tradeSpikeSignals:
      raw.tradeSpikeSignals !== undefined
        ? Boolean(raw.tradeSpikeSignals)
        : DEFAULT_CONFIG.tradeSpikeSignals,
    tradeFastCorridorSignals: Boolean(raw.tradeFastCorridorSignals),
    tradeSfpSignals: Boolean(raw.tradeSfpSignals),
    tradePullbackSignals: Boolean(raw.tradePullbackSignals),
    addOnEnabled: Boolean(raw.addOnEnabled),
    addOnDepositPct: clamp(num(raw.addOnDepositPct, DEFAULT_CONFIG.addOnDepositPct), 0.1, 100),
    addOnMovePct: clamp(num(raw.addOnMovePct, DEFAULT_CONFIG.addOnMovePct), 0.1, 100),
    addOnMaxAdds: clamp(
      Math.round(num(raw.addOnMaxAdds, DEFAULT_CONFIG.addOnMaxAdds)),
      0,
      50
    ),
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
    falseSpikeEnabled: Boolean(raw.falseSpikeEnabled),
    falseSpikeAfterMinutes: clamp(
      Math.round(
        num(raw.falseSpikeAfterMinutes, DEFAULT_CONFIG.falseSpikeAfterMinutes)
      ),
      1,
      24 * 60
    ),
    falseSpikeBelowEntryPct: clamp(
      num(raw.falseSpikeBelowEntryPct, DEFAULT_CONFIG.falseSpikeBelowEntryPct),
      -20,
      50
    ),
    ...normalizeDrawdownConfig({ ...DEFAULT_CONFIG, ...raw }),
  };
}

/**
 * False-spike trigger level from initial entry.
 * Positive % = below entry; negative % = above entry (LONG: close when price <= level).
 */
function falseSpikeThresholdPrice(initialEntry, entryOffsetPct) {
  if (!Number.isFinite(initialEntry) || initialEntry <= 0) return null;
  const pct = num(entryOffsetPct, 0);
  return initialEntry * (1 - pct / 100);
}

/** Close when price falls to entry offset level after min hold time. */
function shouldCloseFalseSpike(pos, markPrice, cfg, nowMs = Date.now()) {
  if (!cfg?.falseSpikeEnabled) return false;
  normalizeOpenPosition(pos);
  const mins = cfg.falseSpikeAfterMinutes ?? DEFAULT_CONFIG.falseSpikeAfterMinutes;
  if (!Number.isFinite(mins) || mins <= 0) return false;
  if (nowMs - pos.openedAt < mins * 60 * 1000) return false;
  const entry = pos.initialEntryPrice ?? pos.entryPrice;
  const threshold = falseSpikeThresholdPrice(
    entry,
    cfg.falseSpikeBelowEntryPct ?? DEFAULT_CONFIG.falseSpikeBelowEntryPct
  );
  if (!Number.isFinite(markPrice) || threshold == null) return false;
  return markPrice <= threshold;
}

function exitReasonLabel(reason) {
  if (reason === "take_profit") return "TP";
  if (reason === "stop_loss") return "SL";
  if (reason === "false_spike") return "false spike";
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

function loadState() {
  const raw = readJsonFile(STATE_FILE(), null);
  if (!raw || typeof raw !== "object") {
    return {
      config: { ...DEFAULT_CONFIG },
      balance: DEFAULT_CONFIG.initialDeposit,
      openPositions: [],
      closedTrades: [],
      log: [],
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
    drawdownBaseline: raw.drawdownBaseline ?? null,
    drawdownTriggeredAt: raw.drawdownTriggeredAt ?? null,
  };
}

function createPaperBot(options = {}) {
  const { onTradeClosed, onDrawdownStop, resolveHtfContraindication } = options;
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

    const entry = metrics.close;
    const exits = resolveExitLevels(signalKind, metrics, entry, state.config, {
      mark: entry,
    });
    const { stopLoss: sl, takeProfit: tp, exitMethod } = exits;
    if (!sl || !tp) return;

    const margin = state.balance * (state.config.positionSizePct / 100);
    if (margin < 1) {
      pushLog("SKIP", symbol, "insufficient balance for margin");
      return;
    }

    const quantity = margin / entry;
    const pos = normalizeOpenPosition({
      id: `${symbol}-${Date.now()}`,
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
      unrealizedPnl: 0,
      openedAt: Date.now(),
    });
    state.balance -= margin;
    state.openPositions.push(pos);
    pushLog(
      "OPEN",
      symbol,
      `LONG ${signalKind} @ ${entry.toFixed(6)} · margin $${margin.toFixed(2)} · deposit $${state.balance.toFixed(2)} · SL ${sl.toFixed(6)} · TP ${tp.toFixed(6)}${exitMethod && exitMethod !== "corridor" ? ` · ${exitMethod}` : ""}`
    );
    persistSoon();
  }

  async function tryOpenWithHtf(symbol, signalKind, metrics) {
    if (
      (signalKind === "sfp" || signalKind === "pullback") &&
      state.config.htfContraindicationEnabled &&
      resolveHtfContraindication
    ) {
      try {
        const htf = await resolveHtfContraindication(symbol, signalKind, Date.now());
        if (htf?.enabled && !htf.pass) {
          pushLog(
            "SKIP",
            symbol,
            `15m blocked: ${htf.detail || "contraindication"}`
          );
          return;
        }
      } catch (e) {
        pushLog("WARN", symbol, `15m check: ${e.message}`);
        return;
      }
    }
    tryOpen(symbol, signalKind, metrics);
  }

  function onSpikeSignal(sym, metrics) {
    if (!state.config.tradeSpikeSignals) return;
    tryOpen(sym, "spike", metrics);
  }

  function onFastCorridorSignal(sym, metrics) {
    if (!state.config.tradeFastCorridorSignals) return;
    tryOpen(sym, "fast-corridor", metrics);
  }

  function onSfpSignal(sym, metrics) {
    if (!state.config.tradeSfpSignals) return;
    void tryOpenWithHtf(sym, "sfp", metrics);
  }

  function onPullbackSignal(sym, metrics) {
    if (!state.config.tradePullbackSignals) return;
    void tryOpenWithHtf(sym, "pullback", metrics);
  }

  function tryAddToPosition(pos, price) {
    const cfg = state.config;
    if (!cfg.addOnEnabled) return false;
    normalizeOpenPosition(pos);
    if (pos.addCount >= cfg.addOnMaxAdds) return false;

    const movePct = movePctFromEntry(price, pos.initialEntryPrice);
    if (movePct == null || movePct < 0) return false;

    const nextLevel = (pos.addCount + 1) * cfg.addOnMovePct;
    if (movePct < nextLevel) return false;

    const addMargin = state.balance * (cfg.addOnDepositPct / 100);
    if (addMargin < 1) {
      pushLog("SKIP", pos.symbol, "insufficient balance for add-on");
      return false;
    }

    const addQty = addMargin / price;
    const oldQty = pos.quantity;
    const oldAvg = pos.entryPrice;
    pos.quantity = oldQty + addQty;
    pos.entryPrice = (oldAvg * oldQty + price * addQty) / pos.quantity;
    pos.margin += addMargin;
    pos.addCount += 1;
    state.balance -= addMargin;
    pushLog(
      "ADD",
      pos.symbol,
      `+${cfg.addOnDepositPct}% ($${addMargin.toFixed(2)}) @ ${price.toFixed(6)} · avg entry ${pos.entryPrice.toFixed(6)} · deposit $${state.balance.toFixed(2)} · move +${movePct.toFixed(2)}% (level ${nextLevel}%)`
    );
    const slMove = moveStopAfterAddOn(pos, cfg.moveStopOffsetPct);
    if (slMove) {
      pushLog(
        "MOVE_SL",
        pos.symbol,
        `SL ${slMove.prev.toFixed(6)} → ${slMove.targetSl.toFixed(6)} (avg entry ${pos.entryPrice.toFixed(6)} ${cfg.moveStopOffsetPct >= 0 ? "−" : "+"}${Math.abs(cfg.moveStopOffsetPct)}%) after add-on`
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
    if (targetSl <= pos.stopLoss) return false;

    const prev = pos.stopLoss;
    pos.stopLoss = targetSl;
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
      pos.movePctFromEntry = +(
        movePctFromEntry(close, pos.initialEntryPrice) ?? 0
      ).toFixed(3);
      pos.unrealizedPnl = +unrealizedFor(pos, close).toFixed(4);
      if (close !== prevLast || pos.unrealizedPnl !== prevUnr) changed = true;

      const addPrice = Number.isFinite(high) ? high : close;
      if (tryAddToPosition(pos, addPrice)) changed = true;
      if (tryMoveStopLoss(pos, addPrice)) changed = true;

      if (shouldCloseFalseSpike(pos, close, state.config)) {
        closePosition(pos, close, "false_spike");
        changed = true;
        continue;
      }

      if (Number.isFinite(low) && low <= pos.stopLoss) {
        closePosition(pos, pos.stopLoss, "stop_loss");
        changed = true;
        continue;
      }
      if (Number.isFinite(high) && high >= pos.takeProfit) {
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
      drawdownBaseline: state.drawdownBaseline,
      drawdownTriggeredAt: state.drawdownTriggeredAt,
      savedAt: Date.now(),
    });
  }

  return {
    getPublicState,
    patchConfig,
    reset,
    onSpikeSignal,
    onFastCorridorSignal,
    onSfpSignal,
    onPullbackSignal,
    updatePrices,
    flush,
  };
}

module.exports = {
  createPaperBot,
  DEFAULT_CONFIG,
  SHARED_BOT_PATCH_KEYS,
  pickSharedBotPatch,
  normalizeConfig,
  normalizeOpenPosition,
  stopLossPrice,
  stopLossFallbackForLong,
  resolveInitialStopLoss,
  wouldLongStopMarketTrigger,
  takeProfitPrice,
  entryBasedStopPrice,
  moveStopAfterAddOn,
  movePctFromEntry,
  falseSpikeThresholdPrice,
  shouldCloseFalseSpike,
  exitReasonLabel,
};
