#!/usr/bin/env node
/** Retrain SFP + pullback signal with given fast BTC hours (uses sweep train caches if present). */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(12288);

const { dataPath, readJsonFile } = require("../lib/data-dir");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const {
  trainFromTrades: trainSfpFromTrades,
  reloadModel: reloadSfpModel,
  saveModel: saveSfpModel,
  getModel: getSfpModel,
} = require("../lib/sfp-regime-model");
const {
  trainFromTrades: trainPbSignalFromTrades,
  reloadModel: reloadPbSignalModel,
} = require("../lib/pullback-signal-model");

const ROOT = path.join(__dirname, "..");
const CACHE = () => dataPath("btc-fast-sweep-train-trades.json");

function log(m) {
  console.error(String(m));
}

function parseArgs(argv) {
  let fastH = 2;
  let liveDbDir = process.env.LIVE_DB_DIR || path.join(ROOT, ".cache", "remote-db");
  let days = 50;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--fast" && argv[i + 1]) fastH = Math.round(Number(argv[++i]));
    else if (argv[i] === "--live-db" && argv[i + 1]) liveDbDir = argv[++i];
    else if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  return { fastH, liveDbDir, days };
}

function loadLiveConfig(liveDbDir) {
  const db = new (require("better-sqlite3"))(path.join(liveDbDir, "vol.db"), { readonly: true });
  try {
    const { loadBotRuntime } = require("../lib/db/repos/bot-state");
    const runtime = loadBotRuntime(db, "live");
    return normalizeLiveConfig({ enabled: true, ...runtime.config });
  } finally {
    db.close();
  }
}

function fetchBarsAll(sym) {
  const s = String(sym).toUpperCase();
  return readSymbolBars("mover", s) ?? readSymbolBars("signal", s) ?? [];
}

async function main() {
  const { fastH, liveDbDir, days } = parseArgs(process.argv);
  let cache = readJsonFile(CACHE(), null);
  if (!cache?.sfpTrades?.length) {
    log("No train cache — need sfp/pb train backtests first");
    process.exit(1);
  }
  const liveConfig = {
    ...loadLiveConfig(liveDbDir),
    aiRegimeBtcFastLookbackHours: fastH,
    aiPullbackSignalBtcFastLookbackHours: fastH,
  };
  log(`Apply fast BTC ${fastH}h to live+paper models`);

  for (const scope of ["live", "paper"]) {
    await trainSfpFromTrades(cache.sfpTrades, fetchBarsAll, {
      modelScope: scope,
      source: `apply:btc-fast-${fastH}h:${scope}`,
      btcFeaturesEnabled: true,
      aiRegimeBtcLookbackHours: liveConfig.aiRegimeBtcLookbackHours ?? 24,
      aiRegimeBtcFastLookbackHours: fastH,
    });
    reloadSfpModel(scope);
    const m = getSfpModel(scope);
    saveSfpModel(
      {
        ...m,
        bull: { ...m.bull, threshold: liveConfig.aiSfpRegimeGbmBullThreshold ?? liveConfig.aiSfpRegimeBullThreshold },
        bear: { ...m.bear, threshold: liveConfig.aiSfpRegimeGbmBearThreshold ?? liveConfig.aiSfpRegimeBearThreshold },
      },
      scope
    );
    reloadSfpModel(scope);

    await trainPbSignalFromTrades(cache.pbTrades, fetchBarsAll, {
      modelScope: scope,
      source: `apply:btc-fast-${fastH}h:${scope}`,
      aiPullbackSignalBtcLookbackHours: liveConfig.aiPullbackSignalBtcLookbackHours ?? 24,
      aiPullbackSignalBtcFastLookbackHours: fastH,
    });
    reloadPbSignalModel(scope);
    log(`  scope ${scope} done`);
  }
  log(`Applied fast ${fastH}h`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
