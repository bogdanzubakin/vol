/**
 * FOI follow-through regime gate.
 *
 * Autopsy (OOS2 vs OOS1/3): good regimes show higher rolling win/TP rate on
 * recent closed FOI trades — not different funding/OI entry levels.
 *
 * Default (BP1.2 OOS-optimized, all 3×10d windows positive):
 *   lookback=40 closed FOI trades, minWinRate=0.35, block during warmup.
 */

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const FOI_FOLLOWTHROUGH_REGIME_DEFAULTS = {
  foiFollowthroughRegimeEnabled: false,
  /** Rolling window of recently closed FOI trades. */
  foiFollowthroughLookback: 40,
  /** Require at least this many closes before gating (else warmupPolicy). */
  foiFollowthroughMinSamples: 16,
  /** Allow entry when rolling win-rate >= this (0–1). */
  foiFollowthroughMinWinRate: 0.35,
  /** warmup: block | allow | half — online books should use allow (block deadlocks empty tracker). */
  foiFollowthroughWarmupPolicy: "allow",
  /**
   * Soft size scaling while still above minWinRate (hard block):
   * wr < coldWinRate → should not happen if min≥cold; when sizeScaling on:
   *   wr < hotMinWinRate → sizeScale=coldSizeScale (default 0.5)
   *   wr ≥ hotMinWinRate → sizeScale=1
   */
  foiFollowthroughSizeScalingEnabled: false,
  foiFollowthroughColdWinRate: 0.28,
  foiFollowthroughHotMinWinRate: 0.38,
  foiFollowthroughColdSizeScale: 0.5,
  /**
   * On hot follow-through days, widen TP so winners are not capped early.
   * Uses rolling WR from the same tracker (no look-ahead).
   */
  foiHotProtectLongHoldsEnabled: false,
  /** Rolling WR threshold to treat regime as hot (typically ≥ minWinRate). */
  foiHotMinWinRate: 0.38,
  /** Multiply TP distance from entry when hot (1 = no change). */
  foiHotTpScale: 1.25,
};

function normalizeFoiFollowthroughRegimeConfig(raw = {}) {
  const warmup = String(
    raw.foiFollowthroughWarmupPolicy ??
      FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughWarmupPolicy
  ).toLowerCase();
  return {
    foiFollowthroughRegimeEnabled: Boolean(
      raw.foiFollowthroughRegimeEnabled ??
        FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughRegimeEnabled
    ),
    foiFollowthroughLookback: clamp(
      Math.round(
        num(
          raw.foiFollowthroughLookback,
          FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughLookback
        )
      ),
      10,
      500
    ),
    foiFollowthroughMinSamples: clamp(
      Math.round(
        num(
          raw.foiFollowthroughMinSamples,
          FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughMinSamples
        )
      ),
      5,
      500
    ),
    foiFollowthroughMinWinRate: clamp(
      num(
        raw.foiFollowthroughMinWinRate,
        FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughMinWinRate
      ),
      0,
      1
    ),
    foiFollowthroughWarmupPolicy:
      warmup === "allow" || warmup === "half" ? warmup : "block",
    foiFollowthroughSizeScalingEnabled: Boolean(
      raw.foiFollowthroughSizeScalingEnabled ??
        FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughSizeScalingEnabled
    ),
    foiFollowthroughColdWinRate: clamp(
      num(
        raw.foiFollowthroughColdWinRate,
        FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughColdWinRate
      ),
      0,
      1
    ),
    foiFollowthroughHotMinWinRate: clamp(
      num(
        raw.foiFollowthroughHotMinWinRate,
        FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughHotMinWinRate
      ),
      0,
      1
    ),
    foiFollowthroughColdSizeScale: clamp(
      num(
        raw.foiFollowthroughColdSizeScale,
        FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiFollowthroughColdSizeScale
      ),
      0.1,
      1
    ),
    foiHotProtectLongHoldsEnabled: Boolean(
      raw.foiHotProtectLongHoldsEnabled ??
        FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiHotProtectLongHoldsEnabled
    ),
    foiHotMinWinRate: clamp(
      num(raw.foiHotMinWinRate, FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiHotMinWinRate),
      0,
      1
    ),
    foiHotTpScale: clamp(
      num(raw.foiHotTpScale, FOI_FOLLOWTHROUGH_REGIME_DEFAULTS.foiHotTpScale),
      1,
      2.5
    ),
  };
}

/**
 * Widen FOI take-profit when rolling follow-through WR is hot.
 * Returns a shallow copy of exits when TP changes; otherwise same object.
 */
