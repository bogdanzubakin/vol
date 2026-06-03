const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");

const STATE_FILE = () => dataPath("paper-bot-state.json");

const DEFAULT_CONFIG = {
  enabled: false,
  initialDeposit: 1000,
  positionSizePct: 1,
  stopLossBelowCorridorPct: 2,
  takeProfitPct: 10,
  tradeSpikeSignals: true,
  tradeFastCorridorSignals: false,
};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
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
    takeProfitPct: clamp(num(raw.takeProfitPct, DEFAULT_CONFIG.takeProfitPct), 0.1, 200),
    tradeSpikeSignals:
      raw.tradeSpikeSignals !== undefined
        ? Boolean(raw.tradeSpikeSignals)
        : DEFAULT_CONFIG.tradeSpikeSignals,
    tradeFastCorridorSignals: Boolean(raw.tradeFastCorridorSignals),
  };
}

/** Stop below the top corridor border (corridor high). */
function stopLossPrice(corridorHigh, pct) {
  if (!Number.isFinite(corridorHigh) || corridorHigh <= 0) return null;
  return corridorHigh * (1 - pct / 100);
}

function takeProfitPrice(entry, pct) {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  return entry * (1 + pct / 100);
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
    };
  }
  const config = normalizeConfig(raw.config);
  return {
    config,
    balance: num(raw.balance, config.initialDeposit),
    openPositions: Array.isArray(raw.openPositions) ? raw.openPositions : [],
    closedTrades: Array.isArray(raw.closedTrades) ? raw.closedTrades : [],
    log: Array.isArray(raw.log) ? raw.log.slice(0, 200) : [],
  };
}

function createPaperBot() {
  let state = loadState();
  let saveTimer = null;

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

  function summarize() {
    const open = state.openPositions;
    let unrealized = 0;
    for (const p of open) unrealized += p.unrealizedPnl ?? 0;
    const realized = state.closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const initial = state.config.initialDeposit;
    return {
      initialDeposit: initial,
      balance: +state.balance.toFixed(4),
      equity: +(state.balance + unrealized).toFixed(4),
      unrealizedPnl: +unrealized.toFixed(4),
      realizedPnl: +realized.toFixed(4),
      totalPnl: +(state.balance - initial + unrealized).toFixed(4),
      openCount: open.length,
      closedCount: state.closedTrades.length,
    };
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
    state.config = normalizeConfig({ ...state.config, ...patch });
    persistSoon();
    return getPublicState();
  }

  function reset() {
    const initial = state.config.initialDeposit;
    state.balance = initial;
    state.openPositions = [];
    state.closedTrades = [];
    state.log = [];
    pushLog("RESET", "—", `Balance reset to $${initial}`);
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
    const sl = stopLossPrice(
      metrics.corridorHigh,
      state.config.stopLossBelowCorridorPct
    );
    const tp = takeProfitPrice(entry, state.config.takeProfitPct);
    if (!sl || !tp) return;

    const margin = state.balance * (state.config.positionSizePct / 100);
    if (margin < 1) {
      pushLog("SKIP", symbol, "insufficient balance for margin");
      return;
    }

    const quantity = margin / entry;
    const pos = {
      id: `${symbol}-${Date.now()}`,
      symbol,
      signalKind,
      side: "LONG",
      entryPrice: entry,
      quantity,
      margin,
      corridorLow: metrics.corridorLow,
      corridorHigh: metrics.corridorHigh ?? null,
      stopLoss: sl,
      takeProfit: tp,
      lastPrice: entry,
      unrealizedPnl: 0,
      openedAt: Date.now(),
    };
    state.openPositions.push(pos);
    pushLog(
      "OPEN",
      symbol,
      `LONG ${signalKind} @ ${entry.toFixed(6)} · margin $${margin.toFixed(2)} · SL ${sl.toFixed(6)} (${state.config.stopLossBelowCorridorPct}% below corridor high) · TP ${tp.toFixed(6)}`
    );
    persistSoon();
  }

  function onSpikeSignal(sym, metrics) {
    if (!state.config.tradeSpikeSignals) return;
    tryOpen(sym, "spike", metrics);
  }

  function onFastCorridorSignal(sym, metrics) {
    if (!state.config.tradeFastCorridorSignals) return;
    tryOpen(sym, "fast-corridor", metrics);
  }

  function closePosition(pos, exitPrice, reason, bar) {
    const pnl = pos.quantity * (exitPrice - pos.entryPrice);
    const pnlPct = (pnl / pos.margin) * 100;
    state.balance += pnl;
    const trade = {
      id: pos.id,
      symbol: pos.symbol,
      signalKind: pos.signalKind,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: pos.quantity,
      margin: pos.margin,
      corridorLow: pos.corridorLow,
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
      `${reason} @ ${exitPrice.toFixed(6)} · PnL $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`
    );
  }

  function updatePrices(getBar) {
    if (!state.openPositions.length) return;
    const stillOpen = [];
    for (const pos of state.openPositions) {
      const bar = getBar(pos.symbol);
      const close = bar?.close;
      const low = bar?.low ?? close;
      const high = bar?.high ?? close;
      if (!Number.isFinite(close)) {
        stillOpen.push(pos);
        continue;
      }
      pos.lastPrice = close;
      pos.unrealizedPnl = +unrealizedFor(pos, close).toFixed(4);

      if (Number.isFinite(low) && low <= pos.stopLoss) {
        closePosition(pos, pos.stopLoss, "stop_loss", bar);
        continue;
      }
      if (Number.isFinite(high) && high >= pos.takeProfit) {
        closePosition(pos, pos.takeProfit, "take_profit", bar);
        continue;
      }
      stillOpen.push(pos);
    }
    if (stillOpen.length !== state.openPositions.length) {
      state.openPositions = stillOpen;
      persistSoon();
    }
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
      savedAt: Date.now(),
    });
  }

  return {
    getPublicState,
    patchConfig,
    reset,
    onSpikeSignal,
    onFastCorridorSignal,
    updatePrices,
    flush,
  };
}

module.exports = {
  createPaperBot,
  DEFAULT_CONFIG,
  normalizeConfig,
  stopLossPrice,
  takeProfitPrice,
};
