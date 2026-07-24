#!/usr/bin/env node
/**
 * Pull Railway live bot + models, run three non-overlapping 10d windows,
 * write a wide comparative report.
 *
 * Windows (end relative to data tip T):
 *   set1  end=T       last 10d
 *   set2  end=T-10d
 *   set3  end=T-20d
 *
 *   RAILWAY_URL=... VOL_SESSION_COOKIE_FILE=scripts/.vol-railway-cookie \
 *     node --max-old-space-size=8192 scripts/run-railway-live-3x10d-wide.js
 *
 *   --skip-pull   use existing .cache/railway-mirror
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
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
const { onnxDir: pbOnnxDir } = require("../lib/pullback-signal-onnx");
const { onnxDir: sfpOnnxDir } = require("../lib/sfp-regime-onnx");
const { isBearSignal } = require("../lib/side-config");
const { createFoiFollowthroughRegimeTracker } = require("../lib/foi-followthrough-regime");

const ROOT = path.join(__dirname, "..");
const MIRROR = path.join(ROOT, ".cache", "railway-mirror");
const INTERVAL = "1m";
const BATCH = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 10;
const ACTIVE_LINEAR_PCT = 1.5;
const OUT = () => dataPath("railway-live-3x10d-wide.json");

const WINDOWS = [
  { id: "set1", label: "Last 10d (tip)", endShiftDays: 0 },
  { id: "set2", label: "Prior 10d (−10d)", endShiftDays: 10 },
  { id: "set3", label: "Prior 10d (−20d)", endShiftDays: 20 },
];

function log(m) {
  console.error(String(m));
}

function parseArgs(argv) {
  let skipPull = false;
  let only = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--skip-pull") skipPull = true;
    else if (argv[i] === "--only" && argv[i + 1]) only = String(argv[++i]).toLowerCase();
  }
  return { skipPull, only };
}

function pullRailway() {
  const baseUrl =
    process.env.RAILWAY_URL ||
    process.env.VOL_RAILWAY_URL ||
    "https://vol-production-d574.up.railway.app";
  log(`Pulling Railway live from ${baseUrl}…`);
  const pull = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "pull-railway-data.js"), "--url", baseUrl],
    { cwd: ROOT, env: process.env, encoding: "utf8" }
  );
  if (pull.stdout) process.stderr.write(pull.stdout);
  if (pull.stderr) process.stderr.write(pull.stderr);
  if (pull.status !== 0) {
    log(`WARN: pull-railway-data exited ${pull.status}`);
  }
  const extra = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "fetch-railway-models-extra.js")],
    {
      cwd: ROOT,
      env: { ...process.env, RAILWAY_URL: baseUrl },
      encoding: "utf8",
    }
  );
  if (extra.stdout) process.stderr.write(extra.stdout);
  if (extra.stderr) process.stderr.write(extra.stderr);
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyOnnxDir(fromScope, toScope, onnxDirFn) {
  const src = onnxDirFn(fromScope);
  const dest = onnxDirFn(toScope);
  if (!fs.existsSync(src)) return { copied: 0 };
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(src)) {
    const p = path.join(src, name);
    if (!fs.statSync(p).isFile()) continue;
    fs.copyFileSync(p, path.join(dest, name));
    copied++;
  }
  return { copied };
}

function installMirrorModels() {
  const installed = [];
  const pairs = [
    ["sfp-regime-model-live.json", modelFileFor("sfp-regime-model", "paper")],
    ["sfp-regime-model-live.json", modelFileFor("sfp-regime-model", "live")],
    ["pullback-signal-model-live.json", modelFileFor("pullback-signal-model", "paper")],
    ["pullback-signal-model-live.json", modelFileFor("pullback-signal-model", "live")],
    ["pullback-regime-model-live.json", modelFileFor("pullback-regime-model", "paper")],
    ["pullback-regime-model-live.json", modelFileFor("pullback-regime-model", "live")],
    [
      "pullback-pattern-break-model-live.json",
      modelFileFor("pullback-pattern-break-model", "paper"),
    ],
    [
      "pullback-pattern-break-model-live.json",
      modelFileFor("pullback-pattern-break-model", "live"),
    ],
    ["ai-exit-levels-live.json", modelFileFor("ai-exit-levels", "paper")],
    ["ai-exit-levels-live.json", modelFileFor("ai-exit-levels", "live")],
    ["early-exit-model-live.json", dataPath("early-exit-sfp.json")],
    ["early-exit-model-live.json", dataPath("early-exit-sfp-live.json")],
  ];
  for (const [srcName, dest] of pairs) {
    if (copyFile(path.join(MIRROR, srcName), dest)) installed.push(srcName);
  }
  copyOnnxDir("live", "paper", pbOnnxDir);
  copyOnnxDir("live", "paper", sfpOnnxDir);
  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }
  return installed;
}

function loadLiveBot() {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {})?.config ?? {};
  // Online sim: warm=block deadlocks (no closes ⇒ never open). Match offline
  // opportunity-set semantics by allowing entries until the rolling window fills.
  return normalizeLiveConfig({
    enabled: true,
    ...raw,
    armed: false,
    drawdownStopEnabled: false,
    foiFollowthroughWarmupPolicy: "allow",
  });
}

function loadSignalConfig() {
  const scanner = readJsonFile(path.join(MIRROR, "scanner-config.json"), {}) ?? {};
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

function bars1m(sym) {
  const signal = readSymbolBars("signal", sym);
  const mover = readSymbolBars("mover", sym);
  if (signal?.length && mover?.length) {
    return signal.length >= mover.length ? signal : mover;
  }
  return signal ?? mover ?? null;
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
  const need = Math.ceil(days * 24 * 60);
  const windowStart = endMs - days * DAY_MS;
  const tail = cut.length > need ? cut.slice(-need) : cut;
  const spanDays = tail.length
    ? +((tail[tail.length - 1].closeTime - tail[0].closeTime) / DAY_MS).toFixed(2)
    : 0;
  return {
    bars: tail,
    coverage: {
      bars: tail.length,
      spanDays,
      startIso: tail[0] ? new Date(tail[0].closeTime).toISOString() : null,
      endIso: tail.length ? new Date(tail[tail.length - 1].closeTime).toISOString() : null,
      windowStartIso: new Date(windowStart).toISOString(),
      enough: spanDays >= days - 0.5 && tail.length >= need * 0.9,
    },
  };
}

function createFetchers(endMs) {
  return {
    async fetchKlinesForSymbol(sym, n) {
      const all = bars1m(String(sym).toUpperCase());
      const sliced = sliceWindow(all, endMs, WINDOW_DAYS);
      if (!sliced?.bars || sliced.bars.length < 200) {
        throw new Error(`no window bars ${sym}`);
      }
      return sliced.bars.length > n ? sliced.bars.slice(-n) : sliced.bars;
    },
    async fetchKlines1mForSymbol() {
      return null;
    },
  };
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
  const byKind = {};
  for (const t of trades) {
    byExit[t.exitReason || "null"] = (byExit[t.exitReason || "null"] || 0) + 1;
    const ck = confirmOf(t);
    if (!byConfirm[ck]) byConfirm[ck] = { trades: 0, pnl: 0, wins: 0 };
    byConfirm[ck].trades++;
    byConfirm[ck].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) byConfirm[ck].wins++;
    const sk = t.signalKind || "null";
    if (!byKind[sk]) byKind[sk] = { trades: 0, pnl: 0, wins: 0 };
    byKind[sk].trades++;
    byKind[sk].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) byKind[sk].wins++;
  }
  for (const map of [byConfirm, byKind]) {
    for (const k of Object.keys(map)) {
      const r = map[k];
      r.pnl = +r.pnl.toFixed(2);
      r.winRate = r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0;
    }
  }

  const qsl = trades.filter(
    (t) => (t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss"
  );
  const tp = trades.filter((t) => t.exitReason === "take_profit");
  const sl = trades.filter((t) => t.exitReason === "stop_loss");

  const holdBins = [
    [0, 15],
    [15, 60],
    [60, 180],
    [180, 360],
    [360, 1e9],
  ].map(([lo, hi]) => {
    const ts = trades.filter(
      (t) => (t.holdMin ?? -1) >= lo && (t.holdMin ?? -1) < hi
    );
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
    [2, 5],
  ].map(([lo, hi]) => {
    const ts = trades.filter((t) => {
      const o = Math.abs(Number(t.oiDelta1h));
      return Number.isFinite(o) && o >= lo && o < hi;
    });
    return { label: `|oi| ${lo}–${hi}`, ...bucket(ts) };
  });

  const bySym = {};
  for (const t of trades) {
    if (!bySym[t.symbol]) bySym[t.symbol] = { trades: 0, pnl: 0, wins: 0, qsl: 0 };
    bySym[t.symbol].trades++;
    bySym[t.symbol].pnl += Number(t.pnl) || 0;
    if ((t.pnl ?? 0) > 0) bySym[t.symbol].wins++;
    if ((t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss") bySym[t.symbol].qsl++;
  }
  const symbolsRanked = Object.entries(bySym)
    .map(([symbol, r]) => ({
      symbol,
      trades: r.trades,
      pnl: +r.pnl.toFixed(2),
      winRate: r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0,
      qsl: r.qsl,
    }))
    .sort((a, b) => a.pnl - b.pnl);

  const byDow = Array.from({ length: 7 }, (_, i) => ({
    dow: i,
    trades: 0,
    pnl: 0,
    wins: 0,
  }));
  const byHour = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    trades: 0,
    pnl: 0,
    wins: 0,
  }));
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
  for (const r of [...byDow, ...byHour]) {
    r.pnl = +r.pnl.toFixed(2);
    r.winRate = r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0;
  }

  const holds = trades
    .map((t) => t.holdMin)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);

  const against = trades.filter((t) => t.move?.againstMove);
  const withM = trades.filter((t) => t.move?.withMove);

  return {
    core: {
      trades: trades.length,
      pnl: sumPnl(trades),
      winRate: winRate(trades),
      wins: wins.length,
      losses: losses.length,
      winPnl: sumPnl(wins),
      lossPnl: sumPnl(losses),
      tpRate: trades.length ? +((100 * tp.length) / trades.length).toFixed(1) : 0,
      slRate: trades.length ? +((100 * sl.length) / trades.length).toFixed(1) : 0,
      byExit,
      byConfirm,
      bySignalKind: byKind,
      holdMedMin: med(holds),
      holdMedWins: med(
        wins
          .map((t) => t.holdMin)
          .filter(Number.isFinite)
          .sort((a, b) => a - b)
      ),
      holdMedLosses: med(
        losses
          .map((t) => t.holdMin)
          .filter(Number.isFinite)
          .sort((a, b) => a - b)
      ),
    },
    quickSlLe15m: bucket(qsl),
    holdBins,
    fundingBands: frBands,
    oiBands,
    moveAlign: {
      against: bucket(against),
      withMove: bucket(withM),
      againstVeryActive: bucket(trades.filter((t) => t.move?.againstVeryActive)),
    },
    byDow,
    byHour,
    worstSymbols: symbolsRanked.slice(0, 15),
    bestSymbols: [...symbolsRanked].reverse().slice(0, 15),
  };
}

function configSnapshot(cfg) {
  return {
    positionSizeUsdt: cfg.positionSizeUsdt,
    addOnMarginUsdt: cfg.addOnMarginUsdt,
    maxOpenPositions: cfg.maxOpenPositions,
    leverage: cfg.leverage,
    tradeFoiSignals: cfg.tradeFoiSignals,
    tradeBearishFoiSignals: cfg.tradeBearishFoiSignals,
    tradeSfpSignals: cfg.tradeSfpSignals,
    tradePullbackSignals: cfg.tradePullbackSignals,
    foiConfirmSfpMaxOiDelta1hAbs: cfg.foiConfirmSfpMaxOiDelta1hAbs ?? null,
    foiConfirmPullbackMaxOiDelta1hAbs: cfg.foiConfirmPullbackMaxOiDelta1hAbs ?? null,
    foiMaxOiDelta1hAbs: cfg.foiMaxOiDelta1hAbs ?? null,
    foiMinAbsFundingRate: cfg.foiMinAbsFundingRate ?? null,
    earlyAbortEnabled: cfg.earlyAbortEnabled,
    foiFollowthroughRegimeEnabled: cfg.foiFollowthroughRegimeEnabled,
    foiFollowthroughMinWinRate: cfg.foiFollowthroughMinWinRate,
    foiFollowthroughLookback: cfg.foiFollowthroughLookback,
    foiFollowthroughWarmupPolicy: cfg.foiFollowthroughWarmupPolicy,
    aiExitLevelsEnabled: cfg.aiExitLevelsEnabled,
    aiSfpRegimeEnabled: cfg.aiSfpRegimeEnabled,
    aiPullbackSignalEnabled: cfg.aiPullbackSignalEnabled,
    aiPullbackRegimeEnabled: cfg.aiPullbackRegimeEnabled,
    aiEarlyExitEnabled: cfg.aiEarlyExitEnabled,
  };
}

async function runWindow({ win, dataEndMs, botConfig, syms, signalCfg, getFundingOiAt }) {
  const endMs = dataEndMs - win.endShiftDays * DAY_MS;
  log(`\n=== ${win.id}: ${win.label} ===`);
  log(`end=${new Date(endMs).toISOString()}`);

  const fetchers = createFetchers(endMs);
  const tracker = createFoiFollowthroughRegimeTracker();
  const closed = [];
  let foiFollowthroughSkips = 0;

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
      modelScope: "live",
      foiFollowthroughTracker: tracker,
      runMeta: { eval: "railway-live-3x10d-wide", window: win.id },
    });
    foiFollowthroughSkips += Number(result.summary?.foiFollowthroughSkips || 0);
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
        entryPrice: t.entryPrice ?? null,
        stopLoss: t.stopLoss ?? null,
        takeProfit: t.takeProfit ?? null,
        fundingRate: t.signalSnapshot?.fundingRate ?? null,
        oiDelta1h: t.signalSnapshot?.oiDelta1h ?? null,
        confirmKind: t.signalSnapshot?.confirmKind ?? null,
        move: classifyAgainst(t),
      });
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
  }

  const wide = buildWide(closed);
  const tradeTimes = closed
    .map((t) => t.openedAt)
    .filter((t) => t != null)
    .sort((a, b) => a - b);
  const tradeSpan = tradeTimes.length
    ? {
        firstOpenIso: new Date(tradeTimes[0]).toISOString(),
        lastOpenIso: new Date(tradeTimes[tradeTimes.length - 1]).toISOString(),
      }
    : null;

  const tradesOut = dataPath(`railway-live-${win.id}-10d-trades.json`);
  writeJsonFile(tradesOut, {
    ranAt: new Date().toISOString(),
    window: win.id,
    endMs,
    trades: closed,
  });

  log(
    `  [${win.id}] PnL $${wide.core.pnl} · ${wide.core.trades} tr · WR ${wide.core.winRate}% · TP ${wide.core.tpRate}% · qSL $${wide.quickSlLe15m.pnl}` +
      (tradeSpan
        ? ` · opens ${tradeSpan.firstOpenIso.slice(0, 10)}→${tradeSpan.lastOpenIso.slice(0, 10)}`
        : "")
  );

  return {
    ...win,
    endMs,
    endIso: new Date(endMs).toISOString(),
    tradeSpan,
    foiFollowthroughSkips,
    wide,
    tradesOut,
    summary: wide.core,
  };
}

async function main() {
  const { skipPull, only } = parseArgs(process.argv);
  if (!skipPull) pullRailway();

  const mirrorMeta = readJsonFile(path.join(MIRROR, "pull-meta.json"), {});
  const installed = installMirrorModels();
  const botConfig = loadLiveBot();
  const signalCfg = loadSignalConfig();
  const syms = symbols();
  const { dataEndMs, dataStartMs, checked } = discoverDataEnd(syms);
  const spanDays = +((dataEndMs - dataStartMs) / DAY_MS).toFixed(2);
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);

  log(
    `Railway live 3×10d wide · ${syms.length} symbols · data ~${spanDays}d (sample ${checked})`
  );
  log(`Config: ${JSON.stringify(configSnapshot(botConfig))}`);
  log(`Models installed from mirror: ${installed.length}`);

  let wins = WINDOWS;
  if (only) {
    wins = WINDOWS.filter((w) => w.id === only);
    if (!wins.length) throw new Error(`unknown --only ${only}`);
  }

  const runs = [];
  for (const win of wins) {
    runs.push(
      await runWindow({
        win,
        dataEndMs,
        botConfig,
        syms,
        signalCfg,
        getFundingOiAt,
      })
    );
  }

  const pnls = runs.map((r) => r.summary.pnl);
  const positive = pnls.filter((p) => p > 0).length;
  const sum = +pnls.reduce((a, b) => a + b, 0).toFixed(2);
  const mean = pnls.length ? +(sum / pnls.length).toFixed(2) : null;

  const report = {
    ranAt: new Date().toISOString(),
    source: "railway-live",
    mirror: {
      pulledAt: mirrorMeta.pulledAt ?? null,
      baseUrl: mirrorMeta.baseUrl ?? null,
      modelsInstalled: installed,
    },
    windowDays: WINDOW_DAYS,
    symbolCount: syms.length,
    dataStartIso: new Date(dataStartMs).toISOString(),
    dataEndIso: new Date(dataEndMs).toISOString(),
    dataSpanDays: spanDays,
    liveConfigSnapshot: configSnapshot(botConfig),
    aggregate: {
      sum,
      mean,
      positive,
      total: runs.length,
      min: pnls.length ? Math.min(...pnls) : null,
      max: pnls.length ? Math.max(...pnls) : null,
    },
    runs: runs.map((r) => ({
      id: r.id,
      label: r.label,
      endShiftDays: r.endShiftDays,
      endIso: r.endIso,
      tradeSpan: r.tradeSpan,
      foiFollowthroughSkips: r.foiFollowthroughSkips,
      summary: r.summary,
      wide: r.wide,
      tradesOut: r.tradesOut,
    })),
  };

  writeJsonFile(OUT(), report);

  log("\n=== RAILWAY LIVE 3×10d ===");
  for (const r of runs) {
    log(
      `${r.id}: $${r.summary.pnl} · ${r.summary.trades} tr · WR ${r.summary.winRate}% · TP ${r.summary.tpRate}% · SL ${r.summary.slRate}%`
    );
  }
  log(
    `Aggregate: sum $${sum} · mean $${mean} · positive ${positive}/${runs.length}`
  );
  log(`Saved ${OUT()}`);
  console.log(
    JSON.stringify(
      {
        aggregate: report.aggregate,
        liveConfigSnapshot: report.liveConfigSnapshot,
        runs: report.runs.map((r) => ({
          id: r.id,
          label: r.label,
          endIso: r.endIso,
          pnl: r.summary.pnl,
          trades: r.summary.trades,
          wr: r.summary.winRate,
          tp: r.summary.tpRate,
          sl: r.summary.slRate,
          qsl: r.wide.quickSlLe15m,
          byConfirm: r.summary.byConfirm,
          holdBins: r.wide.holdBins,
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
