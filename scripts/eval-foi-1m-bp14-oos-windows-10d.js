#!/usr/bin/env node
/**
 * P0 OOS: BP1.4 stack on three 10d windows immediately before the in-sample
 * (last-10d) period, each shifted 10d earlier than the previous.
 *
 *   IS  (reference): end=T,     window [T-10d, T]
 *   OOS1:            end=T-10d, window [T-20d, T-10d]
 *   OOS2:            end=T-20d, window [T-30d, T-20d]
 *   OOS3:            end=T-30d, window [T-40d, T-30d]
 *
 * Requires ~40d+ of 1m cache (extend-backtest-klines --to-days 45).
 *
 *   node scripts/eval-foi-1m-bp14-oos-windows-10d.js
 *   node scripts/eval-foi-1m-bp14-oos-windows-10d.js --only oos1
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
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 10;
const ACTIVE_LINEAR_PCT = 1.5;
const OUT = () => dataPath("foi-1m-bp14-oos-windows-10d.json");
const BP14_DIR = () => path.join(dataPath(), "breakpoints", "1.4");

/** Shift of window end relative to data tip T. IS=0, OOS1=10, … */
const WINDOWS = [
  {
    id: "is_ref",
    label: "IS reference (last 10d)",
    endShiftDays: 0,
    isReference: true,
  },
  {
    id: "oos1",
    label: "OOS1: 10d before IS",
    endShiftDays: 10,
    isReference: false,
  },
  {
    id: "oos2",
    label: "OOS2: 20d before IS tip (10d before OOS1)",
    endShiftDays: 20,
    isReference: false,
  },
  {
    id: "oos3",
    label: "OOS3: 30d before IS tip (10d before OOS2)",
    endShiftDays: 30,
    isReference: false,
  },
];

function log(m) {
  console.error(String(m));
}

function parseArgs(argv) {
  let only = null;
  // Default: only the 3 OOS windows (IS already measured at BP1.4).
  let skipIs = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) only = String(argv[++i]).toLowerCase();
    else if (argv[i] === "--skip-is") skipIs = true;
    else if (argv[i] === "--with-is") skipIs = false;
  }
  return { only, skipIs };
}

