#!/usr/bin/env node
/**
 * Railway live 30d backtest + by-day analysis + profit/stability recommendations.
 *
 *   RAILWAY_URL=... VOL_SESSION_COOKIE_FILE=scripts/.vol-railway-cookie \
 *     node --max-old-space-size=8192 scripts/run-railway-live-30d-daily.js
 *
 *   --skip-pull
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
const { readSymbolBars, readBest1mBars } = require("../lib/backtest-kline-cache");
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
const { createFoiColdDayTracker } = require("../lib/foi-cold-day-regime");
const { createFoiMiddayColdPauseTracker } = require("../lib/foi-midday-cold-pause");

const ROOT = path.join(__dirname, "..");
const MIRROR = path.join(ROOT, ".cache", "railway-mirror");
const INTERVAL = "1m";
const BATCH = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 30;
const OUT = () => dataPath("railway-live-30d-daily.json");
const TRADES_OUT = () => dataPath("railway-live-30d-trades.json");

/** Ladder-proven A+B stack (less qSL + hot TP protect). */
const FEATURE_PATCH_AB = {
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
};

/** A+B + 4h BTC pathCosine≥0.95 + cold-day size×0.5 (OOS champion). */
const FEATURE_PATCH_AB_PATHCOSINE = {
  ...FEATURE_PATCH_AB,
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

/** Champion + mid-day cold pause (2h WR<25% OR dayPnL<-1.5 → block). */
const FEATURE_PATCH_AB_PATHCOSINE_MIDDAY = {
  ...FEATURE_PATCH_AB_PATHCOSINE,
  foiMiddayColdPauseEnabled: true,
  foiMiddayColdPauseWindowHours: 2,
  foiMiddayColdPauseMinSamples: 6,
  foiMiddayColdPauseMaxWr: 0.25,
  foiMiddayColdPauseMaxDayPnl: -1.5,
  foiMiddayColdPauseRequireBoth: false,
  foiMiddayColdPausePolicy: "block",
};

function featurePatchFor(features) {
  const f = String(features || "").toLowerCase();
  if (f === "ab" || f === "a+b") return FEATURE_PATCH_AB;
  if (
    f === "ab-pathcosine" ||
    f === "ab+pathcosine" ||
    f === "ab-pc" ||
    f === "champion"
  ) {
    return FEATURE_PATCH_AB_PATHCOSINE;
  }
  if (
    f === "ab-pathcosine-midday" ||
    f === "ab-pc-midday" ||
    f === "champion-midday" ||
    f === "midday"
  ) {
    return FEATURE_PATCH_AB_PATHCOSINE_MIDDAY;
  }
  return {};
}

function featureTag(features) {
  const f = String(features || "").toLowerCase();
  if (f === "ab" || f === "a+b") return "ab";
  if (
    f === "ab-pathcosine" ||
    f === "ab+pathcosine" ||
    f === "ab-pc" ||
    f === "champion"
  ) {
    return "ab-pathcosine";
  }
  if (
    f === "ab-pathcosine-midday" ||
    f === "ab-pc-midday" ||
    f === "champion-midday" ||
    f === "midday"
  ) {
    return "ab-pathcosine-midday";
  }
  return null;
}

function log(m) {
  console.error(String(m));
}

function parseArgs(argv) {
  let skipPull = false;
  let days = DAYS;
  let features = null;
  let foiSymbolsOnly = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--skip-pull") skipPull = true;
    else if (argv[i] === "--foi-symbols-only") foiSymbolsOnly = true;
    else if (argv[i] === "--features" && argv[i + 1]) {
      features = String(argv[++i]).toLowerCase();
    } else if (argv[i] === "--days" && argv[i + 1]) {
      days = Math.max(5, Math.min(45, Math.round(Number(argv[++i]) || DAYS)));
    }
  }
  return { skipPull, days, features, foiSymbolsOnly };
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
  spawnSync(process.execPath, [path.join(ROOT, "scripts", "fetch-railway-models-extra.js")], {
    cwd: ROOT,
    env: { ...process.env, RAILWAY_URL: baseUrl },
    encoding: "utf8",
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

function loadLiveBot(features = null) {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {})?.config ?? {};
  const patch = featurePatchFor(features);
  return normalizeLiveConfig({
    enabled: true,
    ...raw,
    ...patch,
    armed: false,
    drawdownStopEnabled: false,
    // Online empty tracker: block warmup deadlocks.
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

function bars1m(sym) {
  return readBest1mBars(String(sym).toUpperCase(), 200);
}

function symbols(foiOnly = false) {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  const all = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .sort();
  let candidates = all;
  if (foiOnly) {
    const prior = readJsonFile(dataPath("railway-live-30d-trades.json"), null);
    const set = new Set((prior?.trades ?? []).map((t) => t.symbol).filter(Boolean));
    if (set.size >= 50) {
      candidates = all.filter((s) => set.has(s));
      log(`FOI-symbol filter: ${candidates.length} candidates (before bar check)`);
    }
  }
  return candidates.filter((s) => (bars1m(s)?.length ?? 0) >= 200);
}

function discoverDataEnd(syms) {
  let maxEnd = 0;
  let minStart = Infinity;
  for (const s of syms.slice(0, 40)) {
    const bars = bars1m(s);
    if (!bars?.length) continue;
    maxEnd = Math.max(maxEnd, bars[bars.length - 1].closeTime);
    minStart = Math.min(minStart, bars[0].closeTime);
  }
  return { dataEndMs: maxEnd, dataStartMs: minStart };
}

function sliceWindow(bars, endMs, days) {
  if (!bars?.length) return null;
  const cut = bars.filter((b) => b.closeTime <= endMs);
  if (!cut.length) return null;
  const need = Math.ceil(days * 24 * 60);
  const tail = cut.length > need ? cut.slice(-need) : cut;
  return tail;
}

function createFetchers(endMs, days) {
  return {
    async fetchKlinesForSymbol(sym, n) {
      const all = bars1m(String(sym).toUpperCase());
      const sliced = sliceWindow(all, endMs, days);
      if (!sliced || sliced.length < 200) throw new Error(`no window bars ${sym}`);
      return sliced.length > n ? sliced.slice(-n) : sliced;
    },
    async fetchKlines1mForSymbol() {
      return null;
    },
  };
}

function dayKey(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
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
    tp: ts.filter((t) => t.exitReason === "take_profit").length,
    sl: ts.filter((t) => t.exitReason === "stop_loss").length,
    qsl: ts.filter((t) => (t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss").length,
  };
}

function confirmOf(t) {
  return t.confirmKind || "null";
}

function analyzeDaily(trades) {
  const byDay = {};
  for (const t of trades) {
    const d = dayKey(t.closedAt || t.openedAt);
    if (!d) continue;
    (byDay[d] ??= []).push(t);
  }
  const days = Object.keys(byDay).sort();
  const rows = [];
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const d of days) {
    const ts = byDay[d];
    const b = bucket(ts);
    const tpRate = b.trades ? +((100 * b.tp) / b.trades).toFixed(1) : 0;
    const slRate = b.trades ? +((100 * b.sl) / b.trades).toFixed(1) : 0;
    const qslShare = b.trades ? +((100 * b.qsl) / b.trades).toFixed(1) : 0;
    const hold180 = ts.filter((t) => (t.holdMin ?? 0) >= 180);
    equity += b.pnl;
    peak = Math.max(peak, equity);
    const dd = +(peak - equity).toFixed(2);
    maxDd = Math.max(maxDd, dd);
    const pb = ts.filter((t) => String(confirmOf(t)).includes("pullback"));
    const sfp = ts.filter((t) => String(confirmOf(t)).includes("sfp"));
    rows.push({
      day: d,
      ...b,
      tpRate,
      slRate,
      qslShare,
      qslPnl: sumPnl(ts.filter((t) => (t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss")),
      hold180Pnl: sumPnl(hold180),
      hold180Share: b.trades ? +((100 * hold180.length) / b.trades).toFixed(1) : 0,
      pbPnl: sumPnl(pb),
      sfpPnl: sumPnl(sfp),
      equity: +equity.toFixed(2),
      drawdownFromPeak: dd,
    });
  }
  return { rows, maxDrawdown: +maxDd.toFixed(2), finalEquity: +equity.toFixed(2) };
}

function rollingStats(dailyRows, lookback = 3) {
  return dailyRows.map((row, i) => {
    const slice = dailyRows.slice(Math.max(0, i - lookback + 1), i + 1);
    const pnl = sumPnl(slice.map((r) => ({ pnl: r.pnl })));
    const wr =
      slice.reduce((s, r) => s + r.winRate * r.trades, 0) /
      Math.max(1, slice.reduce((s, r) => s + r.trades, 0));
    return {
      day: row.day,
      rollPnl: +pnl.toFixed(2),
      rollWr: +wr.toFixed(1),
      cold: wr < 28 || pnl < -1.5,
    };
  });
}

function buildRecommendations(trades, daily, botConfig) {
  const recs = [];
  const overall = bucket(trades);
  const badDays = daily.rows.filter((d) => d.pnl < 0);
  const goodDays = daily.rows.filter((d) => d.pnl > 0);
  const worst = [...daily.rows].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
  const best = [...daily.rows].sort((a, b) => b.pnl - a.pnl).slice(0, 5);

  const meanDayPnl = daily.rows.length
    ? +(daily.rows.reduce((s, r) => s + r.pnl, 0) / daily.rows.length).toFixed(2)
    : 0;
  const stdDay = (() => {
    if (daily.rows.length < 2) return 0;
    const m = meanDayPnl;
    const v =
      daily.rows.reduce((s, r) => s + (r.pnl - m) ** 2, 0) / (daily.rows.length - 1);
    return +Math.sqrt(v).toFixed(2);
  })();

  const roll = rollingStats(daily.rows, 3);
  const coldDays = roll.filter((r) => r.cold);

  // Counterfactual: drop worst calendar days (optimistic upper bound)
  const dropWorst3 = new Set(worst.slice(0, 3).map((d) => d.day));
  const withoutWorst3 = trades.filter((t) => !dropWorst3.has(dayKey(t.closedAt || t.openedAt)));
  recs.push({
    id: "skip_worst_3_days",
    priority: "high",
    title: "Сильніше різати холодні дні (regime-gate)",
    why: `${badDays.length}/${daily.rows.length} днів у мінусі; топ-3 worst = $${worst
      .slice(0, 3)
      .reduce((s, d) => s + d.pnl, 0)
      .toFixed(2)}. Offline drop worst3 → $${sumPnl(withoutWorst3)} (optimistic).`,
    action:
      "Підкрутити follow-through: wr≥0.32–0.38 або вимагати rolling 3d WR≥30% / day PnL≥0 перед новими входами; на cold → size 0 або half.",
    estDelta: +(sumPnl(withoutWorst3) - overall.pnl).toFixed(2),
  });

  const qsl = trades.filter(
    (t) => (t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss"
  );
  const noQsl = trades.filter(
    (t) => !((t.holdMin ?? 99) <= 15 && t.exitReason === "stop_loss")
  );
  recs.push({
    id: "reduce_quick_sl",
    priority: "high",
    title: "Зменшити quick-SL (≤15m)",
    why: `${qsl.length} qSL · $${sumPnl(qsl)}; без них PnL $${sumPnl(noQsl)}.`,
    action:
      "Ширший min smart-stop / вищий min SL distance на bear FOI; або не входити коли |oi| високий і funding крайній.",
    estDelta: +(sumPnl(noQsl) - overall.pnl).toFixed(2),
  });

  const shortHold = trades.filter((t) => (t.holdMin ?? 0) < 60);
  const longHold = trades.filter((t) => (t.holdMin ?? 0) >= 180);
  recs.push({
    id: "favor_followthrough",
    priority: "high",
    title: "Більше ваги на follow-through holds",
    why: `hold<60m: $${sumPnl(shortHold)} (${shortHold.length}tr); hold≥180m: $${sumPnl(longHold)} (${longHold.length}tr).`,
    action:
      "Не різати раннер рано; перевірити move-stop/add-on щоб не вибивало перед TP; cold-day — не форсувати short-hold scalp.",
    estDelta: null,
  });

  const pb = trades.filter((t) => String(confirmOf(t)).includes("pullback"));
  const sfp = trades.filter((t) => String(confirmOf(t)).includes("sfp"));
  if (sumPnl(pb) < sumPnl(sfp) - 2) {
    recs.push({
      id: "pb_quality",
      priority: "medium",
      title: "Підняти якість PB confirm",
      why: `PB $${sumPnl(pb)} / ${pb.length}tr vs SFP $${sumPnl(sfp)} / ${sfp.length}tr.`,
      action:
        "Жорсткіший PB OI-gate (1.0–1.5) або PB-only коли rolling PB WR≥SFP WR; інакше SFP-prefer на cold days.",
      estDelta: null,
    });
  }

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, trades: [], pnl: 0 }));
  for (const t of trades) {
    if (t.openedAt == null) continue;
    const h = new Date(t.openedAt).getUTCHours();
    byHour[h].trades.push(t);
    byHour[h].pnl += Number(t.pnl) || 0;
  }
  const badHours = byHour
    .map((h) => ({
      hour: h.hour,
      trades: h.trades.length,
      pnl: +h.pnl.toFixed(2),
      wr: winRate(h.trades),
    }))
    .filter((h) => h.trades >= 20 && h.pnl < -1)
    .sort((a, b) => a.pnl - b.pnl);
  if (badHours.length) {
    const badSet = new Set(badHours.map((h) => h.hour));
    const filtered = trades.filter(
      (t) => t.openedAt == null || !badSet.has(new Date(t.openedAt).getUTCHours())
    );
    recs.push({
      id: "utc_hour_filter",
      priority: "medium",
      title: "Фільтр поганих UTC годин",
      why: `Години з ≥20tr і PnL<-1: ${badHours
        .map((h) => `${h.hour}h($${h.pnl})`)
        .join(", ")}.`,
      action: `Блокувати нові FOI входи в UTC [${[...badSet].sort((a, b) => a - b).join(",")}].`,
      estDelta: +(sumPnl(filtered) - overall.pnl).toFixed(2),
    });
  }

  const bySym = {};
  for (const t of trades) {
    (bySym[t.symbol] ??= []).push(t);
  }
  const symRows = Object.entries(bySym)
    .map(([symbol, rows]) => ({ symbol, ...bucket(rows) }))
    .sort((a, b) => a.pnl - b.pnl);
  const toxic = symRows.filter((s) => s.pnl <= -1.5 || (s.trades >= 8 && s.winRate < 20));
  if (toxic.length) {
    const toxicSet = new Set(toxic.slice(0, 12).map((s) => s.symbol));
    const filtered = trades.filter((t) => !toxicSet.has(t.symbol));
    recs.push({
      id: "symbol_blocklist",
      priority: "medium",
      title: "Блокліст токсичних символів",
      why: `Топ losers: ${toxic
        .slice(0, 8)
        .map((s) => `${s.symbol} $${s.pnl}`)
        .join(", ")}.`,
      action: "autoBlockAfterConsecutiveSl=2–3 + ручний blocklist на 30d losers ≤-$1.5.",
      estDelta: +(sumPnl(filtered) - overall.pnl).toFixed(2),
    });
  }

  if (botConfig.positionSizeUsdt >= 6 && daily.maxDrawdown > Math.abs(meanDayPnl) * 5) {
    recs.push({
      id: "size_stability",
      priority: "medium",
      title: "Size scaling від режиму",
      why: `Size $${botConfig.positionSizeUsdt}, maxDD $${daily.maxDrawdown}, day σ $${stdDay}.`,
      action: "Cold (rolling WR<28%): size×0.5; hot (WR≥38%): full. Зберігає upside, ріже хвости.",
      estDelta: null,
    });
  }

  recs.push({
    id: "keep_warmup_allow",
    priority: "low",
    title: "Тримати warmup=allow онлайн",
    why: "warmup=block на порожньому tracker глушить усі входи.",
    action: "Не повертати block без seed історії FOI closes.",
    estDelta: null,
  });

  return {
    summaryStats: {
      days: daily.rows.length,
      positiveDays: goodDays.length,
      negativeDays: badDays.length,
      meanDayPnl,
      stdDayPnl: stdDay,
      maxDrawdown: daily.maxDrawdown,
      bestDays: best.map((d) => ({ day: d.day, pnl: d.pnl, wr: d.winRate, trades: d.trades })),
      worstDays: worst.map((d) => ({ day: d.day, pnl: d.pnl, wr: d.winRate, trades: d.trades })),
      coldRolling3dDays: coldDays.length,
    },
    recommendations: recs.sort((a, b) => {
      const p = { high: 0, medium: 1, low: 2 };
      return (p[a.priority] ?? 9) - (p[b.priority] ?? 9);
    }),
  };
}

function configSnapshot(cfg) {
  return {
    positionSizeUsdt: cfg.positionSizeUsdt,
    addOnMarginUsdt: cfg.addOnMarginUsdt,
    maxOpenPositions: cfg.maxOpenPositions,
    leverage: cfg.leverage,
    tradeBearishFoiSignals: cfg.tradeBearishFoiSignals,
    foiConfirmSfpMaxOiDelta1hAbs: cfg.foiConfirmSfpMaxOiDelta1hAbs ?? null,
    foiConfirmPullbackMaxOiDelta1hAbs: cfg.foiConfirmPullbackMaxOiDelta1hAbs ?? null,
    earlyAbortEnabled: cfg.earlyAbortEnabled,
    foiFollowthroughRegimeEnabled: cfg.foiFollowthroughRegimeEnabled,
    foiFollowthroughMinWinRate: cfg.foiFollowthroughMinWinRate,
    foiFollowthroughLookback: cfg.foiFollowthroughLookback,
    foiFollowthroughWarmupPolicy: cfg.foiFollowthroughWarmupPolicy,
    aiExitLevelsEnabled: cfg.aiExitLevelsEnabled,
    aiExitLevelsSlClampMin: cfg.aiExitLevelsSlClampMin,
    minSmartStopDistancePct: cfg.minSmartStopDistancePct,
    minSmartStopDistancePctBear: cfg.minSmartStopDistancePctBear ?? null,
    foiSkipExtremeCrowdingAnd: cfg.foiSkipExtremeCrowdingAnd,
    foiExtremeFundingAbs: cfg.foiExtremeFundingAbs,
    foiExtremeOiDelta1hAbs: cfg.foiExtremeOiDelta1hAbs,
    moveStopEnabled: cfg.moveStopEnabled,
    foiHotProtectLongHoldsEnabled: cfg.foiHotProtectLongHoldsEnabled,
    foiHotMinWinRate: cfg.foiHotMinWinRate,
    foiHotTpScale: cfg.foiHotTpScale,
    foiBtcLookalikeEnabled: cfg.foiBtcLookalikeEnabled,
    foiBtcLookalikeHours: cfg.foiBtcLookalikeHours,
    foiBtcLookalikeMinPathCosine: cfg.foiBtcLookalikeMinPathCosine,
    foiColdDayEnabled: cfg.foiColdDayEnabled,
    foiColdDayPolicy: cfg.foiColdDayPolicy,
    foiColdDayMaxWinRate: cfg.foiColdDayMaxWinRate,
    foiMiddayColdPauseEnabled: cfg.foiMiddayColdPauseEnabled,
    foiMiddayColdPauseWindowHours: cfg.foiMiddayColdPauseWindowHours,
    foiMiddayColdPauseMaxWr: cfg.foiMiddayColdPauseMaxWr,
    foiMiddayColdPauseMaxDayPnl: cfg.foiMiddayColdPauseMaxDayPnl,
    foiMiddayColdPausePolicy: cfg.foiMiddayColdPausePolicy,
    foiBlockedUtcHours: cfg.foiBlockedUtcHours,
    aiSfpRegimeEnabled: cfg.aiSfpRegimeEnabled,
    aiPullbackSignalEnabled: cfg.aiPullbackSignalEnabled,
  };
}

async function main() {
  const { skipPull, days, features, foiSymbolsOnly } = parseArgs(process.argv);
  if (!skipPull) pullRailway();

  const mirrorMeta = readJsonFile(path.join(MIRROR, "pull-meta.json"), {});
  const installed = installMirrorModels();
  const botConfig = loadLiveBot(features);
  const signalCfg = loadSignalConfig();
  const syms = symbols(foiSymbolsOnly);
  const { dataEndMs, dataStartMs } = discoverDataEnd(syms);
  const spanDays = +((dataEndMs - dataStartMs) / DAY_MS).toFixed(2);
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);
  const fetchers = createFetchers(dataEndMs, days);
  const tracker = createFoiFollowthroughRegimeTracker();
  const coldDayTracker = createFoiColdDayTracker();
  const middayColdPauseTracker = createFoiMiddayColdPauseTracker();

  log(`Railway live ${days}d daily · features=${features || "none"} · ${syms.length} symbols · cache ~${spanDays}d`);
  log(`Config: ${JSON.stringify(configSnapshot(botConfig))}`);
  log(`Models from mirror: ${installed}`);

  const closed = [];
  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    log(`  batch ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
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
      forceKlineFetch: true,
      simYieldEvery: 0,
      modelScope: "live",
      foiFollowthroughTracker: tracker,
      foiColdDayTracker: coldDayTracker,
      foiMiddayColdPauseTracker: middayColdPauseTracker,
      runMeta: { eval: "railway-live-30d-daily", days, features },
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
      });
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
  }

  const overall = bucket(closed);
  const daily = analyzeDaily(closed);
  const analysis = buildRecommendations(closed, daily, botConfig);
  const holdBins = [
    [0, 15],
    [15, 60],
    [60, 180],
    [180, 360],
    [360, 1e9],
  ].map(([lo, hi]) => {
    const ts = closed.filter((t) => (t.holdMin ?? -1) >= lo && (t.holdMin ?? -1) < hi);
    return { label: hi > 1e6 ? `${lo}+m` : `${lo}-${hi}m`, ...bucket(ts) };
  });
  const byConfirm = {};
  for (const t of closed) {
    const ck = confirmOf(t);
    if (!byConfirm[ck]) byConfirm[ck] = [];
    byConfirm[ck].push(t);
  }
  for (const k of Object.keys(byConfirm)) {
    byConfirm[k] = bucket(byConfirm[k]);
  }

  const tag = featureTag(features);
  const patch = featurePatchFor(features);
  const outPath = () =>
    tag ? dataPath(`railway-live-30d-${tag}-daily.json`) : OUT();
  const tradesPath = () =>
    tag ? dataPath(`railway-live-30d-${tag}-trades.json`) : TRADES_OUT();

  writeJsonFile(tradesPath(), {
    ranAt: new Date().toISOString(),
    days,
    features: features || null,
    trades: closed,
  });

  const report = {
    ranAt: new Date().toISOString(),
    source: "railway-live",
    days,
    features: features || null,
    featurePatch: Object.keys(patch).length ? patch : null,
    symbolCount: syms.length,
    foiSymbolsOnly,
    dataEndIso: new Date(dataEndMs).toISOString(),
    dataStartIso: new Date(dataStartMs).toISOString(),
    mirror: { pulledAt: mirrorMeta.pulledAt ?? null, modelsInstalled: installed },
    liveConfigSnapshot: configSnapshot(botConfig),
    overall: {
      ...overall,
      tpRate: overall.trades ? +((100 * overall.tp) / overall.trades).toFixed(1) : 0,
      slRate: overall.trades ? +((100 * overall.sl) / overall.trades).toFixed(1) : 0,
    },
    daily: daily.rows,
    equity: {
      final: daily.finalEquity,
      maxDrawdown: daily.maxDrawdown,
    },
    holdBins,
    byConfirm,
    analysis,
    tradesOut: tradesPath(),
  };

  writeJsonFile(outPath(), report);

  log("\n=== 30d OVERALL ===");
  log(
    `PnL $${overall.pnl} · ${overall.trades} tr · WR ${overall.winRate}% · maxDD $${daily.maxDrawdown}`
  );
  log(
    `Days +${analysis.summaryStats.positiveDays}/−${analysis.summaryStats.negativeDays} · mean/day $${analysis.summaryStats.meanDayPnl} · σ $${analysis.summaryStats.stdDayPnl}`
  );
  log("\n=== WORST DAYS ===");
  for (const d of analysis.summaryStats.worstDays) {
    log(`  ${d.day}: $${d.pnl} · ${d.trades}tr · WR ${d.wr}%`);
  }
  log("\n=== RECOMMENDATIONS ===");
  for (const r of analysis.recommendations) {
    log(`[${r.priority}] ${r.title}`);
    log(`  ${r.why}`);
    log(`  → ${r.action}${r.estDelta != null ? ` · est Δ $${r.estDelta}` : ""}`);
  }
  log(`\nSaved ${outPath()}`);
  console.log(
    JSON.stringify(
      {
        features: features || null,
        overall: report.overall,
        equity: report.equity,
        summaryStats: analysis.summaryStats,
        recommendations: analysis.recommendations,
        daily: daily.rows,
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
