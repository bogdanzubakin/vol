#!/usr/bin/env node
/**
 * Propose & test PnL improvement ideas on breakpoint 1.0 FOI trades (10d).
 * Fast 1m bar-replay from each entry (same entries as bp 1.0) under alternate exit/hedge policies.
 *
 *   node scripts/sweep-foi-bp10-pnl-ideas-10d.js
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(4096);

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { readSymbolBars } = require("../lib/backtest-kline-cache");

const BP = () => path.join(dataPath(), "breakpoints", "1.0");
const OUT = () => dataPath("foi-bp10-pnl-ideas-10d.json");
const DETAIL = () => dataPath("foi-bp10-pnl-ideas-10d-trades.json");

function log(m) {
  console.error(String(m));
}

function bars1m(sym) {
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym);
}

function movePct(side, entry, px) {
  if (!Number.isFinite(entry) || !Number.isFinite(px) || entry === 0) return null;
  return side === "SHORT" ? ((entry - px) / entry) * 100 : ((px - entry) / entry) * 100;
}

function adversePct(side, entry, high, low) {
  if (side === "SHORT") {
    if (!Number.isFinite(high) || !Number.isFinite(entry)) return null;
    return ((high - entry) / entry) * 100;
  }
  if (!Number.isFinite(low) || !Number.isFinite(entry)) return null;
  return ((entry - low) / entry) * 100;
}

function favorPct(side, entry, high, low) {
  if (side === "SHORT") {
    if (!Number.isFinite(low) || !Number.isFinite(entry)) return null;
    return ((entry - low) / entry) * 100;
  }
  if (!Number.isFinite(high) || !Number.isFinite(entry)) return null;
  return ((high - entry) / entry) * 100;
}

function hitSl(side, sl, high, low) {
  if (!Number.isFinite(sl)) return false;
  return side === "SHORT" ? high >= sl : low <= sl;
}

function hitTp(side, tp, high, low) {
  if (!Number.isFinite(tp)) return false;
  return side === "SHORT" ? low <= tp : high >= tp;
}

function exitPxOnSl(side, sl) {
  return sl;
}
function exitPxOnTp(side, tp) {
  return tp;
}

/** Dollars per 1% price move, calibrated from recorded trade. */
function dollarPerPct(trade) {
  const m = movePct(trade.side, trade.entryPrice, trade.exitPrice);
  if (!Number.isFinite(m) || Math.abs(m) < 1e-9) {
    // fallback from SL distance
    const slM = movePct(trade.side, trade.entryPrice, trade.stopLoss);
    if (Number.isFinite(slM) && Math.abs(slM) > 1e-9) {
      return Math.abs(Number(trade.pnl) || 0.23) / Math.abs(slM);
    }
    return 0.2;
  }
  return (Number(trade.pnl) || 0) / m;
}

function barsFromEntry(symbol, openedAt, maxBars = 8000) {
  const all = bars1m(symbol) ?? [];
  const out = [];
  for (const b of all) {
    if (b.closeTime <= openedAt) continue;
    out.push(b);
    if (out.length >= maxBars) break;
  }
  return out;
}

/**
 * Policies — each returns { pnl, exitReason, exitPrice, holdBars, hedgeUsed?, notes? }
 */
