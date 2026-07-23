#!/usr/bin/env node
/**
 * Apply FOI 1m loss-reduction recommendations and eval on 10d.
 *
 *   node scripts/eval-foi-1m-loss-reduce-10d.js --days 10
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
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { isBearSignal } = require("../lib/side-config");

const INTERVAL = "1m";
const BATCH = 50;
const ACTIVE_LINEAR_PCT = 1.5;
const OUT = () => dataPath("foi-1m-loss-reduce-10d.json");
const TRADES_OUT = () => dataPath("foi-1m-loss-reduce-10d-trades.json");
const BASELINE = () => dataPath("foi-1m-winner-10d-audit.json");

/** Stacked loss-reduction patch on top of 1m FOI winner. */
const LOSS_REDUCE_PATCH = {
  // Winner funding floors
  foiMinAbsFundingRate: 0.00012,
  foiMinAbsFundingRateBull: 0.00018,
  foiMinAbsFundingRateBear: 0.0001,
  // #2 cap extreme funding
  foiMaxAbsFundingRate: 0.0005,
  // #3 block OI spikes / crashes
  foiMaxOiDelta1hAbs: 5,
  foiRequireOiConfirm: true,
  // #4 long SFP only (drop long pullback); shorts keep both
  foiConfirmSfp: true,
  foiConfirmPullback: true,
  foiConfirmSfpBull: true,
  foiConfirmPullbackBull: false,
  foiConfirmSfpBear: true,
  foiConfirmPullbackBear: true,
  // #5 short-only (disable long FOI) — strongest long-loss cut
  tradeFoiSignals: false,
  tradeBearishFoiSignals: true,
  tradeSfpSignals: false,
  tradeBearishSfpSignals: false,
  tradePullbackSignals: false,
  tradeBearishPullbackSignals: false,
  // Winner TP split
  takeProfitPctBull: 2.5,
  takeProfitPctBear: 3.5,
  // #1 soft early-abort (was OFF) — target quick adverse
  earlyAbortEnabled: true,
  earlyAbortEnabledBull: true,
  earlyAbortEnabledBear: true,
  earlyAbortBars: 15,
  earlyAbortBarsBull: 15,
  earlyAbortBarsBear: 15,
  earlyAbortMaxAdversePct: 2.0,
  earlyAbortMaxAdversePctBull: 2.0,
  earlyAbortMaxAdversePctBear: 2.0,
  earlyAbortMinProgressPct: 0.25,
  earlyAbortInvalidateBars: 5,
  // #6 tighter bear stop geometry (esp. pullback_bear wide SL)
  stopLossBelowCorridorPctBear: 1.5,
  minSmartStopDistancePct: 1.0,
  minSmartStopDistancePctBear: 0.8,
  aiExitLevelsEnabled: true,
  smartExitLevelsEnabled: true,
};

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
  return {
    async fetchKlinesForSymbol(sym, n) {
      const c = sliceTail(bars1m(String(sym).toUpperCase()), n);
      if (c?.length >= 200) return c;
      throw new Error(`no 1m ${sym}`);
    },
    async fetchKlines1mForSymbol() {
      return null;
    },
  };
}

function loadBot() {
  const best = readJsonFile(dataPath("foi-1m-both-10d-best.json"), null);
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
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
    foiRequireOiConfirm: true,
    foiConfirmSfp: true,
    foiConfirmPullback: true,
    ...(best?.patch ?? {}),
    ...LOSS_REDUCE_PATCH,
    armed: false,
    drawdownStopEnabled: false,
    aiSfpRegimeEnabled: false,
    aiPullbackSignalEnabled: false,
    aiPullbackRegimeEnabled: false,
    aiPullbackPatternBreakEnabled: false,
    aiEarlyExitEnabled: false,
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
    log(`WARN: no FOI 1m model at ${src}`);
    return;
  }
  for (const scope of ["paper", "live"]) {
    const dest = modelFileFor("ai-exit-levels", scope);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    reloadExitLevels(scope);
  }
}

function classifyAgainst(trade) {
  const snap = trade.signalSnapshot ?? {};
  const linear = Number(snap.linearChangePct);
  const absLinear = Number(snap.absLinearChangePct ?? Math.abs(linear));
  const short = isBearSignal(trade.signalKind, { side: trade.side });
  const veryActive = Number.isFinite(absLinear) && absLinear >= ACTIVE_LINEAR_PCT;
  let against = false;
  let withMove = false;
  if (Number.isFinite(linear)) {
    if (short && linear > 0) against = true;
    if (short && linear < 0) withMove = true;
    if (!short && linear < 0) against = true;
    if (!short && linear > 0) withMove = true;
  }
  return {
    linearChangePct: Number.isFinite(linear) ? +linear.toFixed(3) : null,
    absLinearChangePct: Number.isFinite(absLinear) ? +absLinear.toFixed(3) : null,
    veryActive,
    againstMove: against,
    withMove,
    againstVeryActive: against && veryActive,
  };
}

