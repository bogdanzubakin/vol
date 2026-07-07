#!/usr/bin/env node
/**
 * 30d sweep of pullback corridor settings (lookback bars + max width filter).
 *
 *   node scripts/optimize-pb-corridor-30d.js --days 30
 *   node scripts/optimize-pb-corridor-30d.js --days 30 --quick
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { onnxDir: pbOnnxDir } = require("../lib/pullback-signal-onnx");

const MIRROR = path.join(".cache", "railway-mirror");
const OUT_FILE = () => dataPath("pb-corridor-30d-optimize.json");

const WIDTH_PCT_FULL = [0, 10, 12, 14, 16, 18, 20, 24, 28, 32];
const WIDTH_PCT_QUICK = [0, 14, 16, 18, 20, 24];
const CORRIDOR_BARS_FULL = [48, 72, 96, 120, 168, 240, 336];
const CORRIDOR_BARS_QUICK = [72, 120, 168, 240];

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 30;
  let quick = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 30)), quick };
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function installLiveArtifacts() {
  const pairs = [
    ["pullback-signal-model-live.json", modelFileFor("pullback-signal-model", "paper")],
    ["ai-exit-levels-live.json", modelFileFor("ai-exit-levels", "paper")],
    ["early-exit-model-live.json", dataPath("early-exit-sfp.json")],
  ];
  for (const [srcName, dest] of pairs) {
    copyFile(path.join(MIRROR, srcName), dest);
  }
  const srcOnnx = pbOnnxDir("live");
  const destOnnx = pbOnnxDir("paper");
  if (fs.existsSync(srcOnnx)) {
    fs.mkdirSync(destOnnx, { recursive: true });
    for (const name of fs.readdirSync(srcOnnx)) {
      const src = path.join(srcOnnx, name);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(destOnnx, name));
    }
  }
  reloadPbSignal("paper");
  reloadExitLevels("paper");
}

function loadLiveBotConfig() {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {}).config || {};
  return normalizeLiveConfig({
    enabled: true,
    ...raw,
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
    aiSfpRegimeEnabled: false,
    aiPullbackRegimeEnabled: false,
  });
}

function loadSignalConfig() {
  const scannerRaw = readJsonFile(path.join(MIRROR, "scanner-config.json"), {});
  const cfg = {
    interval: "5m",
    corridorDays: 2,
    corridorExcludeMinutes: 40,
    signalCandles: 3,
    fastMoveLookbackCandles: 15,
    minAvgMovePct: 0.4,
    minLinearChangePct: 0.5,
    fastMoveExcludeMult: 3,
    topMoveMinPct: 15,
    sfpLookbackBars: 30,
    sfpRangeBars: 45,
    sfpReclaimBars: 5,
    sfpMinSweepPct: 0.08,
    pullbackMaBars: 7,
    pullbackTouchLookback: 12,
    pullbackMaxDistancePct: 0.35,
    pullbackMaxAboveMaPct: 1.5,
    pullbackMaxBelowMaPct: 1.5,
    pullbackCorridorBars: 120,
    ...scannerRaw,
  };
  applyBarConfig(cfg);
  return cfg;
}

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((sym) => readSymbolBars("mover", sym)?.length)
    .sort();
}

function createFetchers() {
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const cached = readCached(sym, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${sym}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const cached = readCached(sym, "mover", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${sym}`);
    },
  };
}

function summarize(result) {
  const s = result.summary ?? {};
  const closed = result.closedTrades ?? [];
  const pb = closed.filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  let pbPnl = 0;
  let tp = 0;
  for (const t of pb) {
    pbPnl += Number(t.pnl) || 0;
    if (t.exitReason === "take_profit") tp++;
  }
  const widths = pb
    .map((t) => t.signalSnapshot?.corridorWidthPct ?? t.corridorWidthPct)
    .filter((v) => Number.isFinite(v));
  const avgCorridor =
    widths.length ? +(widths.reduce((a, b) => a + b, 0) / widths.length).toFixed(2) : null;
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    pbPnl: +pbPnl.toFixed(2),
    trades: s.closedCount ?? 0,
    pbTrades: pb.length,
    tpRate: pb.length ? +((100 * tp) / pb.length).toFixed(1) : 0,
    winRate: pb.length
      ? +((100 * pb.filter((t) => (t.pnl ?? 0) > 0).length) / pb.length).toFixed(1)
      : 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    skippedOpen: s.skippedOpen ?? 0,
    avgCorridorWidthPct: avgCorridor,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runOne({ label, botConfig, signalCfg, days, symbols, getFundingOiAt, fetchers }) {
  log(`\n=== ${label} ===`);
  let last = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: false,
    getFundingOiAt,
    runMeta: { optimize: "pb-corridor", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 120 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      }
    },
  });
  const row = summarize(result);
  log(
    `→ PB $${row.pbPnl} · ${row.pbTrades} tr · TP ${row.tpRate}% · win ${row.winRate}% · sig skip ${row.pbSignalSkips} · avg cw ${row.avgCorridorWidthPct ?? "—"}%`
  );
  return { label, ...row };
}

function saveStore(store) {
  writeJsonFile(OUT_FILE(), { ...store, updatedAt: new Date().toISOString() });
}

async function main() {
  const { days, quick } = parseArgs(process.argv);
  installLiveArtifacts();
  const baseBot = loadLiveBotConfig();
  const baseSignal = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);

  const store = readJsonFile(OUT_FILE(), {
    days,
    symbolCount: symbols.length,
    runs: [],
    phase: null,
  });
  store.days = days;
  store.symbolCount = symbols.length;
  store.liveBase = {
    maxPullbackCorridorWidthPct: baseBot.maxPullbackCorridorWidthPct,
    pullbackCorridorBars: baseSignal.pullbackCorridorBars ?? 120,
    aiPullbackSignalGbm: baseBot.aiPullbackSignalFundingOiGbmEnabled,
  };

  log(`PB corridor optimize · ${days}d · ${symbols.length} symbols · PB-only · live AI stack`);

  const widthValues = quick ? WIDTH_PCT_QUICK : WIDTH_PCT_FULL;
  const barValues = quick ? CORRIDOR_BARS_QUICK : CORRIDOR_BARS_FULL;

  store.phase = "width_sweep";
  const widthRuns = [];
  for (const maxPullbackCorridorWidthPct of widthValues) {
    const label = `width_${maxPullbackCorridorWidthPct}`;
    const existing = store.runs.find((r) => r.label === label);
    if (existing) {
      log(`[skip] ${label} cached $${existing.pbPnl}`);
      widthRuns.push(existing);
      continue;
    }
    const row = await runOne({
      label,
      botConfig: { ...baseBot, maxPullbackCorridorWidthPct },
      signalCfg: { ...baseSignal, pullbackCorridorBars: 120 },
      days,
      symbols,
      getFundingOiAt,
      fetchers,
    });
    const full = {
      ...row,
      maxPullbackCorridorWidthPct,
      pullbackCorridorBars: 120,
    };
    widthRuns.push(full);
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(full);
    saveStore(store);
  }

  const bestWidth = [...widthRuns].sort((a, b) => b.pbPnl - a.pbPnl)[0];
  store.bestWidth = bestWidth;
  log(`\nBest width filter: ${bestWidth.maxPullbackCorridorWidthPct}% → PB $${bestWidth.pbPnl}`);

  store.phase = "bars_sweep";
  const barRuns = [];
  for (const pullbackCorridorBars of barValues) {
    const label = `bars_${pullbackCorridorBars}`;
    const existing = store.runs.find((r) => r.label === label);
    if (existing) {
      log(`[skip] ${label} cached $${existing.pbPnl}`);
      barRuns.push(existing);
      continue;
    }
    const row = await runOne({
      label,
      botConfig: {
        ...baseBot,
        maxPullbackCorridorWidthPct: bestWidth.maxPullbackCorridorWidthPct,
      },
      signalCfg: { ...baseSignal, pullbackCorridorBars },
      days,
      symbols,
      getFundingOiAt,
      fetchers,
    });
    const full = {
      ...row,
      maxPullbackCorridorWidthPct: bestWidth.maxPullbackCorridorWidthPct,
      pullbackCorridorBars,
    };
    barRuns.push(full);
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(full);
    saveStore(store);
  }

  const bestCombo = [...barRuns].sort((a, b) => b.pbPnl - a.pbPnl)[0];
  store.bestCombo = bestCombo;
  store.ranking = [...store.runs].sort((a, b) => b.pbPnl - a.pbPnl);
  store.recommendation = {
    maxPullbackCorridorWidthPct: bestCombo.maxPullbackCorridorWidthPct,
    pullbackCorridorBars: bestCombo.pullbackCorridorBars,
    pbPnl: bestCombo.pbPnl,
    pbTrades: bestCombo.pbTrades,
    tpRate: bestCombo.tpRate,
    winRate: bestCombo.winRate,
    vsLiveDefault: {
      width16bars120: widthRuns.find(
        (r) => r.maxPullbackCorridorWidthPct === 16 && r.pullbackCorridorBars === 120
      ),
      deltaPbPnl: +(
        bestCombo.pbPnl -
        (widthRuns.find((r) => r.maxPullbackCorridorWidthPct === 16)?.pbPnl ?? 0)
      ).toFixed(2),
    },
  };
  saveStore(store);

  log("\n=== TOP PB CORRIDOR SETTINGS ===");
  for (const r of store.ranking.slice(0, 10)) {
    log(
      `${r.label}: PB $${r.pbPnl} · ${r.pbTrades} tr · width≤${r.maxPullbackCorridorWidthPct}% · bars ${r.pullbackCorridorBars} · TP ${r.tpRate}%`
    );
  }
  log(`\nRecommended: width≤${store.recommendation.maxPullbackCorridorWidthPct}% · lookback ${store.recommendation.pullbackCorridorBars} bars (5m)`);
  log(`Results: ${OUT_FILE()}`);
  console.log(JSON.stringify(store.recommendation, null, 2));
}

main().catch((e) => {
  log(e.stack || e.message || String(e));
  process.exit(1);
});
