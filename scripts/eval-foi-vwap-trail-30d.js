#!/usr/bin/env node
/**
 * Full 30d FOI VWAP trail report (arm +0.3%, VWAP120).
 *
 * Counterfactual on champion FOI trades using lib/foi-vwap-trail.js.
 *
 *   node scripts/eval-foi-vwap-trail-30d.js
 */
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const {
  readBest1mBars,
  clearBarsMemoryCache,
} = require("../lib/backtest-kline-cache");
const {
  FOI_VWAP_TRAIL_DEFAULTS,
  simulateFoiVwapTrailOnPath,
  normalizeFoiVwapTrailConfig,
} = require("../lib/foi-vwap-trail");

const OUT = () => dataPath("foi-vwap-trail-30d-report.json");

function log(m) {
  process.stderr.write(String(m) + "\n");
}

function summarize(pnls) {
  const xs = pnls.map((x) => Number(x) || 0);
  if (!xs.length) return { n: 0, mean: null, hitRate: null, sum: 0, maxDd: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  const hits = xs.filter((x) => x > 0).length;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of xs) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return {
    n: xs.length,
    mean: +(sum / xs.length).toFixed(4),
    hitRate: +((100 * hits) / xs.length).toFixed(1),
    sum: +sum.toFixed(4),
    maxDd: +maxDd.toFixed(4),
  };
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function endIdx(bars, ms) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeTime <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function typical(bar) {
  const h = +bar.high;
  const l = +bar.low;
  const c = +bar.close;
  if (h > 0 && l > 0 && c > 0) return (h + l + c) / 3;
  return c > 0 ? c : null;
}

function makeRing(w) {
  const ring = [];
  let sumPv = 0;
  let sumV = 0;
  return {
    push(bar) {
      const tp = typical(bar);
      const v = +bar.volume || 0;
      if (!(tp > 0)) return null;
      ring.push({ pv: tp * v, v });
      sumPv += tp * v;
      sumV += v;
      while (ring.length > w) {
        const o = ring.shift();
        sumPv -= o.pv;
        sumV -= o.v;
      }
      if (ring.length < Math.min(20, w) || !(sumV > 0)) return null;
      return sumPv / sumV;
    },
  };
}

function main() {
  const cfg = normalizeFoiVwapTrailConfig(FOI_VWAP_TRAIL_DEFAULTS);
  const raw = readJsonFile(
    dataPath("railway-live-30d-ab-pathcosine-trades.json"),
    null
  );
  const trades = (raw?.trades ?? []).filter(
    (t) =>
      t.openedAt != null &&
      t.closedAt != null &&
      t.pnl != null &&
      String(t.signalKind || "").startsWith("foi")
  );

  log(
    `FOI VWAP trail 30d · ${trades.length} trades · arm=${cfg.foiVwapTrailArmPct}% · VWAP${cfg.foiVwapTrailBars}`
  );

  const bySym = new Map();
  for (const t of trades) {
    const s = String(t.symbol).toUpperCase();
    if (!bySym.has(s)) bySym.set(s, []);
    bySym.get(s).push(t);
  }

  const rows = [];
  let si = 0;
  for (const [sym, list] of bySym) {
    si++;
    const bars = readBest1mBars(sym);
    clearBarsMemoryCache();
    if (!bars?.length) continue;

    for (const t of list) {
      const side =
        t.side === "SHORT" || t.signalKind === "foi_bear" ? "SHORT" : "LONG";
      const openedAt = +t.openedAt;
      const closedAt = +t.closedAt;
      const i0 = endIdx(bars, openedAt);
      const i1 = endIdx(bars, closedAt);
      if (i0 < cfg.foiVwapTrailBars || i1 <= i0) continue;
      const entry = +t.entryPrice || +bars[i0].close;
      if (!(entry > 0)) continue;

      const ring = makeRing(cfg.foiVwapTrailBars);
      const warm = Math.max(0, i0 - cfg.foiVwapTrailBars);
      const path = [];
      for (let i = warm; i <= i1; i++) {
        const vwap = ring.push(bars[i]);
        if (i < i0) continue;
        path.push({
          high: +bars[i].high,
          low: +bars[i].low,
          close: +bars[i].close,
          vwap,
        });
      }

      const initialSl =
        +t.stopLoss ||
        +t.initialStopLoss ||
        (side === "SHORT" ? entry * 1.02 : entry * 0.98);

      const sim = simulateFoiVwapTrailOnPath(
        {
          side,
          entry,
          exit: +t.exitPrice || null,
          pnl: +t.pnl,
          initialSl,
          path,
          exitReason: t.exitReason,
        },
        { armPct: cfg.foiVwapTrailArmPct }
      );

      rows.push({
        symbol: sym,
        side,
        signalKind: t.signalKind,
        openedAt,
        closedAt,
        baselinePnl: +Number(t.pnl).toFixed(4),
        trailPnl: sim.pnl,
        delta: +(sim.pnl - Number(t.pnl)).toFixed(4),
        exitReasonBaseline: t.exitReason || null,
        exitReasonTrail: sim.exitReason,
        armed: sim.armed,
        trailedExit: sim.exitReason === "foi_vwap_trail",
      });
    }
    if (si % 20 === 0 || si === bySym.size) {
      log(`  symbols ${si}/${bySym.size} · rows ${rows.length}`);
    }
  }

  rows.sort((a, b) => a.openedAt - b.openedAt);
  const baseline = summarize(rows.map((r) => r.baselinePnl));
  const trailed = summarize(rows.map((r) => r.trailPnl));

  // OOS 3×10d
  const tMin = rows[0]?.openedAt;
  const tMax = rows[rows.length - 1]?.openedAt;
  const span = tMax - tMin || 1;
  const oos = [0, 1, 2].map((i) => {
    const lo = tMin + (span * i) / 3;
    const hi = tMin + (span * (i + 1)) / 3;
    const slice = rows.filter(
      (r) => r.openedAt >= lo && (i === 2 ? r.openedAt <= hi : r.openedAt < hi)
    );
    const b = summarize(slice.map((r) => r.baselinePnl));
    const t = summarize(slice.map((r) => r.trailPnl));
    return {
      window: i + 1,
      from: new Date(lo).toISOString().slice(0, 10),
      to: new Date(hi).toISOString().slice(0, 10),
      n: slice.length,
      baseline: b,
      trail: t,
      deltaSum: +(t.sum - b.sum).toFixed(4),
    };
  });

  // Daily
  const byDay = new Map();
  for (const r of rows) {
    const d = dayKey(r.openedAt);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  const daily = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, xs]) => {
      const b = summarize(xs.map((x) => x.baselinePnl));
      const t = summarize(xs.map((x) => x.trailPnl));
      return {
        day,
        n: xs.length,
        baselineSum: b.sum,
        trailSum: t.sum,
        delta: +(t.sum - b.sum).toFixed(4),
        trailWr: t.hitRate,
        baselineWr: b.hitRate,
      };
    });

  const trailedExits = rows.filter((r) => r.trailedExit);
  const armedOnly = rows.filter((r) => r.armed && !r.trailedExit);
  const neverArmed = rows.filter((r) => !r.armed);

  const byExit = {};
  for (const r of rows) {
    const k = r.exitReasonTrail || "unknown";
    if (!byExit[k]) byExit[k] = { n: 0, pnl: 0 };
    byExit[k].n++;
    byExit[k].pnl += r.trailPnl;
  }
  for (const k of Object.keys(byExit)) {
    byExit[k].pnl = +byExit[k].pnl.toFixed(4);
  }

  // Arm sensitivity
  const armSweep = [0.2, 0.3, 0.5, 0.8].map((arm) => {
    // Re-sim would need paths again — approximate from stored using re-run only for arm on same paths is heavy.
    // Skip full re-path; report only default arm in body, note research arms from nine-ideas.
    return { arm, note: "see nine-ideas for full arm sweep" };
  });

  const report = {
    ranAt: new Date().toISOString(),
    method:
      "Counterfactual FOI VWAP120 trail (lib/foi-vwap-trail) on railway-live-30d-ab-pathcosine trades",
    cfg,
    n: rows.length,
    baseline,
    trail: trailed,
    deltaSum: +(trailed.sum - baseline.sum).toFixed(4),
    deltaMean: +(trailed.mean - baseline.mean).toFixed(4),
    deltaMaxDd: +(trailed.maxDd - baseline.maxDd).toFixed(4),
    oos,
    oosPositiveWindows: oos.filter((w) => w.deltaSum > 0).length,
    daily,
    cohorts: {
      trailedExit: {
        n: trailedExits.length,
        ...summarize(trailedExits.map((r) => r.trailPnl)),
        baselineSum: summarize(trailedExits.map((r) => r.baselinePnl)).sum,
      },
      armedKeptOriginalExit: {
        n: armedOnly.length,
        ...summarize(armedOnly.map((r) => r.trailPnl)),
      },
      neverArmed: {
        n: neverArmed.length,
        ...summarize(neverArmed.map((r) => r.trailPnl)),
      },
    },
    byExitReasonTrail: byExit,
    armSweepNote:
      "Primary preset arm=0.3 / VWAP120. Arm 0.5 also + in nine-ideas; 0.8 flat.",
    sample: rows
      .filter((r) => r.trailedExit)
      .slice(0, 15)
      .map((r) => ({
        symbol: r.symbol,
        side: r.side,
        baselinePnl: r.baselinePnl,
        trailPnl: r.trailPnl,
        delta: r.delta,
      })),
    verdict: {
      works: trailed.sum > baseline.sum && oos.filter((w) => w.deltaSum > 0).length >= 2,
      why: `Trail Δ$${+(trailed.sum - baseline.sum).toFixed(2)} · $${baseline.sum}→$${trailed.sum} · WR ${baseline.hitRate}%→${trailed.hitRate}% · OOS+ ${oos.filter((w) => w.deltaSum > 0).length}/3 · trail exits ${trailedExits.length}/${rows.length}`,
    },
  };

  writeJsonFile(OUT(), report);
  log("\n=== FOI VWAP TRAIL 30d ===");
  log(report.verdict.why);
  for (const w of oos) {
    log(
      `  OOS${w.window} ${w.from}..${w.to}: Δ$${w.deltaSum} (n=${w.n})`
    );
  }
  log(`wrote ${OUT()}`);
}

main();
