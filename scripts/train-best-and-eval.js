#!/usr/bin/env node
/**
 * Train all AI models on train window (default 20d of 30d cache) with best-known settings,
 * then evaluate on held-out test window (default last 10d).
 *
 *   node scripts/train-best-and-eval.js
 *   node scripts/train-best-and-eval.js --train-days 20 --test-days 10
 */

const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { pickLiveConfig, applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk: ensureSfpModels,
  trainFromTrades: trainSfpFromTrades,
  reloadModel: reloadSfpModel,
  saveModel: saveSfpModel,
  getModel: getSfpModel,
} = require("../lib/sfp-regime-model");
const {
  ensureAllDefaultModelsOnDisk: ensureEarlyExitModels,
  trainFromTrades: trainEarlyExitFromTrades,
  reloadModel: reloadEarlyExitModel,
  getModelStatus: getEarlyExitStatus,
  isAiEarlyExitReason,
} = require("../lib/early-exit-model");
const {
  ensureAllDefaultModelsOnDisk: ensurePbSignalModels,
  trainFromTrades: trainPbSignalFromTrades,
  reloadModel: reloadPbSignalModel,
} = require("../lib/pullback-signal-model");
const {
  ensureAllDefaultModelsOnDisk: ensurePbRegimeModels,
  trainFromTrades: trainPbRegimeFromTrades,
  reloadModel: reloadPbRegimeModel,
} = require("../lib/pullback-regime-model");
const {
  ensureAllDefaultModelsOnDisk: ensurePbPatternBreakModels,
  trainFromTrades: trainPbPatternBreakFromTrades,
  reloadModel: reloadPbPatternBreakModel,
} = require("../lib/pullback-pattern-break-model");
const {
  ensureAllDefaultModelsOnDisk: ensureExitLevelsModels,
  trainFromTrades: trainExitLevelsFromTrades,
  reloadModel: reloadExitLevelsModel,
  saveModel: saveExitLevelsModel,
  getModel: getExitLevelsModel,
} = require("../lib/ai-exit-levels");

const TRAIN_ORDER = ["sfp_regime", "early_exit", "pullback", "exit_levels"];

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

/** Best winning settings from sfp-regime-btc-compare + probe cumulative config. */
const BEST_BOT = {
  earlyAbortEnabled: false,
  runnerEnabled: false,
  aiLevelBreakRegimeEnabled: false,
  tradeLevelBreakSignals: false,
  tradeBearishLevelBreakSignals: false,
  tradeSfpSignals: true,
  tradeBearishSfpSignals: true,
  tradePullbackSignals: true,
  tradeBearishPullbackSignals: true,
  aiSfpRegimeEnabled: true,
  aiSfpRegimeBullThreshold: 0.78,
  aiSfpRegimeBearThreshold: 0.72,
  aiRegimeBtcLookbackHours: 24,
  aiEarlyExitEnabled: true,
  aiEarlyExitHardThreshold: 0.76,
  aiEarlyExitSoftThreshold: 0.88,
  aiEarlyExitMinBars: 9,
  aiPullbackSignalEnabled: true,
  aiPullbackSignalBullThreshold: 0.52,
  aiPullbackSignalBearThreshold: 0.54,
  aiPullbackRegimeEnabled: true,
  aiPullbackRegimeBullThreshold: 0.76,
  aiPullbackRegimeBearThreshold: 0.74,
  aiPullbackPatternBreakEnabled: false,
  aiPullbackPatternBreakBullThreshold: 0.72,
  aiPullbackPatternBreakBearThreshold: 0.7,
  aiPullbackPatternBreakBtcLookbackHours: 24,
  aiExitLevelsEnabled: true,
  aiExitLevelsLegacyDisabled: true,
  aiExitLevelsMode: "legacy_scale",
  aiExitLevelsSlScale: 1.15,
  aiExitLevelsTpScale: 1.15,
  smartExitLevelsEnabled: true,
};

function parseArgs(argv) {
  const td = argv.indexOf("--train-days");
  const ts = argv.indexOf("--test-days");
  const from = argv.indexOf("--from-step");
  return {
    trainDays: td >= 0 && argv[td + 1] ? Number(argv[td + 1]) : 20,
    testDays: ts >= 0 && argv[ts + 1] ? Number(argv[ts + 1]) : 10,
    fromStep: from >= 0 && argv[from + 1] ? argv[from + 1] : null,
  };
}

