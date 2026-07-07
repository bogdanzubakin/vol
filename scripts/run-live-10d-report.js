#!/usr/bin/env node
/**
 * Pull Railway live settings (mirror), install models, run 10d cached backtest, write full report.
 *
 *   RAILWAY_URL=... VOL_SESSION_COOKIE_FILE=scripts/.vol-railway-cookie \
 *     node scripts/run-live-10d-report.js --days 10
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { buildBacktestExport } = require("../lib/backtest-export");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { onnxDir: pbOnnxDir } = require("../lib/pullback-signal-onnx");
const { onnxDir: sfpOnnxDir } = require("../lib/sfp-regime-onnx");

const ROOT = path.join(__dirname, "..");
const MIRROR = path.join(ROOT, ".cache", "railway-mirror");
const REPORT_FILE = () => dataPath("live-10d-backtest-report.json");

function parseArgs(argv) {
  let days = 10;
  let skipPull = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--skip-pull") skipPull = true;
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 10)), skipPull };
}

function log(line) {
  console.error(String(line));
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
  if (!fs.existsSync(src)) return { copied: 0, dest };
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    if (!fs.statSync(srcPath).isFile()) continue;
    fs.copyFileSync(srcPath, path.join(dest, name));
    copied++;
  }
  return { copied, dest };
}

function installMirrorModels() {
  const installed = [];
  const pairs = [
    ["sfp-regime-model-live.json", modelFileFor("sfp-regime-model", "paper")],
    ["sfp-regime-model-live.json", modelFileFor("sfp-regime-model", "live")],
    ["pullback-signal-model-live.json", modelFileFor("pullback-signal-model", "paper")],
    ["pullback-signal-model-live.json", modelFileFor("pullback-signal-model", "live")],
    ["ai-exit-levels-live.json", modelFileFor("ai-exit-levels", "paper")],
    ["ai-exit-levels-live.json", modelFileFor("ai-exit-levels", "live")],
    ["early-exit-model-live.json", dataPath("early-exit-sfp.json")],
  ];
  for (const [srcName, dest] of pairs) {
    const src = path.join(MIRROR, srcName);
    if (copyFile(src, dest)) installed.push({ src: srcName, dest });
  }
  const onnx = {
    pullback: copyOnnxDir("live", "paper", pbOnnxDir),
    sfp: copyOnnxDir("live", "paper", sfpOnnxDir),
  };
  reloadSfp("paper");
  reloadSfp("live");
  reloadPbSignal("paper");
  reloadPbSignal("live");
  reloadExitLevels("paper");
  reloadExitLevels("live");
  return { installed, onnx };
}

function loadLiveConfigFromMirror() {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {}).config || {};
  return normalizeLiveConfig({ enabled: true, ...raw });
}

function loadSignalConfigFromMirror() {
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

function aiFlags(cfg) {
  return {
    sfpRegime: Boolean(cfg.aiSfpRegimeEnabled),
    sfpRegimeGbm: Boolean(cfg.aiSfpRegimeFundingOiGbmEnabled),
    sfpBullTh: cfg.aiSfpRegimeGbmBullThreshold ?? cfg.aiSfpRegimeBullThreshold,
    sfpBearTh: cfg.aiSfpRegimeGbmBearThreshold ?? cfg.aiSfpRegimeBearThreshold,
    pbSignal: Boolean(cfg.aiPullbackSignalEnabled),
    pbSignalGbm: Boolean(cfg.aiPullbackSignalFundingOiGbmEnabled),
    pbBullTh: cfg.aiPullbackSignalGbmBullThreshold ?? cfg.aiPullbackSignalBullThreshold,
    pbBearTh: cfg.aiPullbackSignalGbmBearThreshold ?? cfg.aiPullbackSignalBearThreshold,
    pbRegime: Boolean(cfg.aiPullbackRegimeEnabled),
    exitLevels: Boolean(cfg.aiExitLevelsEnabled),
    exitLevelsTpScale: cfg.aiExitLevelsTpScale,
    exitLevelsSlScale: cfg.aiExitLevelsSlScale,
    earlyExit: Boolean(cfg.aiEarlyExitEnabled),
    drawdownStop: Boolean(cfg.drawdownStopEnabled),
    drawdownStopPct: cfg.drawdownStopPct,
  };
}

function breakdownBySignal(trades) {
  const kinds = ["sfp", "sfp_bear", "pullback", "pullback_bear"];
  const out = {};
  for (const k of kinds) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    const pnl = rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const tp = rows.filter((t) => t.exitReason === "take_profit").length;
    const sl = rows.filter((t) => t.exitReason === "stop_loss").length;
    out[k] = {
      trades: rows.length,
      pnl: +pnl.toFixed(2),
      winRate: +((100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) / rows.length).toFixed(1),
      tpRate: +((100 * tp) / rows.length).toFixed(1),
      slRate: +((100 * sl) / rows.length).toFixed(1),
    };
  }
  return out;
}

function breakdownByExit(trades) {
  const map = new Map();
  for (const t of trades) {
    const r = t.exitReason || "unknown";
    if (!map.has(r)) map.set(r, { count: 0, pnl: 0 });
    const row = map.get(r);
    row.count++;
    row.pnl += Number(t.pnl) || 0;
  }
  return [...map.entries()]
    .map(([reason, v]) => ({
      reason,
      count: v.count,
      pnl: +v.pnl.toFixed(2),
      share: 0,
    }))
    .sort((a, b) => b.count - a.count)
    .map((r, _i, arr) => ({
      ...r,
      share: trades.length ? +((100 * r.count) / trades.length).toFixed(1) : 0,
    }));
}

function pullRailway() {
  const baseUrl =
    process.env.RAILWAY_URL ||
    process.env.VOL_RAILWAY_URL ||
    readJsonFile(path.join(MIRROR, "pull-meta.json"), {})?.baseUrl;
  if (!baseUrl) throw new Error("Set RAILWAY_URL");
  log(`Pulling live settings from ${baseUrl}…`);
  const pull = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "pull-railway-data.js"), "--url", baseUrl],
    {
      cwd: ROOT,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  if (pull.stdout) process.stderr.write(pull.stdout);
  if (pull.status !== 0) {
    log(`pull-railway-data exited ${pull.status} (continuing with partial mirror)`);
    if (pull.stderr) log(pull.stderr.slice(-500));
  }
  const extra = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "fetch-railway-models-extra.js")],
    { cwd: ROOT, env: { ...process.env, RAILWAY_URL: baseUrl }, encoding: "utf8" }
  );
  if (extra.status === 0 && extra.stdout) log(extra.stdout.trim());
}

async function main() {
  const { days, skipPull } = parseArgs(process.argv);
  if (!skipPull) pullRailway();

  const mirrorMeta = readJsonFile(path.join(MIRROR, "pull-meta.json"), {});
  const models = installMirrorModels();
  const botConfig = loadLiveConfigFromMirror();
  const signalCfg = loadSignalConfigFromMirror();
  const symbols = cachedSymbolList();
  if (!symbols.length) throw new Error("No cached symbols — run kline backtest first");

  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);
  const fetchers = createFetchers();

  log(`\nLive 10d report · ${days}d · ${symbols.length} symbols`);
  log(`Leverage ${botConfig.leverage}x · margin $${botConfig.positionSizeUsdt} · max pos ${botConfig.maxOpenPositions}`);
  log(`TP ${botConfig.takeProfitPct}% (min ${botConfig.takeProfitMinPct}%) · SFP TP ${botConfig.sfpTakeProfitPct}%`);
  log(`AI: ${JSON.stringify(aiFlags(botConfig))}`);

  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveLastResult: true,
    getFundingOiAt,
    runMeta: { report: "live-10d", days, mirrorPulledAt: mirrorMeta.pulledAt ?? null },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          log(`[simulate] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });

  const trades = result.closedTrades ?? [];
  const s = result.summary ?? {};
  const exportBundle = buildBacktestExport({
    includeSourceCode: false,
    includeEvents: true,
    includeEquityCurve: true,
  });

  const report = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    mirror: {
      pulledAt: mirrorMeta.pulledAt ?? null,
      baseUrl: mirrorMeta.baseUrl ?? null,
      modelsInstalled: models,
    },
    liveConfig: botConfig,
    signalConfig: signalCfg,
    aiFlags: aiFlags(botConfig),
    summary: {
      realizedPnl: s.realizedPnl,
      closedCount: s.closedCount,
      winCount: s.winCount,
      lossCount: s.lossCount,
      winRate: s.closedCount
        ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
        : 0,
      sfpSignals: s.sfpSignals,
      sfpBearSignals: s.sfpBearSignals,
      pullbackSignals: s.pullbackSignals,
      pullbackBearSignals: s.pullbackBearSignals,
      sfpRegimeSkips: s.sfpRegimeSkips,
      sfpRegimeSkipsBull: s.sfpRegimeSkipsBull,
      sfpRegimeSkipsBear: s.sfpRegimeSkipsBear,
      pullbackRegimeSkips: s.pullbackRegimeSkips,
      pullbackSignalSkips: s.pullbackSignalSkips,
      skippedOpen: s.skippedOpen,
      aiExits: s.aiExits,
      elapsedSec: result.elapsedSec,
    },
    bySignal: breakdownBySignal(trades),
    byExitReason: breakdownByExit(trades),
    topWinners: result.topWinners?.slice(0, 15) ?? [],
    topLosers: result.topLosers?.slice(0, 15) ?? [],
    analytics: exportBundle.analytics ?? null,
    events: exportBundle.events ?? null,
    equityCurve: exportBundle.equityCurve ?? null,
    integrity: exportBundle.integrity ?? null,
  };

  writeJsonFile(REPORT_FILE(), report);
  console.log(JSON.stringify(report, null, 2));
  log(`\nFull report: ${REPORT_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
