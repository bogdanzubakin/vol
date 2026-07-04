#!/usr/bin/env node
/**
 * Probe profitable AI training order on cached backtest data, optimize + train all models,
 * apply best configs to paper/live, and optionally push to Railway.
 *
 *   node scripts/train-all-ai-and-deploy.js --days 30
 *   node scripts/train-all-ai-and-deploy.js --days 30 --quick
 *   node scripts/train-all-ai-and-deploy.js --days 30 --probe-only
 *   node scripts/train-all-ai-and-deploy.js --days 30 --skip-optimize --push
 *   node scripts/train-all-ai-and-deploy.js --days 30 --skip-probe --push
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { ensureMinHeapMb, execNode, nodeChildEnv } = require("../lib/node-mem");
ensureMinHeapMb();
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { pickLiveConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");

const ROOT = path.join(__dirname, "..");

const LAYER_DEFS = [
  {
    id: "sfp_regime",
    label: "SFP regime + BTC",
    optimizeScript: "compare-sfp-regime-btc.js",
    resultsFile: "sfp-regime-btc-compare.json",
    probePatch: {
      aiSfpRegimeEnabled: true,
      aiSfpRegimeBullThreshold: 0.76,
      aiSfpRegimeBearThreshold: 0.72,
      aiRegimeBtcLookbackHours: 24,
    },
  },
  {
    id: "pullback",
    label: "Pullback signal + regime",
    optimizeScript: "optimize-pullback-params.js",
    resultsFile: "pullback-optimization-results.json",
    probePatch: {
      aiPullbackSignalEnabled: true,
      aiPullbackSignalBullThreshold: 0.52,
      aiPullbackSignalBearThreshold: 0.54,
      aiPullbackRegimeEnabled: true,
      aiPullbackRegimeBullThreshold: 0.76,
      aiPullbackRegimeBearThreshold: 0.74,
    },
  },
  {
    id: "early_exit",
    label: "SFP early exit",
    optimizeScript: "optimize-early-exit-params.js",
    resultsFile: "early-exit-optimization-results.json",
    probePatch: {
      aiEarlyExitEnabled: true,
      aiEarlyExitHardThreshold: 0.76,
      aiEarlyExitSoftThreshold: 0.88,
      aiEarlyExitMinBars: 9,
    },
  },
  {
    id: "exit_levels",
    label: "AI exit levels (SL/TP)",
    optimizeScript: "optimize-ai-exit-levels-params.js",
    resultsFile: "ai-exit-levels-optimization-results.json",
    trainedFile: "ai-exit-levels-trained.json",
    probePatch: {
      aiExitLevelsEnabled: true,
      aiExitLevelsLegacyDisabled: true,
      aiExitLevelsMode: "legacy_scale",
      aiExitLevelsSlScale: 1.15,
      aiExitLevelsTpScale: 1.15,
      smartExitLevelsEnabled: true,
    },
  },
];

const BEST_SCANNER = {
  interval: "5m",
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
};

function parseArgs(argv) {
  const daysIdx = argv.indexOf("--days");
  return {
    days:
      daysIdx >= 0 && argv[daysIdx + 1]
        ? Math.max(1, Math.min(60, Math.round(Number(argv[daysIdx + 1])) || 30))
        : 30,
    quick: argv.includes("--quick"),
    probeOnly: argv.includes("--probe-only"),
    skipOptimize: argv.includes("--skip-optimize"),
    skipTrain: argv.includes("--skip-train"),
    skipBacktest: argv.includes("--skip-backtest"),
    skipProbe: argv.includes("--skip-probe"),
    push: argv.includes("--push"),
  };
}

function log(msg) {
  console.error(String(msg));
}

function runNode(script, extraArgs = []) {
  log(`\n▶ node ${[script, ...extraArgs].join(" ")}`);
  execNode(path.join("scripts", script), extraArgs, { cwd: ROOT, stdio: "inherit" });
}

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((sym) => readSymbolBars("mover", sym)?.length)
    .sort();
}

function loadBaseBot() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiLevelBreakRegimeEnabled: false,
    tradeLevelBreakSignals: false,
    tradeLevelBreakBearSignals: false,
  });
}

function loadSignalConfig() {
  const cfg = { ...BEST_SCANNER, corridorDays: 2, corridorExcludeMinutes: 40, signalCandles: 3 };
  scannerConfig.loadInto(cfg);
  return cfg;
}

function createFetchers() {
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "mover", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
}

async function probeLayerOrder(days, symbols) {
  log(`\n=== PROBE: marginal PnL per AI layer (${days}d · ${symbols.length} symbols) ===`);
  const baseBot = loadBaseBot();
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const layers = [];
  let cumulativePatch = {};

  for (const def of LAYER_DEFS) {
    cumulativePatch = { ...cumulativePatch, ...def.probePatch };
    const botConfig = normalizeConfig({ ...baseBot, ...cumulativePatch });
    const started = Date.now();
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
      runMeta: { probe: "train-order", layer: def.id },
    });
    const pnl = +(result.summary?.realizedPnl ?? 0).toFixed(2);
    const prevPnl = layers.length ? layers[layers.length - 1].cumulativePnl : 0;
    const marginal = +(pnl - prevPnl).toFixed(2);
    layers.push({
      id: def.id,
      label: def.label,
      cumulativePnl: pnl,
      marginalPnl: marginal,
      trades: result.summary?.closedCount ?? 0,
      elapsedSec: Math.round((Date.now() - started) / 1000),
    });
    log(
      `  + ${def.label}: cumulative $${pnl} (Δ +$${marginal}) · ${layers[layers.length - 1].trades} tr · ${layers[layers.length - 1].elapsedSec}s`
    );
  }

  const ranked = [...layers].sort((a, b) => (b.marginalPnl ?? 0) - (a.marginalPnl ?? 0));
  const order = ranked.map((r) => r.id);
  const store = {
    days,
    symbolCount: symbols.length,
    probedAt: new Date().toISOString(),
    layers,
    trainingOrder: order,
    rationale:
      "Optimize/train layers in descending marginal PnL order; each step uses cumulative config from prior winners.",
  };
  writeJsonFile(dataPath("ai-training-order.json"), store);
  log("\n=== TRAINING ORDER (by marginal PnL) ===");
  for (const r of ranked) {
    log(`  ${r.id}: Δ $${r.marginalPnl} (cumulative $${r.cumulativePnl})`);
  }
  log(`\nSaved: ${dataPath("ai-training-order.json")}`);
  return order;
}

function loadTrainingOrder() {
  const saved = readJsonFile(dataPath("ai-training-order.json"), null);
  if (saved?.trainingOrder?.length) return saved.trainingOrder;
  return LAYER_DEFS.map((d) => d.id);
}

function patchBotState(relFile, patch, { keepLeverage } = {}) {
  const file = dataPath(relFile);
  const raw = readJsonFile(file, { config: {} });
  const prev = raw.config ?? {};
  const merged = normalizeConfig({
    ...prev,
    ...patch,
    ...(keepLeverage ? { leverage: prev.leverage } : {}),
  });
  writeJsonFile(file, { ...raw, config: merged });
  return merged;
}

function applyScannerPatch(signalPatch = {}) {
  const current = readJsonFile(scannerConfig.CONFIG_FILE(), {});
  const merged = pickLiveConfig({ ...BEST_SCANNER, ...current, ...signalPatch, interval: "5m" });
  writeJsonFile(scannerConfig.CONFIG_FILE(), merged);
}

function extractSfpPatch(store) {
  const ranked = [...(store?.runs ?? [])].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const best = ranked[0];
  if (!best?.botConfig) return null;
  return {
    aiSfpRegimeEnabled: true,
    aiSfpRegimeBullThreshold: best.botConfig.aiSfpRegimeBullThreshold,
    aiSfpRegimeBearThreshold: best.botConfig.aiSfpRegimeBearThreshold,
    aiRegimeBtcLookbackHours: best.botConfig.aiRegimeBtcLookbackHours,
  };
}

function extractPullbackPatch(store) {
  const ranked = [...(store?.runs ?? [])].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const best = ranked[0];
  if (!best) return { bot: null, signal: null };
  return {
    bot: best.botPatch ?? null,
    signal: best.signalPatch ?? null,
    label: best.label,
  };
}

function extractEarlyExitPatch(store) {
  const ranked = [...(store?.runs ?? [])].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const best = ranked[0];
  if (!best?.botConfig) return null;
  return {
    aiEarlyExitEnabled: true,
    aiEarlyExitHardThreshold: best.botConfig.aiEarlyExitHardThreshold,
    aiEarlyExitSoftThreshold: best.botConfig.aiEarlyExitSoftThreshold,
    aiEarlyExitMinBars: best.botConfig.aiEarlyExitMinBars,
  };
}

function extractExitLevelsPatch(store, trainedFile) {
  const trained = readJsonFile(dataPath(trainedFile), null);
  if (trained?.recommend) return trained.recommend;
  const ranked = [...(store?.runs ?? [])].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const best = ranked[0];
  return best?.botPatch ?? null;
}

function applyBestConfigs(order) {
  log("\n=== APPLY best configs to paper + live ===");
  const merged = {};

  for (const id of order) {
    const def = LAYER_DEFS.find((d) => d.id === id);
    if (!def) continue;
    const store = readJsonFile(dataPath(def.resultsFile), null);
    if (!store) {
      log(`  skip ${id}: missing ${def.resultsFile}`);
      continue;
    }

    if (id === "sfp_regime") {
      const patch = extractSfpPatch(store);
      if (patch) Object.assign(merged, patch);
    } else if (id === "pullback") {
      const { bot, signal, label } = extractPullbackPatch(store);
      if (bot) Object.assign(merged, bot);
      if (signal && Object.keys(signal).length) applyScannerPatch(signal);
      if (label) log(`  pullback best: ${label}`);
    } else if (id === "early_exit") {
      const patch = extractEarlyExitPatch(store);
      if (patch) Object.assign(merged, patch);
    } else if (id === "exit_levels") {
      const patch = extractExitLevelsPatch(store, def.trainedFile);
      if (patch) Object.assign(merged, patch);
    }
  }

  applyScannerPatch();
  patchBotState("paper-bot-state.json", merged);
  patchBotState("live-bot-state.json", merged, { keepLeverage: true });
  writeJsonFile(dataPath("ai-training-applied-config.json"), {
    appliedAt: new Date().toISOString(),
    patch: merged,
    order,
  });
  log(`  merged ${Object.keys(merged).length} config keys`);
  log(`  saved ${dataPath("ai-training-applied-config.json")}`);
  return merged;
}

async function trainAllModels(days) {
  log("\n=== TRAIN all models (paper + live) ===");

  runNode("apply-best-training-config.js", [
    "--days",
    String(days),
    "--skip-backtest",
  ]);

  const scopedTrains = [
    "train-pullback-signal-model.js",
    "train-pullback-regime-model.js",
    "train-early-exit-model.js",
  ];

  for (const scope of ["paper", "live"]) {
    for (const script of scopedTrains) {
      runNode(script, ["--source", "backtest", "--scope", scope]);
    }
  }

  runNode("train-ai-exit-levels.js", ["--days", String(days), "--skip-backtest"]);
}

async function main() {
  const args = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols — run extend-backtest-klines.js first.");
    process.exit(1);
  }

  const manifest = readJsonFile(dataPath("backtest-klines/manifest.json"), null);
  log(
    `AI train & deploy · ${args.days}d · ${symbols.length} symbols` +
      (manifest?.days ? ` · cache manifest ${manifest.days}d` : "")
  );

  const order = args.skipProbe
    ? loadTrainingOrder()
    : await probeLayerOrder(args.days, symbols);

  if (args.probeOnly) {
    log("\nProbe only — exiting.");
    return;
  }

  const optimizeOrder = loadTrainingOrder();
  log(`\nOptimize order: ${optimizeOrder.join(" → ")}`);

  if (!args.skipOptimize) {
    log("\n=== OPTIMIZE (full pipeline) ===");
    if (!args.skipBacktest) {
      runNode("run-cached-train-backtest.js", [`--days`, String(args.days)]);
    }
    const quickFlag = args.quick ? ["--quick"] : [];
    const cacheFlag = ["--cache-only"];
    for (const id of optimizeOrder) {
      const def = LAYER_DEFS.find((d) => d.id === id);
      if (!def) continue;
      const extra =
        def.id === "early_exit" || def.id === "exit_levels"
          ? [...cacheFlag, ...quickFlag, "--days", String(args.days)]
          : ["--days", String(args.days), ...quickFlag];
      runNode(def.optimizeScript, extra);
    }
  }

  applyBestConfigs(optimizeOrder);

  if (!args.skipTrain) {
    await trainAllModels(args.days);
  }

  if (args.push) {
    log("\n=== PUSH to Railway ===");
    execNode(path.join("scripts", "push-railway-data.js"), [], {
      cwd: ROOT,
      stdio: "inherit",
      env: nodeChildEnv({
        RAILWAY_URL:
          process.env.RAILWAY_URL ||
          process.env.VOL_RAILWAY_URL ||
          "https://vol-production-d574.up.railway.app",
        VOL_SESSION_COOKIE_FILE:
          process.env.VOL_SESSION_COOKIE_FILE ||
          path.join(ROOT, "scripts", ".vol-railway-cookie"),
      }),
    });
  } else {
    log("\nPush when ready: node scripts/train-all-ai-and-deploy.js --days 30 --skip-optimize --push");
  }

  log("\nDone.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
