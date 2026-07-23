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
const OUT = () => dataPath("foi-1m-bp-oos-compare-10d.json");
const BP_DIR = (v) => path.join(dataPath(), "breakpoints", String(v));

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
  let skipIs = true;
  let bps = ["1.1", "1.2"];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--only" && argv[i + 1]) only = String(argv[++i]).toLowerCase();
    else if (argv[i] === "--skip-is") skipIs = true;
    else if (argv[i] === "--with-is") skipIs = false;
    else if (argv[i] === "--bps" && argv[i + 1]) {
      bps = String(argv[++i])
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return { only, skipIs, bps };
}

function buildPatch(bpVersion) {
  const bp = readJsonFile(path.join(BP_DIR(bpVersion), "patch.json"), null);
  if (!bp) throw new Error(`missing breakpoints/${bpVersion}/patch.json`);
  return { ...bp };
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

async function runWindow({ win, dataEndMs, patch, bpVersion, syms, signalCfg, getFundingOiAt }) {
  const endMs = dataEndMs - win.endShiftDays * DAY_MS;
  const cov = sampleCoverage(syms, endMs);
  log(`\n=== BP${bpVersion} · ${win.id}: ${win.label} ===`);
  log(
    `end=${new Date(endMs).toISOString()} · coverage sample ok=${cov.ok} weak=${cov.weak}`
  );
  if (cov.ok < 10) {
    log(`SKIP ${win.id}: insufficient history (need extend-backtest-klines --to-days 45)`);
    return {
      bpVersion,
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
    log(`  [BP${bpVersion}/${win.id}] batch ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
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
      runMeta: { eval: "foi-1m-bp-oos-compare-10d", bp: bpVersion, window: win.id },
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
  const tradesOut = dataPath(`foi-1m-bp${bpVersion}-${win.id}-10d-trades.json`);
  writeJsonFile(tradesOut, {
    ranAt: new Date().toISOString(),
    window: win.id,
    endMs,
    tradeSpan,
    trades: closed,
  });
  log(
    `  [BP${bpVersion}/${win.id}] PnL $${summary.pnl} · ${summary.trades} tr · WR ${summary.winRate}% · qSL $${summary.quickSlLe15m.pnl}` +
      (tradeSpan ? ` · opens ${tradeSpan.firstOpenIso.slice(0, 10)}→${tradeSpan.lastOpenIso.slice(0, 10)}` : "")
  );
  return {
    bpVersion,
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
  const { only, skipIs, bps } = parseArgs(process.argv);

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
  const bp14 = readJsonFile(dataPath("foi-1m-bp14-oos-windows-10d.json"), null);

  log(`FOI BP OOS compare · bps=${bps.join(",")} · ${syms.length} symbols`);
  log(
    `data ${new Date(dataStartMs).toISOString()} → ${new Date(dataEndMs).toISOString()} (~${spanDays}d, sample ${checked})`
  );

  let wins = WINDOWS.filter((w) => !(skipIs && w.isReference));
  if (only) {
    wins = WINDOWS.filter((w) => w.id === only);
    if (!wins.length) throw new Error(`unknown --only ${only}`);
  }

  const byBp = {};
  for (const bpVersion of bps) {
    const patch = buildPatch(bpVersion);
    log(
      `\n######## BP ${bpVersion} · SFP-gate=${patch.foiConfirmSfpMaxOiDelta1hAbs ?? "—"} · PB-gate=${patch.foiConfirmPullbackMaxOiDelta1hAbs ?? "—"} · EA=${patch.earlyAbortEnabled} ########`
    );
    const runs = [];
    for (const win of wins) {
      runs.push(
        await runWindow({
          win,
          dataEndMs,
          patch,
          bpVersion,
          syms,
          signalCfg,
          getFundingOiAt,
        })
      );
    }
    const oos = runs.filter((r) => !r.skipped && r.summary);
    const pnls = oos.map((r) => r.summary.pnl);
    const mean = pnls.length
      ? +(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2)
      : null;
    const positive = pnls.filter((p) => p > 0).length;
    const verdict = verdictFrom(runs, bp14?.savedIsPnl ?? 31.77);
    byBp[bpVersion] = {
      patch,
      runs: runs.map((r) => ({
        id: r.id,
        label: r.label,
        endShiftDays: r.endShiftDays,
        endIso: r.endIso,
        skipped: r.skipped,
        reason: r.reason ?? null,
        summary: r.summary,
        tradeSpan: r.tradeSpan,
        tradesOut: r.tradesOut ?? null,
      })),
      meanOos: mean,
      positive,
      oosCount: oos.length,
      verdict,
    };
  }

  // Include BP1.4 reference summary if present
  const bp14Summary = bp14
    ? {
        meanOos: bp14.verdict?.mean ?? null,
        positive: bp14.verdict?.positive ?? null,
        oosCount: bp14.verdict?.oosCount ?? null,
        verdict: bp14.verdict,
        runs: (bp14.runs || []).map((r) => ({
          id: r.id,
          pnl: r.summary?.pnl ?? null,
          trades: r.summary?.trades ?? null,
          winRate: r.summary?.winRate ?? null,
          quickSl: r.summary?.quickSlLe15m ?? null,
        })),
      }
    : null;

  const ranking = [
    ...Object.entries(byBp).map(([v, x]) => ({
      bp: v,
      meanOos: x.meanOos,
      positive: x.positive,
      status: x.verdict.status,
    })),
    bp14Summary
      ? {
          bp: "1.4",
          meanOos: bp14Summary.meanOos,
          positive: bp14Summary.positive,
          status: bp14Summary.verdict?.status,
        }
      : null,
  ]
    .filter(Boolean)
    .sort((a, b) => (b.meanOos ?? -1e9) - (a.meanOos ?? -1e9));

  const report = {
    ranAt: new Date().toISOString(),
    interval: INTERVAL,
    windowDays: WINDOW_DAYS,
    symbolCount: syms.length,
    dataStartIso: new Date(dataStartMs).toISOString(),
    dataEndIso: new Date(dataEndMs).toISOString(),
    dataSpanDays: spanDays,
    bps,
    byBp,
    bp14Reference: bp14Summary,
    ranking,
    recommendation: ranking[0]
      ? {
          prefer: ranking[0].bp,
          why: `Highest OOS mean among compared stacks ($${ranking[0].meanOos}, ${ranking[0].positive}/${ranking[0].bp === "1.4" ? bp14Summary?.oosCount : byBp[ranking[0].bp]?.oosCount} positive)`,
        }
      : null,
  };

  writeJsonFile(OUT(), report);

  log("\n=== BP OOS COMPARE ===");
  for (const row of ranking) {
    log(
      `BP${row.bp}: mean $${row.meanOos} · positive ${row.positive} · status ${row.status}`
    );
  }
  for (const [v, block] of Object.entries(byBp)) {
    log(`\n-- BP${v} windows --`);
    for (const r of block.runs) {
      if (r.skipped) {
        log(`  ${r.id}: SKIP`);
        continue;
      }
      log(
        `  ${r.id}: $${r.summary.pnl} · ${r.summary.trades} tr · WR ${r.summary.winRate}% · qSL $${r.summary.quickSlLe15m.pnl}`
      );
    }
  }
  log(`\nPrefer: BP${report.recommendation?.prefer} — ${report.recommendation?.why}`);
  log(`Saved ${OUT()}`);
  console.log(
    JSON.stringify(
      {
        ranking: report.ranking,
        recommendation: report.recommendation,
        byBp: Object.fromEntries(
          Object.entries(byBp).map(([v, b]) => [
            v,
            {
              meanOos: b.meanOos,
              positive: b.positive,
              verdict: b.verdict.status,
              runs: b.runs.map((r) => ({
                id: r.id,
                pnl: r.summary?.pnl,
                trades: r.summary?.trades,
                wr: r.summary?.winRate,
              })),
            },
          ])
        ),
        bp14Reference: bp14Summary,
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
