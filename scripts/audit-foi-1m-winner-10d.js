#!/usr/bin/env node
/**
 * Audit winning FOI 1m both-sides config on 10d:
 * - re-check FOI entry rules per trade
 * - flag bugs (wrong side, SL/TP geometry, early-abort while disabled)
 * - report trades opened against strong active price movement
 *
 *   node scripts/audit-foi-1m-winner-10d.js --days 10
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(8192);

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { evaluateFoiLong, evaluateFoiBear, normalizeFoiConfig } = require("../lib/foi-signal");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { isBearSignal } = require("../lib/side-config");

const INTERVAL = "1m";
const BATCH = 50;
const OUT = (days) => dataPath(`foi-1m-winner-${days}d-audit.json`);
const TRADES_OUT = (days) => dataPath(`foi-1m-winner-${days}d-trades.json`);

/** Absolute linear move (lookback window) that counts as "very active". */
const ACTIVE_LINEAR_PCT = 1.5;
const ACTIVE_AVG_MOVE_PCT = 0.6;

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

function bars1m(sym) {
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym);
}

function sliceTail(bars, n) {
  if (!bars?.length) return null;
  return bars.length > n ? bars.slice(-n) : bars;
}

function createFetchers() {
  function signalBars(sym, barCount) {
    return sliceTail(bars1m(String(sym).toUpperCase()), barCount);
  }
  return {
    signalBars,
    async fetchKlinesForSymbol(sym, n) {
      const c = signalBars(sym, n);
      if (c?.length >= 200) return c;
      throw new Error(`no 1m ${sym}`);
    },
    async fetchKlines1mForSymbol() {
      return null;
    },
  };
}

function loadWinnerBot() {
  const best = readJsonFile(dataPath("foi-1m-both-10d-best.json"), null);
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  // Rebuild like optimize loadBaseBot + winning patch (do not inherit stale 15m FOI flags).
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    foiMinAbsFundingRate: 0.00012,
    foiMinAbsFundingRateBull: null,
    foiMinAbsFundingRateBear: null,
    foiRequireOiConfirm: true,
    foiConfirmSfp: true,
    foiConfirmPullback: true,
    ...(best?.patch ?? {}),
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    foiRequireOiConfirm: true,
    foiConfirmSfp: true,
    foiConfirmPullback: true,
    earlyAbortEnabledBear: false,
    earlyAbortEnabledBull: false,
    armed: false,
    drawdownStopEnabled: false,
    aiSfpRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    aiEarlyExitEnabled: false,
    aiExitLevelsEnabled: true,
    smartExitLevelsEnabled: true,
  });
}

function loadSignalConfig() {
  const scanner = readJsonFile(dataPath("scanner-config.json"), {}) ?? {};
  const detection = readJsonFile(dataPath("bear-detection-best-10d.json"), null);
  const cfg = {
    interval: INTERVAL,
    ...scanner,
    ...(detection?.patch ?? {}),
    interval: INTERVAL,
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
    .filter((s) => (bars1m(s)?.length ?? 0) >= 200)
    .sort();
}

function installWinnerModel() {
  const src = path.join(dataPath(), "foi-1m-both-models", "ai-exit-levels.json");
  if (!fs.existsSync(src)) {
    log(`WARN: no FOI 1m model at ${src} — using current paper model`);
    return;
  }
  for (const scope of ["paper", "live"]) {
    const dest = modelFileFor("ai-exit-levels", scope);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    reloadExitLevels(scope);
  }
}

function barsAtOrBefore(bars, asOfMs) {
  if (!bars?.length) return [];
  let hi = bars.length - 1;
  while (hi >= 0 && bars[hi].closeTime > asOfMs) hi--;
  return bars.slice(0, hi + 1);
}

function pctDist(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / a) * 100;
}

