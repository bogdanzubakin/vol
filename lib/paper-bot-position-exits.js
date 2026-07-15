/**
 * Early-abort (phase 1) and runner trail (phase 2) for paper bot positions.
 */

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const POSITION_EXIT_DEFAULTS = {
  earlyAbortEnabled: false,
  /** Signal bars without min progress → early_stall. */
  earlyAbortBars: 8,
  /** First N bars: close below corridor/reclaim → early_invalidation. */
  earlyAbortInvalidateBars: 5,
  earlyAbortMinProgressPct: 0.5,
  earlyAbortMaxAdversePct: 1.1,
  runnerEnabled: false,
  /** 0 = use takeProfitPct × runnerActivateTpFraction for activation. */
  runnerActivatePct: 0,
  runnerActivateTpFraction: 0.95,
  /** Trail stop / reversal giveback from peak (%). */
  runnerGivebackPct: 0.5,
  /** Bars of lows kept for structure-break reversal. */
  runnerStructureBars: 4,
  /** Reversal votes required (giveback, structure, corridor). */
  runnerReversalSignals: 2,
};

function normalizePositionExitConfig(raw = {}) {
  const d = POSITION_EXIT_DEFAULTS;
  return {
    earlyAbortEnabled: Boolean(raw.earlyAbortEnabled),
    earlyAbortBars: clamp(Math.round(num(raw.earlyAbortBars, d.earlyAbortBars)), 1, 120),
    earlyAbortInvalidateBars: clamp(
      Math.round(num(raw.earlyAbortInvalidateBars, d.earlyAbortInvalidateBars)),
      1,
      30
    ),
    earlyAbortMinProgressPct: clamp(
      num(raw.earlyAbortMinProgressPct, d.earlyAbortMinProgressPct),
      0,
      20
    ),
    earlyAbortMaxAdversePct: clamp(
      num(raw.earlyAbortMaxAdversePct, d.earlyAbortMaxAdversePct),
      0.1,
      20
    ),
    runnerEnabled: Boolean(raw.runnerEnabled),
    runnerActivatePct: clamp(num(raw.runnerActivatePct, d.runnerActivatePct), 0, 100),
    runnerActivateTpFraction: clamp(
      num(raw.runnerActivateTpFraction, d.runnerActivateTpFraction),
      0.5,
      1
    ),
    runnerGivebackPct: clamp(num(raw.runnerGivebackPct, d.runnerGivebackPct), 0.05, 10),
    runnerStructureBars: clamp(
      Math.round(num(raw.runnerStructureBars, d.runnerStructureBars)),
      2,
      20
    ),
    runnerReversalSignals: clamp(
      Math.round(num(raw.runnerReversalSignals, d.runnerReversalSignals)),
      1,
      3
    ),
  };
}

const { isShort, peakMovePct, adverseMovePct, takeProfitHit } = require("./position-side");
const { cfgForSignal } = require("./side-config");

/** Avoid re-moving SL on every tick for sub-tick float / mark noise. */
function stopPricesCloseEnough(a, b, referencePrice) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const ref = Number.isFinite(referencePrice) ? referencePrice : a;
  const tol = Math.max(1e-8, Math.abs(ref) * 1e-5);
  return Math.abs(a - b) <= tol;
}

function takeProfitPctForSignal(signalKind, cfg) {
  cfg = cfgForSignal(cfg, signalKind);
  const base = num(cfg.takeProfitPct, 3);
  if (
    (signalKind === "sfp" || signalKind === "sfp_bear") &&
    num(cfg.sfpTakeProfitPct, 0) > 0
  ) {
    return Math.min(num(cfg.sfpTakeProfitPct, base), base);
  }
  return base;
}

function reclaimLevelFor(pos) {
  const corridorLow = pos.corridorLow;
  const sweepLow = pos.sweepLow;
  if (Number.isFinite(sweepLow) && Number.isFinite(corridorLow)) {
    return Math.max(corridorLow, sweepLow);
  }
  return corridorLow ?? sweepLow ?? null;
}