function shouldRun(step, fromStep) {
  if (!fromStep) return true;
  const order = [...TRAIN_ORDER, "test"];
  return order.indexOf(step) >= order.indexOf(fromStep);
}

function log(msg) {
  console.error(String(msg));
}

function barsForDays(days, interval = "5m") {
  const ms = interval === "1m" ? 60_000 : 300_000;
  return Math.ceil((days * 24 * 60 * 60_000) / ms);
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

function loadSignalConfig() {
  const cfg = {
    ...BEST_SCANNER,
    corridorDays: 2,
    corridorExcludeMinutes: 40,
    signalCandles: 3,
  };
  applyBarConfig(cfg);
  scannerConfig.loadInto(cfg);
  applyBarConfig(cfg);
  return cfg;
}

function sliceBars(bars, mode, trainDays, testDays, interval) {
  if (!bars?.length) return null;
  const trainBars = barsForDays(trainDays, interval);
  const testBars = barsForDays(testDays, interval);
  const total = trainBars + testBars;
  if (bars.length < total) return bars.length > 200 ? bars : null;
  if (mode === "train") return bars.slice(0, trainBars);
  if (mode === "test") return bars.slice(-testBars);
  return bars.slice(-total);
}

function createWindowFetchers(mode, trainDays, testDays) {
  function readCached(sym, kind, barCount, interval) {
    const bars = readSymbolBars(kind, sym);
    const sliced = sliceBars(bars, mode, trainDays, testDays, interval);
    if (!sliced?.length) return null;
    if (sliced.length > barCount) return sliced.slice(-barCount);
    return sliced;
  }
  return {
    async fetchKlinesForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "signal", barCount, "5m");
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${symbol}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const symbol = String(sym).toUpperCase();
      const cached = readCached(symbol, "mover", barCount, "1m");
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    },
  };
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

function applyScanner() {
  writeJsonFile(
    scannerConfig.CONFIG_FILE(),
    pickLiveConfig({ ...BEST_SCANNER, interval: "5m" })
  );
}

async function runWindowBacktest({ label, botConfig, signalCfg, symbols, days, mode, trainDays, testDays, saveResult }) {
  const fetchers = createWindowFetchers(mode, trainDays, testDays);
  log(`\n[${label}] ${mode} window · ${days}d · ${symbols.length} symbols`);
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig: normalizeConfig(botConfig),
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: signalCfg.interval !== "1m" ? fetchers.fetchKlines1mForSymbol : null,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: Boolean(saveResult),
    runMeta: { trainBestEval: label, mode },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.done % 150 === 0) {
        log(`  ${label}: ${p.done + 1}/${symbols.length} · ${p.symbol}`);
      }
    },
  });
  const s = result.summary ?? {};
  return {
    label,
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    sfpRegimeSkips: s.sfpRegimeSkips ?? 0,
    pbRegimeSkips: s.pullbackRegimeSkips ?? 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    aiExits: s.aiEarlyExitCount ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

function fetchBarsAll(symbol) {
  const sym = String(symbol).toUpperCase();
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
}

async function trainSfpRegime(scopes, btcHours, bullTh, bearTh) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 12) throw new Error(`SFP train: need >=12 trades (got ${trades.length})`);
  log(`\n=== TRAIN sfp_regime (${trades.length} trades) ===`);
  for (const scope of scopes) {
    await trainSfpFromTrades(trades, fetchBarsAll, {
      modelScope: scope,
      source: `train:cached-backtest:30d:${scope}`,
      btcFeaturesEnabled: true,
      aiRegimeBtcLookbackHours: btcHours,
    });
    reloadSfpModel(scope);
    const model = getSfpModel(scope);
    saveSfpModel(
      {
        ...model,
        bull: { ...model.bull, threshold: bullTh },
        bear: { ...model.bear, threshold: bearTh },
      },
      scope
    );
    log(`  ✓ ${scope} sfp-regime`);
  }
}

async function trainEarlyExit(scopes) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) =>
      !isAiEarlyExitReason(t.exitReason) &&
      (t.signalKind === "sfp" || t.signalKind === "sfp_bear")
  );
  if (trades.length < 20) throw new Error(`Early exit train: need >=20 trades (got ${trades.length})`);
  log(`\n=== TRAIN early_exit (${trades.length} trades) ===`);
  for (const scope of scopes) {
    await trainEarlyExitFromTrades(trades, fetchBarsAll, {
      modelScope: scope,
      source: `train:cached-backtest:30d:${scope}`,
    });
    reloadEarlyExitModel(scope);
    const st = getEarlyExitStatus(scope);
    log(`  ✓ ${scope} early-exit · hard ${st.hardThreshold} soft ${st.softThreshold}`);
  }
}

