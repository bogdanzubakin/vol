#!/usr/bin/env node
/**
 * Design + causal OOS backtest of FOI follow-through regime gate on BP1.2
 * trade streams (3×10d windows).
 *
 * Metric (from autopsy): rolling win-rate of recently closed FOI trades.
 * Objective: maximize profit across OOS1/2/3; prefer all-positive.
 *
 *   node scripts/optimize-foi-followthrough-regime-oos-10d.js
 */
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const {
  FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
  applyFoiFollowthroughGateToTrades,
} = require("../lib/foi-followthrough-regime");

const WINDOW_IDS = ["oos1", "oos2", "oos3"];
const OUT = () => dataPath("foi-1m-bp12-followthrough-regime-oos-10d.json");

function log(m) {
  console.error(String(m));
}

function loadTrades(id) {
  const file = dataPath(`foi-1m-bp1.2-${id}-10d-trades.json`);
  const raw = readJsonFile(file, null);
  if (!raw?.trades?.length) throw new Error(`missing trades ${file}`);
  return raw.trades;
}

function baseline(trades) {
  const pnl = +trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2);
  const wins = trades.filter((t) => (t.pnl || 0) > 0).length;
  return {
    trades: trades.length,
    pnl,
    winRate: trades.length ? +((100 * wins) / trades.length).toFixed(1) : 0,
  };
}

function scoreWindows(per) {
  const vals = WINDOW_IDS.map((id) => per[id].summary.pnl);
  const sum = +vals.reduce((a, b) => a + b, 0).toFixed(2);
  const mean = +(sum / vals.length).toFixed(2);
  const positive = vals.filter((v) => v > 0).length;
  const min = Math.min(...vals);
  return { sum, mean, positive, min: +min.toFixed(2), pnls: vals };
}

function evaluateCfg(windows, cfg) {
  const per = {};
  for (const id of WINDOW_IDS) {
    per[id] = applyFoiFollowthroughGateToTrades(windows[id], cfg);
  }
  return { cfg, per, ...scoreWindows(per) };
}