function rejectLevelFor(pos) {
  const corridorHigh = pos.corridorHigh;
  const sweepHigh = pos.sweepHigh;
  if (Number.isFinite(sweepHigh) && Number.isFinite(corridorHigh)) {
    return Math.min(corridorHigh, sweepHigh);
  }
  return corridorHigh ?? sweepHigh ?? null;
}

function longTakeProfitHit(high, pos) {
  return takeProfitHit({ high, low: high, close: high }, pos);
}

function seedPositionExitContext(pos, metrics) {
  if (metrics?.sweepLow != null && pos.sweepLow == null) {
    pos.sweepLow = metrics.sweepLow;
  }
  if (metrics?.sweepHigh != null && pos.sweepHigh == null) {
    pos.sweepHigh = metrics.sweepHigh;
  }
  if (metrics?.levelPrice != null && pos.levelPrice == null) {
    pos.levelPrice = metrics.levelPrice;
  }
  pos.reclaimLevel = reclaimLevelFor(pos);
  pos.rejectLevel = rejectLevelFor(pos);
  if (pos.runnerMode == null) pos.runnerMode = false;
  if (pos.barsInTrade == null) pos.barsInTrade = 0;
  if (pos.recentLows == null) pos.recentLows = [];
  if (pos.recentHighs == null) pos.recentHighs = [];
  if (pos.lastBarKey == null) pos.lastBarKey = null;
  return pos;
}

/**
 * True while we are still inside the candle that was open when the position entered.
 * That candle's high/low can include pre-entry wicks and must not drive early exits.
 */
function isEntryBar(pos, bar) {
  const openedAt = pos?.openedAt ?? pos?.exchangeOpenedAt;
  const openTime = bar?.openTime;
  const closeTime = bar?.closeTime;
  if (!Number.isFinite(openedAt) || !Number.isFinite(openTime)) return false;
  if (Number.isFinite(closeTime)) {
    return openTime <= openedAt && openedAt <= closeTime;
  }
  return openTime <= openedAt;
}

/**
 * High/low for SL/TP/extreme tracking. On the entry bar, only the mark/close
 * after entry is trusted — full candle range can pre-date the fill.
 */
function postEntryBarExtremes(pos, bar, high, low, close) {
  if (isEntryBar(pos, bar)) {
    const mark = Number.isFinite(close) ? close : bar?.close;
    return { high: mark, low: mark, close: mark };
  }
  return {
    high: Number.isFinite(high) ? high : close,
    low: Number.isFinite(low) ? low : close,
    close,
  };
}

function tickBarProgress(pos, bar, cfg) {
  const key = bar?.openTime ?? bar?.closeTime ?? null;
  if (key == null) return;
  if (pos.lastBarKey === key) return;

  // First unique bar seen after open is the entry candle — record it but do not
  // count it as a completed in-trade bar. Counting it allowed early_invalidation /
  // early_adverse to fire within seconds on pre-entry wick extremes.
  if (pos.lastBarKey == null) {
    pos.lastBarKey = key;
    pos.entryBarKey = key;
    return;
  }

  pos.lastBarKey = key;
  pos.barsInTrade = (pos.barsInTrade ?? 0) + 1;
  const k = cfg?.runnerStructureBars ?? POSITION_EXIT_DEFAULTS.runnerStructureBars;
  const { low, high } = postEntryBarExtremes(
    pos,
    bar,
    bar.low ?? bar.close,
    bar.high ?? bar.close,
    bar.close
  );
  if (Number.isFinite(low)) {
    pos.recentLows = [...(pos.recentLows ?? []), low].slice(-k);
  }
  if (Number.isFinite(high)) {
    pos.recentHighs = [...(pos.recentHighs ?? []), high].slice(-k);
  }
}

function runnerActivateThreshold(cfg, pos) {
  if (num(cfg.runnerActivatePct, 0) > 0) {
    return cfg.runnerActivatePct;
  }
  return takeProfitPctForSignal(pos.signalKind, cfg) * num(cfg.runnerActivateTpFraction, 0.95);
}