async function trainPullback(scopes) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "pullback" || t.signalKind === "pullback_bear"
  );
  if (trades.length < 30) {
    log(`  skip pullback train: ${trades.length} PB trades (need >=30)`);
    return { skipped: true, trades: trades.length };
  }
  log(`\n=== TRAIN pullback signal+regime+pattern-break (${trades.length} trades) ===`);
  for (const scope of scopes) {
    await trainPbSignalFromTrades(trades, fetchBarsAll, {
      modelScope: scope,
      source: `train:cached-backtest:30d:${scope}`,
    });
    reloadPbSignalModel(scope);
    await trainPbRegimeFromTrades(trades, fetchBarsAll, {
      modelScope: scope,
      source: `train:cached-backtest:30d:${scope}`,
      aiRegimeBtcLookbackHours: BEST_BOT.aiRegimeBtcLookbackHours,
    });
    reloadPbRegimeModel(scope);
    await trainPbPatternBreakFromTrades(trades, fetchBarsAll, {
      modelScope: scope,
      source: `train:cached-backtest:30d:${scope}`,
      aiPullbackPatternBreakBtcLookbackHours: BEST_BOT.aiPullbackPatternBreakBtcLookbackHours,
    });
    reloadPbPatternBreakModel(scope);
    log(`  ✓ ${scope} pullback signal + regime + pattern-break`);
  }
}

async function trainExitLevels(scopes, botConfig) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 20) throw new Error(`Exit levels train: need >=20 trades (got ${trades.length})`);
  log(`\n=== TRAIN exit_levels (${trades.length} trades) ===`);

  function fetchBars(symbol, openedAt, closedAt) {
    const sym = String(symbol).toUpperCase();
    const bars = readSymbolBars("mover", sym) ?? [];
    if (!bars.length) return [];
    const from = openedAt - 120_000;
    const to = closedAt + 120_000;
    return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
  }

  await trainExitLevelsFromTrades(trades, fetchBars, {
    botConfig,
    scope: "paper",
    source: "train:cached-backtest:30d",
  });
  reloadExitLevelsModel("paper");
  const paperModel = getExitLevelsModel("paper");
  saveExitLevelsModel({ ...paperModel, source: "train:cached-backtest:30d:live" }, "live");
  reloadExitLevelsModel("live");
  log(`  ✓ paper + live exit-levels`);
}

