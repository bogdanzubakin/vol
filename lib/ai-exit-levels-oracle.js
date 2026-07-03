const { positionPnl, isShort } = require("./position-side");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function slTpCandidates(cfg, signalKind) {
  const baseTp =
    (signalKind === "sfp" || signalKind === "sfp_bear") &&
    num(cfg.sfpTakeProfitPct, 0) > 0
      ? Math.min(num(cfg.sfpTakeProfitPct), num(cfg.takeProfitPct, 5))
      : num(cfg.takeProfitPct, 5);
  const tpMin = Math.max(0.8, num(cfg.takeProfitMinPct, 1.5));
  const tpMax = Math.max(tpMin, baseTp);
  const slMin = Math.max(0.4, num(cfg.minSmartStopDistancePct, 0.8));
  const slMax = Math.max(
    slMin,
    num(cfg.stopLossFallbackPnlPct, 2),
    num(cfg.stopLossBelowCorridorPct, 2)
  );

  const sl = [];
  const tp = [];
  for (let v = slMin; v <= slMax + 1e-6; v += 0.25) sl.push(+v.toFixed(2));
  for (let v = tpMin; v <= tpMax + 1e-6; v += 0.35) tp.push(+v.toFixed(2));
  if (!sl.includes(slMax)) sl.push(+slMax.toFixed(2));
  if (!tp.includes(tpMax)) tp.push(+tpMax.toFixed(2));
  return { sl, tp, slMin, slMax, tpMin, tpMax };
}

function bracketPrices(entry, slPct, tpPct, short) {
  if (short) {
    return {
      stopLoss: entry * (1 + slPct / 100),
      takeProfit: entry * (1 - tpPct / 100),
    };
  }
  return {
    stopLoss: entry * (1 - slPct / 100),
    takeProfit: entry * (1 + tpPct / 100),
  };
}

function simulateBracketPnl(trade, bars, slPct, tpPct) {
  const entry = num(trade.entryPrice);
  if (!entry || !bars?.length) return null;
  const short = isShort(trade);
  const margin = num(trade.margin, 1);
  const leverage = num(trade.leverage, 1);
  const quantity = num(trade.quantity, (margin * leverage) / entry);
  const pos = {
    side: short ? "SHORT" : "LONG",
    entryPrice: entry,
    quantity,
    margin,
    leverage,
  };
  const { stopLoss, takeProfit } = bracketPrices(entry, slPct, tpPct, short);

  for (const bar of bars) {
    const low = num(bar.low, bar.close);
    const high = num(bar.high, bar.close);
    if (short) {
      if (high >= stopLoss) {
        return {
          pnl: positionPnl(pos, stopLoss),
          exitReason: "stop_loss",
          slPct,
          tpPct,
        };
      }
      if (low <= takeProfit) {
        return {
          pnl: positionPnl(pos, takeProfit),
          exitReason: "take_profit",
          slPct,
          tpPct,
        };
      }
    } else {
      if (low <= stopLoss) {
        return {
          pnl: positionPnl(pos, stopLoss),
          exitReason: "stop_loss",
          slPct,
          tpPct,
        };
      }
      if (high >= takeProfit) {
        return {
          pnl: positionPnl(pos, takeProfit),
          exitReason: "take_profit",
          slPct,
          tpPct,
        };
      }
    }
  }

  const last = bars[bars.length - 1]?.close ?? entry;
  return {
    pnl: positionPnl(pos, last),
    exitReason: "backtest_end",
    slPct,
    tpPct,
  };
}

/**
 * Grid-search oracle: best SL/TP % pair on forward path (legacy param bounds).
 */
function oracleSlTpFromBars(trade, bars, cfg = {}) {
  const entry = num(trade.entryPrice);
  if (!entry || !bars?.length) return null;
  const signalKind = trade.signalKind ?? "sfp";
  const { sl, tp } = slTpCandidates(cfg, signalKind);
  const legacy = simulateBracketPnl(
    trade,
    bars,
    num(trade.slDistancePct, num(cfg.stopLossFallbackPnlPct, 2)),
    num(trade.tpDistancePct, num(cfg.takeProfitPct, 5))
  );

  let best = null;
  for (const slPct of sl) {
    for (const tpPct of tp) {
      if (tpPct < slPct * 0.45) continue;
      const sim = simulateBracketPnl(trade, bars, slPct, tpPct);
      if (!sim) continue;
      const score = sim.pnl;
      if (
        !best ||
        score > best.pnl + 1e-6 ||
        (Math.abs(score - best.pnl) < 1e-6 && sim.exitReason === "take_profit")
      ) {
        best = { ...sim, score };
      }
    }
  }

  if (!best) return null;
  return {
    slPct: best.slPct,
    tpPct: best.tpPct,
    oraclePnl: +best.pnl.toFixed(4),
    oracleExitReason: best.exitReason,
    legacyPnl: legacy ? +legacy.pnl.toFixed(4) : null,
    deltaVsLegacy: legacy ? +(best.pnl - legacy.pnl).toFixed(4) : null,
  };
}

function barsInTradeRange(allBars, openedAt, closedAt) {
  return (allBars ?? []).filter(
    (b) => b.closeTime >= openedAt && b.closeTime <= closedAt + 120_000
  );
}

module.exports = {
  slTpCandidates,
  bracketPrices,
  simulateBracketPnl,
  oracleSlTpFromBars,
  barsInTradeRange,
};