const POLICIES = {
  /** Sanity: SL/TP only (ignore recorded early exits). */
  sl_tp_only(ctx) {
    return walk(ctx, { useEarly: false });
  },

  /** Replay approx of bp1.0 early-abort settings. */
  baseline_ea(ctx) {
    return walk(ctx, {
      useEarly: true,
      invalidateBars: 5,
      eaBars: 15,
      minProg: 0.25,
      maxAdv: 2.0,
      stall: true,
      adverse: true,
      invalidation: true,
    });
  },

  /** #1 User idea: bidirectional lock on fast adverse, flatten when back to entry. */
  hedge_lock_to_entry(ctx) {
    return walkHedge(ctx, {
      triggerAdversePct: 1.0,
      triggerWithinBars: 15,
      mode: "return_to_entry",
      maxBarsAfterHedge: 90,
    });
  },

  /** Hedge lock, flatten both after fixed time. */
  hedge_lock_time30(ctx) {
    return walkHedge(ctx, {
      triggerAdversePct: 1.0,
      triggerWithinBars: 15,
      mode: "time",
      maxBarsAfterHedge: 30,
    });
  },

  /** Hedge at 1.5% adverse within 20 bars; flatten at entry return or 60 bars. */
  hedge_lock_15_60(ctx) {
    return walkHedge(ctx, {
      triggerAdversePct: 1.5,
      triggerWithinBars: 20,
      mode: "return_to_entry",
      maxBarsAfterHedge: 60,
    });
  },

  /** Keep early_adverse + invalidation, drop early_stall. */
  no_early_stall(ctx) {
    return walk(ctx, {
      useEarly: true,
      invalidateBars: 5,
      eaBars: 15,
      minProg: 0.25,
      maxAdv: 2.0,
      stall: false,
      adverse: true,
      invalidation: true,
    });
  },

  /** Only early_adverse (no stall / invalidation). */
  adverse_only(ctx) {
    return walk(ctx, {
      useEarly: true,
      eaBars: 15,
      minProg: 0.25,
      maxAdv: 2.0,
      stall: false,
      adverse: true,
      invalidation: false,
    });
  },

  /** Softer stall: 30 bars, lower progress bar. */
  softer_stall(ctx) {
    return walk(ctx, {
      useEarly: true,
      invalidateBars: 5,
      eaBars: 30,
      minProg: 0.15,
      maxAdv: 2.5,
      stall: true,
      adverse: true,
      invalidation: true,
    });
  },

  /** After +0.5% favor, move SL to entry (breakeven). */
  breakeven_05(ctx) {
    return walk(ctx, {
      useEarly: true,
      invalidateBars: 5,
      eaBars: 15,
      minProg: 0.25,
      maxAdv: 2.0,
      stall: true,
      adverse: true,
      invalidation: true,
      breakevenAtFavorPct: 0.5,
    });
  },

  /** Trail: after +1.5% favor, exit on 0.6% giveback from peak. */
  runner_15_06(ctx) {
    return walk(ctx, {
      useEarly: false,
      runnerActivatePct: 1.5,
      runnerGivebackPct: 0.6,
    });
  },

  /** Force flatten at 120 bars (~2h on 1m). */
  max_hold_120(ctx) {
    return walk(ctx, {
      useEarly: true,
      invalidateBars: 5,
      eaBars: 15,
      minProg: 0.25,
      maxAdv: 2.0,
      stall: true,
      adverse: true,
      invalidation: true,
      maxHoldBars: 120,
    });
  },

  /** Instead of early exit: hedge then time-flatten (lock path). */
  hedge_instead_of_early(ctx) {
    return walkHedge(ctx, {
      triggerAdversePct: 2.0,
      triggerWithinBars: 15,
      mode: "return_to_entry",
      maxBarsAfterHedge: 45,
      alsoTriggerOnStall: true,
      stallBars: 15,
      stallMinProg: 0.25,
    });
  },
};

function checkInvalidation(ctx, bar, bars) {
  const { side, snap } = ctx;
  const close = bar.close;
  if (side === "SHORT") {
    if (Number.isFinite(snap.corridorHigh) && close > snap.corridorHigh) {
      return { reason: "early_invalidation", exitPrice: close };
    }
  } else if (Number.isFinite(snap.corridorLow) && close < snap.corridorLow) {
    return { reason: "early_invalidation", exitPrice: close };
  }
  return null;
}

function walk(ctx, opt) {
  const { side, entry, sl0, tp, bars, dpp, snap } = ctx;
  let sl = sl0;
  let peakFavor = 0;
  let troughAdv = 0;
  let runnerOn = false;
  let runnerPeak = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const high = bar.high ?? bar.close;
    const low = bar.low ?? bar.close;
    const close = bar.close;
    const barsIn = i + 1;

    const fav = favorPct(side, entry, high, low) ?? 0;
    const adv = adversePct(side, entry, high, low) ?? 0;
    peakFavor = Math.max(peakFavor, fav);
    troughAdv = Math.max(troughAdv, adv);

    if (opt.breakevenAtFavorPct != null && peakFavor >= opt.breakevenAtFavorPct) {
      // move SL to entry (breakeven)
      if (side === "SHORT") sl = Math.min(sl, entry);
      else sl = Math.max(sl, entry);
    }

    if (opt.runnerActivatePct != null) {
      if (!runnerOn && peakFavor >= opt.runnerActivatePct) {
        runnerOn = true;
        runnerPeak = peakFavor;
      }
      if (runnerOn) {
        runnerPeak = Math.max(runnerPeak, fav);
        const giveback = runnerPeak - (movePct(side, entry, close) ?? 0);
        // use close-based favor for giveback
        const closeFavor = movePct(side, entry, close) ?? 0;
        const gb = runnerPeak - closeFavor;
        if (gb >= (opt.runnerGivebackPct ?? 0.5)) {
          return finish(ctx, dpp, close, "runner_giveback", barsIn);
        }
      }
    }

    // SL / TP on bar extremes (SL first if both — conservative)
    if (hitSl(side, sl, high, low)) {
      return finish(ctx, dpp, exitPxOnSl(side, sl), "stop_loss", barsIn);
    }
    if (hitTp(side, tp, high, low)) {
      return finish(ctx, dpp, exitPxOnTp(side, tp), "take_profit", barsIn);
    }

    if (opt.maxHoldBars != null && barsIn >= opt.maxHoldBars) {
      return finish(ctx, dpp, close, "max_hold", barsIn);
    }

    if (opt.useEarly) {
      if (opt.invalidation && barsIn <= (opt.invalidateBars ?? 5)) {
        const inv = checkInvalidation(ctx, bar, barsIn);
        if (inv) return finish(ctx, dpp, inv.exitPrice, inv.reason, barsIn);
      }
      if (
        opt.adverse &&
        barsIn <= (opt.eaBars ?? 15) &&
        troughAdv >= (opt.maxAdv ?? 2) &&
        peakFavor < (opt.minProg ?? 0.25)
      ) {
        return finish(ctx, dpp, close, "early_adverse", barsIn);
      }
      if (
        opt.stall &&
        barsIn >= (opt.eaBars ?? 15) &&
        peakFavor < (opt.minProg ?? 0.25)
      ) {
        return finish(ctx, dpp, close, "early_stall", barsIn);
      }
    }
  }

  const last = bars[bars.length - 1];
  return finish(ctx, dpp, last?.close ?? entry, "backtest_end", bars.length);
}

