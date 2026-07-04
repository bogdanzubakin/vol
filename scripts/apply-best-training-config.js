#!/usr/bin/env node
/**
 * Apply settings from the highest-PnL training run (sfp-regime-btc-compare.json),
 * retrain SFP regime models with matching BTC lookback, and optionally push to Railway.
 *
 *   node scripts/apply-best-training-config.js
 *   node scripts/apply-best-training-config.js --push
 *   node scripts/apply-best-training-config.js --skip-backtest --skip-train
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
const { normalizeAiModelScope } = require("../lib/ai-model-scope");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const {
  trainFromTrades,
  reloadModel,
  saveModel,
  getModel,
  MODEL_FILE,
} = require("../lib/sfp-regime-model");

const COMPARE_FILE = () => dataPath("sfp-regime-btc-compare.json");
const ROOT = path.join(__dirname, "..");

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
  levelBreakPivotBars: 4,
  levelBreakLookbackBars: 300,
  levelBreakMinTouches: 5,
  levelBreakTouchPct: 0.25,
  levelBreakMinPct: 0.12,
  levelBreakApproachPct: 0.4,
  levelBreakApproachBars: 8,
};

const BEST_BOT_PATCH = {
  earlyAbortEnabled: false,
  runnerEnabled: false,
  aiEarlyExitEnabled: false,
  aiLevelBreakRegimeEnabled: false,
  aiSfpRegimeEnabled: true,
  aiSfpRegimeBullThreshold: 0.76,
  aiSfpRegimeBearThreshold: 0.72,
  aiRegimeBtcLookbackHours: 24,
};

function parseArgs(argv) {
  return {
    push: argv.includes("--push"),
    skipBacktest: argv.includes("--skip-backtest"),
    skipTrain: argv.includes("--skip-train"),
    days: (() => {
      const i = argv.indexOf("--days");
      return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : null;
    })(),
  };
}

function loadBestRun() {
  const store = readJsonFile(COMPARE_FILE(), null);
  if (!store?.runs?.length) {
    throw new Error(`Missing ${COMPARE_FILE()} — run compare-sfp-regime-btc.js first`);
  }
  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const best = ranked[0];
  const bot = { ...BEST_BOT_PATCH, ...(best.botConfig ?? {}) };
  return {
    label: best.label,
    pnl: best.pnl,
    days: store.days ?? 10,
    botConfig: bot,
    scanner: BEST_SCANNER,
  };
}

function patchBotState(relFile, configPatch, { keepLeverage } = {}) {
  const file = dataPath(relFile);
  const raw = readJsonFile(file, { config: {} });
  const prev = raw.config ?? {};
  const merged = normalizeConfig({
    ...prev,
    ...configPatch,
    ...(keepLeverage ? { leverage: prev.leverage } : {}),
  });
  writeJsonFile(file, { ...raw, config: merged });
  return merged;
}

function applyScannerConfig(scanner) {
  writeJsonFile(scannerConfig.CONFIG_FILE(), pickLiveConfig({ ...scanner, interval: scanner.interval }));
}

async function trainScope(scope, btcHours, bullTh, bearTh) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 12) {
    throw new Error(`Need >=12 SFP trades in backtest cache (got ${trades.length})`);
  }

  function fetchBars(symbol) {
    const sym = String(symbol).toUpperCase();
    return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
  }

  await trainFromTrades(trades, fetchBars, {
    modelScope: scope,
    source: `best-training:${scope}`,
    btcFeaturesEnabled: true,
    aiRegimeBtcLookbackHours: btcHours,
  });
  reloadModel(scope);

  const model = getModel(scope);
  const stored = {
    ...model,
    bull: { ...model.bull, threshold: bullTh },
    bear: { ...model.bear, threshold: bearTh },
  };
  saveModel(stored, scope);

  const bw = stored.bull?.weights ?? [];
  return {
    scope,
    path: MODEL_FILE(scope),
    btcWeights: [bw[12] ?? 0, bw[13] ?? 0],
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const best = loadBestRun();
  const days = args.days ?? best.days ?? 10;

  console.log(`Best training run: ${best.label} · $${best.pnl} (${days}d cache)`);
  console.log(
    `Regime: ON · bull ${best.botConfig.aiSfpRegimeBullThreshold} · bear ${best.botConfig.aiSfpRegimeBearThreshold} · BTC ${best.botConfig.aiRegimeBtcLookbackHours}h\n`
  );

  applyScannerConfig(best.scanner);
  console.log("✓ scanner-config.json");

  patchBotState("paper-bot-state.json", best.botConfig);
  console.log("✓ paper-bot-state.json");

  patchBotState("live-bot-state.json", best.botConfig, { keepLeverage: true });
  console.log("✓ live-bot-state.json (leverage unchanged)");

  if (!args.skipBacktest) {
    console.log("\nRunning baseline backtest (regime OFF) for training trades…");
    execNode(path.join("scripts", "run-cached-train-backtest.js"), [`--days`, String(days)], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  if (!args.skipTrain) {
    console.log("\nTraining SFP regime models (BTC features)…");
    for (const scope of ["paper", "live"]) {
      const info = await trainScope(
        scope,
        best.botConfig.aiRegimeBtcLookbackHours,
        best.botConfig.aiSfpRegimeBullThreshold,
        best.botConfig.aiSfpRegimeBearThreshold
      );
      console.log(
        `✓ ${scope} model → ${info.path} · btc weights [${info.btcWeights.map((w) => w.toFixed(4)).join(", ")}]`
      );
    }
  }

  if (args.push) {
    console.log("\nPushing to Railway…");
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

  console.log("\nDone.");
  if (!args.push) {
    console.log("Push to server: node scripts/apply-best-training-config.js --push");
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
