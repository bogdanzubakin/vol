#!/usr/bin/env node
/**
 * 50d FOI + VWAP120 trail test as 5 non-overlapping 10d portions.
 *
 * Per window: live baseline (trail OFF) + path counterfactual trail (arm 0.3%).
 * Optional --live-trail also runs full trail-ON sim per window.
 *
 * Windows (end relative to data tip T):
 *   w1  end=T        most recent 10d
 *   w2  end=T-10d
 *   w3  end=T-20d
 *   w4  end=T-30d
 *   w5  end=T-40d
 *
 *   node --max-old-space-size=8192 --expose-gc scripts/run-foi-vwap-trail-50d.js --skip-pull --skip-extend
 *   node --max-old-space-size=8192 --expose-gc scripts/run-foi-vwap-trail-50d.js --skip-pull --skip-extend --only w3
 *   node --max-old-space-size=8192 --expose-gc scripts/run-foi-vwap-trail-50d.js --skip-pull --skip-extend --live-trail
 *
 * Memory/causality fixes: warmup bars before each 10d window, CF passthrough,
 * cold-day applied offline in calendar order (not batched symbol order),
 * single-symbol-pass trackers per window (no cross-batch regime skew).
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
const {
  readBest1mBars,
  clearBarsMemoryCache,
  extendBacktestKlineCache,
  loadManifest,
} = require("../lib/backtest-kline-cache");
const { createOlderKlineFetcher } = require("../lib/binance-rest-fetch");
const { createRestQueue } = require("../lib/rest-queue");
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
const { createFoiFollowthroughRegimeTracker } = require("../lib/foi-followthrough-regime");
const {
  createFoiColdDayTracker,
  normalizeFoiColdDayConfig,
} = require("../lib/foi-cold-day-regime");
const {
  FOI_VWAP_TRAIL_DEFAULTS,
  simulateFoiVwapTrailOnPath,
  normalizeFoiVwapTrailConfig,
} = require("../lib/foi-vwap-trail");

const ROOT = path.join(__dirname, "..");
const MIRROR = path.join(ROOT, ".cache", "railway-mirror");
const INTERVAL = "1m";
const BATCH = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 10;
const WARMUP_BARS = 400; // VWAP120 + lookalike headroom before window
const OUT = () => dataPath("foi-vwap-trail-50d-report.json");

const WINDOWS = [
  { id: "w1", label: "Last 10d (tip)", endShiftDays: 0 },
  { id: "w2", label: "10–20d ago", endShiftDays: 10 },
  { id: "w3", label: "20–30d ago", endShiftDays: 20 },
  { id: "w4", label: "30–40d ago", endShiftDays: 30 },
  { id: "w5", label: "40–50d ago", endShiftDays: 40 },
];

const FEATURE_PATCH = {
  aiExitLevelsSlClampMin: 1.2,
  minSmartStopDistancePct: 1.2,
  minSmartStopDistancePctBear: 1.2,
  foiSkipExtremeCrowdingAnd: true,
  foiExtremeFundingAbs: 0.00025,
  foiExtremeOiDelta1hAbs: 0.8,
  moveStopEnabled: false,
  foiHotProtectLongHoldsEnabled: true,
  foiHotMinWinRate: 0.38,
  foiHotTpScale: 1.25,
  foiBtcLookalikeEnabled: true,
  foiBtcLookalikeHours: 4,
  foiBtcLookalikeBarMin: 5,
  foiBtcLookalikeMinPathCosine: 0.95,
  foiBtcLookalikeFailClosed: true,
  foiColdDayEnabled: true,
  foiColdDayLookbackDays: 3,
  foiColdDayMaxWinRate: 0.28,
  foiColdDayMaxDayPnl: 0,
  foiColdDayMinTrades: 8,
  foiColdDayPolicy: "half",
};

function log(m) {
  process.stderr.write(String(m) + "\n");
}

function parseArgs(argv) {
  let skipPull = false;
  let skipExtend = false;
  let only = null; // null = all windows, or w1..w5
  let liveTrail = false;
  let portions = null; // e.g. 3 → first 3 windows
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--skip-pull") skipPull = true;
    else if (argv[i] === "--skip-extend") skipExtend = true;
    else if (argv[i] === "--live-trail") liveTrail = true;
    else if (argv[i] === "--only" && argv[i + 1]) {
      only = String(argv[++i]).toLowerCase();
    } else if (
      (argv[i] === "--portions" || argv[i] === "--windows") &&
      argv[i + 1]
    ) {
      portions = Math.max(1, Math.min(5, Math.round(Number(argv[++i]) || 3)));
    }
  }
  return { skipPull, skipExtend, only, liveTrail, portions };
}

function pullRailway() {
  const baseUrl =
    process.env.RAILWAY_URL ||
    process.env.VOL_RAILWAY_URL ||
    "https://vol-production-d574.up.railway.app";
  log(`Pulling Railway live from ${baseUrl}…`);
  spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "pull-railway-data.js"), "--url", baseUrl],
    { cwd: ROOT, env: process.env, encoding: "utf8", stdio: "inherit" }
  );
  spawnSync(process.execPath, [path.join(ROOT, "scripts", "fetch-railway-models-extra.js")], {
    cwd: ROOT,
    env: { ...process.env, RAILWAY_URL: baseUrl },
    encoding: "utf8",
    stdio: "inherit",
  });
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
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const p = path.join(src, name);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dest, name));
  }
}

function installMirrorModels() {
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
  let n = 0;
  for (const [src, dest] of pairs) {
    if (copyFile(path.join(MIRROR, src), dest)) n++;
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
  return n;
}

function loadBotConfig(trailEnabled) {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {})?.config ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...raw,
    ...FEATURE_PATCH,
    ...FOI_VWAP_TRAIL_DEFAULTS,
    foiVwapTrailEnabled: Boolean(trailEnabled),
    foiVwapTrailOnlyFoi: true,
    foiVwapTrailArmPct: 0.3,
    foiVwapTrailBars: 120,
    // Cold-day applied offline in calendar order after sim (avoids batch symbol-order bias).
    foiColdDayEnabled: false,
    armed: false,
    drawdownStopEnabled: false,
    foiFollowthroughWarmupPolicy: "allow",
  });
}

function loadSignalConfig() {
  const scanner = readJsonFile(path.join(MIRROR, "scanner-config.json"), {}) ?? {};
  const detection = readJsonFile(dataPath("bear-detection-best-10d.json"), null);
  const cfg = { interval: INTERVAL, ...scanner, ...(detection?.patch ?? {}), interval: INTERVAL };
  applyBarConfig(cfg);
  return cfg;
}

function foiSymbols() {
  const prior =
    readJsonFile(dataPath("railway-live-30d-ab-pathcosine-trades.json"), null) ||
    readJsonFile(dataPath("railway-live-30d-trades.json"), null);
  const set = new Set((prior?.trades ?? []).map((t) => t.symbol).filter(Boolean));
  set.add("BTCUSDT");
  const root = path.join(dataPath(), "backtest-klines", "signal");
  const all = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""));
  const candidates = set.size >= 50 ? all.filter((s) => set.has(s)) : all;
  const out = [];
  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    const n = readBest1mBars(s)?.length ?? 0;
    if (n >= 200) out.push(s);
    // Drop full series from memory cache — do not retain 161×50d bars.
    if ((i + 1) % 5 === 0) clearBarsMemoryCache();
  }
  clearBarsMemoryCache();
  return out.sort();
}

function discoverDataEnd(syms) {
  let maxEnd = 0;
  let minStart = Infinity;
  for (let i = 0; i < Math.min(40, syms.length); i++) {
    const bars = readBest1mBars(syms[i]);
    if (!bars?.length) continue;
    maxEnd = Math.max(maxEnd, bars[bars.length - 1].closeTime);
    minStart = Math.min(minStart, bars[0].closeTime);
    clearBarsMemoryCache();
  }
  return { dataEndMs: maxEnd, dataStartMs: minStart };
}

function sliceWindow(bars, endMs, days, warmupBars = WARMUP_BARS) {
  if (!bars?.length) return null;
  // Binary search end — avoid copying the entire series via filter().
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeTime <= endMs) lo = mid + 1;
    else hi = mid;
  }
  const iEnd = lo - 1;
  if (iEnd < 0) return null;
  const need = Math.ceil(days * 24 * 60) + Math.max(0, warmupBars | 0);
  const iStart = Math.max(0, iEnd - need + 1);
  return bars.slice(iStart, iEnd + 1);
}

function createFetchers(endMs, days) {
  return {
    async fetchKlinesForSymbol(sym, _n) {
      const all = readBest1mBars(String(sym).toUpperCase());
      // Include WARMUP_BARS before the window; do NOT trim to `_n` (that would
      // drop the warmup the backtest barCount request would otherwise discard).
      const sliced = sliceWindow(all, endMs, days, WARMUP_BARS);
      // Drop full-series cache entry — keep only the windowed slice for sim.
      clearBarsMemoryCache();
      if (!sliced || sliced.length < 200) throw new Error(`no window bars ${sym}`);
      return sliced;
    },
    async fetchKlines1mForSymbol() {
      return null;
    },
  };
}

function summarize(trades) {
  const xs = trades.map((t) => Number(t.pnl) || 0);
  const n = xs.length;
  if (!n) return { n: 0, sum: 0, mean: null, hitRate: null, maxDd: 0, trailExits: 0 };
  const sum = xs.reduce((a, b) => a + b, 0);
  const hits = xs.filter((x) => x > 0).length;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of xs) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return {
    n,
    sum: +sum.toFixed(4),
    mean: +(sum / n).toFixed(4),
    hitRate: +((100 * hits) / n).toFixed(1),
    maxDd: +maxDd.toFixed(4),
    trailExits: trades.filter((t) => t.exitReason === "foi_vwap_trail").length,
  };
}

const COLD_HALF_CFG = normalizeFoiColdDayConfig({
  foiColdDayEnabled: true,
  foiColdDayLookbackDays: 3,
  foiColdDayMaxWinRate: 0.28,
  foiColdDayMaxDayPnl: 0,
  foiColdDayMinTrades: 8,
  foiColdDayPolicy: "half",
});

/** Causal cold-day half on calendar-ordered opens (fixes batch symbol-order bias). */
function applyColdHalfChrono(trades) {
  const tracker = createFoiColdDayTracker();
  const events = trades
    .filter((t) => t.openedAt != null && t.closedAt != null)
    .map((t) => ({
      openAt: Number(t.openedAt),
      closeAt: Number(t.closedAt),
      trade: t,
    }));
  const opens = [...events].sort((a, b) => a.openAt - b.openAt || a.closeAt - b.closeAt);
  const closes = [...events].sort((a, b) => a.closeAt - b.closeAt || a.openAt - b.openAt);
  let ci = 0;
  const kept = [];
  let scaled = 0;
  for (const ev of opens) {
    while (ci < closes.length && closes[ci].closeAt < ev.openAt) {
      tracker.recordClosedTrade(closes[ci].trade);
      ci += 1;
    }
    const gate = tracker.check(COLD_HALF_CFG, ev.openAt);
    if (!gate.pass || gate.sizeScale <= 0) continue;
    const scale = gate.sizeScale < 1 ? gate.sizeScale : 1;
    if (scale < 1) scaled += 1;
    kept.push({
      ...ev.trade,
      pnl: +(Number(ev.trade.pnl) || 0) * scale,
      coldSizeScale: scale,
    });
  }
  return { kept, dropped: trades.length - kept.length, scaled };
}