/**
 * Bidirectional lock: keep original + open opposite at trigger.
 * Net PnL while hedged ≈ locked move to hedge price (fixed) + residual if asymmetric close.
 * Model: both legs same notional; when hedged, further price moves cancel;
 * unlock by closing both at same price → net = move from entry→hedge on original only.
 */
function walkHedge(ctx, opt) {
  const { side, entry, sl0, tp, bars, dpp } = ctx;
  let hedged = false;
  let hedgePx = null;
  let hedgeBar = null;
  let peakFavor = 0;
  let troughAdv = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const high = bar.high ?? bar.close;
    const low = bar.low ?? bar.close;
    const close = bar.close;
    const barsIn = i + 1;

    const fav = favorPct(side, entry, high, low) ?? 0;
    const adv = adversePct(side, entry, high, low) ?? 0;
    peakFavor = Math.max(peakFavor, fav);
    troughAdv = Math.max(troughAdv, adv);

    if (!hedged) {
      // Normal SL/TP before hedge
      if (hitSl(side, sl0, high, low)) {
        return finish(ctx, dpp, exitPxOnSl(side, sl0), "stop_loss", barsIn, false);
      }
      if (hitTp(side, tp, high, low)) {
        return finish(ctx, dpp, exitPxOnTp(side, tp), "take_profit", barsIn, false);
      }

      let trigger = false;
      let tPx = close;
      if (barsIn <= opt.triggerWithinBars && troughAdv >= opt.triggerAdversePct) {
        // hedge at adverse extreme of bar (worse fill)
        tPx = side === "SHORT" ? high : low;
        trigger = true;
      }
      if (
        opt.alsoTriggerOnStall &&
        barsIn >= (opt.stallBars ?? 15) &&
        peakFavor < (opt.stallMinProg ?? 0.25)
      ) {
        tPx = close;
        trigger = true;
      }
      if (trigger) {
        hedged = true;
        hedgePx = tPx;
        hedgeBar = barsIn;
        // locked unrealized on original = move entry→hedgePx
        continue;
      }
    } else {
      const after = barsIn - hedgeBar;
      // While hedged, SL/TP on original are notionally locked by opposite —
      // we only exit both together.
      if (opt.mode === "return_to_entry") {
        // short: price back down to entry; long: price back up to entry
        const back =
          side === "SHORT"
            ? low <= entry || close <= entry
            : high >= entry || close >= entry;
        if (back) {
          // close both near entry → net ≈ locked loss at hedge (entry→hedge on original)
          const lockedMove = movePct(side, entry, hedgePx);
          const pnl = (lockedMove ?? 0) * dpp;
          return {
            pnl: +pnl.toFixed(4),
            exitReason: "hedge_unlock_entry",
            exitPrice: entry,
            holdBars: barsIn,
            hedgeUsed: true,
            hedgePx,
            lockedPct: lockedMove,
          };
        }
      }
      if (after >= (opt.maxBarsAfterHedge ?? 30)) {
        // flatten both at close: net = original(entry→close) + hedge(hedgePx→close)
        // hedge is opposite side → hedge move = -original move from hedgePx
        const orig = movePct(side, entry, close) ?? 0;
        const hedgeSide = side === "SHORT" ? "LONG" : "SHORT";
        const hedgeM = movePct(hedgeSide, hedgePx, close) ?? 0;
        const pnl = (orig + hedgeM) * dpp;
        // orig + hedgeM = move(entry,close) + (-move(hedgePx,close)) = move(entry,hedgePx)
        return {
          pnl: +pnl.toFixed(4),
          exitReason: "hedge_time_flat",
          exitPrice: close,
          holdBars: barsIn,
          hedgeUsed: true,
          hedgePx,
          lockedPct: movePct(side, entry, hedgePx),
        };
      }
    }
  }

  const last = bars[bars.length - 1];
  const close = last?.close ?? entry;
  if (hedged) {
    const orig = movePct(side, entry, close) ?? 0;
    const hedgeSide = side === "SHORT" ? "LONG" : "SHORT";
    const hedgeM = movePct(hedgeSide, hedgePx, close) ?? 0;
    return {
      pnl: +((orig + hedgeM) * dpp).toFixed(4),
      exitReason: "hedge_end_flat",
      exitPrice: close,
      holdBars: bars.length,
      hedgeUsed: true,
      hedgePx,
    };
  }
  return finish(ctx, dpp, close, "backtest_end", bars.length, false);
}