async function main() {
  const { trainDays, testDays, fromStep } = parseArgs(process.argv);
  const totalDays = trainDays + testDays;
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }

  log(`Train best AI models · ${symbols.length} symbols · train ${trainDays}d + test ${testDays}d (of ${totalDays}d cache)`);
  log(`Order: ${TRAIN_ORDER.join(" → ")}`);

  ensureSfpModels();
  ensureEarlyExitModels();
  ensurePbSignalModels();
  ensurePbRegimeModels();
  ensurePbPatternBreakModels();
  ensureExitLevelsModels();

  applyScanner();
  patchBotState("paper-bot-state.json", BEST_BOT);
  patchBotState("live-bot-state.json", BEST_BOT, { keepLeverage: true });
  const signalCfg = loadSignalConfig();
  const scopes = ["paper", "live"];

  // 1) SFP regime
  if (shouldRun("sfp_regime", fromStep)) {
    await runWindowBacktest({
    label: "sfp_train_data",
    botConfig: { ...BEST_BOT, aiSfpRegimeEnabled: false, aiEarlyExitEnabled: false },
    signalCfg,
    symbols,
    days: trainDays,
    mode: "train",
    trainDays,
    testDays,
    saveResult: true,
  });
  await trainSfpRegime(
    scopes,
    BEST_BOT.aiRegimeBtcLookbackHours,
    BEST_BOT.aiSfpRegimeBullThreshold,
    BEST_BOT.aiSfpRegimeBearThreshold
  );
  }

  // 2) Early exit
  if (shouldRun("early_exit", fromStep)) {
    await runWindowBacktest({
    label: "early_exit_train_data",
    botConfig: { ...BEST_BOT, aiEarlyExitEnabled: false },
    signalCfg,
    symbols,
    days: trainDays,
    mode: "train",
    trainDays,
    testDays,
    saveResult: true,
  });
    await trainEarlyExit(scopes);
  }

  // 3) Pullback
  let pbTrain = { skipped: true, trades: 0 };
  if (shouldRun("pullback", fromStep)) {
    await runWindowBacktest({
    label: "pullback_train_data",
    botConfig: {
      ...BEST_BOT,
      aiEarlyExitEnabled: false,
      aiPullbackSignalEnabled: false,
      aiPullbackRegimeEnabled: false,
      aiPullbackPatternBreakEnabled: false,
    },
    signalCfg,
    symbols,
    days: trainDays,
    mode: "train",
    trainDays,
    testDays,
    saveResult: true,
  });
    pbTrain = await trainPullback(scopes);
  }

  // 4) Exit levels
  if (shouldRun("exit_levels", fromStep)) {
    await runWindowBacktest({
    label: "exit_levels_train_data",
    botConfig: {
      ...BEST_BOT,
      aiEarlyExitEnabled: false,
      aiExitLevelsEnabled: false,
      smartExitLevelsEnabled: true,
    },
    signalCfg,
    symbols,
    days: trainDays,
    mode: "train",
    trainDays,
    testDays,
    saveResult: true,
  });
    await trainExitLevels(scopes, BEST_BOT);
  }

  const evalBot =
    pbTrain?.skipped
      ? {
          ...BEST_BOT,
          aiPullbackSignalEnabled: false,
          aiPullbackRegimeEnabled: false,
        }
      : BEST_BOT;

  // Re-enable full best config for eval
  patchBotState("paper-bot-state.json", evalBot);

  if (!shouldRun("test", fromStep) || testDays <= 0) return;

  log(`\n=== TEST (${testDays}d held-out) ===`);
  const baseline = await runWindowBacktest({
    label: "test_baseline_no_ai",
    botConfig: {
      ...evalBot,
      aiSfpRegimeEnabled: false,
      aiEarlyExitEnabled: false,
      aiPullbackSignalEnabled: false,
      aiPullbackRegimeEnabled: false,
      aiExitLevelsEnabled: false,
      smartExitLevelsEnabled: true,
    },
    signalCfg,
    symbols,
    days: testDays,
    mode: "test",
    trainDays,
    testDays,
    saveResult: false,
  });

  const fullAi = await runWindowBacktest({
    label: "test_full_ai",
    botConfig: evalBot,
    signalCfg,
    symbols,
    days: testDays,
    mode: "test",
    trainDays,
    testDays,
    saveResult: false,
  });

  const summary = {
    trainedAt: new Date().toISOString(),
    symbolCount: symbols.length,
    trainDays,
    testDays,
    trainOrder: TRAIN_ORDER,
    settings: evalBot,
    training: {
      sfpRegime: true,
      earlyExit: true,
      pullback: !pbTrain?.skipped,
      pullbackTrades: pbTrain?.trades ?? null,
      exitLevels: true,
    },
    test: {
      baseline,
      fullAi,
      deltaPnl: +(fullAi.pnl - baseline.pnl).toFixed(2),
      deltaTrades: fullAi.trades - baseline.trades,
    },
  };
  writeJsonFile(dataPath("ai-train-eval-summary.json"), summary);

  console.log("\n========== SUMMARY ==========");
  console.log(`Symbols: ${symbols.length} · train ${trainDays}d · test ${testDays}d`);
  console.log(`Train order: ${TRAIN_ORDER.join(" → ")}`);
  console.log("\nTest window (held-out):");
  console.log(`  Baseline (no AI):  $${baseline.pnl} · ${baseline.trades} trades · ${baseline.wins}W/${baseline.losses}L`);
  console.log(`  Full AI (trained): $${fullAi.pnl} · ${fullAi.trades} trades · ${fullAi.wins}W/${fullAi.losses}L`);
  console.log(
    `  Delta:             ${summary.test.deltaPnl >= 0 ? "+" : ""}$${summary.test.deltaPnl} · ${summary.test.deltaTrades >= 0 ? "+" : ""}${summary.test.deltaTrades} trades`
  );
  console.log(
    `  Skips (full AI):   SFP regime ${fullAi.sfpRegimeSkips} · PB regime ${fullAi.pbRegimeSkips} · PB signal ${fullAi.pbSignalSkips} · AI exits ${fullAi.aiExits}`
  );
  console.log(`\nSaved: ${dataPath("ai-train-eval-summary.json")}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