function applyFoiHotTpProtect(exits, options = {}) {
  const {
    signalKind,
    entry,
    short = false,
    cfg = {},
    tracker = null,
    asOfMs = Date.now(),
  } = options;
  if (!exits || exits.rejectReason || !isFoiSignalKind(signalKind)) return exits;
  const hc = normalizeFoiFollowthroughRegimeConfig(cfg);
  if (!hc.foiHotProtectLongHoldsEnabled || hc.foiHotTpScale <= 1) return exits;
  if (!tracker || typeof tracker.rollingBefore !== "function") return exits;
  const lookback = hc.foiFollowthroughLookback;
  const rolling = tracker.rollingBefore(asOfMs, lookback);
  if (!rolling || rolling.n < hc.foiFollowthroughMinSamples) return exits;
  if (rolling.wr < hc.foiHotMinWinRate) return exits;
  const tp0 = Number(exits.takeProfit);
  const e = Number(entry);
  if (!Number.isFinite(tp0) || !Number.isFinite(e) || e <= 0) return exits;
  const dist = short ? e - tp0 : tp0 - e;
  if (!(dist > 0)) return exits;
  const tp = short ? e - dist * hc.foiHotTpScale : e + dist * hc.foiHotTpScale;
  if (!(tp > 0) || !Number.isFinite(tp)) return exits;
  return {
    ...exits,
    takeProfit: tp,
    foiHotTpScaled: true,
    foiHotTpScale: hc.foiHotTpScale,
    foiHotWr: +rolling.wr.toFixed(4),
  };
}

function isFoiSignalKind(signalKind) {
  return signalKind === "foi" || signalKind === "foi_bear";
}

function createFoiFollowthroughRegimeTracker(options = {}) {
  const maxKeep = clamp(Math.round(num(options.maxKeep, 500)), 50, 5000);
  /** @type {{ closedAt: number, pnl: number, win: boolean }[]} */
  const closes = [];

  function recordClosedTrade(trade) {
    if (!trade || !isFoiSignalKind(trade.signalKind)) return;
    const closedAt = Number(trade.closedAt);
    const pnl = Number(trade.pnl);
    if (!Number.isFinite(closedAt)) return;
    closes.push({
      closedAt,
      pnl: Number.isFinite(pnl) ? pnl : 0,
      win: Number.isFinite(pnl) && pnl > 0,
    });
    if (closes.length > maxKeep) closes.splice(0, closes.length - maxKeep);
  }

  function rollingBefore(asOfMs, lookback) {
    const asOf = Number(asOfMs);
    if (!Number.isFinite(asOf)) return null;
    const eligible = [];
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i];
      if (c.closedAt >= asOf) continue;
      eligible.push(c);
      if (eligible.length >= lookback) break;
    }
    if (!eligible.length) return null;
    const n = eligible.length;
    const wins = eligible.filter((c) => c.win).length;
    const sumPnl = eligible.reduce((s, c) => s + c.pnl, 0);
    return {
      n,
      wr: wins / n,
      sumPnl,
      avgPnl: sumPnl / n,
    };
  }

  /**
   * @returns {{ pass: boolean, sizeScale: number, detail: string, rolling: object|null, warmup: boolean }}
   */
  function check(cfgInput, asOfMs = Date.now()) {
    const cfg = normalizeFoiFollowthroughRegimeConfig(cfgInput ?? {});
    if (!cfg.foiFollowthroughRegimeEnabled) {
      return { pass: true, sizeScale: 1, detail: "disabled", rolling: null, warmup: false };
    }
    const rolling = rollingBefore(asOfMs, cfg.foiFollowthroughLookback);
    const minN = Math.min(cfg.foiFollowthroughMinSamples, cfg.foiFollowthroughLookback);
    if (!rolling || rolling.n < minN) {
      if (cfg.foiFollowthroughWarmupPolicy === "allow") {
        return {
          pass: true,
          sizeScale: 1,
          detail: `warmup allow (${rolling?.n ?? 0}/${minN})`,
          rolling,
          warmup: true,
        };
      }
      if (cfg.foiFollowthroughWarmupPolicy === "half") {
        return {
          pass: true,
          sizeScale: 0.5,
          detail: `warmup half (${rolling?.n ?? 0}/${minN})`,
          rolling,
          warmup: true,
        };
      }
      return {
        pass: false,
        sizeScale: 0,
        detail: `warmup block (${rolling?.n ?? 0}/${minN})`,
        rolling,
        warmup: true,
      };
    }
    const ok = rolling.wr >= cfg.foiFollowthroughMinWinRate;
    if (!ok) {
      return {
        pass: false,
        sizeScale: 0,
        detail: `wr ${(100 * rolling.wr).toFixed(1)}% < ${(100 * cfg.foiFollowthroughMinWinRate).toFixed(1)}% (n=${rolling.n})`,
        rolling,
        warmup: false,
      };
    }
    let sizeScale = 1;
    let detail = `wr ${(100 * rolling.wr).toFixed(1)}% ≥ ${(100 * cfg.foiFollowthroughMinWinRate).toFixed(1)}% (n=${rolling.n})`;
    if (cfg.foiFollowthroughSizeScalingEnabled) {
      if (rolling.wr < cfg.foiFollowthroughHotMinWinRate) {
        sizeScale = cfg.foiFollowthroughColdSizeScale;
        detail += ` · size×${sizeScale} (below hot ${(100 * cfg.foiFollowthroughHotMinWinRate).toFixed(0)}%)`;
      } else {
        detail += ` · size×1 (hot)`;
      }
      // Optional: if somehow wr between cold and min — already blocked above when min≥cold.
      if (rolling.wr < cfg.foiFollowthroughColdWinRate) {
        sizeScale = Math.min(sizeScale, cfg.foiFollowthroughColdSizeScale);
        detail += ` · cold wr`;
      }
    }
    return {
      pass: true,
      sizeScale,
      detail,
      rolling,
      warmup: false,
    };
  }

  function snapshot() {
    return closes.map((c) => ({ ...c }));
  }

  return {
    recordClosedTrade,
    rollingBefore,
    check,
    snapshot,
    get size() {
      return closes.length;
    },
  };
}