function finish(ctx, dpp, exitPrice, reason, holdBars, hedgeUsed = false) {
  const m = movePct(ctx.side, ctx.entry, exitPrice) ?? 0;
  return {
    pnl: +(m * dpp).toFixed(4),
    exitReason: reason,
    exitPrice,
    holdBars,
    hedgeUsed,
  };
}

function summarize(rows) {
  const pnl = +rows.reduce((s, r) => s + r.pnl, 0).toFixed(2);
  const wins = rows.filter((r) => r.pnl > 0);
  const losses = rows.filter((r) => r.pnl <= 0);
  const byExit = {};
  for (const r of rows) byExit[r.exitReason] = (byExit[r.exitReason] || 0) + 1;
  const hedged = rows.filter((r) => r.hedgeUsed);
  return {
    trades: rows.length,
    pnl,
    winRate: rows.length ? +((100 * wins.length) / rows.length).toFixed(1) : 0,
    wins: wins.length,
    losses: losses.length,
    winPnl: +wins.reduce((s, r) => s + r.pnl, 0).toFixed(2),
    lossPnl: +losses.reduce((s, r) => s + r.pnl, 0).toFixed(2),
    byExit,
    hedgeTrades: hedged.length,
    hedgePnl: +hedged.reduce((s, r) => s + r.pnl, 0).toFixed(2),
  };
}

