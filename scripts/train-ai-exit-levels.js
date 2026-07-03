#!/usr/bin/env node
/**
 * Train AI exit-levels models from cached backtest trades (paper + live).
 *
 *   node scripts/train-ai-exit-levels.js --days 10
 */

const { execSync } = require("child_process");
const { dataPath, readJsonFile } = require("../lib/data-dir");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk,
  trainFromTrades,
  reloadModel,
  getModelStatus,
  saveModel,
  getModel,
} = require("../lib/ai-exit-levels");

function parseArgs(argv) {
  let days = 10;
  let skipBacktest = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--skip-backtest") skipBacktest = true;
  }
  return { days: Math.max(1, Math.min(21, Math.round(days) || 10)), skipBacktest };
}

function loadBotConfig() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    aiExitLevelsEnabled: false,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiSfpRegimeEnabled: true,
  });
}

async function main() {
  const { days, skipBacktest } = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();
  const botConfig = loadBotConfig();

  if (!skipBacktest) {
    console.error(`Running baseline backtest ${days}d (regime ON, legacy SL/TP)…`);
    execSync(`node scripts/run-cached-train-backtest.js --days ${days} --regime-on`, {
      stdio: "inherit",
      cwd: require("path").join(__dirname, ".."),
    });
  }

  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 20) {
    throw new Error(`Need >=20 SFP trades (got ${trades.length})`);
  }
  console.error(`\nTraining AI exit-levels from ${trades.length} trades…`);

  function fetchBars(symbol, openedAt, closedAt) {
    const sym = String(symbol).toUpperCase();
    const bars = readSymbolBars("mover", sym) ?? [];
    if (!bars.length) return [];
    const from = openedAt - 120_000;
    const to = closedAt + 120_000;
    return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
  }

  await trainFromTrades(trades, fetchBars, {
    botConfig,
    scope: "paper",
    source: "train:cached-backtest",
  });
  reloadModel("paper");

  const paperModel = getModel("paper");
  saveModel(
    { ...paperModel, source: "train:cached-backtest:live" },
    "live"
  );
  reloadModel("live");

  const paperSt = getModelStatus("paper");
  const liveSt = getModelStatus("live");
  console.error("\nPaper model:", paperSt.file, paperSt);
  console.error("Live model:", liveSt.file, liveSt);
  console.error("Done.");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
