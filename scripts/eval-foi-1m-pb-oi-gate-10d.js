#!/usr/bin/env node
/**
 * Single lever on BP 1.2: pullback confirm only if |oiΔ1h| < 2 (SFP gate unchanged).
 * Targets quick-SL PB pocket. Keeps EA off + SFP OI-gate.
 *
 *   node scripts/eval-foi-1m-pb-oi-gate-10d.js --days 10
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
const OUT = () => dataPath("foi-1m-pb-oi-gate-10d.json");
const TRADES_OUT = () => dataPath("foi-1m-pb-oi-gate-10d-trades.json");
const BP12_BASE = () => dataPath("foi-1m-ea-off-10d.json");
const BP12_DIR = () => path.join(dataPath(), "breakpoints", "1.2");

function buildPatch() {
  const bp12 = readJsonFile(BP12_BASE(), null) ?? readJsonFile(path.join(BP12_DIR(), "foi-1m-ea-off-10d.json"), null);
  const base = bp12?.patch ?? readJsonFile(path.join(BP12_DIR(), "patch.json"), {}) ?? {};
  return {
    ...base,
    foiConfirmSfpMaxOiDelta1hAbs: 2,
    foiConfirmPullbackMaxOiDelta1hAbs: 2,
    earlyAbortEnabled: false,
    earlyAbortEnabledBull: false,
    earlyAbortEnabledBear: false,
    earlyAbortAdverseEnabled: false,
    earlyAbortStallEnabled: false,
    earlyAbortInvalidationEnabled: false,
  };
}

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

function applyLocalPatch(patch) {
  for (const name of ["paper-bot-state.json", "live-bot-state.json"]) {
    const state = readJsonFile(dataPath(name), null);
    if (!state?.config) continue;
    Object.assign(state.config, patch);
    writeJsonFile(dataPath(name), state);
    log(`Applied pb_oi_gate patch → ${name}`);
  }
}

async function main() {
  const { days } = parseArgs(process.argv);
  const patch = buildPatch();

  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }
  installWinnerModel();

  const botConfig = loadBot(patch);
  const signalCfg = loadSignalConfig();
  const syms = symbols();
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);

  log(`FOI 1m pb_oi_gate eval · ${days}d · ${syms.length} symbols`);
  log(
    `OI global=${patch.foiMaxOiDelta1hAbs} · SFP-gate=${patch.foiConfirmSfpMaxOiDelta1hAbs} · PB-gate=${patch.foiConfirmPullbackMaxOiDelta1hAbs} · EA=${patch.earlyAbortEnabled}`
  );
  log(
    `EA adverse=${patch.earlyAbortAdverseEnabled} stall=${patch.earlyAbortStallEnabled} inv=${patch.earlyAbortInvalidationEnabled} maxAdv=${patch.earlyAbortMaxAdversePct}`
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
      runMeta: { eval: "foi-1m-pb-oi-gate-10d" },
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
  const bp12Report = readJsonFile(BP12_BASE(), null);
  const bp12Summary = bp12Report?.summary ?? null;
  const deltaVsBp12 = bp12Summary
    ? {
        pnl: +(summary.pnl - bp12Summary.pnl).toFixed(2),
        trades: summary.trades - bp12Summary.trades,
        winRate: +(summary.winRate - bp12Summary.winRate).toFixed(1),
        earlyExits: summary.earlyExits - (bp12Summary.earlyExits ?? 0),
        winPnl: +(summary.winPnl - bp12Summary.winPnl).toFixed(2),
        lossPnl: +(summary.lossPnl - bp12Summary.lossPnl).toFixed(2),
      }
    : null;

  const improves = deltaVsBp12 ? deltaVsBp12.pnl > 0.01 : false;
  if (improves) applyLocalPatch(patch);
  else log(`SKIP apply: pb_oi_gate $${summary.pnl} did not beat BP1.2 $${bp12Summary?.pnl}`);

  const report = {
    ranAt: new Date().toISOString(),
    days,
    interval: INTERVAL,
    symbolCount: syms.length,
    mode: "pb_oi_gate",
    patch,
    summary,
    baselineBp12: bp12Summary,
    deltaVsBp12,
    applied: improves,
  };

  writeJsonFile(OUT(), report);
  writeJsonFile(TRADES_OUT(), { ranAt: report.ranAt, trades: closed });

  log("\n=== PB_OI_GATE 10d ===");
  log(`PnL $${summary.pnl} · ${summary.trades} tr · WR ${summary.winRate}%`);
  log(`Wins $${summary.winPnl} · Losses $${summary.lossPnl}`);
  log(`Early: ${summary.earlyExits} ${JSON.stringify(summary.earlyByReason)}`);
  log(`Exits: ${JSON.stringify(summary.byExit)}`);
  log(`Confirm: ${JSON.stringify(summary.byConfirm)}`);
  if (deltaVsBp12) {
    log(
      `Δ vs BP1.2: PnL ${deltaVsBp12.pnl >= 0 ? "+" : ""}$${deltaVsBp12.pnl} · trades ${deltaVsBp12.trades} · applied=${improves}`
    );
  }
  log(`Saved ${OUT()}`);
  console.log(JSON.stringify({ summary, deltaVsBp12, applied: improves }, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
