#!/usr/bin/env node
/**
 * Deep diagnosis of FOI short-only winner on last N days of cache.
 * Saves trade dump + pattern splits for early_adverse / stop_loss.
 *
 *   node scripts/analyze-foi-short-10d.js --days 10
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(12288);

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

const BATCH = 50;
const OUT = () => dataPath("foi-short-10d-diagnosis.json");
const TRADES_OUT = () => dataPath("foi-short-10d-trades.json");

function log(m) {
  console.error(String(m));
}

function parseArgs(argv) {
  let days = 10;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Math.max(1, Number(argv[++i]) || 10);
  }
  return { days };
}

function loadBot() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  const foiBest = readJsonFile(dataPath("foi-best-10d.json"), null)?.patch ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: false,
    tradeBearishFoiSignals: true,
    foiMinAbsFundingRate: 0.00008,
    foiRequireOiConfirm: false,
    foiConfirmSfp: false,
    foiConfirmPullback: true,
    ...foiBest,
    tradeFoiSignals: false,
    tradeBearishFoiSignals: true,
    armed: false,
    drawdownStopEnabled: false,
    aiRegimeBtcFastLookbackHours: local.aiRegimeBtcFastLookbackHours ?? 2,
    aiPullbackSignalBtcFastLookbackHours:
      local.aiPullbackSignalBtcFastLookbackHours ?? 2,
  });
}

function loadSignalConfig() {
  const scanner = readJsonFile(dataPath("scanner-config.json"), {}) ?? {};
  const detection = readJsonFile(dataPath("bear-detection-best-10d.json"), null);
  const cfg = {
    interval: "1m",
    sfpLookbackBars: 30,
    sfpRangeBars: 45,
    sfpReclaimBars: 5,
    sfpMinSweepPct: 0.08,
    pullbackMaBars: 7,
    pullbackTouchLookback: 12,
    pullbackMaxDistancePct: 0.35,
    pullbackMaxAboveMaPct: 1.5,
    pullbackMaxBelowMaPct: 1.5,
    fastMoveLookbackCandles: 15,
    minAvgMovePct: 0.4,
    minLinearChangePct: 0.5,
    fastMoveExcludeMult: 3,
    ...scanner,
    ...(detection?.patch ?? {}),
  };
  applyBarConfig(cfg);
  return cfg;
}

function symbols() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((s) => (readSymbolBars("signal", s)?.length ?? 0) >= 200)
    .sort();
}

function fetchers() {
  function read(sym, kind, n) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > n ? bars.slice(-n) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, n) {
      const c = read(sym, "signal", n);
      if (c?.length >= 200) return c;
      throw new Error(`no signal ${sym}`);
    },
    async fetchKlines1mForSymbol(sym, n) {
      const c = read(sym, "mover", n) ?? read(sym, "signal", n);
      if (c?.length >= 200) return c;
      throw new Error(`no 1m ${sym}`);
    },
  };
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcHour(ms) {
  return new Date(ms).getUTCHours();
}

function avg(xs) {
  if (!xs.length) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function median(xs) {
  if (!xs.length) return null;
  const h = [...xs].sort((a, b) => a - b);
  return h[Math.floor(h.length / 2)];
}

function pct(n, d) {
  return d ? +((100 * n) / d).toFixed(1) : 0;
}

function summarizeBucket(rows) {
  const pnls = rows.map((t) => Number(t.pnl) || 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const sum = pnls.reduce((s, p) => s + p, 0);
  const holds = rows.map((t) => t.holdMin || 0);
  const fund = rows.map((t) => t.fundingRate).filter((x) => x != null);
  const oi = rows.map((t) => t.oiDelta1h).filter((x) => x != null);
  const trend = rows.map((t) => t.fundingTrend).filter((x) => x != null);
  const corr = rows.map((t) => t.corridorWidthPct).filter((x) => x != null);
  const slDist = rows.map((t) => t.slDistancePct).filter((x) => x != null);
  const peak = rows.map((t) => t.peakMovePct).filter((x) => x != null);
  const trough = rows.map((t) => t.troughMovePct).filter((x) => x != null);
  return {
    trades: rows.length,
    pnl: +sum.toFixed(2),
    winRate: pct(wins.length, rows.length),
    avgWin: wins.length ? +avg(wins).toFixed(3) : 0,
    avgLoss: losses.length ? +avg(losses).toFixed(3) : 0,
    winPnl: +wins.reduce((s, p) => s + p, 0).toFixed(2),
    lossPnl: +losses.reduce((s, p) => s + p, 0).toFixed(2),
    avgHoldMin: holds.length ? +avg(holds).toFixed(1) : 0,
    medianHoldMin: holds.length ? +median(holds).toFixed(1) : 0,
    avgFunding: fund.length ? +avg(fund).toFixed(6) : null,
    medianFunding: fund.length ? +median(fund).toFixed(6) : null,
    avgOiDelta1h: oi.length ? +avg(oi).toFixed(3) : null,
    pctOiRising: oi.length ? pct(oi.filter((x) => x > 0).length, oi.length) : null,
    avgFundingTrend: trend.length ? +avg(trend).toFixed(6) : null,
    pctFundingTrendUp: trend.length
      ? pct(trend.filter((x) => x > 0).length, trend.length)
      : null,
    avgCorridorWidthPct: corr.length ? +avg(corr).toFixed(2) : null,
    avgSlDistancePct: slDist.length ? +avg(slDist).toFixed(2) : null,
    avgPeakMovePct: peak.length ? +avg(peak).toFixed(3) : null,
    avgTroughMovePct: trough.length ? +avg(trough).toFixed(3) : null,
  };
}

function bucketBy(rows, keyFn, labelFn = (k) => String(k)) {
  const map = new Map();
  for (const t of rows) {
    const k = keyFn(t);
    if (k == null) continue;
    const lab = labelFn(k);
    if (!map.has(lab)) map.set(lab, []);
    map.get(lab).push(t);
  }
  return [...map.entries()]
    .map(([label, rs]) => ({ label, ...summarizeBucket(rs) }))
    .sort((a, b) => a.pnl - b.pnl);
}

function compareGroups(groups) {
  // groups: { name, rows }[]
  return groups.map((g) => ({ name: g.name, ...summarizeBucket(g.rows) }));
}

function patternInsights(trades) {
  const ea = trades.filter((t) => t.exitReason === "early_adverse");
  const sl = trades.filter((t) => t.exitReason === "stop_loss");
  const tp = trades.filter((t) => t.exitReason === "take_profit");
  const stall = trades.filter((t) => t.exitReason === "early_stall");
  const bad = [...ea, ...sl];
  const good = tp;

  const byConfirm = bucketBy(trades, (t) => t.confirmKind || "unknown");
  const byConfirmEa = bucketBy(ea, (t) => t.confirmKind || "unknown");
  const byConfirmSl = bucketBy(sl, (t) => t.confirmKind || "unknown");
  const byConfirmTp = bucketBy(tp, (t) => t.confirmKind || "unknown");

  const fundingBuckets = [
    { label: "fr < 0.0001", test: (t) => t.fundingRate != null && t.fundingRate < 0.0001 },
    { label: "0.0001–0.0002", test: (t) => t.fundingRate >= 0.0001 && t.fundingRate < 0.0002 },
    { label: "0.0002–0.0004", test: (t) => t.fundingRate >= 0.0002 && t.fundingRate < 0.0004 },
    { label: "≥ 0.0004", test: (t) => t.fundingRate >= 0.0004 },
  ].map((b) => ({ label: b.label, ...summarizeBucket(trades.filter(b.test)) }));

  const oiBuckets = [
    { label: "OI falling (≤0)", test: (t) => t.oiDelta1h != null && t.oiDelta1h <= 0 },
    { label: "OI rising (>0)", test: (t) => t.oiDelta1h != null && t.oiDelta1h > 0 },
    { label: "OI strong (>2%)", test: (t) => t.oiDelta1h != null && t.oiDelta1h > 2 },
  ].map((b) => ({ label: b.label, ...summarizeBucket(trades.filter(b.test)) }));

  const trendBuckets = [
    { label: "fundingTrend ≤0", test: (t) => t.fundingTrend != null && t.fundingTrend <= 0 },
    { label: "fundingTrend >0", test: (t) => t.fundingTrend != null && t.fundingTrend > 0 },
  ].map((b) => ({ label: b.label, ...summarizeBucket(trades.filter(b.test)) }));

  const corrBuckets = [
    { label: "corr <4%", test: (t) => t.corridorWidthPct != null && t.corridorWidthPct < 4 },
    { label: "corr 4–8%", test: (t) => t.corridorWidthPct >= 4 && t.corridorWidthPct < 8 },
    { label: "corr 8–16%", test: (t) => t.corridorWidthPct >= 8 && t.corridorWidthPct < 16 },
    { label: "corr ≥16%", test: (t) => t.corridorWidthPct >= 16 },
  ].map((b) => ({ label: b.label, ...summarizeBucket(trades.filter(b.test)) }));

  const hourBuckets = bucketBy(trades, (t) => utcHour(t.openedAt), (h) => `UTC ${String(h).padStart(2, "0")}`);
  const hourEaRate = [];
  for (let h = 0; h < 24; h++) {
    const rows = trades.filter((t) => utcHour(t.openedAt) === h);
    if (rows.length < 8) continue;
    const eaN = rows.filter((t) => t.exitReason === "early_adverse").length;
    const slN = rows.filter((t) => t.exitReason === "stop_loss").length;
    hourEaRate.push({
      hourUtc: h,
      trades: rows.length,
      pnl: +rows.reduce((s, t) => s + (t.pnl || 0), 0).toFixed(2),
      earlyAdverseRate: pct(eaN, rows.length),
      stopLossRate: pct(slN, rows.length),
      tpRate: pct(rows.filter((t) => t.exitReason === "take_profit").length, rows.length),
      winRate: pct(rows.filter((t) => (t.pnl || 0) > 0).length, rows.length),
    });
  }
  hourEaRate.sort((a, b) => b.earlyAdverseRate + b.stopLossRate - (a.earlyAdverseRate + a.stopLossRate));

  const slDistBuckets = [
    { label: "SL dist <1.5%", test: (t) => t.slDistancePct != null && t.slDistancePct < 1.5 },
    { label: "SL dist 1.5–2.5%", test: (t) => t.slDistancePct >= 1.5 && t.slDistancePct < 2.5 },
    { label: "SL dist 2.5–4%", test: (t) => t.slDistancePct >= 2.5 && t.slDistancePct < 4 },
    { label: "SL dist ≥4%", test: (t) => t.slDistancePct >= 4 },
  ].map((b) => ({ label: b.label, ...summarizeBucket(trades.filter(b.test)) }));

  // Counterfactual filters: what if we skipped weak setups?
  const filters = [
    {
      id: "oi_confirm",
      label: "Require OI rising OR fundingTrend>0",
      keep: (t) => (t.oiDelta1h != null && t.oiDelta1h > 0) || (t.fundingTrend != null && t.fundingTrend > 0),
    },
    {
      id: "funding_ge_0.00015",
      label: "fundingRate ≥ 0.00015",
      keep: (t) => t.fundingRate != null && t.fundingRate >= 0.00015,
    },
    {
      id: "funding_ge_0.00025",
      label: "fundingRate ≥ 0.00025",
      keep: (t) => t.fundingRate != null && t.fundingRate >= 0.00025,
    },
    {
      id: "corr_lt_8",
      label: "corridorWidth < 8%",
      keep: (t) => t.corridorWidthPct != null && t.corridorWidthPct < 8,
    },
    {
      id: "corr_lt_12",
      label: "corridorWidth < 12%",
      keep: (t) => t.corridorWidthPct != null && t.corridorWidthPct < 12,
    },
    {
      id: "no_early_adverse_like",
      label: "Drop trades that exited early_adverse (upper bound if EA off & those continue)",
      keep: (t) => t.exitReason !== "early_adverse",
    },
    {
      id: "oi_and_funding_mid",
      label: "OI rising + funding ≥ 0.00015",
      keep: (t) =>
        t.oiDelta1h != null &&
        t.oiDelta1h > 0 &&
        t.fundingRate != null &&
        t.fundingRate >= 0.00015,
    },
    {
      id: "avoid_weak_hours",
      label: "Skip UTC 0–4 (if weak)",
      keep: (t) => utcHour(t.openedAt) >= 5,
    },
  ].map((f) => {
    const kept = trades.filter(f.keep);
    const dropped = trades.length - kept.length;
    const s = summarizeBucket(kept);
    const base = summarizeBucket(trades);
    return {
      id: f.id,
      label: f.label,
      kept: kept.length,
      dropped,
      ...s,
      deltaPnl: +(s.pnl - base.pnl).toFixed(2),
      eaRate: pct(kept.filter((t) => t.exitReason === "early_adverse").length, kept.length),
      slRate: pct(kept.filter((t) => t.exitReason === "stop_loss").length, kept.length),
      tpRate: pct(kept.filter((t) => t.exitReason === "take_profit").length, kept.length),
    };
  });

  const groupCompare = compareGroups([
    { name: "early_adverse", rows: ea },
    { name: "stop_loss", rows: sl },
    { name: "early_stall", rows: stall },
    { name: "take_profit", rows: tp },
    { name: "all_bad (EA+SL)", rows: bad },
    { name: "take_profit_only", rows: good },
  ]);

  // Pattern notes
  const notes = [];
  const eaSum = summarizeBucket(ea);
  const slSum = summarizeBucket(sl);
  const tpSum = summarizeBucket(tp);

  if (eaSum.medianHoldMin != null && eaSum.medianHoldMin <= 5) {
    notes.push(
      `early_adverse fires very fast (median ${eaSum.medianHoldMin}m) — maxAdverse 1.5% within first ~20 bars; most never reach minProgress 0.4%.`
    );
  }
  if (eaSum.avgFunding != null && tpSum.avgFunding != null) {
    const diff = tpSum.avgFunding - eaSum.avgFunding;
    if (Math.abs(diff) > 0.00002) {
      notes.push(
        `Funding at entry: EA avg ${eaSum.avgFunding} vs TP avg ${tpSum.avgFunding} (${diff > 0 ? "TP more crowded" : "EA more crowded"}).`
      );
    } else {
      notes.push(
        `Funding at entry similar for EA (${eaSum.avgFunding}) vs TP (${tpSum.avgFunding}) — funding level alone does not separate early_adverse.`
      );
    }
  }
  if (eaSum.pctOiRising != null && tpSum.pctOiRising != null) {
    notes.push(
      `OI rising share: EA ${eaSum.pctOiRising}% · SL ${slSum.pctOiRising}% · TP ${tpSum.pctOiRising}%.`
    );
  }
  if (slSum.avgCorridorWidthPct != null && tpSum.avgCorridorWidthPct != null) {
    notes.push(
      `Corridor width: SL avg ${slSum.avgCorridorWidthPct}% vs TP ${tpSum.avgCorridorWidthPct}%.`
    );
  }
  if (slSum.avgSlDistancePct != null && tpSum.avgSlDistancePct != null) {
    notes.push(
      `SL distance at entry: SL-exits avg ${slSum.avgSlDistancePct}% vs TP-exits ${tpSum.avgSlDistancePct}%.`
    );
  }
  const bestFilter = [...filters].filter((f) => f.id !== "no_early_adverse_like").sort((a, b) => b.pnl - a.pnl)[0];
  if (bestFilter) {
    notes.push(
      `Best entry filter on this dump: "${bestFilter.label}" → $${bestFilter.pnl} (${bestFilter.kept} tr, Δ ${bestFilter.deltaPnl >= 0 ? "+" : ""}${bestFilter.deltaPnl}).`
    );
  }

  return {
    groupCompare,
    byConfirm,
    byConfirmEa,
    byConfirmSl,
    byConfirmTp,
    fundingBuckets,
    oiBuckets,
    trendBuckets,
    corrBuckets,
    slDistBuckets,
    hourBuckets: hourBuckets.sort((a, b) => Number(a.label.slice(4)) - Number(b.label.slice(4))),
    hourBadRates: hourEaRate.slice(0, 8),
    counterfactualFilters: filters.sort((a, b) => b.pnl - a.pnl),
    notes,
  };
}

function diagnose(trades, botConfig, window) {
  const byExit = {};
  for (const t of trades) {
    const r = t.exitReason || "unknown";
    (byExit[r] ??= []).push(t);
  }
  const exitBreakdown = Object.entries(byExit)
    .map(([reason, rows]) => ({ reason, ...summarizeBucket(rows) }))
    .sort((a, b) => a.pnl - b.pnl);

  const byDay = {};
  for (const t of trades) {
    const d = dayKey(t.closedAt || t.openedAt || 0);
    (byDay[d] ??= []).push(t);
  }
  const daily = Object.keys(byDay)
    .sort()
    .map((d) => ({ day: d, ...summarizeBucket(byDay[d]) }));

  const bySym = {};
  for (const t of trades) {
    (bySym[t.symbol] ??= []).push(t);
  }
  const symbolRows = Object.entries(bySym).map(([symbol, rows]) => ({
    symbol,
    ...summarizeBucket(rows),
  }));
  const topLosers = [...symbolRows].sort((a, b) => a.pnl - b.pnl).slice(0, 15);
  const topWinners = [...symbolRows].sort((a, b) => b.pnl - a.pnl).slice(0, 10);

  const holdBuckets = [
    { label: "<2m", min: 0, max: 2 },
    { label: "2–10m", min: 2, max: 10 },
    { label: "10–30m", min: 10, max: 30 },
    { label: "30–120m", min: 30, max: 120 },
    { label: ">120m", min: 120, max: Infinity },
  ].map((b) => {
    const rows = trades.filter((t) => t.holdMin >= b.min && t.holdMin < b.max);
    return { label: b.label, ...summarizeBucket(rows) };
  });

  const overall = summarizeBucket(trades);
  const expectancy =
    overall.trades > 0
      ? +(
          (overall.winRate / 100) * overall.avgWin +
          (1 - overall.winRate / 100) * overall.avgLoss
        ).toFixed(4)
      : 0;

  const mid = window.from + (window.to - window.from) / 2;
  const firstHalf = trades.filter((t) => (t.closedAt || 0) < mid);
  const secondHalf = trades.filter((t) => (t.closedAt || 0) >= mid);

  const sorted = [...trades].sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const equityByDay = {};
  for (const t of sorted) {
    equity += Number(t.pnl) || 0;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    equityByDay[dayKey(t.closedAt || 0)] = +equity.toFixed(2);
  }
  const equityDaily = Object.keys(equityByDay)
    .sort()
    .map((day) => ({ day, equity: equityByDay[day] }));

  const patterns = patternInsights(trades);

  return {
    overall: { ...overall, expectancy, maxDrawdown: +maxDd.toFixed(2) },
    exitBreakdown,
    daily,
    equityDaily,
    holdBuckets,
    halves: {
      first: summarizeBucket(firstHalf),
      second: summarizeBucket(secondHalf),
    },
    topLosers,
    topWinners,
    patterns,
    botExitFlags: {
      takeProfitPct: botConfig.takeProfitPct,
      aiExitLevelsEnabled: botConfig.aiExitLevelsEnabled,
      earlyAbortEnabled: botConfig.earlyAbortEnabled,
      earlyAbortBars: botConfig.earlyAbortBars,
      earlyAbortMaxAdversePct: botConfig.earlyAbortMaxAdversePct,
      earlyAbortMinProgressPct: botConfig.earlyAbortMinProgressPct,
      pbEarlyInvalidationEnabled: botConfig.pbEarlyInvalidationEnabled,
      foiConfirmPullback: botConfig.foiConfirmPullback,
      foiRequireOiConfirm: botConfig.foiRequireOiConfirm,
      foiConfirmSfp: botConfig.foiConfirmSfp,
      foiMinAbsFundingRate: botConfig.foiMinAbsFundingRate,
    },
    levers: [
      {
        target: "early_adverse",
        actions: [
          "Raise earlyAbortMaxAdversePctBear (e.g. 1.5 → 2.5–3.0) so FOI shorts survive noise.",
          "Raise earlyAbortBarsBear or lower earlyAbortMinProgressPctBear so peak progress is easier.",
          "Or earlyAbortEnabledBear=false while FOI-only (note: also affects other bear signals if enabled).",
        ],
      },
      {
        target: "stop_loss",
        actions: [
          "Tighten entry: foiRequireOiConfirm=true and/or higher foiMinAbsFundingRateBear.",
          "Cap corridor width for FOI confirms (wide corridors → farther SL / worse RR).",
          "Review AI exit SL scale for foi_bear if aiSlPct systematically tight.",
        ],
      },
    ],
  };
}

async function main() {
  const { days } = parseArgs(process.argv);
  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }

  const syms = symbols();
  const signalCfg = loadSignalConfig();
  const botConfig = loadBot();
  const f = fetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);

  const btc = readSymbolBars("signal", "BTCUSDT") ?? [];
  const last = btc[btc.length - 1]?.openTime ?? Date.now();
  const window = {
    from: last - days * 24 * 60 * 60 * 1000,
    to: last,
    fromIso: new Date(last - days * 24 * 60 * 60 * 1000).toISOString(),
    toIso: new Date(last).toISOString(),
  };

  log(`Analyze FOI short-only · ${days}d · ${syms.length} symbols`);
  log(`Window ${window.fromIso} → ${window.toIso}`);
  log(
    `Flags TP=${botConfig.takeProfitPct}% AI-exit=${botConfig.aiExitLevelsEnabled} earlyAbort=${botConfig.earlyAbortEnabled} maxAdv=${botConfig.earlyAbortMaxAdversePct}`
  );

  const trades = [];
  const started = Date.now();
  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    log(`batch ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
    const { result } = await runPaperBotBacktest({
      symbols: batch,
      signalCfg,
      botConfig,
      days,
      fetchKlinesForSymbol: f.fetchKlinesForSymbol,
      fetchKlines1mForSymbol: f.fetchKlines1mForSymbol,
      getFundingOiAt,
      restGapMs: 0,
      saveLastResult: false,
      saveKlineCache: false,
      modelScope: "paper",
      runMeta: { analyze: "foi-short-10d-patterns" },
    });
    for (const t of result.closedTrades ?? []) {
      if (t.signalKind !== "foi_bear" && t.signalKind !== "foi") continue;
      const openedAt = t.openedAt ?? null;
      const closedAt = t.closedAt ?? null;
      const holdMin =
        openedAt != null && closedAt != null
          ? +((closedAt - openedAt) / 60000).toFixed(2)
          : 0;
      const snap = t.signalSnapshot ?? {};
      let fundingRate = snap.fundingRate ?? null;
      let fundingTrend = snap.fundingTrend ?? null;
      let oiDelta1h = snap.oiDelta1h ?? null;
      if ((fundingRate == null || oiDelta1h == null) && openedAt != null) {
        const foi = getFundingOiAt(t.symbol, openedAt);
        fundingRate = fundingRate ?? foi?.fundingRate ?? null;
        fundingTrend = fundingTrend ?? foi?.fundingTrend ?? null;
        oiDelta1h = oiDelta1h ?? foi?.oiDelta1h ?? null;
      }
      trades.push({
        symbol: t.symbol,
        signalKind: t.signalKind,
        side: t.side,
        pnl: +(Number(t.pnl) || 0).toFixed(4),
        exitReason: t.exitReason || "unknown",
        openedAt,
        closedAt,
        holdMin,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        fundingRate,
        fundingTrend,
        oiDelta1h,
        confirmKind: snap.confirmKind ?? null,
        corridorWidthPct: t.corridorWidthPct ?? snap.corridorWidthPct ?? null,
        slDistancePct: t.slDistancePct ?? null,
        tpDistancePct: t.tpDistancePct ?? null,
        peakMovePct: t.peakMovePct ?? null,
        troughMovePct: t.troughMovePct ?? null,
        aiSlPct: t.aiSlPct ?? null,
        aiTpPct: t.aiTpPct ?? null,
        hourUtc: openedAt != null ? utcHour(openedAt) : null,
      });
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
  }

  const analysis = diagnose(trades, botConfig, window);
  const out = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: syms.length,
    window,
    elapsedSec: +((Date.now() - started) / 1000).toFixed(1),
    tradeCount: trades.length,
    ...analysis,
  };
  writeJsonFile(OUT(), out);
  writeJsonFile(TRADES_OUT(), {
    ranAt: out.ranAt,
    window,
    tradeCount: trades.length,
    trades,
  });

  log(`\n=== DIAGNOSIS ===`);
  log(`PnL $${analysis.overall.pnl} · ${analysis.overall.trades} tr · WR ${analysis.overall.winRate}%`);
  for (const n of analysis.patterns.notes) log(`• ${n}`);
  log(`\nCounterfactual filters (top):`);
  for (const f of analysis.patterns.counterfactualFilters.slice(0, 6)) {
    log(
      `  ${f.label}: $${f.pnl} · ${f.kept} tr · EA ${f.eaRate}% · SL ${f.slRate}% · TP ${f.tpRate}% · Δ ${f.deltaPnl}`
    );
  }
  log(`Saved ${OUT()}`);
  log(`Trades ${TRADES_OUT()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
