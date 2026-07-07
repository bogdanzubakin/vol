#!/usr/bin/env node
/**
 * Complete 1m migration: apply winning settings, train/sync models (paper+live), push Railway.
 *
 *   node scripts/migrate-railway-1m.js
 *   node scripts/migrate-railway-1m.js --skip-train --skip-push
 */
const { ensureMinHeapMb, execNode, nodeChildEnv } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { copyGbmOnnxDir } = require("../lib/gbm-model-import");

const ROOT = path.join(__dirname, "..");
const OPTIMIZE_FILE = () => dataPath("optimize-1m-config-10d.json");
const MODEL_DIR = path.join(".cache", "interval-10d-models", "1m");

function log(msg) {
  console.error(String(msg));
}

function parseArgs(argv) {
  return {
    skipTrain: argv.includes("--skip-train"),
    skipPush: argv.includes("--skip-push"),
    days: (() => {
      const i = argv.indexOf("--days");
      return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 10;
    })(),
  };
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function syncModelToLive(paperRel, liveRel) {
  const src = dataPath(paperRel);
  const dest = dataPath(liveRel);
  if (!copyFile(src, dest)) {
    log(`  skip live copy: missing ${paperRel}`);
    return false;
  }
  return true;
}

function install1mModelsFromCache() {
  function pickInstall(name, dest) {
    const onnx = path.join(MODEL_DIR, name.replace(".json", "-onnx.json").replace("funding-onnx", "onnx"));
    const onnxAlt = path.join(MODEL_DIR, name.includes("sfp") ? "sfp-regime-onnx.json" : name.includes("pullback") ? "pullback-signal-onnx.json" : name);
    const plain = path.join(MODEL_DIR, name);
    const src = [onnxAlt, onnx, plain].find((p) => fs.existsSync(p));
    if (src) copyFile(src, dest);
    return src;
  }
  pickInstall("sfp-regime-onnx.json", modelFileFor("sfp-regime-model", "paper"));
  pickInstall("pullback-signal-onnx.json", modelFileFor("pullback-signal-model", "paper"));
  copyFile(path.join(MODEL_DIR, "early-exit-sfp.json"), dataPath("early-exit-sfp.json"));
  copyFile(path.join(MODEL_DIR, "ai-exit-levels.json"), modelFileFor("ai-exit-levels", "paper"));
  for (const basename of ["sfp-regime-onnx", "pullback-signal-onnx"]) {
    const srcDir = path.join(MODEL_DIR, basename);
    if (!fs.existsSync(srcDir)) continue;
    const destDir = dataPath(`${basename}-paper`);
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      const p = path.join(srcDir, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(destDir, f));
    }
  }
}

function applyWinningConfig() {
  const store = readJsonFile(OPTIMIZE_FILE(), null);
  if (!store?.bestBot || !store?.bestSignal) {
    throw new Error(`Missing ${OPTIMIZE_FILE()} — run optimize-1m-config-10d.js first`);
  }
  const bot = normalizeLiveConfig({ ...store.bestBot, enabled: true });
  const signal = { ...store.bestSignal, interval: "1m", pullbackCorridorBars: 120 };
  applyBarConfig(signal);

  writeJsonFile(dataPath("scanner-config.json"), signal);
  for (const rel of ["paper-bot-state.json", "live-bot-state.json"]) {
    const raw = readJsonFile(dataPath(rel), { config: {} });
    writeJsonFile(dataPath(rel), {
      ...raw,
      config: bot,
      savedAt: Date.now(),
    });
  }
  log("✓ Applied winning 1m config to scanner + paper/live bot");
  return { bot, signal };
}

function syncPaperToLiveModels() {
  log("\n=== Sync paper → live model files ===");
  const pairs = [
    ["sfp-regime-model.json", "sfp-regime-model-live.json"],
    ["pullback-signal-model.json", "pullback-signal-model-live.json"],
    ["early-exit-sfp.json", "early-exit-sfp-live.json"],
    ["ai-exit-levels.json", "ai-exit-levels-live.json"],
  ];
  for (const [paper, live] of pairs) {
    if (syncModelToLive(paper, live)) log(`  ✓ ${live}`);
  }
  copyGbmOnnxDir({ basename: "sfp-regime-onnx", fromScope: "paper", toScope: "live" });
  copyGbmOnnxDir({ basename: "pullback-signal-onnx", fromScope: "paper", toScope: "live" });
  log("  ✓ GBM onnx dirs paper → live");
}

function train1mModels(days) {
  log(`\n=== Train 1m models (${days}d) ===`);
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "optimize-1m-config-10d.js"), "--days", String(days)],
    { cwd: ROOT, stdio: "inherit", env: process.env }
  );
  if (res.status !== 0) throw new Error("1m training failed");
  install1mModelsFromCache();
}

function pushRailway() {
  log("\n=== Push to Railway ===");
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
}

function verifyPull() {
  log("\n=== Verify Railway mirror ===");
  const pull = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "pull-railway-data.js")],
    {
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
    }
  );
  if (pull.status !== 0) log("Pull had errors (check manually)");
  const mirrorScanner = readJsonFile(path.join(ROOT, ".cache", "railway-mirror", "scanner-config.json"), {});
  const mirrorLive = readJsonFile(path.join(ROOT, ".cache", "railway-mirror", "live-bot-state.json"), {})
    .config;
  log(`Railway interval: ${mirrorScanner.interval ?? "?"}`);
  log(`Railway live leverage: ${mirrorLive?.leverage ?? "?"} · SFP GBM ${mirrorLive?.aiSfpRegimeFundingOiGbmEnabled}`);
}

async function main() {
  const { skipTrain, skipPush, days } = parseArgs(process.argv);
  log("1m Railway migration — paper + live");

  const { bot } = applyWinningConfig();

  if (skipTrain) {
    log("\n=== Using cached 1m models ===");
    install1mModelsFromCache();
  } else {
    train1mModels(days);
  }

  syncPaperToLiveModels();

  writeJsonFile(dataPath("migrate-railway-1m.json"), {
    migratedAt: new Date().toISOString(),
    interval: "1m",
    botSummary: {
      leverage: bot.leverage,
      takeProfitPct: bot.takeProfitPct,
      stopLossBelowCorridorPct: bot.stopLossBelowCorridorPct,
      sfpGbm: `${bot.aiSfpRegimeGbmBullThreshold}/${bot.aiSfpRegimeGbmBearThreshold}`,
      pbGbm: `${bot.aiPullbackSignalGbmBullThreshold}/${bot.aiPullbackSignalGbmBearThreshold}`,
      aiExitScales: `${bot.aiExitLevelsSlScale}/${bot.aiExitLevelsTpScale}`,
      earlyExit: `${bot.aiEarlyExitHardThreshold}/${bot.aiEarlyExitSoftThreshold} min${bot.aiEarlyExitMinBars}`,
    },
    optimizePnl: readJsonFile(OPTIMIZE_FILE(), {})?.best?.pnl ?? null,
  });

  if (!skipPush) {
    pushRailway();
    verifyPull();
  } else {
    log("\nSkip push — run: node scripts/push-railway-data.js");
  }

  log("\nDone. Deploy app code to Railway for GBM bundle import (index.js gbmBundles support).");
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
