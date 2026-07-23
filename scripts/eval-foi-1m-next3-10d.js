#!/usr/bin/env node
/**
 * Stack on adverse_only / BP1.0:
 *   1) |oiDelta1h| < 2
 *   2) early_adverse soft (maxAdv 3%) OR SL/TP-only (adverse off)
 *   3) bear confirm = pullback only (SFP bear off)
 *
 *   node scripts/eval-foi-1m-next3-10d.js --days 10
 *   node scripts/eval-foi-1m-next3-10d.js --days 10 --only soft3
 *   node scripts/eval-foi-1m-next3-10d.js --days 10 --only sltp
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
const OUT = () => dataPath("foi-1m-next3-10d.json");
const BP_DIR = () => path.join(dataPath(), "breakpoints", "1.0");
const ADVERSE_BASE = () => dataPath("foi-1m-adverse-only-10d.json");

const VARIANTS = {
  soft3: {
    id: "soft3",
    label: "OI≤2 · maxAdv 3% · PB-bear-only",
    ea: {
      earlyAbortEnabled: true,
      earlyAbortEnabledBull: true,
      earlyAbortEnabledBear: true,
      earlyAbortBars: 15,
      earlyAbortBarsBull: 15,
      earlyAbortBarsBear: 15,
      earlyAbortMaxAdversePct: 3.0,
      earlyAbortMaxAdversePctBull: 3.0,
      earlyAbortMaxAdversePctBear: 3.0,
      earlyAbortMinProgressPct: 0.25,
      earlyAbortInvalidateBars: 5,
      earlyAbortAdverseEnabled: true,
      earlyAbortStallEnabled: false,
      earlyAbortInvalidationEnabled: false,
    },
  },
  sltp: {
    id: "sltp",
    label: "OI≤2 · SL/TP-only · PB-bear-only",
    ea: {
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
      earlyAbortAdverseEnabled: false,
      earlyAbortStallEnabled: false,
      earlyAbortInvalidationEnabled: false,
    },
  },
};

function buildBaseStack() {
  const bpPatch = readJsonFile(path.join(BP_DIR(), "patch.json"), {}) ?? {};
  return {
    ...bpPatch,
    foiMaxOiDelta1hAbs: 2,
    foiConfirmSfpBear: false,
    foiConfirmPullbackBear: true,
  };
}

function buildPatch(variantId) {
  const v = VARIANTS[variantId];
  if (!v) throw new Error(`unknown variant ${variantId}`);
  return { ...buildBaseStack(), ...v.ea };
}

function log(m) {
  console.error(String(m));
}

function parseArgs(argv) {
  let days = 10;
  let only = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Math.max(1, Number(argv[++i]) || 10);
    else if (argv[i] === "--only" && argv[i + 1]) {
      only = String(argv[++i]).toLowerCase();
      if (!VARIANTS[only]) throw new Error(`--only must be soft3|sltp, got ${only}`);
    }
  }
  return { days, only };
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

function loadBot(patch) {
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
    ...patch,
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

async function runVariant({ variantId, days, syms, signalCfg, fetchers, getFundingOiAt }) {
  const variant = VARIANTS[variantId];
  const patch = buildPatch(variantId);
  const botConfig = loadBot(patch);
  log(`\n=== RUN ${variant.id}: ${variant.label} ===`);
  log(
    `OI max|Δ|=${patch.foiMaxOiDelta1hAbs} · SFP_bear=${patch.foiConfirmSfpBear} · PB_bear=${patch.foiConfirmPullbackBear}`
  );
  log(
    `EA adverse=${patch.earlyAbortAdverseEnabled} stall=${patch.earlyAbortStallEnabled} inv=${patch.earlyAbortInvalidationEnabled} maxAdv=${patch.earlyAbortMaxAdversePct}`
  );

  const closed = [];
  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    log(`  [${variant.id}] batch ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
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
      runMeta: { eval: "foi-1m-next3-10d", variant: variantId },
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
  const tradesOut = dataPath(`foi-1m-next3-${variantId}-10d-trades.json`);
  writeJsonFile(tradesOut, { ranAt: new Date().toISOString(), variant: variantId, trades: closed });
  log(
    `  [${variant.id}] PnL $${summary.pnl} · ${summary.trades} tr · WR ${summary.winRate}% · early ${summary.earlyExits}`
  );
  return { variantId, label: variant.label, patch, summary, tradesOut, tradeCount: closed.length };
}

function applyLocalPatch(patch, label) {
  for (const name of ["paper-bot-state.json", "live-bot-state.json"]) {
    const state = readJsonFile(dataPath(name), null);
    if (!state?.config) continue;
    Object.assign(state.config, patch);
    writeJsonFile(dataPath(name), state);
    log(`Applied ${label} patch → ${name}`);
  }
}

async function main() {
  const { days, only } = parseArgs(process.argv);
  const variantIds = only ? [only] : Object.keys(VARIANTS);

  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }
  installWinnerModel();

  const signalCfg = loadSignalConfig();
  const syms = symbols();
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);

  log(`FOI 1m next3 eval · ${days}d · ${syms.length} symbols · variants=${variantIds.join(",")}`);

  const runs = [];
  for (const id of variantIds) {
    runs.push(await runVariant({ variantId: id, days, syms, signalCfg, fetchers, getFundingOiAt }));
  }

  const adverse = readJsonFile(ADVERSE_BASE(), null);
  const bpReport = readJsonFile(path.join(BP_DIR(), "foi-1m-loss-reduce-10d.json"), null);
  const adverseSummary = adverse?.summary ?? null;
  const bpSummary = bpReport?.summary ?? null;

  const enriched = runs.map((r) => ({
    ...r,
    deltaVsAdverse: adverseSummary
      ? {
          pnl: +(r.summary.pnl - adverseSummary.pnl).toFixed(2),
          trades: r.summary.trades - adverseSummary.trades,
          winRate: +(r.summary.winRate - adverseSummary.winRate).toFixed(1),
          earlyExits: r.summary.earlyExits - (adverseSummary.earlyExits ?? 0),
        }
      : null,
    deltaVsBp10: bpSummary
      ? {
          pnl: +(r.summary.pnl - bpSummary.pnl).toFixed(2),
          trades: r.summary.trades - bpSummary.trades,
          winRate: +(r.summary.winRate - bpSummary.winRate).toFixed(1),
        }
      : null,
  }));

  enriched.sort((a, b) => b.summary.pnl - a.summary.pnl);
  const winner = enriched[0];
  const adversePnl = adverseSummary?.pnl ?? null;
  const improves =
    adversePnl == null ? true : winner.summary.pnl > adversePnl + 0.01;

  // Only persist if the stack beats adverse_only — never regress live/paper.
  if (improves) {
    applyLocalPatch(winner.patch, winner.variantId);
  } else {
    log(
      `SKIP apply: winner $${winner.summary.pnl} ≤ adverse_only $${adversePnl} — keep prior config`
    );
  }
  writeJsonFile(dataPath("foi-1m-next3-winner-patch.json"), {
    ranAt: new Date().toISOString(),
    winner: winner.variantId,
    label: winner.label,
    applied: improves,
    patch: winner.patch,
    adversePnl,
  });

  const report = {
    ranAt: new Date().toISOString(),
    days,
    interval: INTERVAL,
    symbolCount: syms.length,
    stack: {
      foiMaxOiDelta1hAbs: 2,
      foiConfirmSfpBear: false,
      foiConfirmPullbackBear: true,
      variants: variantIds,
    },
    baselineAdverse: adverseSummary,
    baselineBp10: bpSummary,
    runs: enriched.map(({ variantId, label, patch, summary, deltaVsAdverse, deltaVsBp10, tradesOut }) => ({
      variantId,
      label,
      patch,
      summary,
      deltaVsAdverse,
      deltaVsBp10,
      tradesOut,
    })),
    winner: {
      variantId: winner.variantId,
      label: winner.label,
      pnl: winner.summary.pnl,
      trades: winner.summary.trades,
      winRate: winner.summary.winRate,
      deltaVsAdverse: winner.deltaVsAdverse,
      deltaVsBp10: winner.deltaVsBp10,
    },
  };

  writeJsonFile(OUT(), report);

  log("\n=== NEXT3 COMPARISON ===");
  for (const r of enriched) {
    const dA = r.deltaVsAdverse;
    const dAStr = dA ? `Δadv ${dA.pnl >= 0 ? "+" : ""}$${dA.pnl}` : "Δadv n/a";
    log(
      `${r.variantId}: $${r.summary.pnl} · ${r.summary.trades} tr · WR ${r.summary.winRate}% · early ${r.summary.earlyExits} · ${dAStr}`
    );
    log(`  exits: ${JSON.stringify(r.summary.byExit)}`);
    log(`  confirm: ${JSON.stringify(r.summary.byConfirm)}`);
  }
  log(
    `\nWINNER: ${winner.variantId} · $${winner.summary.pnl} · ${winner.summary.trades} tr` +
      (winner.deltaVsAdverse
        ? ` · Δ vs adverse_only ${winner.deltaVsAdverse.pnl >= 0 ? "+" : ""}$${winner.deltaVsAdverse.pnl}`
        : "")
  );
  log(`Saved ${OUT()}`);
  console.log(
    JSON.stringify(
      {
        winner: report.winner,
        runs: report.runs.map((r) => ({
          variantId: r.variantId,
          pnl: r.summary.pnl,
          trades: r.summary.trades,
          winRate: r.summary.winRate,
          earlyExits: r.summary.earlyExits,
          byExit: r.summary.byExit,
          byConfirm: r.summary.byConfirm,
          deltaVsAdverse: r.deltaVsAdverse,
        })),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