function main() {
  const bpTrades =
    readJsonFile(path.join(BP(), "foi-1m-loss-reduce-10d-trades.json"), null)?.trades ??
    readJsonFile(dataPath("foi-1m-loss-reduce-10d-trades.json"), null)?.trades;
  if (!bpTrades?.length) {
    console.error("No breakpoint 1.0 trades found");
    process.exit(1);
  }

  const recorded = {
    trades: bpTrades.length,
    pnl: +bpTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    winRate: +((100 * bpTrades.filter((t) => t.pnl > 0).length) / bpTrades.length).toFixed(1),
    lossPnl: +bpTrades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0).toFixed(2),
    winPnl: +bpTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0).toFixed(2),
  };

  log(`BP 1.0 trades ${recorded.trades} · recorded PnL $${recorded.pnl}`);
  log(`Policies: ${Object.keys(POLICIES).join(", ")}`);

  const barCache = new Map();
  function getBars(sym, openedAt) {
    const key = `${sym}:${openedAt}`;
    if (barCache.has(key)) return barCache.get(key);
    const b = barsFromEntry(sym, openedAt);
    barCache.set(key, b);
    return b;
  }

  const contexts = [];
  for (const t of bpTrades) {
    const bars = getBars(t.symbol, t.openedAt);
    if (bars.length < 2) continue;
    contexts.push({
      trade: t,
      side: t.side,
      entry: t.entryPrice,
      sl0: t.stopLoss,
      tp: t.takeProfit,
      bars,
      dpp: dollarPerPct(t),
      snap: t.signalSnapshot ?? {},
    });
  }
  log(`Replayable contexts: ${contexts.length}`);

  const results = {};
  const perTrade = {};

  for (const [name, fn] of Object.entries(POLICIES)) {
    const rows = [];
    for (const ctx of contexts) {
      const r = fn(ctx);
      rows.push({
        symbol: ctx.trade.symbol,
        signalKind: ctx.trade.signalKind,
        recordedPnl: ctx.trade.pnl,
        recordedExit: ctx.trade.exitReason,
        ...r,
      });
    }
    const summary = summarize(rows);
    summary.deltaVsRecorded = +(summary.pnl - recorded.pnl).toFixed(2);
    summary.deltaVsBaselineEa = null; // fill after
    results[name] = summary;
    perTrade[name] = rows;
    log(
      `  ${name}: $${summary.pnl} · ${summary.trades} tr · WR ${summary.winRate}% · Δrec ${summary.deltaVsRecorded >= 0 ? "+" : ""}${summary.deltaVsRecorded}${summary.hedgeTrades ? ` · hedge ${summary.hedgeTrades}` : ""}`
    );
  }

  const baseEaPnl = results.baseline_ea?.pnl ?? recorded.pnl;
  for (const s of Object.values(results)) {
    s.deltaVsBaselineEa = +(s.pnl - baseEaPnl).toFixed(2);
  }

  const ranked = Object.entries(results)
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.pnl - a.pnl);

  const proposals = [
    {
      id: "hedge_lock_to_entry",
      title: "Bidirectional lock → unlock at entry",
      idea: "On fast adverse (≥1% within 15 bars), open opposite size to lock loss; close both when price returns to entry (or 90 bars).",
    },
    {
      id: "hedge_lock_time30",
      title: "Bidirectional lock → time flatten 30m",
      idea: "Same hedge trigger; flatten both after 30 bars regardless of recovery.",
    },
    {
      id: "hedge_lock_15_60",
      title: "Hedge at 1.5%/20 bars → entry or 60m",
      idea: "Stricter hedge trigger, shorter unlock window.",
    },
    {
      id: "hedge_instead_of_early",
      title: "Hedge instead of early abort",
      idea: "At early-adverse/stall conditions, hedge+lock rather than realizing early exit.",
    },
    {
      id: "no_early_stall",
      title: "Drop early_stall only",
      idea: "Keep invalidation + early_adverse; let stalled trades reach SL/TP.",
    },
    {
      id: "adverse_only",
      title: "Early adverse only",
      idea: "Remove stall + invalidation; only hard adverse early exit.",
    },
    {
      id: "softer_stall",
      title: "Softer early-abort",
      idea: "30 bars / 0.15% min progress / 2.5% adverse.",
    },
    {
      id: "breakeven_05",
      title: "Breakeven stop after +0.5%",
      idea: "Once trade is +0.5% favor, move SL to entry.",
    },
    {
      id: "runner_15_06",
      title: "Runner trail",
      idea: "After +1.5% favor, exit on 0.6% giveback from peak (no EA).",
    },
    {
      id: "max_hold_120",
      title: "Max hold 120m",
      idea: "Force flatten after 120 bars on top of baseline EA.",
    },
    {
      id: "sl_tp_only",
      title: "SL/TP only (no EA)",
      idea: "Disable all early exits — upper bound if EA was hurting.",
    },
  ];

  const report = {
    ranAt: new Date().toISOString(),
    method:
      "1m bar-replay from breakpoint 1.0 entries; same SL/TP geometry; dollar/pct calibrated per trade from recorded fill.",
    breakpoint: "1.0",
    recorded,
    baselineReplay: results.baseline_ea,
    proposals,
    results,
    ranked,
  };

  writeJsonFile(OUT(), report);
  writeJsonFile(DETAIL(), {
    ranAt: report.ranAt,
    // keep only top/bottom policy trade lists to limit size
    policies: Object.fromEntries(
      ranked.slice(0, 4).map((r) => [
        r.name,
        perTrade[r.name].slice(0, 30).concat(
          [...perTrade[r.name]].sort((a, b) => a.pnl - b.pnl).slice(0, 10)
        ),
      ])
    ),
  });

  log("\n=== RANKED ===");
  for (const r of ranked) {
    log(
      `${r.pnl >= 0 ? "+" : ""}${r.pnl}  ${r.name}  (Δea ${r.deltaVsBaselineEa >= 0 ? "+" : ""}${r.deltaVsBaselineEa})`
    );
  }
  log(`Saved ${OUT()}`);
  console.log(
    JSON.stringify(
      {
        recorded,
        ranked: ranked.map((r) => ({
          name: r.name,
          pnl: r.pnl,
          deltaEa: r.deltaVsBaselineEa,
          wr: r.winRate,
          lossPnl: r.lossPnl,
          hedgeTrades: r.hedgeTrades,
        })),
      },
      null,
      2
    )
  );
}

main();