function evaluateEarlyAbort(cfg, pos, bar) {
  const { cfgForSignal } = require("./side-config");
  cfg = cfgForSignal(cfg, pos?.signalKind, { side: pos?.side });
  if (!cfg.earlyAbortEnabled) return null;
  const close = bar.close;
  if (!Number.isFinite(close)) return null;

  const bars = pos.barsInTrade ?? 0;
  const invalidateBars = cfg.earlyAbortInvalidateBars ?? 3;

  if (bars > 0 && bars <= invalidateBars) {
    if (isShort(pos)) {
      if (Number.isFinite(pos.corridorHigh) && close > pos.corridorHigh) {
        return {
          reason: "early_invalidation",
          exitPrice: close,
          detail: "close above corridor high",
        };
      }
      const reject = pos.rejectLevel ?? rejectLevelFor(pos);
      if (Number.isFinite(reject) && close > reject) {
        return {
          reason: "early_invalidation",
          exitPrice: close,
          detail: "close above reject",
        };
      }
    } else {
      if (Number.isFinite(pos.corridorLow) && close < pos.corridorLow) {
        return {
          reason: "early_invalidation",
          exitPrice: close,
          detail: "close below corridor low",
        };
      }
      const reclaim = pos.reclaimLevel ?? reclaimLevelFor(pos);
      if (Number.isFinite(reclaim) && close < reclaim) {
        return {
          reason: "early_invalidation",
          exitPrice: close,
          detail: "close below reclaim",
        };
      }
    }
  }

  const maxBars = cfg.earlyAbortBars ?? 8;
  const minProg = cfg.earlyAbortMinProgressPct ?? 0.5;
  const maxAdv = cfg.earlyAbortMaxAdversePct ?? 0.9;
  const peak = peakMovePct(pos);
  const adverse = adverseMovePct(pos);

  if (bars > 0 && bars <= maxBars) {
    if (
      adverse != null &&
      adverse >= maxAdv &&
      (peak == null || peak < minProg)
    ) {
      return {
        reason: "early_adverse",
        exitPrice: close,
        detail: `${isShort(pos) ? "peak" : "trough"} ${adverse.toFixed(2)}%`,
      };
    }
  }

  if (bars >= maxBars) {
    if (peak == null || peak < minProg) {
      return {
        reason: "early_stall",
        exitPrice: close,
        detail: `peak ${peak == null ? "—" : peak.toFixed(2)}%`,
      };
    }
  }

  return null;
}

function tryActivateRunner(cfg, pos, bar) {
  if (!cfg.runnerEnabled || pos.runnerMode) return false;
  const high = bar.high ?? bar.close;
  const peak = peakMovePct(pos);
  const threshold = runnerActivateThreshold(cfg, pos);

  if (peak != null && peak >= threshold) {
    pos.runnerMode = true;
    return true;
  }
  if (longTakeProfitHit(high, pos)) {
    pos.runnerMode = true;
    return true;
  }
  if (
    cfg.moveStopEnabled &&
    pos.moveStopRaised &&
    peak != null &&
    peak >= num(cfg.moveStopAfterMovePct, 0)
  ) {
    pos.runnerMode = true;
    return true;
  }
  return false;
}