function classifyAgainstMove(trade, snap, signalCfg) {
  const linear = Number(snap?.linearChangePct);
  const absLinear = Number(snap?.absLinearChangePct ?? Math.abs(linear));
  const avgMove = Number(snap?.avgMovePct);
  const short = isBearSignal(trade.signalKind, { side: trade.side });
  const activeLinear =
    Number.isFinite(absLinear) && absLinear >= ACTIVE_LINEAR_PCT;
  const activeAvg =
    Number.isFinite(avgMove) && avgMove >= ACTIVE_AVG_MOVE_PCT;
  const veryActive = activeLinear || (activeLinear === false && activeAvg && absLinear >= 1.0);
  const veryActiveStrict = activeLinear && (activeAvg || absLinear >= ACTIVE_LINEAR_PCT);

  let against = false;
  let withMove = false;
  if (Number.isFinite(linear)) {
    if (short && linear > 0) against = true;
    if (short && linear < 0) withMove = true;
    if (!short && linear < 0) against = true;
    if (!short && linear > 0) withMove = true;
  }

  const againstVeryActive = against && veryActiveStrict;
  return {
    linearChangePct: Number.isFinite(linear) ? +linear.toFixed(3) : null,
    absLinearChangePct: Number.isFinite(absLinear) ? +absLinear.toFixed(3) : null,
    avgMovePct: Number.isFinite(avgMove) ? +avgMove.toFixed(3) : null,
    veryActive: veryActiveStrict,
    againstMove: against,
    withMove,
    againstVeryActive,
    minLinearCfg: signalCfg.minLinearChangePct ?? null,
  };
}