function buildPatch() {
  const bp = readJsonFile(path.join(BP14_DIR(), "patch.json"), null);
  const wide = readJsonFile(path.join(BP14_DIR(), "foi-1m-bp13-wide-10d.json"), null);
  return {
    ...(wide?.patch ?? {}),
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
  const signal = readSymbolBars("signal", sym);
  const mover = readSymbolBars("mover", sym);
  // Prefer the longer series — stale mover files can be shorter than extended signal.
  if (signal?.length && mover?.length) {
    return signal.length >= mover.length ? signal : mover;
  }
  return signal ?? mover ?? null;
}

function discoverDataEnd(syms) {
  let maxEnd = 0;
  let minStart = Infinity;
  let checked = 0;
  for (const s of syms.slice(0, 40)) {
    const bars = bars1m(s);
    if (!bars?.length) continue;
    checked++;
    maxEnd = Math.max(maxEnd, bars[bars.length - 1].closeTime);
    minStart = Math.min(minStart, bars[0].closeTime);
  }
  return { dataEndMs: maxEnd, dataStartMs: minStart, checked };
}

function sliceWindow(bars, endMs, days) {
  if (!bars?.length) return null;
  const cut = bars.filter((b) => b.closeTime <= endMs);
  if (!cut.length) return null;
  const need = Math.ceil(days * 24 * 60); // 1m bars
  const windowStart = endMs - days * DAY_MS;
  // Prefer last `need` bars at or before endMs (matches IS eval shape).
  const tail = cut.length > need ? cut.slice(-need) : cut;
  const spanDays = tail.length
    ? +((tail[tail.length - 1].closeTime - tail[0].closeTime) / DAY_MS).toFixed(2)
    : 0;
  const coverage = {
    bars: tail.length,
    spanDays,
    startIso: tail[0] ? new Date(tail[0].closeTime).toISOString() : null,
    endIso: tail.length
      ? new Date(tail[tail.length - 1].closeTime).toISOString()
      : null,
    requestedEndIso: new Date(endMs).toISOString(),
    windowStartIso: new Date(windowStart).toISOString(),
    enough: spanDays >= days - 0.5 && tail.length >= need * 0.9,
  };
  return { bars: tail, coverage };
}

function createFetchers(endMs) {
  return {
    async fetchKlinesForSymbol(sym, n) {
      const all = bars1m(String(sym).toUpperCase());
      const sliced = sliceWindow(all, endMs, WINDOW_DAYS);
      if (!sliced?.bars || sliced.bars.length < 200) {
        throw new Error(`no window bars ${sym}`);
      }
      // Honor requested n if larger (warmup) — but we only have window length.
      const out =
        sliced.bars.length > n ? sliced.bars.slice(-n) : sliced.bars;
      return out;
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

function summarize(trades) {
  const pnl = +trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2);
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl ?? 0) <= 0);
  const byExit = {};
  const byConfirm = {};
  for (const t of trades) {
    byExit[t.exitReason || "null"] = (byExit[t.exitReason || "null"] || 0) + 1;
    const ck = t.confirmKind || t.signalSnapshot?.confirmKind || "null";
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
  const qsl = trades.filter(
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
    byConfirm,
    earlyExits: trades.filter((t) => /^early_/.test(String(t.exitReason || ""))).length,
    quickSlLe15m: {
      trades: qsl.length,
      pnl: +qsl.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    },
  };
}

function sampleCoverage(syms, endMs) {
  let ok = 0;
  let weak = 0;
  const samples = [];
  for (const s of syms.slice(0, 25)) {
    const all = bars1m(s);
    const sliced = sliceWindow(all, endMs, WINDOW_DAYS);
    if (!sliced) {
      weak++;
      continue;
    }
    if (sliced.coverage.enough) ok++;
    else weak++;
    if (samples.length < 3) samples.push({ symbol: s, ...sliced.coverage });
  }
  return { ok, weak, samples };
}

async function runWindow({ win, dataEndMs, patch, syms, signalCfg, getFundingOiAt }) {
  const endMs = dataEndMs - win.endShiftDays * DAY_MS;
  const cov = sampleCoverage(syms, endMs);
  log(`\n=== ${win.id}: ${win.label} ===`);
  log(
    `end=${new Date(endMs).toISOString()} · coverage sample ok=${cov.ok} weak=${cov.weak}`
  );
  if (cov.ok < 10) {
    log(`SKIP ${win.id}: insufficient history (need extend-backtest-klines --to-days 45)`);
    return {
      ...win,
      endMs,
      endIso: new Date(endMs).toISOString(),
      skipped: true,
      reason: "insufficient_history",
      coverage: cov,
      summary: null,
    };
  }

  const fetchers = createFetchers(endMs);
  const botConfig = loadBot(patch);
  const closed = [];
  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    log(`  [${win.id}] batch ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
    const { result } = await runPaperBotBacktest({
      symbols: batch,
      signalCfg,
      botConfig,
      days: WINDOW_DAYS,
      fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
      fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
      getFundingOiAt,
      restGapMs: 0,
      saveLastResult: false,
      saveKlineCache: false,
      forceKlineFetch: true,
      modelScope: "paper",
      runMeta: { eval: "foi-1m-bp14-oos-windows-10d", window: win.id },
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
        fundingRate: t.signalSnapshot?.fundingRate ?? null,
        oiDelta1h: t.signalSnapshot?.oiDelta1h ?? null,
        confirmKind: t.signalSnapshot?.confirmKind ?? null,
        move: classifyAgainst(t),
      });
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
  }

  const summary = summarize(closed);
  const tradeTimes = closed
    .map((t) => t.openedAt)
    .filter((t) => t != null)
    .sort((a, b) => a - b);
  const tradeSpan = tradeTimes.length
    ? {
        firstOpenIso: new Date(tradeTimes[0]).toISOString(),
        lastOpenIso: new Date(tradeTimes[tradeTimes.length - 1]).toISOString(),
        withinWindow:
          tradeTimes[0] >= endMs - WINDOW_DAYS * DAY_MS - DAY_MS &&
          tradeTimes[tradeTimes.length - 1] <= endMs + DAY_MS,
      }
    : null;
  if (tradeSpan && !tradeSpan.withinWindow) {
    log(
      `  WARN [${win.id}] trades outside expected window: ${tradeSpan.firstOpenIso} … ${tradeSpan.lastOpenIso}`
    );
  }
  const tradesOut = dataPath(`foi-1m-bp14-${win.id}-10d-trades.json`);
  writeJsonFile(tradesOut, {
    ranAt: new Date().toISOString(),
    window: win.id,
    endMs,
    tradeSpan,
    trades: closed,
  });
  log(
    `  [${win.id}] PnL $${summary.pnl} · ${summary.trades} tr · WR ${summary.winRate}% · qSL $${summary.quickSlLe15m.pnl}` +
      (tradeSpan ? ` · opens ${tradeSpan.firstOpenIso.slice(0, 10)}→${tradeSpan.lastOpenIso.slice(0, 10)}` : "")
  );
  return {
    ...win,
    endMs,
    endIso: new Date(endMs).toISOString(),
    skipped: false,
    coverage: cov,
    summary,
    tradeSpan,
    tradesOut,
  };
}

function verdictFrom(runs, isPnl) {
  const oos = runs.filter((r) => !r.isReference && !r.skipped && r.summary);
  if (!oos.length) return { status: "insufficient_data", note: "No OOS windows completed" };
  const pnls = oos.map((r) => r.summary.pnl);
  const positive = pnls.filter((p) => p > 0).length;
  const mean = +(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2);
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  let status = "mixed";
  let note = "";
  if (positive === oos.length && mean >= isPnl * 0.35) {
    status = "pass";
    note = "All OOS windows positive; mean retains meaningful fraction of IS";
  } else if (positive === oos.length && mean > 0) {
    status = "weak_pass";
    note = "All OOS positive but much weaker than IS — edge exists, IS inflated";
  } else if (positive >= Math.ceil(oos.length * 0.66) && mean > 0) {
    status = "mixed";
    note = "Majority OOS positive; regime sensitivity";
  } else if (mean <= 0 || positive === 0) {
    status = "fail";
    note = "OOS not supportive — do not stack more in-sample levers";
  } else {
    status = "mixed";
    note = "Inconsistent OOS — proceed only with caution";
  }
  return { status, note, oosCount: oos.length, positive, mean, min, max, isPnl };
}

async function main() {
  const { only, skipIs } = parseArgs(process.argv);
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

  const signalCfg = loadSignalConfig();
  const syms = symbols();
  const { dataEndMs, dataStartMs, checked } = discoverDataEnd(syms);
  const spanDays = +((dataEndMs - dataStartMs) / DAY_MS).toFixed(2);
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);

  log(`FOI BP1.4 OOS windows · ${syms.length} symbols`);
  log(
    `data ${new Date(dataStartMs).toISOString()} → ${new Date(dataEndMs).toISOString()} (~${spanDays}d, sample ${checked})`
  );
  log(
    `SFP-gate=${patch.foiConfirmSfpMaxOiDelta1hAbs} · PB-gate=${patch.foiConfirmPullbackMaxOiDelta1hAbs} · EA=${patch.earlyAbortEnabled}`
  );

  if (spanDays < 39) {
    log(
      `WARN: span ${spanDays}d < 40d needed for 3 full OOS windows before IS. Extend cache: node scripts/extend-backtest-klines.js --to-days 45`
    );
  }

  let wins = WINDOWS.filter((w) => !(skipIs && w.isReference));
  if (only) {
    wins = WINDOWS.filter((w) => w.id === only);
    if (!wins.length) throw new Error(`unknown --only ${only}`);
  }

  const runs = [];
  for (const win of wins) {
    runs.push(
      await runWindow({ win, dataEndMs, patch, syms, signalCfg, getFundingOiAt })
    );
  }

  const isRun = runs.find((r) => r.id === "is_ref" && r.summary) ?? null;
  const savedIs = readJsonFile(path.join(BP14_DIR(), "manifest.json"), null)?.eval?.pnl ?? 31.77;
  const isPnl = isRun?.summary?.pnl ?? savedIs;
  const verdict = verdictFrom(runs, isPnl);

  const report = {
    ranAt: new Date().toISOString(),
    interval: INTERVAL,
    windowDays: WINDOW_DAYS,
    symbolCount: syms.length,
    dataStartIso: new Date(dataStartMs).toISOString(),
    dataEndIso: new Date(dataEndMs).toISOString(),
    dataSpanDays: spanDays,
    patch,
    savedIsPnl: savedIs,
    runs: runs.map((r) => ({
      id: r.id,
      label: r.label,
      endShiftDays: r.endShiftDays,
      endIso: r.endIso,
      isReference: r.isReference,
      skipped: r.skipped,
      reason: r.reason ?? null,
      coverage: r.coverage,
      summary: r.summary,
      deltaVsIs: r.summary
        ? {
            pnl: +(r.summary.pnl - isPnl).toFixed(2),
            trades: r.summary.trades - (isRun?.summary?.trades ?? 0),
            winRate: +((r.summary.winRate ?? 0) - (isRun?.summary?.winRate ?? 0)).toFixed(1),
          }
        : null,
      tradesOut: r.tradesOut ?? null,
    })),
    verdict,
    recommendations: [
      verdict.status === "pass" || verdict.status === "weak_pass"
        ? {
            priority: "P1",
            action: "Proceed to PB-SL geometry / trail lever (single change)",
            why: verdict.note,
          }
        : {
            priority: "P0",
            action: "Do not stack new in-sample filters; simplify or investigate regime",
            why: verdict.note,
          },
      {
        priority: "info",
        action: "Keep BP1.4 as production freeze until OOS interpretation is accepted",
      },
    ],
  };

  writeJsonFile(OUT(), report);

  log("\n=== OOS COMPARISON ===");
  for (const r of report.runs) {
    if (r.skipped) {
      log(`${r.id}: SKIPPED (${r.reason})`);
      continue;
    }
    const d = r.deltaVsIs;
    log(
      `${r.id}: $${r.summary.pnl} · ${r.summary.trades} tr · WR ${r.summary.winRate}% · qSL $${r.summary.quickSlLe15m.pnl}` +
        (d ? ` · ΔIS ${d.pnl >= 0 ? "+" : ""}$${d.pnl}` : "")
    );
  }
  log(`\nVERDICT: ${verdict.status} — ${verdict.note}`);
  log(`mean OOS $${verdict.mean} · min $${verdict.min} · max $${verdict.max} · IS $${isPnl}`);
  log(`Saved ${OUT()}`);
  console.log(
    JSON.stringify(
      {
        verdict: report.verdict,
        runs: report.runs.map((r) => ({
          id: r.id,
          skipped: r.skipped,
          pnl: r.summary?.pnl ?? null,
          trades: r.summary?.trades ?? null,
          winRate: r.summary?.winRate ?? null,
          quickSl: r.summary?.quickSlLe15m ?? null,
          deltaVsIs: r.deltaVsIs,
          endIso: r.endIso,
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