function summarize(trades) {
  const pnl = +trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2);
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl ?? 0) <= 0);
  const byExit = {};
  const bySignal = {};
  const byConfirm = {};
  for (const t of trades) {
    byExit[t.exitReason || "null"] = (byExit[t.exitReason || "null"] || 0) + 1;
    const sk = t.signalKind || "null";
    if (!bySignal[sk]) bySignal[sk] = { trades: 0, pnl: 0, wins: 0 };
    bySignal[sk].trades++;
    bySignal[sk].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) bySignal[sk].wins++;
    const ck = t.signalSnapshot?.confirmKind || t.confirmKind || "null";
    if (!byConfirm[ck]) byConfirm[ck] = { trades: 0, pnl: 0, wins: 0 };
    byConfirm[ck].trades++;
    byConfirm[ck].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) byConfirm[ck].wins++;
  }
  for (const k of Object.keys(bySignal)) {
    const r = bySignal[k];
    r.pnl = +r.pnl.toFixed(2);
    r.winRate = r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0;
  }
  for (const k of Object.keys(byConfirm)) {
    const r = byConfirm[k];
    r.pnl = +r.pnl.toFixed(2);
    r.winRate = r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0;
  }
  const against = trades.filter((t) => t.move?.againstVeryActive);
  const holdQuickSl = trades.filter(
    (t) => (t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss"
  );
  return {
    trades: trades.length,
    pnl,
    winRate: trades.length ? +((100 * wins.length) / trades.length).toFixed(1) : 0,
    wins: wins.length,
    losses: losses.length,
    winPnl: +wins.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    lossPnl: +losses.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    byExit,
    bySignal,
    byConfirm,
    earlyExits: trades.filter((t) => /^early_/.test(String(t.exitReason || ""))).length,
    earlyByReason: trades
      .filter((t) => /^early_/.test(String(t.exitReason || "")))
      .reduce((m, t) => {
        m[t.exitReason] = (m[t.exitReason] || 0) + 1;
        return m;
      }, {}),
    quickSlLe15m: {
      trades: holdQuickSl.length,
      pnl: +holdQuickSl.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    },
    againstActive: {
      trades: against.length,
      sharePct: trades.length ? +((100 * against.length) / trades.length).toFixed(1) : 0,
      pnl: +against.reduce((s, t) => s + t.pnl, 0).toFixed(2),
      winRate: against.length
        ? +((100 * against.filter((t) => t.pnl > 0).length) / against.length).toFixed(1)
        : 0,
    },
  };
}