function countRunnerReversalSignals(cfg, pos, bar) {
  const close = bar.close;
  if (!Number.isFinite(close)) return 0;

  let signals = 0;
  const giveback = cfg.runnerGivebackPct ?? 0.5;
  const k = cfg.runnerStructureBars ?? 4;

  if (isShort(pos)) {
    const trough = pos.troughPrice;
    if (Number.isFinite(trough) && trough > 0) {
      const retracePct = ((close - trough) / trough) * 100;
      if (retracePct >= giveback) signals++;
    }
    const recent = pos.recentHighs ?? [];
    if (recent.length >= k) {
      const window = recent.slice(-k);
      const maxHigh = Math.max(...window);
      if (close > maxHigh) signals++;
    }
    if (Number.isFinite(pos.corridorHigh) && close > pos.corridorHigh) {
      signals++;
    }
    return signals;
  }

  const peak = pos.peakPrice;
  if (!Number.isFinite(peak) || peak <= 0) return 0;

  const retracePct = ((peak - close) / peak) * 100;
  if (retracePct >= giveback) signals++;

  const recent = pos.recentLows ?? [];
  if (recent.length >= k) {
    const window = recent.slice(-k);
    const minLow = Math.min(...window);
    if (close < minLow) signals++;
  }

  if (Number.isFinite(pos.corridorLow) && close < pos.corridorLow) {
    signals++;
  }

  return signals;
}

/**
 * Runner phase: activate, trail SL from peak, optional reversal exit.
 * Returns { activated, trailedSl, prevSl, exit, reason, exitPrice, detail }.
 */
function processRunnerPhase(cfg, pos, bar) {
  const out = {
    activated: false,
    trailedSl: false,
    prevSl: null,
    exit: false,
    reason: null,
    exitPrice: null,
    detail: null,
  };
  if (!cfg.runnerEnabled) return out;

  if (tryActivateRunner(cfg, pos, bar)) {
    out.activated = true;
    out.detail = `peak ${(peakMovePct(pos) ?? 0).toFixed(2)}%`;
  }

  if (!pos.runnerMode) return out;

  const giveback = cfg.runnerGivebackPct ?? 0.5;
  const ref = pos.entryPrice ?? pos.initialEntryPrice;

  if (isShort(pos)) {
    const trough = pos.troughPrice;
    if (Number.isFinite(trough) && trough > 0) {
      const trailSl = trough * (1 + giveback / 100);
      if (
        Number.isFinite(trailSl) &&
        trailSl < pos.stopLoss &&
        !stopPricesCloseEnough(trailSl, pos.stopLoss, ref)
      ) {
        out.prevSl = pos.stopLoss;
        pos.stopLoss = trailSl;
        out.trailedSl = true;
      }
    }
  } else {
    const peak = pos.peakPrice;
    if (Number.isFinite(peak) && peak > 0) {
      const trailSl = peak * (1 - giveback / 100);
      if (
        Number.isFinite(trailSl) &&
        trailSl > pos.stopLoss &&
        !stopPricesCloseEnough(trailSl, pos.stopLoss, ref)
      ) {
        out.prevSl = pos.stopLoss;
        pos.stopLoss = trailSl;
        out.trailedSl = true;
      }
    }
  }

  const need = cfg.runnerReversalSignals ?? 2;
  const signals = countRunnerReversalSignals(cfg, pos, bar);
  if (signals >= need) {
    out.exit = true;
    out.reason = "runner_exit";
    out.exitPrice = bar.close;
    out.detail = `reversal ${signals}/${need}`;
  }

  return out;
}

/**
 * Run early-abort + runner after peak/trough updated. Does not check SL/TP.
 */
function evaluatePositionExits(cfg, pos, bar) {
  tickBarProgress(pos, bar, cfg);

  const early = evaluateEarlyAbort(cfg, pos, bar);
  if (early) {
    return { close: true, ...early };
  }

  const runner = processRunnerPhase(cfg, pos, bar);
  if (runner.exit) {
    return {
      close: true,
      reason: runner.reason,
      exitPrice: runner.exitPrice,
      detail: runner.detail,
      runner,
    };
  }

  return { close: false, runner };
}

module.exports = {
  POSITION_EXIT_DEFAULTS,
  normalizePositionExitConfig,
  seedPositionExitContext,
  isEntryBar,
  postEntryBarExtremes,
  tickBarProgress,
  evaluateEarlyAbort,
  processRunnerPhase,
  evaluatePositionExits,
  peakMovePct,
  longTakeProfitHit,
  takeProfitHit,
  stopPricesCloseEnough,
};
