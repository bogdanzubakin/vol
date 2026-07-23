#!/usr/bin/env node
/**
 * BP 1.3 confirmation 10d + wide report + next-step recommendations.
 *
 *   node scripts/eval-foi-1m-bp13-wide-10d.js --days 10
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
const OUT = () => dataPath("foi-1m-bp13-wide-10d.json");
const TRADES_OUT = () => dataPath("foi-1m-bp13-wide-10d-trades.json");
const BP13_DIR = () => path.join(dataPath(), "breakpoints", "1.3");

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

function buildPatch() {
  const bp = readJsonFile(path.join(BP13_DIR(), "patch.json"), null);
  const evalR = readJsonFile(path.join(BP13_DIR(), "foi-1m-pb-oi-gate-10d.json"), null);
  return {
    ...(evalR?.patch ?? {}),
    ...(bp ?? {}),
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
  const cfg = { interval: INTERVAL, ...scanner, ...(detection?.patch ?? {}), interval: INTERVAL };
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

function sumPnl(ts) {
  return +ts.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2);
}
function winRate(ts) {
  const w = ts.filter((t) => (t.pnl ?? 0) > 0).length;
  return ts.length ? +((100 * w) / ts.length).toFixed(1) : 0;
}
function bucket(ts) {
  return {
    trades: ts.length,
    pnl: sumPnl(ts),
    winRate: winRate(ts),
    winPnl: +ts.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + t.pnl, 0).toFixed(2),
    lossPnl: +ts.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + t.pnl, 0).toFixed(2),
  };
}

function confirmOf(t) {
  return t.confirmKind || t.signalSnapshot?.confirmKind || "null";
}

function stopDistPct(t) {
  const e = Number(t.entryPrice);
  const sl = Number(t.stopLoss);
  if (!e || !Number.isFinite(sl)) return null;
  return Math.abs((sl - e) / e) * 100;
}

function buildWide(trades) {
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl ?? 0) <= 0);
  const byExit = {};
  const byConfirm = {};
  for (const t of trades) {
    byExit[t.exitReason || "null"] = (byExit[t.exitReason || "null"] || 0) + 1;
    const ck = confirmOf(t);
    if (!byConfirm[ck]) byConfirm[ck] = { trades: 0, pnl: 0, wins: 0 };
    byConfirm[ck].trades++;
    byConfirm[ck].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) byConfirm[ck].wins++;
  }
  for (const k of Object.keys(byConfirm)) {
    const r = byConfirm[k];
    r.pnl = +r.pnl.toFixed(2);
    r.winRate = r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0;
  }

  const qsl = trades.filter((t) => (t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss");
  const holdBins = [
    [0, 15],
    [15, 60],
    [60, 180],
    [180, 360],
    [360, 1e9],
  ].map(([lo, hi]) => {
    const ts = trades.filter((t) => (t.holdMin ?? -1) >= lo && (t.holdMin ?? -1) < hi);
    return { label: hi > 1e6 ? `${lo}+m` : `${lo}-${hi}m`, ...bucket(ts) };
  });

  const frBands = [
    [0, 0.00015],
    [0.00015, 0.00025],
    [0.00025, 0.00035],
    [0.00035, 0.0005],
  ].map(([lo, hi]) => {
    const ts = trades.filter((t) => {
      const f = Math.abs(Number(t.fundingRate));
      return Number.isFinite(f) && f >= lo && f < hi;
    });
    return { label: `${lo}–${hi}`, ...bucket(ts) };
  });

  const oiBands = [
    [0, 0.5],
    [0.5, 1],
    [1, 1.5],
    [1.5, 2],
  ].map(([lo, hi]) => {
    const ts = trades.filter((t) => {
      const o = Math.abs(Number(t.oiDelta1h));
      return Number.isFinite(o) && o >= lo && o < hi;
    });
    return { label: `|oi| ${lo}–${hi}`, ...bucket(ts) };
  });

  const stopBands = [
    [0, 1.2],
    [1.2, 1.8],
    [1.8, 2.6],
    [2.6, 99],
  ].map(([lo, hi]) => {
    const ts = trades.filter((t) => {
      const d = stopDistPct(t);
      return d != null && d >= lo && d < hi;
    });
    return { label: `SL dist ${lo}–${hi}%`, ...bucket(ts) };
  });

  const bySym = {};
  for (const t of trades) {
    if (!bySym[t.symbol]) bySym[t.symbol] = { trades: 0, pnl: 0, wins: 0, qsl: 0 };
    bySym[t.symbol].trades++;
    bySym[t.symbol].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) bySym[t.symbol].wins++;
    if ((t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss") bySym[t.symbol].qsl++;
  }
  const symbols = Object.entries(bySym)
    .map(([symbol, r]) => ({
      symbol,
      trades: r.trades,
      pnl: +r.pnl.toFixed(2),
      winRate: r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0,
      qsl: r.qsl,
    }))
    .sort((a, b) => a.pnl - b.pnl);

  // UTC day-of-week / hour from openedAt
  const byDow = Array.from({ length: 7 }, (_, i) => ({ dow: i, trades: 0, pnl: 0, wins: 0 }));
  const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, trades: 0, pnl: 0, wins: 0 }));
  for (const t of trades) {
    if (t.openedAt == null) continue;
    const d = new Date(t.openedAt);
    const dow = d.getUTCDay();
    const hour = d.getUTCHours();
    byDow[dow].trades++;
    byDow[dow].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) byDow[dow].wins++;
    byHour[hour].trades++;
    byHour[hour].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) byHour[hour].wins++;
  }
  for (const r of byDow) {
    r.pnl = +r.pnl.toFixed(2);
    r.winRate = r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0;
  }
  for (const r of byHour) {
    r.pnl = +r.pnl.toFixed(2);
    r.winRate = r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0;
  }

  const confirmExit = {};
  for (const t of trades) {
    const k = `${confirmOf(t)}|${t.exitReason || "null"}`;
    if (!confirmExit[k]) confirmExit[k] = { trades: 0, pnl: 0 };
    confirmExit[k].trades++;
    confirmExit[k].pnl += Number(t.pnl) || 0;
  }
  const confirmExitRows = Object.entries(confirmExit)
    .map(([k, v]) => {
      const [confirm, exit] = k.split("|");
      return { confirm, exit, trades: v.trades, pnl: +v.pnl.toFixed(2) };
    })
    .sort((a, b) => a.pnl - b.pnl);

  // Static drop-filter ideas (offline attrition — not full-path)
  const baselinePnl = sumPnl(trades);
  const ideas = [];
  function idea(id, pred, note) {
    const kept = trades.filter(pred);
    const pnl = sumPnl(kept);
    ideas.push({
      id,
      note,
      trades: kept.length,
      dropped: trades.length - kept.length,
      pnl,
      delta: +(pnl - baselinePnl).toFixed(2),
      winRate: winRate(kept),
    });
  }
  idea("drop_qsl_rows", (t) => !((t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss"), "optimistic: remove quick-SL exits");
  idea("drop_fr_ge_0.00035", (t) => Math.abs(Number(t.fundingRate) || 0) < 0.00035, "tighter max funding");
  idea("drop_fr_ge_0.00025", (t) => Math.abs(Number(t.fundingRate) || 0) < 0.00025, "tighter max funding");
  idea("drop_oi_ge_1.5", (t) => Math.abs(Number(t.oiDelta1h) || 0) < 1.5, "tighter dual OI-gates to 1.5");
  idea("drop_oi_ge_1.0", (t) => Math.abs(Number(t.oiDelta1h) || 0) < 1.0, "tighter dual OI-gates to 1.0");
  idea("sfp_only", (t) => confirmOf(t) === "sfp_bear", "kill PB");
  idea("pb_only", (t) => confirmOf(t) === "pullback_bear", "kill SFP");
  idea(
    "drop_stopDist_lt_1.2",
    (t) => {
      const d = stopDistPct(t);
      return d == null || d >= 1.2;
    },
    "avoid narrow stops"
  );
  const worstSyms = new Set(symbols.filter((s) => s.pnl <= -1.0).map((s) => s.symbol));
  idea("drop_worst_syms_pnl_le_-1", (t) => !worstSyms.has(t.symbol), `drop ${worstSyms.size} symbols with PnL≤-1`);
  const highQslSyms = new Set(symbols.filter((s) => s.qsl >= 3).map((s) => s.symbol));
  idea("drop_syms_qsl_ge_3", (t) => !highQslSyms.has(t.symbol), `drop ${highQslSyms.size} symbols with ≥3 quick SL`);
  // UTC hours with negative PnL
  const badHours = new Set(byHour.filter((h) => h.trades >= 15 && h.pnl < 0).map((h) => h.hour));
  idea(
    "drop_bad_utc_hours",
    (t) => t.openedAt == null || !badHours.has(new Date(t.openedAt).getUTCHours()),
    `skip UTC hours with ≥15tr & PnL<0 (${[...badHours].sort((a, b) => a - b).join(",")})`
  );
  ideas.sort((a, b) => b.delta - a.delta);

  const holds = trades.map((t) => t.holdMin).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);

  return {
    core: {
      trades: trades.length,
      pnl: baselinePnl,
      winRate: winRate(trades),
      wins: wins.length,
      losses: losses.length,
      winPnl: sumPnl(wins),
      lossPnl: sumPnl(losses),
      byExit,
      byConfirm,
      earlyExits: trades.filter((t) => /^early_/.test(String(t.exitReason || ""))).length,
      holdMedMin: med(holds),
      holdMedWins: med(wins.map((t) => t.holdMin).filter(Number.isFinite).sort((a, b) => a - b)),
      holdMedLosses: med(losses.map((t) => t.holdMin).filter(Number.isFinite).sort((a, b) => a - b)),
    },
    quickSlLe15m: {
      ...bucket(qsl),
      byConfirm: {
        pullback_bear: bucket(qsl.filter((t) => confirmOf(t) === "pullback_bear")),
        sfp_bear: bucket(qsl.filter((t) => confirmOf(t) === "sfp_bear")),
      },
    },
    holdBins,
    fundingBands: frBands,
    oiBands,
    stopDistanceBands: stopBands,
    confirmExitMatrix: confirmExitRows.slice(0, 20),
    utcDayOfWeek: byDow,
    utcHour: byHour,
    worstSymbols: symbols.slice(0, 15),
    bestSymbols: [...symbols].sort((a, b) => b.pnl - a.pnl).slice(0, 10),
    staticFilterIdeas: ideas,
  };
}

function buildRecommendations(wide, lineage) {
  const recs = [];
  const ideas = wide.staticFilterIdeas || [];
  const top = ideas.filter((i) => !i.id.startsWith("drop_qsl") && i.delta >= 1.0).slice(0, 5);

  recs.push({
    priority: "P0",
    id: "confirm_reproducibility",
    action: "Treat this wide run as BP1.3 confirmation; keep dual OI-gates=2 + EA off.",
    why: `PnL $${wide.core.pnl} vs saved BP1.3 $${lineage.bp13SavedPnl}`,
  });

  const frIdea = ideas.find((i) => i.id === "drop_fr_ge_0.00035" || i.id === "drop_fr_ge_0.00025");
  if (frIdea && frIdea.delta > 0.5) {
    recs.push({
      priority: "P0",
      id: "tighter_funding_cap",
      action: `Full-bot test: ${frIdea.id.replace("drop_fr_ge_", "foiMaxAbsFundingRate < ")}`,
      why: `Static Δ $${frIdea.delta} on ${frIdea.dropped} dropped trades — single-lever, low interaction risk`,
      static: frIdea,
    });
  }

  const oi15 = ideas.find((i) => i.id === "drop_oi_ge_1.5");
  if (oi15 && oi15.delta > 0.5) {
    recs.push({
      priority: "P1",
      id: "tighten_oi_gates_to_1_5",
      action: "Full-bot: foiConfirmSfp/PullbackMaxOiDelta1hAbs 2 → 1.5",
      why: `Static Δ $${oi15.delta}; may over-cut volume — test alone`,
      static: oi15,
    });
  }

  if (wide.quickSlLe15m.pnl < -15) {
    recs.push({
      priority: "P1",
      id: "quick_sl_remain",
      action: "Do not drop-exit; design entry/SL geometry (wider minSmartStop or PB quality features)",
      why: `Quick SL still $${wide.quickSlLe15m.pnl} / ${wide.quickSlLe15m.trades}tr after dual gates`,
    });
  }

  const hourIdea = ideas.find((i) => i.id === "drop_bad_utc_hours");
  if (hourIdea && hourIdea.delta >= 1.5) {
    recs.push({
      priority: "P2",
      id: "utc_hour_filter",
      action: "Optional session filter for negative UTC hours (overfit risk — validate OOS)",
      why: `Static Δ $${hourIdea.delta}`,
      static: hourIdea,
    });
  }

  const symIdea = ideas.find((i) => i.id === "drop_syms_qsl_ge_3");
  if (symIdea && symIdea.delta > 0) {
    recs.push({
      priority: "P2",
      id: "symbol_blacklist",
      action: "Avoid hard blacklist from in-sample; prefer feature-based if repeating",
      why: symIdea.note,
      static: symIdea,
    });
  }

  recs.push({
    priority: "P2",
    id: "oos_or_30d",
    action: "Run same BP1.3 stack on a different window (e.g. prior 10d or 30d) before stacking more filters",
    why: "Stack from 1.0→1.3 is in-sample optimized; need stability check",
  });

  if (top.length) {
    recs.push({
      priority: "info",
      id: "top_static_ideas",
      action: "Candidates ranked by static Δ (full-path required)",
      ideas: top,
    });
  }

  return recs;
}

async function main() {
  const { days } = parseArgs(process.argv);
  const patch = buildPatch();
  const bp13Manifest = readJsonFile(path.join(BP13_DIR(), "manifest.json"), null);

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

  log(`FOI 1m BP1.3 wide eval · ${days}d · ${syms.length} symbols`);
  log(
    `SFP-gate=${patch.foiConfirmSfpMaxOiDelta1hAbs} · PB-gate=${patch.foiConfirmPullbackMaxOiDelta1hAbs} · EA=${patch.earlyAbortEnabled} · globalOI=${patch.foiMaxOiDelta1hAbs}`
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
      runMeta: { eval: "foi-1m-bp13-wide-10d" },
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

  const wide = buildWide(closed);
  const lineage = {
    bp10: 19.15,
    adverse: 24.31,
    bp11: 25.76,
    bp12: 26.58,
    bp13SavedPnl: bp13Manifest?.eval?.pnl ?? 31.77,
  };
  const recommendations = buildRecommendations(wide, lineage);

  const report = {
    ranAt: new Date().toISOString(),
    days,
    interval: INTERVAL,
    symbolCount: syms.length,
    mode: "bp13_wide",
    patch,
    lineage,
    deltaVsSavedBp13: {
      pnl: +(wide.core.pnl - lineage.bp13SavedPnl).toFixed(2),
      trades: wide.core.trades - (bp13Manifest?.eval?.trades ?? 587),
    },
    wide,
    recommendations,
  };

  writeJsonFile(OUT(), report);
  writeJsonFile(TRADES_OUT(), { ranAt: report.ranAt, trades: closed });

  log("\n=== BP1.3 WIDE 10d ===");
  log(`PnL $${wide.core.pnl} · ${wide.core.trades} tr · WR ${wide.core.winRate}%`);
  log(`Wins $${wide.core.winPnl} · Losses $${wide.core.lossPnl}`);
  log(`Quick SL ≤15m: ${wide.quickSlLe15m.trades} tr · $${wide.quickSlLe15m.pnl}`);
  log(`Exits: ${JSON.stringify(wide.core.byExit)}`);
  log(`Confirm: ${JSON.stringify(wide.core.byConfirm)}`);
  log(`Δ vs saved BP1.3: $${report.deltaVsSavedBp13.pnl}`);
  log("\nTop static ideas:");
  for (const i of wide.staticFilterIdeas.slice(0, 6)) {
    log(`  ${i.id}: Δ$${i.delta} · kept ${i.trades} · ${i.note}`);
  }
  log("\nRecommendations:");
  for (const r of recommendations.filter((x) => x.priority !== "info")) {
    log(`  [${r.priority}] ${r.id}: ${r.action}`);
  }
  log(`Saved ${OUT()}`);
  console.log(
    JSON.stringify(
      {
        core: wide.core,
        quickSl: wide.quickSlLe15m,
        deltaVsSavedBp13: report.deltaVsSavedBp13,
        topIdeas: wide.staticFilterIdeas.slice(0, 8),
        recommendations: recommendations.filter((x) => x.priority !== "info"),
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