function applyLocalPatch() {
  for (const name of ["paper-bot-state.json", "live-bot-state.json"]) {
    const state = readJsonFile(dataPath(name), null);
    if (!state?.config) continue;
    Object.assign(state.config, LOSS_REDUCE_PATCH);
    writeJsonFile(dataPath(name), state);
    log(`Applied loss-reduce patch → ${name}`);
  }
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
  applyLocalPatch();

  const botConfig = loadBot();
  const signalCfg = loadSignalConfig();
  const syms = symbols();
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);

  log(`FOI 1m loss-reduce eval · ${days}d · ${syms.length} symbols`);
  log(
    `Patch: short-only · max|fr|<${LOSS_REDUCE_PATCH.foiMaxAbsFundingRate} · max|oi|<${LOSS_REDUCE_PATCH.foiMaxOiDelta1hAbs} · EA bars=${LOSS_REDUCE_PATCH.earlyAbortBars} adv=${LOSS_REDUCE_PATCH.earlyAbortMaxAdversePct} · bear SL corridor=${LOSS_REDUCE_PATCH.stopLossBelowCorridorPctBear}`
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
      runMeta: { eval: "foi-1m-loss-reduce-10d" },
    });
    for (const t of result.closedTrades ?? []) {
      if (t.signalKind !== "foi" && t.signalKind !== "foi_bear") continue;
      const holdMin =
        t.openedAt != null && t.closedAt != null
          ? +((t.closedAt - t.openedAt) / 60000).toFixed(1)
          : null;
      closed.push({
        symbol: t.symbol,
        signalKind: t.signalKind,
        side: t.side,
        pnl: +(Number(t.pnl) || 0).toFixed(4),
        exitReason: t.exitReason,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        holdMin,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        fundingRate: t.signalSnapshot?.fundingRate ?? null,
        oiDelta1h: t.signalSnapshot?.oiDelta1h ?? null,
        confirmKind: t.signalSnapshot?.confirmKind ?? null,
        move: classifyAgainst(t),
        signalSnapshot: t.signalSnapshot ?? null,
      });
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
  }

  const summary = summarize(closed);
  const baseline = readJsonFile(BASELINE(), null)?.overall ?? null;
  const report = {
    ranAt: new Date().toISOString(),
    days,
    interval: INTERVAL,
    symbolCount: syms.length,
    patch: LOSS_REDUCE_PATCH,
    recommendationsApplied: [
      "early_abort_soft_15m_2pct",
      "foiMaxAbsFundingRate_0.0005",
      "foiMaxOiDelta1hAbs_5",
      "long_sfp_only_flags_set",
      "short_only_tradeFoiSignals_false",
      "tighter_bear_stop_corridor_1.5_minSmart_0.8",
    ],
    summary,
    baselineWinner10d: baseline,
    deltaVsBaseline: baseline
      ? {
          pnl: +(summary.pnl - (baseline.pnl ?? 0)).toFixed(2),
          trades: summary.trades - (baseline.trades ?? 0),
          winRate: +(summary.winRate - (baseline.winRate ?? 0)).toFixed(1),
          lossPnl: +(summary.lossPnl - (baseline.bySignal ? null : 0)).toFixed(2),
        }
      : null,
  };

  // richer baseline loss compare if winner trades exist
  const baseTrades = readJsonFile(dataPath("foi-1m-winner-10d-trades.json"), null)?.trades;
  if (baseTrades?.length) {
    const baseLoss = baseTrades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
    const baseWin = baseTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const baseQuick = baseTrades.filter(
      (t) => (t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss"
    );
    report.baselineDetail = {
      pnl: +baseTrades.reduce((s, t) => s + t.pnl, 0).toFixed(2),
      trades: baseTrades.length,
      winPnl: +baseWin.toFixed(2),
      lossPnl: +baseLoss.toFixed(2),
      quickSlLe15m: {
        trades: baseQuick.length,
        pnl: +baseQuick.reduce((s, t) => s + t.pnl, 0).toFixed(2),
      },
    };
    report.deltaVsBaseline = {
      pnl: +(summary.pnl - report.baselineDetail.pnl).toFixed(2),
      trades: summary.trades - report.baselineDetail.trades,
      winRate: +(summary.winRate - (baseline?.winRate ?? 0)).toFixed(1),
      lossPnl: +(summary.lossPnl - report.baselineDetail.lossPnl).toFixed(2),
      winPnl: +(summary.winPnl - report.baselineDetail.winPnl).toFixed(2),
      quickSlPnl: +(summary.quickSlLe15m.pnl - report.baselineDetail.quickSlLe15m.pnl).toFixed(2),
      quickSlTrades:
        summary.quickSlLe15m.trades - report.baselineDetail.quickSlLe15m.trades,
    };
  }

  writeJsonFile(OUT(), report);
  writeJsonFile(TRADES_OUT(), { ranAt: report.ranAt, trades: closed });

  log("\n=== LOSS-REDUCE 10d ===");
  log(`PnL $${summary.pnl} · ${summary.trades} tr · WR ${summary.winRate}%`);
  log(`Wins $${summary.winPnl} · Losses $${summary.lossPnl}`);
  log(`Early exits: ${summary.earlyExits} ${JSON.stringify(summary.earlyByReason)}`);
  log(`Quick SL ≤15m: ${summary.quickSlLe15m.trades} · $${summary.quickSlLe15m.pnl}`);
  if (report.deltaVsBaseline) {
    log(
      `Δ vs winner: PnL ${report.deltaVsBaseline.pnl >= 0 ? "+" : ""}$${report.deltaVsBaseline.pnl} · trades ${report.deltaVsBaseline.trades} · lossPnl ${report.deltaVsBaseline.lossPnl >= 0 ? "+" : ""}$${report.deltaVsBaseline.lossPnl}`
    );
  }
  log(`Saved ${OUT()}`);
  console.log(JSON.stringify({ summary, delta: report.deltaVsBaseline, patch: LOSS_REDUCE_PATCH }, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