function auditTrade(trade, botConfig, signalCfg, fetchers, getFundingOiAt) {
  const bugs = [];
  const ruleFails = [];
  const openedAt = trade.openedAt;
  const snap = trade.signalSnapshot ?? {};
  const short = isBearSignal(trade.signalKind, { side: trade.side });

  // Side consistency
  if (trade.signalKind === "foi" && trade.side !== "LONG") {
    bugs.push("foi_signal_not_long");
  }
  if (trade.signalKind === "foi_bear" && trade.side !== "SHORT") {
    bugs.push("foi_bear_signal_not_short");
  }
  if (short && trade.side !== "SHORT") bugs.push("bear_kind_side_mismatch");
  if (!short && trade.side !== "LONG") bugs.push("bull_kind_side_mismatch");

  // SL/TP geometry
  const entry = Number(trade.entryPrice);
  const sl = Number(trade.stopLoss ?? trade.initialStopLoss);
  const tp = Number(trade.takeProfit);
  if (Number.isFinite(entry) && Number.isFinite(sl)) {
    if (short && sl <= entry) bugs.push("short_sl_not_above_entry");
    if (!short && sl >= entry) bugs.push("long_sl_not_below_entry");
  } else {
    bugs.push("missing_sl_or_entry");
  }
  if (Number.isFinite(entry) && Number.isFinite(tp)) {
    if (short && tp >= entry) bugs.push("short_tp_not_below_entry");
    if (!short && tp <= entry) bugs.push("long_tp_not_above_entry");
  } else {
    bugs.push("missing_tp_or_entry");
  }

  // Early abort disabled for both sides in winner — should not see early_* exits
  const eaBullOff = botConfig.earlyAbortEnabledBull === false;
  const eaBearOff = botConfig.earlyAbortEnabledBear === false;
  const eaOff =
    botConfig.earlyAbortEnabled === false ||
    (short ? eaBearOff : eaBullOff) ||
    (eaBullOff && eaBearOff);
  if (eaOff && /^early_/.test(String(trade.exitReason || ""))) {
    bugs.push(`early_exit_while_disabled:${trade.exitReason}`);
  }

  // Re-evaluate FOI at entry time
  const bars15 = fetchers.signalBars(trade.symbol, 5000) ?? [];
  const asOfBars = barsAtOrBefore(bars15, openedAt);
  const mover = barsAtOrBefore(bars1m(trade.symbol) ?? [], openedAt);
  const fundingOi = getFundingOiAt(trade.symbol, openedAt);
  const fc = normalizeFoiConfig(botConfig);

  let reeval = null;
  if (trade.signalKind === "foi_bear") {
    reeval = evaluateFoiBear(asOfBars, signalCfg, fundingOi, {}, mover);
  } else if (trade.signalKind === "foi") {
    reeval = evaluateFoiLong(asOfBars, signalCfg, fundingOi, {}, mover);
  } else {
    bugs.push(`unexpected_signalKind:${trade.signalKind}`);
  }

  if (!reeval?.passes) {
    ruleFails.push(`reeval_fail:${reeval?.reason || "null"}`);
  } else {
    const bullMin = fc.foiMinAbsFundingRateBull ?? fc.foiMinAbsFundingRate;
    const bearMin = fc.foiMinAbsFundingRateBear ?? fc.foiMinAbsFundingRate;
    if (short) {
      if (!(fundingOi.fundingRate >= bearMin)) {
        ruleFails.push(`funding_below_bear_min:${fundingOi.fundingRate}<${bearMin}`);
      }
    } else if (!(fundingOi.fundingRate <= -bullMin)) {
      ruleFails.push(`funding_above_bull_max:${fundingOi.fundingRate}>-${bullMin}`);
    }
    if (!fc.foiConfirmSfp && /sfp/i.test(String(snap.confirmKind || reeval.confirmKind || ""))) {
      ruleFails.push(`sfp_confirm_while_disabled:${snap.confirmKind || reeval.confirmKind}`);
    }
  }

  // Snapshot funding vs live lookup (tolerance)
  const snapFr = snap.fundingRate ?? null;
  if (snapFr != null && fundingOi.fundingRate != null) {
    if (Math.abs(snapFr - fundingOi.fundingRate) > 1e-8) {
      // funding series steps — allow if same sign & above threshold
      if (Math.sign(snapFr) !== Math.sign(fundingOi.fundingRate || 0) && snapFr !== 0) {
        bugs.push("snapshot_funding_sign_mismatch");
      }
    }
  }

  const move = classifyAgainstMove(trade, { ...snap, ...reeval }, signalCfg);
  const holdMin =
    trade.openedAt != null && trade.closedAt != null
      ? +((trade.closedAt - trade.openedAt) / 60000).toFixed(1)
      : null;

  return {
    symbol: trade.symbol,
    signalKind: trade.signalKind,
    side: trade.side,
    pnl: +(Number(trade.pnl) || 0).toFixed(4),
    exitReason: trade.exitReason,
    openedAt,
    closedAt: trade.closedAt,
    holdMin,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    slDistPct: pctDist(entry, sl),
    tpDistPct: pctDist(entry, tp),
    fundingRate: fundingOi.fundingRate ?? snap.fundingRate ?? null,
    fundingTrend: fundingOi.fundingTrend ?? snap.fundingTrend ?? null,
    oiDelta1h: fundingOi.oiDelta1h ?? snap.oiDelta1h ?? null,
    confirmKind: snap.confirmKind ?? reeval?.confirmKind ?? null,
    reevalPasses: Boolean(reeval?.passes),
    reevalReason: reeval?.reason ?? null,
    move,
    bugs,
    ruleFails,
    ok: bugs.length === 0 && ruleFails.length === 0,
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
  installWinnerModel();

  const botConfig = loadWinnerBot();
  const signalCfg = loadSignalConfig();
  const syms = symbols();
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);

  log(`Audit FOI 1m winner · ${days}d · ${syms.length} symbols`);
  log(
    `Flags funding≥${botConfig.foiMinAbsFundingRate} OI=${botConfig.foiRequireOiConfirm} SFP=${botConfig.foiConfirmSfp} PB=${botConfig.foiConfirmPullback} eaBull=${botConfig.earlyAbortEnabledBull} eaBear=${botConfig.earlyAbortEnabledBear}`
  );

  const closed = [];
  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    log(`batch ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
    const { result } = await runPaperBotBacktest({
      symbols: batch,
      signalCfg,
      botConfig,
      days,
      fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
      fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
      getFundingOiAt,
      restGapMs: 0,
      saveLastResult: false,
      saveKlineCache: false,
      modelScope: "paper",
      runMeta: { audit: `foi-1m-winner-${days}d` },
    });
    for (const t of result.closedTrades ?? []) {
      if (t.signalKind === "foi" || t.signalKind === "foi_bear") closed.push(t);
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
  }

  const audited = closed.map((t) =>
    auditTrade(t, botConfig, signalCfg, fetchers, getFundingOiAt)
  );

  const bugs = audited.filter((t) => t.bugs.length);
  const ruleFails = audited.filter((t) => t.ruleFails.length);
  const againstActive = audited.filter((t) => t.move.againstVeryActive);
  const withActive = audited.filter((t) => t.move.veryActive && t.move.withMove);
  const againstAny = audited.filter((t) => t.move.againstMove);
  const againstActiveWins = againstActive.filter((t) => t.pnl > 0);
  const againstActiveLosses = againstActive.filter((t) => t.pnl <= 0);

  function sumPnl(rows) {
    return +rows.reduce((s, t) => s + t.pnl, 0).toFixed(2);
  }
  function wr(rows) {
    return rows.length
      ? +((100 * rows.filter((t) => t.pnl > 0).length) / rows.length).toFixed(1)
      : 0;
  }

  const byExit = {};
  for (const t of audited) {
    byExit[t.exitReason] = (byExit[t.exitReason] || 0) + 1;
  }

  const bugCounts = {};
  for (const t of bugs) {
    for (const b of t.bugs) bugCounts[b] = (bugCounts[b] || 0) + 1;
  }
  const ruleFailCounts = {};
  for (const t of ruleFails) {
    for (const b of t.ruleFails) ruleFailCounts[b] = (ruleFailCounts[b] || 0) + 1;
  }

  const againstBuckets = [
    { label: "absLinear ≥ 1.5% against", rows: againstActive },
    {
      label: "absLinear ≥ 3% against",
      rows: againstActive.filter((t) => (t.move.absLinearChangePct ?? 0) >= 3),
    },
    {
      label: "absLinear ≥ 5% against",
      rows: againstActive.filter((t) => (t.move.absLinearChangePct ?? 0) >= 5),
    },
  ].map((b) => ({
    label: b.label,
    trades: b.rows.length,
    pnl: sumPnl(b.rows),
    winRate: wr(b.rows),
    long: b.rows.filter((t) => t.signalKind === "foi").length,
    short: b.rows.filter((t) => t.signalKind === "foi_bear").length,
  }));

  const report = {
    ranAt: new Date().toISOString(),
    days,
    interval: INTERVAL,
    symbolCount: syms.length,
    activeMoveThreshold: {
      absLinearPct: ACTIVE_LINEAR_PCT,
      avgMovePct: ACTIVE_AVG_MOVE_PCT,
      definition:
        "against_very_active = trade direction opposite to linearChangePct AND abs(linear)≥1.5%",
    },
    botFlags: {
      foiMinAbsFundingRate: botConfig.foiMinAbsFundingRate,
      foiRequireOiConfirm: botConfig.foiRequireOiConfirm,
      foiConfirmSfp: botConfig.foiConfirmSfp,
      foiConfirmPullback: botConfig.foiConfirmPullback,
      earlyAbortEnabledBull: botConfig.earlyAbortEnabledBull,
      earlyAbortEnabledBear: botConfig.earlyAbortEnabledBear,
      aiExitLevelsTpScale: botConfig.aiExitLevelsTpScale,
      minSmartStopDistancePct: botConfig.minSmartStopDistancePct,
    },
    overall: {
      trades: audited.length,
      pnl: sumPnl(audited),
      winRate: wr(audited),
      bySignal: {
        foi: {
          trades: audited.filter((t) => t.signalKind === "foi").length,
          pnl: sumPnl(audited.filter((t) => t.signalKind === "foi")),
          winRate: wr(audited.filter((t) => t.signalKind === "foi")),
        },
        foi_bear: {
          trades: audited.filter((t) => t.signalKind === "foi_bear").length,
          pnl: sumPnl(audited.filter((t) => t.signalKind === "foi_bear")),
          winRate: wr(audited.filter((t) => t.signalKind === "foi_bear")),
        },
      },
      byExit,
    },
    validation: {
      okTrades: audited.filter((t) => t.ok).length,
      bugTrades: bugs.length,
      ruleFailTrades: ruleFails.length,
      bugCounts,
      ruleFailCounts,
      sampleBugs: bugs.slice(0, 15),
      sampleRuleFails: ruleFails.slice(0, 15),
    },
    againstActiveMovement: {
      trades: againstActive.length,
      sharePct: audited.length
        ? +((100 * againstActive.length) / audited.length).toFixed(1)
        : 0,
      pnl: sumPnl(againstActive),
      winRate: wr(againstActive),
      wins: againstActiveWins.length,
      losses: againstActiveLosses.length,
      winPnl: sumPnl(againstActiveWins),
      lossPnl: sumPnl(againstActiveLosses),
      bySignal: {
        foi: {
          trades: againstActive.filter((t) => t.signalKind === "foi").length,
          pnl: sumPnl(againstActive.filter((t) => t.signalKind === "foi")),
          winRate: wr(againstActive.filter((t) => t.signalKind === "foi")),
        },
        foi_bear: {
          trades: againstActive.filter((t) => t.signalKind === "foi_bear").length,
          pnl: sumPnl(againstActive.filter((t) => t.signalKind === "foi_bear")),
          winRate: wr(againstActive.filter((t) => t.signalKind === "foi_bear")),
        },
      },
      buckets: againstBuckets,
      vsRest: {
        restTrades: audited.length - againstActive.length,
        restPnl: sumPnl(audited.filter((t) => !t.move.againstVeryActive)),
        restWinRate: wr(audited.filter((t) => !t.move.againstVeryActive)),
      },
      withActiveMove: {
        trades: withActive.length,
        pnl: sumPnl(withActive),
        winRate: wr(withActive),
      },
      againstAnyMove: {
        trades: againstAny.length,
        pnl: sumPnl(againstAny),
        winRate: wr(againstAny),
      },
      topAgainst: [...againstActive]
        .sort((a, b) => (b.move.absLinearChangePct || 0) - (a.move.absLinearChangePct || 0))
        .slice(0, 20)
        .map((t) => ({
          symbol: t.symbol,
          signalKind: t.signalKind,
          pnl: t.pnl,
          exitReason: t.exitReason,
          linearChangePct: t.move.linearChangePct,
          absLinearChangePct: t.move.absLinearChangePct,
          avgMovePct: t.move.avgMovePct,
          fundingRate: t.fundingRate,
          confirmKind: t.confirmKind,
        })),
      worstAgainst: [...againstActive]
        .sort((a, b) => a.pnl - b.pnl)
        .slice(0, 10)
        .map((t) => ({
          symbol: t.symbol,
          signalKind: t.signalKind,
          pnl: t.pnl,
          exitReason: t.exitReason,
          linearChangePct: t.move.linearChangePct,
        })),
      bestAgainst: [...againstActive]
        .sort((a, b) => b.pnl - a.pnl)
        .slice(0, 10)
        .map((t) => ({
          symbol: t.symbol,
          signalKind: t.signalKind,
          pnl: t.pnl,
          exitReason: t.exitReason,
          linearChangePct: t.move.linearChangePct,
        })),
    },
  };

  writeJsonFile(OUT(days), report);
  writeJsonFile(TRADES_OUT(days), { ranAt: report.ranAt, trades: audited });

  log("\n=== AUDIT SUMMARY ===");
  log(`Trades ${report.overall.trades} · PnL $${report.overall.pnl} · WR ${report.overall.winRate}%`);
  log(`OK ${report.validation.okTrades} · bugs ${report.validation.bugTrades} · ruleFails ${report.validation.ruleFailTrades}`);
  if (Object.keys(bugCounts).length) log(`Bugs: ${JSON.stringify(bugCounts)}`);
  if (Object.keys(ruleFailCounts).length) log(`Rule fails: ${JSON.stringify(ruleFailCounts)}`);
  log(
    `Against very active move: ${againstActive.length} (${report.againstActiveMovement.sharePct}%) · $${report.againstActiveMovement.pnl} · WR ${report.againstActiveMovement.winRate}%`
  );
  log(`Saved ${OUT(days)}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