function maybeGc() {
  clearBarsMemoryCache();
  if (typeof global.gc === "function") global.gc();
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function oosWindows(trades, parts = 5) {
  if (!trades.length) return [];
  const sorted = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  const tMin = sorted[0].openedAt;
  const tMax = sorted[sorted.length - 1].openedAt;
  const span = tMax - tMin || 1;
  return Array.from({ length: parts }, (_, i) => {
    const lo = tMin + (span * i) / parts;
    const hi = tMin + (span * (i + 1)) / parts;
    const slice = sorted.filter(
      (t) => t.openedAt >= lo && (i === parts - 1 ? t.openedAt <= hi : t.openedAt < hi)
    );
    return {
      window: i + 1,
      from: dayKey(lo),
      to: dayKey(hi),
      ...summarize(slice),
    };
  });
}

async function extendFoiSymbols(syms, targetDays) {
  const manifest = loadManifest() ?? {};
  const interval = manifest.interval ?? "1m";
  // Signal cache is already 1m in this project — skip redundant mover extend.
  const needs1m = interval !== "1m";
  const restQueue = createRestQueue({ label: "foi-trail-extend", gapMs: 300 });
  const fetchSignalOlder = createOlderKlineFetcher({
    interval,
    restQueue,
    batchPauseMs: 150,
  });
  const fetchMoverOlder = needs1m
    ? createOlderKlineFetcher({
        interval: "1m",
        restQueue,
        batchPauseMs: 150,
      })
    : null;
  log(
    `Extending ${syms.length} FOI symbols to ${targetDays}d (interval=${interval}, mover=${needs1m})…`
  );
  const stats = await extendBacktestKlineCache({
    targetDays,
    interval,
    moverInterval: "1m",
    symbols: syms,
    needs1m,
    fetchSignalOlder,
    fetchMoverOlder,
    resume: true,
    symbolPauseMs: 80,
    onProgress: (p) => {
      if (p.error) {
        log(`  [err] ${p.message}`);
        return;
      }
      if (p.resumed) return;
      if (p.phase === "done" && (p.done % 10 === 0 || p.done === p.total)) {
        log(`  extend ${p.done}/${p.total} ${p.symbol}`);
      }
    },
  });
  clearBarsMemoryCache();
  log(`extend done: ${JSON.stringify(stats)}`);
  return stats;
}

async function runVariant({
  label,
  trailEnabled,
  days,
  syms,
  signalCfg,
  endMs,
  getFundingOiAt,
}) {
  const botConfig = loadBotConfig(trailEnabled);
  const fetchers = createFetchers(endMs, days);
  const tracker = createFoiFollowthroughRegimeTracker();
  const windowStartMs = endMs - days * DAY_MS;
  const closed = [];

  log(
    `\n=== RUN ${label} · trail=${trailEnabled} · ${days}d · ${syms.length} symbols · warmup=${WARMUP_BARS} ===`
  );
  log(
    `trail cfg: enabled=${botConfig.foiVwapTrailEnabled} arm=${botConfig.foiVwapTrailArmPct} bars=${botConfig.foiVwapTrailBars}`
  );

  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    log(`  batch ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
    const { result } = await runPaperBotBacktest({
      symbols: batch,
      signalCfg,
      botConfig,
      // Request enough bars so cache layer does not fight our warmup fetch.
      days: days + Math.ceil(WARMUP_BARS / (24 * 60)) + 1,
      fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
      fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
      getFundingOiAt,
      restGapMs: 0,
      saveLastResult: false,
      saveKlineCache: false,
      forceKlineFetch: true,
      simYieldEvery: 0,
      modelScope: "live",
      foiFollowthroughTracker: tracker,
      runMeta: { eval: "foi-vwap-trail-50d", label, trailEnabled, days },
    });
    for (const t of result.closedTrades ?? []) {
      if (t.signalKind !== "foi" && t.signalKind !== "foi_bear") continue;
      const openedAt = t.openedAt;
      // Drop warmup-period opens — bars include pre-window history for VWAP/lookalike.
      if (!(openedAt >= windowStartMs && openedAt < endMs)) continue;
      closed.push({
        symbol: t.symbol,
        signalKind: t.signalKind,
        side: t.side,
        pnl: +(Number(t.pnl) || 0).toFixed(4),
        exitReason: t.exitReason,
        openedAt,
        closedAt: t.closedAt,
        entryPrice: t.entryPrice ?? t.initialEntryPrice ?? null,
        exitPrice: t.exitPrice ?? null,
        stopLoss: t.initialStopLoss ?? t.stopLoss ?? null,
        holdMin:
          openedAt != null && t.closedAt != null
            ? +((t.closedAt - openedAt) / 60000).toFixed(1)
            : null,
      });
    }
    result.closedTrades = null;
    maybeGc();
  }

  closed.sort((a, b) => a.openedAt - b.openedAt);
  return { trades: closed, summary: summarize(closed), botConfig };
}

function endIdx(bars, ms) {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeTime <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function typical(bar) {
  const h = +bar.high;
  const l = +bar.low;
  const c = +bar.close;
  if (h > 0 && l > 0 && c > 0) return (h + l + c) / 3;
  return c > 0 ? c : null;
}

function makeRing(w) {
  const ring = [];
  let sumPv = 0;
  let sumV = 0;
  return {
    push(bar) {
      const tp = typical(bar);
      const v = +bar.volume || 0;
      if (!(tp > 0)) return null;
      ring.push({ pv: tp * v, v });
      sumPv += tp * v;
      sumV += v;
      while (ring.length > w) {
        const o = ring.shift();
        sumPv -= o.pv;
        sumV -= o.v;
      }
      if (ring.length < Math.min(20, w) || !(sumV > 0)) return null;
      return sumPv / sumV;
    },
  };
}

/** Fast path counterfactual; never drops trades (passthrough baseline PnL). */
function counterfactualTrail(trades, armPct = 0.3, vwapBars = 120) {
  const cfg = normalizeFoiVwapTrailConfig({
    ...FOI_VWAP_TRAIL_DEFAULTS,
    foiVwapTrailArmPct: armPct,
    foiVwapTrailBars: vwapBars,
  });
  const bySym = new Map();
  for (const t of trades) {
    const s = String(t.symbol).toUpperCase();
    if (!bySym.has(s)) bySym.set(s, []);
    bySym.get(s).push(t);
  }
  const rows = [];
  let passthrough = 0;
  let trailed = 0;
  for (const [sym, list] of bySym) {
    const bars = readBest1mBars(sym);
    if (!bars?.length) {
      for (const t of list) {
        passthrough += 1;
        rows.push({
          ...t,
          pnl: +Number(t.pnl).toFixed(4),
          exitReason: t.exitReason || "original",
          baselinePnl: +t.pnl,
          trailDelta: 0,
          cfPassthrough: true,
        });
      }
      clearBarsMemoryCache();
      continue;
    }
    for (const t of list) {
      const side =
        t.side === "SHORT" || t.signalKind === "foi_bear" ? "SHORT" : "LONG";
      const i0 = endIdx(bars, +t.openedAt);
      const i1 = endIdx(bars, +t.closedAt);
      if (i0 < 0 || i1 <= i0 || i0 < cfg.foiVwapTrailBars) {
        passthrough += 1;
        rows.push({
          ...t,
          pnl: +Number(t.pnl).toFixed(4),
          exitReason: t.exitReason || "original",
          baselinePnl: +t.pnl,
          trailDelta: 0,
          cfPassthrough: true,
        });
        continue;
      }
      const entry = +t.entryPrice || +bars[i0].close;
      if (!(entry > 0)) {
        passthrough += 1;
        rows.push({
          ...t,
          pnl: +Number(t.pnl).toFixed(4),
          exitReason: t.exitReason || "original",
          baselinePnl: +t.pnl,
          trailDelta: 0,
          cfPassthrough: true,
        });
        continue;
      }
      const ring = makeRing(cfg.foiVwapTrailBars);
      const warm = Math.max(0, i0 - cfg.foiVwapTrailBars);
      const path = [];
      for (let i = warm; i <= i1; i++) {
        const vwap = ring.push(bars[i]);
        if (i < i0) continue;
        path.push({
          high: +bars[i].high,
          low: +bars[i].low,
          close: +bars[i].close,
          vwap,
        });
      }
      const initialSl =
        +t.stopLoss || (side === "SHORT" ? entry * 1.02 : entry * 0.98);
      const sim = simulateFoiVwapTrailOnPath(
        {
          side,
          entry,
          exit: +t.exitPrice || null,
          pnl: +t.pnl,
          initialSl,
          path,
          exitReason: t.exitReason,
        },
        { armPct: cfg.foiVwapTrailArmPct }
      );
      if (sim.exitReason === "foi_vwap_trail") trailed += 1;
      rows.push({
        ...t,
        pnl: sim.pnl,
        exitReason: sim.exitReason,
        baselinePnl: +t.pnl,
        trailDelta: +(sim.pnl - Number(t.pnl)).toFixed(4),
        cfPassthrough: false,
      });
    }
    clearBarsMemoryCache();
  }
  rows.sort((a, b) => a.openedAt - b.openedAt);
  return {
    trades: rows,
    summary: summarize(rows),
    passthrough,
    trailed,
  };
}

async function main() {
  const {
    skipPull,
    skipExtend,
    only,
    liveTrail,
    portions: portionLimit,
  } = parseArgs(process.argv);
  if (!skipPull) pullRailway();
  const installed = installMirrorModels();
  const signalCfg = loadSignalConfig();
  let syms = foiSymbols();

  if (!skipExtend) {
    try {
      await extendFoiSymbols(syms, 50);
      syms = foiSymbols();
    } catch (e) {
      log(`extend warn: ${e.message} — continuing with cache`);
    }
  }

  const { dataEndMs, dataStartMs } = discoverDataEnd(syms);
  const spanDays = +((dataEndMs - dataStartMs) / DAY_MS).toFixed(2);
  let wins = only
    ? WINDOWS.filter((w) => w.id === only || only === w.id.replace("w", ""))
    : WINDOWS;
  if (portionLimit != null && !only) {
    wins = WINDOWS.slice(0, portionLimit);
  }
  if (!wins.length) {
    throw new Error(`Unknown --only ${only}; use w1..w5 or --portions 3`);
  }

  log(
    `FOI VWAP trail 5×10d · cache ~${spanDays}d · ${syms.length} symbols · models ${installed} · windows ${wins.map((w) => w.id).join(",")} · gc=${typeof global.gc === "function" ? "on" : "off (pass --expose-gc)"}`
  );

  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);
  const portions = [];
  const allBaseline = [];
  const allTrailCf = [];
  const allTrailLive = [];

  for (const win of wins) {
    const endMs = dataEndMs - win.endShiftDays * DAY_MS;
    const startMs = endMs - WINDOW_DAYS * DAY_MS;
    if (startMs < dataStartMs - DAY_MS) {
      log(`\n=== SKIP ${win.id}: not enough cache (need from ${new Date(startMs).toISOString()}) ===`);
      portions.push({
        ...win,
        skipped: true,
        reason: "insufficient_cache",
        endIso: new Date(endMs).toISOString(),
      });
      continue;
    }

    log(`\n######## ${win.id}: ${win.label} ########`);
    log(`window ${new Date(startMs).toISOString().slice(0, 10)} .. ${new Date(endMs).toISOString().slice(0, 10)}`);

    const rawBaseline = await runVariant({
      label: `${win.id}_baseline`,
      trailEnabled: false,
      days: WINDOW_DAYS,
      syms,
      signalCfg,
      endMs,
      getFundingOiAt,
    });
    maybeGc();

    const cold = applyColdHalfChrono(rawBaseline.trades);
    const baselineTrades = cold.kept;
    const baseline = {
      trades: baselineTrades,
      summary: summarize(baselineTrades),
      cold: { dropped: cold.dropped, scaled: cold.scaled, rawN: rawBaseline.trades.length },
    };
    log(
      `  cold-day offline: raw ${rawBaseline.trades.length} → kept ${baselineTrades.length} (dropped ${cold.dropped}, scaled ${cold.scaled})`
    );

    log(`  CF trail on ${baseline.trades.length} baseline trades…`);
    const trailCf = counterfactualTrail(baseline.trades, 0.3, 120);
    maybeGc();

    let trailLive = null;
    if (liveTrail) {
      const rawLive = await runVariant({
        label: `${win.id}_trail`,
        trailEnabled: true,
        days: WINDOW_DAYS,
        syms,
        signalCfg,
        endMs,
        getFundingOiAt,
      });
      const liveCold = applyColdHalfChrono(rawLive.trades);
      trailLive = {
        trades: liveCold.kept,
        summary: summarize(liveCold.kept),
      };
      maybeGc();
    }

    const deltaCf = +(trailCf.summary.sum - baseline.summary.sum).toFixed(4);
    const portion = {
      id: win.id,
      label: win.label,
      endShiftDays: win.endShiftDays,
      from: new Date(startMs).toISOString().slice(0, 10),
      to: new Date(endMs).toISOString().slice(0, 10),
      endIso: new Date(endMs).toISOString(),
      baseline: baseline.summary,
      cold: baseline.cold,
      trailCf: trailCf.summary,
      cfMeta: { passthrough: trailCf.passthrough, trailed: trailCf.trailed },
      deltaCf,
      trailLive: trailLive ? trailLive.summary : null,
      deltaLive: trailLive
        ? +(trailLive.summary.sum - baseline.summary.sum).toFixed(4)
        : null,
    };
    portions.push(portion);
    allBaseline.push(...baseline.trades.map((t) => ({ ...t, window: win.id })));
    allTrailCf.push(...trailCf.trades.map((t) => ({ ...t, window: win.id })));
    if (trailLive) {
      allTrailLive.push(...trailLive.trades.map((t) => ({ ...t, window: win.id })));
    }

    writeJsonFile(dataPath(`foi-vwap-trail-50d-${win.id}-trades.json`), {
      ranAt: new Date().toISOString(),
      window: portion,
      baselineTrades: baseline.trades,
      trailCfTrades: trailCf.trades,
      trailLiveTrades: trailLive?.trades ?? null,
    });

    log(
      `  ${win.id}: baseline $${baseline.summary.sum} → CF trail $${trailCf.summary.sum} (Δ$${deltaCf}) · n=${baseline.summary.n}→${trailCf.summary.n} WR ${baseline.summary.hitRate}%→${trailCf.summary.hitRate}% · trailExits ${trailCf.summary.trailExits}`
    );
  }

  const baselineAll = summarize(allBaseline);
  const trailCfAll = summarize(allTrailCf);
  const trailLiveAll = allTrailLive.length ? summarize(allTrailLive) : null;
  const deltaSum = +(trailCfAll.sum - baselineAll.sum).toFixed(4);
  const positivePortions = portions.filter(
    (p) => !p.skipped && (p.deltaCf ?? 0) > 0
  ).length;
  const runPortions = portions.filter((p) => !p.skipped);

  const report = {
    ranAt: new Date().toISOString(),
    method:
      "Champion FOI immediate entry + VWAP120 trail arm0.3%. 5×10d portions; warmup bars; cold-day offline chrono; CF passthrough; live baseline + path CF trail.",
    fixes: [
      "cf_passthrough_equal_n",
      "warmup_bars_before_window",
      "cold_day_offline_chrono",
      "trail_exits_metric",
      "foi_symbols_memory_clear",
      "funding_cache_once",
      "slice_window_no_filter_copy",
      "exit_reason_foi_vwap_trail",
      "proxy_pnl_near_zero_guard",
    ],
    cacheSpanDays: spanDays,
    symbolCount: syms.length,
    dataEndIso: new Date(dataEndMs).toISOString(),
    dataStartIso: new Date(dataStartMs).toISOString(),
    featurePatch: FEATURE_PATCH,
    trailDefaults: FOI_VWAP_TRAIL_DEFAULTS,
    liveTrail,
    portions,
    aggregate: {
      baseline: baselineAll,
      trailCf: trailCfAll,
      trailLive: trailLiveAll,
      deltaCf: deltaSum,
      deltaLive: trailLiveAll
        ? +(trailLiveAll.sum - baselineAll.sum).toFixed(4)
        : null,
      positivePortions,
      portionsRun: runPortions.length,
    },
    verdict: {
      works: deltaSum > 0 && positivePortions >= 3,
      why: `5×10d CF trail: $${baselineAll.sum} → $${trailCfAll.sum} (Δ$${deltaSum}) · WR ${baselineAll.hitRate}%→${trailCfAll.hitRate}% · n=${baselineAll.n} · OOS+ ${positivePortions}/${runPortions.length} portions`,
    },
  };

  writeJsonFile(OUT(), report);
  writeJsonFile(dataPath("foi-vwap-trail-50d-baseline-trades.json"), {
    ranAt: new Date().toISOString(),
    trades: allBaseline,
  });
  writeJsonFile(dataPath("foi-vwap-trail-50d-trail-cf-trades.json"), {
    ranAt: new Date().toISOString(),
    trades: allTrailCf,
  });

  log("\n=== FOI + VWAP TRAIL 5×10d ===");
  for (const p of portions) {
    if (p.skipped) {
      log(`  ${p.id}: SKIPPED (${p.reason})`);
      continue;
    }
    log(
      `  ${p.id} ${p.from}..${p.to}: Δ$${p.deltaCf} · base $${p.baseline.sum} → trail $${p.trailCf.sum} · n=${p.baseline.n}`
    );
  }
  log(report.verdict.why);
  log(`wrote ${OUT()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