function main() {
  const windows = Object.fromEntries(WINDOW_IDS.map((id) => [id, loadTrades(id)]));
  const basePer = Object.fromEntries(
    WINDOW_IDS.map((id) => [id, { summary: baseline(windows[id]) }])
  );
  const baseScore = scoreWindows(basePer);

  log("FOI follow-through regime · BP1.2 · 3×10d OOS");
  log(
    `baseline sum $${baseScore.sum} · mean $${baseScore.mean} · positive ${baseScore.positive}/3`
  );

  const candidates = [];
  for (const lookback of [30, 35, 40, 45, 50, 60, 80]) {
    for (const minWinRate of [0.28, 0.3, 0.32, 0.33, 0.34, 0.35, 0.36, 0.38]) {
      for (const warmup of ["block", "allow", "half"]) {
        const minSamples = Math.max(12, Math.floor(lookback * 0.4));
        candidates.push(
          evaluateCfg(windows, {
            foiFollowthroughLookback: lookback,
            foiFollowthroughMinWinRate: minWinRate,
            foiFollowthroughMinSamples: minSamples,
            foiFollowthroughWarmupPolicy: warmup,
          })
        );
      }
    }
  }

  const bySum = [...candidates].sort(
    (a, b) => b.sum - a.sum || b.positive - a.positive || b.min - a.min
  );
  const allPos = candidates
    .filter((c) => c.positive === 3)
    .sort((a, b) => b.sum - a.sum || b.min - a.min);

  // Primary: all 3 OOS positive with best sum (robust regime gate).
  // Alternate: max sum (may leave a window red).
  const recommended = allPos[0] || bySum[0];
  const maxSum = bySum[0];

  const patch = {
    ...FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
    foiFollowthroughRegimeEnabled: true,
    foiFollowthroughLookback: recommended.cfg.foiFollowthroughLookback,
    foiFollowthroughMinWinRate: recommended.cfg.foiFollowthroughMinWinRate,
    foiFollowthroughMinSamples: recommended.cfg.foiFollowthroughMinSamples,
    foiFollowthroughWarmupPolicy: recommended.cfg.foiFollowthroughWarmupPolicy,
  };

  const report = {
    ranAt: new Date().toISOString(),
    bp: "1.2",
    method:
      "causal rolling FOI win-rate gate on saved BP1.2 OOS trade streams (no look-ahead)",
    baseline: {
      ...baseScore,
      windows: Object.fromEntries(
        WINDOW_IDS.map((id) => [id, basePer[id].summary])
      ),
    },
    recommended: {
      objective: "all_three_oos_positive_max_sum",
      patch,
      sum: recommended.sum,
      mean: recommended.mean,
      positive: recommended.positive,
      min: recommended.min,
      windows: Object.fromEntries(
        WINDOW_IDS.map((id) => [
          id,
          {
            pnl: recommended.per[id].summary.pnl,
            trades: recommended.per[id].summary.trades,
            blocked: recommended.per[id].summary.blocked,
            winRate: recommended.per[id].summary.winRate,
            deltaVsBase: +(
              recommended.per[id].summary.pnl - basePer[id].summary.pnl
            ).toFixed(2),
          },
        ])
      ),
    },
    maxSumAlternate: {
      objective: "max_sum_pnl",
      patch: {
        ...FOI_FOLLOWTHROUGH_REGIME_DEFAULTS,
        foiFollowthroughRegimeEnabled: true,
        ...maxSum.cfg,
      },
      sum: maxSum.sum,
      mean: maxSum.mean,
      positive: maxSum.positive,
      min: maxSum.min,
      windows: Object.fromEntries(
        WINDOW_IDS.map((id) => [
          id,
          {
            pnl: maxSum.per[id].summary.pnl,
            trades: maxSum.per[id].summary.trades,
            blocked: maxSum.per[id].summary.blocked,
            winRate: maxSum.per[id].summary.winRate,
          },
        ])
      ),
    },
    topAllPositive: allPos.slice(0, 8).map((c) => ({
      sum: c.sum,
      mean: c.mean,
      min: c.min,
      cfg: c.cfg,
      pnls: Object.fromEntries(
        WINDOW_IDS.map((id) => [id, c.per[id].summary.pnl])
      ),
    })),
    topBySum: bySum.slice(0, 8).map((c) => ({
      sum: c.sum,
      positive: c.positive,
      min: c.min,
      cfg: c.cfg,
      pnls: Object.fromEntries(
        WINDOW_IDS.map((id) => [id, c.per[id].summary.pnl])
      ),
    })),
    verdict: {
      status:
        recommended.positive === 3 && recommended.mean > 0
          ? "pass"
          : recommended.mean > 0
            ? "mixed"
            : "fail",
      note:
        recommended.positive === 3
          ? `All 3 OOS positive under follow-through gate (mean $${recommended.mean}, sum $${recommended.sum})`
          : `Best gate still not all-positive (positive ${recommended.positive}/3, mean $${recommended.mean})`,
      vsBaseline: {
        sumDelta: +(recommended.sum - baseScore.sum).toFixed(2),
        meanDelta: +(recommended.mean - baseScore.mean).toFixed(2),
        positiveDelta: recommended.positive - baseScore.positive,
      },
    },
  };

  writeJsonFile(OUT(), report);

  log("\n=== RECOMMENDED (all-positive) ===");
  log(
    `wr≥${patch.foiFollowthroughMinWinRate} lb=${patch.foiFollowthroughLookback} warm=${patch.foiFollowthroughWarmupPolicy} minN=${patch.foiFollowthroughMinSamples}`
  );
  log(
    `sum $${recommended.sum} · mean $${recommended.mean} · positive ${recommended.positive}/3 · min $${recommended.min}`
  );
  for (const id of WINDOW_IDS) {
    const w = report.recommended.windows[id];
    const b = basePer[id].summary;
    log(
      `  ${id}: $${w.pnl} (${w.trades} tr, blocked ${w.blocked}) · base $${b.pnl} · Δ $${w.deltaVsBase}`
    );
  }
  log("\n=== MAX-SUM ALTERNATE ===");
  log(
    `sum $${maxSum.sum} · positive ${maxSum.positive}/3 · min $${maxSum.min} · wr≥${maxSum.cfg.foiFollowthroughMinWinRate} lb=${maxSum.cfg.foiFollowthroughLookback} warm=${maxSum.cfg.foiFollowthroughWarmupPolicy}`
  );
  log(`\nVerdict: ${report.verdict.status} — ${report.verdict.note}`);
  log(`Saved ${OUT()}`);
  console.log(
    JSON.stringify(
      {
        verdict: report.verdict,
        recommended: report.recommended,
        maxSumAlternate: {
          sum: report.maxSumAlternate.sum,
          positive: report.maxSumAlternate.positive,
          patch: report.maxSumAlternate.patch,
          windows: report.maxSumAlternate.windows,
        },
      },
      null,
      2
    )
  );
}

main();