/**
 * Causal offline filter on a list of FOI trades (for OOS threshold search).
 * Only uses closes with closedAt < openAt (no look-ahead).
 */
function applyFoiFollowthroughGateToTrades(trades, cfgInput) {
  const cfg = normalizeFoiFollowthroughRegimeConfig({
    ...FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
    foiFollowthroughRegimeEnabled: true,
    ...cfgInput,
  });
  const tracker = createFoiFollowthroughRegimeTracker();
  const events = [...(trades || [])]
    .filter((t) => t?.openedAt != null && t?.closedAt != null)
    .map((t) => ({
      kind: "trade",
      openAt: Number(t.openedAt),
      closeAt: Number(t.closedAt),
      trade: t,
    }))
    .filter((e) => Number.isFinite(e.openAt) && Number.isFinite(e.closeAt));

  // Process in time order: at each open, decide; at each close, record.
  // Use dual timeline: sort opens and closes separately with a merge.
  const opens = events
    .map((e) => ({ t: e.openAt, type: "open", trade: e.trade }))
    .sort((a, b) => a.t - b.t || a.trade.symbol?.localeCompare?.(b.trade.symbol) || 0);
  const closesChrono = events
    .map((e) => ({ t: e.closeAt, type: "close", trade: e.trade }))
    .sort((a, b) => a.t - b.t);

  let ci = 0;
  const kept = [];
  const blocked = [];
  for (const ev of opens) {
    while (ci < closesChrono.length && closesChrono[ci].t < ev.t) {
      tracker.recordClosedTrade(closesChrono[ci].trade);
      ci++;
    }
    const gate = tracker.check(cfg, ev.t);
    const size = gate.sizeScale;
    if (size > 0) {
      kept.push({
        ...ev.trade,
        pnl: +(Number(ev.trade.pnl) || 0) * size,
        _regimeSize: size,
        _regimeDetail: gate.detail,
      });
    } else {
      blocked.push({ ...ev.trade, _regimeDetail: gate.detail });
    }
  }
  // Drain remaining closes (not needed for PnL but keeps tracker consistent)
  while (ci < closesChrono.length) {
    tracker.recordClosedTrade(closesChrono[ci].trade);
    ci++;
  }

  const pnl = +kept.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2);
  const wins = kept.filter((t) => (t.pnl || 0) > 0).length;
  return {
    cfg,
    kept,
    blocked,
    summary: {
      trades: kept.length,
      blocked: blocked.length,
      pnl,
      winRate: kept.length ? +((100 * wins) / kept.length).toFixed(1) : 0,
    },
  };
}

module.exports = {
  FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
  normalizeFoiFollowthroughRegimeConfig,
  createFoiFollowthroughRegimeTracker,
  applyFoiFollowthroughGateToTrades,
  applyFoiHotTpProtect,
  isFoiSignalKind,
};
