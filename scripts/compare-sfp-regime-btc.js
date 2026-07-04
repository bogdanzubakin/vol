#!/usr/bin/env node
/**
 * Compare SFP regime with vs without BTC trend features on cached backtest data.
 *
 *   node scripts/compare-sfp-regime-btc.js --days 10
 *   node scripts/compare-sfp-regime-btc.js --days 10 --quick
 */

const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk,
  trainFromTrades,
  reloadModel,
  getModel,
  saveModel,
  MODEL_FILE,
} = require("../lib/sfp-regime-model");

const RESULTS_FILE = () => dataPath("sfp-regime-btc-compare.json");
const LOG_FILE = () => dataPath("sfp-regime-btc-compare.log");

function log(line) {
  const msg = String(line);
  console.error(msg);
  fs.appendFileSync(LOG_FILE(), `${msg}\n`);
}

function parseArgs(argv) {
  let days = 10;
  let quick = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--quick") quick = true;
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 10)), quick };
}

function loadBotConfig(overrides = {}) {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiLevelBreakRegimeEnabled: false,
    ...overrides,
  });
}

function loadSignalConfig() {
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
    levelBreakPivotBars: 4,
    levelBreakLookbackBars: 300,
    levelBreakMinTouches: 5,
    levelBreakTouchPct: 0.25,
    levelBreakMinPct: 0.12,
    levelBreakApproachPct: 0.4,
    levelBreakApproachBars: 8,
  };
  applyBarConfig(cfg);
  scannerConfig.loadInto(cfg);
  applyBarConfig(cfg);
  return cfg;
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

function fetchBars(symbol) {
  const sym = String(symbol).toUpperCase();
  return readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
}

function summarizeRun(label, result, meta = {}) {
  const s = result.summary ?? {};
  return {
    label,
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    regimeSkips: s.sfpRegimeSkips ?? 0,
    regimeSkipsBull: s.sfpRegimeSkipsBull ?? 0,
    regimeSkipsBear: s.sfpRegimeSkipsBear ?? 0,
    skippedOpen: s.skippedOpen ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
    ...meta,
  };
}

function saveResults(store) {
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });
}

async function runBacktest({ label, symbols, days, signalCfg, botConfig, fetchers, store }) {
  const existing = store.runs.find((r) => r.label === label);
  if (existing) {
    log(`[skip] ${label}: $${existing.pnl} (cached)`);
    return existing;
  }

  log(`\n=== RUN ${label} ===`);
  let lastSym = "";
  const started = Date.now();
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol:
      signalCfg.interval !== "1m" ? fetchers.fetchKlines1mForSymbol : null,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: label === "baseline_no_regime",
    runMeta: { compare: "sfp-regime-btc", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });

  const row = summarizeRun(label, result, {
    botConfig: {
      aiSfpRegimeEnabled: botConfig.aiSfpRegimeEnabled,
      aiSfpRegimeBullThreshold: botConfig.aiSfpRegimeBullThreshold,
      aiSfpRegimeBearThreshold: botConfig.aiSfpRegimeBearThreshold,
      aiRegimeBtcLookbackHours: botConfig.aiRegimeBtcLookbackHours,
    },
    elapsedTotalSec: Math.round((Date.now() - started) / 1000),
  });
  store.runs.push(row);
  saveResults(store);
  log(
    `→ ${label}: PnL $${row.pnl} · ${row.trades} trades · skips ${row.regimeSkips} (${row.regimeSkipsBull}b/${row.regimeSkipsBear}br) · ${row.elapsedSec}s`
  );
  return row;
}

async function trainModel(trades, options, label) {
  log(`\n=== TRAIN ${label} ===`);
  await trainFromTrades(trades, fetchBars, {
    modelScope: "paper",
    source: `compare:${label}`,
    ...options,
  });
  reloadModel("paper");
  const st = getModel("paper");
  const bw = st.bull?.weights ?? [];
  log(
    `trained · bull btcW=[${(bw[12] ?? 0).toFixed(3)}, ${(bw[13] ?? 0).toFixed(3)}] · bear btcW=[${(st.bear?.weights?.[12] ?? 0).toFixed(3)}, ${(st.bear?.weights?.[13] ?? 0).toFixed(3)}]`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();

  try {
    fs.writeFileSync(LOG_FILE(), "");
  } catch {
    /* ignore */
  }

  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols in backtest-klines.");
    process.exit(1);
  }

  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const modelBackup = readJsonFile(MODEL_FILE("paper"), null);

  let store = readJsonFile(RESULTS_FILE(), {
    runs: [],
    days: args.days,
    symbolCount: symbols.length,
  });
  store.days = args.days;
  store.symbolCount = symbols.length;

  const inferLookbacks = args.quick ? [8, 12, 18] : [4, 6, 8, 12, 18, 24];
  const trainLookbacks = args.quick ? [12] : [6, 12, 24];
  const thresholdSweep = args.quick
    ? []
    : [
        { bull: 0.76, bear: 0.72 },
        { bull: 0.78, bear: 0.72 },
        { bull: 0.78, bear: 0.74 },
        { bull: 0.8, bear: 0.74 },
      ];

  log(
    `SFP regime BTC compare · ${symbols.length} symbols × ${args.days}d · quick=${args.quick}`
  );

  const baselineBot = loadBotConfig({ aiSfpRegimeEnabled: false });
  const baseline = await runBacktest({
    label: "baseline_no_regime",
    symbols,
    days: args.days,
    signalCfg,
    botConfig: baselineBot,
    fetchers,
    store,
  });

  const trades = (readJsonFile(dataPath("paper-bot-backtest-last.json"), null)?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 12) {
    throw new Error(`Need >=12 SFP trades from baseline (got ${trades.length})`);
  }
  log(`Baseline trades for training: ${trades.length}`);

  const regimeBase = loadBotConfig({ aiSfpRegimeEnabled: true });

  await trainModel(trades, { btcFeaturesEnabled: false }, "no_btc_features");
  await runBacktest({
    label: "regime_no_btc",
    symbols,
    days: args.days,
    signalCfg,
    botConfig: regimeBase,
    fetchers,
    store,
  });

  let bestBtc = null;
  for (const trainHours of trainLookbacks) {
    await trainModel(
      trades,
      { btcFeaturesEnabled: true, aiRegimeBtcLookbackHours: trainHours },
      `btc_train_${trainHours}h`
    );

    for (const inferHours of inferLookbacks) {
      const row = await runBacktest({
        label: `btc_train${trainHours}h_infer${inferHours}h`,
        symbols,
        days: args.days,
        signalCfg,
        botConfig: { ...regimeBase, aiRegimeBtcLookbackHours: inferHours },
        fetchers,
        store,
      });
      if (!bestBtc || row.pnl > bestBtc.pnl) bestBtc = { ...row, trainHours, inferHours };
    }
  }

  if (bestBtc && thresholdSweep.length) {
    log(
      `\nBest BTC config so far: train ${bestBtc.trainHours}h · infer ${bestBtc.inferHours}h · $${bestBtc.pnl}`
    );
    await trainModel(
      trades,
      {
        btcFeaturesEnabled: true,
        aiRegimeBtcLookbackHours: bestBtc.trainHours,
      },
      `btc_retrain_${bestBtc.trainHours}h`
    );

    for (const th of thresholdSweep) {
      const baseTh = {
        bull: regimeBase.aiSfpRegimeBullThreshold,
        bear: regimeBase.aiSfpRegimeBearThreshold,
      };
      if (th.bull === baseTh.bull && th.bear === baseTh.bear) continue;
      await runBacktest({
        label: `btc_best_th_bull${th.bull}_bear${th.bear}`,
        symbols,
        days: args.days,
        signalCfg,
        botConfig: {
          ...regimeBase,
          aiRegimeBtcLookbackHours: bestBtc.inferHours,
          aiSfpRegimeBullThreshold: th.bull,
          aiSfpRegimeBearThreshold: th.bear,
        },
        fetchers,
        store,
      });
    }
  }

  if (modelBackup) {
    saveModel(modelBackup, "paper");
    reloadModel("paper");
    log("\nRestored original paper regime model.");
  }

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  const baselinePnl = baseline.pnl ?? 0;
  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    deltaVsBaseline: +(r.pnl - baselinePnl).toFixed(2),
    trades: r.trades,
    regimeSkips: r.regimeSkips,
    lookback: r.botConfig?.aiRegimeBtcLookbackHours ?? null,
  }));
  saveResults(store);

  log("\n=== RANKING (vs baseline $" + baselinePnl.toFixed(2) + ") ===");
  for (const r of store.ranking.slice(0, 12)) {
    log(
      `${r.label}: $${r.pnl} (${r.deltaVsBaseline >= 0 ? "+" : ""}${r.deltaVsBaseline}) · ${r.trades} trades · skips ${r.regimeSkips}`
    );
  }

  const noBtc = store.runs.find((r) => r.label === "regime_no_btc");
  const best = ranked[0];
  const bestBtcRun = ranked.find((r) => r.label.startsWith("btc_"));
  log("\n=== VERDICT ===");
  if (noBtc) {
    log(
      `Regime without BTC: $${noBtc.pnl} (${+(noBtc.pnl - baselinePnl).toFixed(2)} vs baseline)`
    );
  }
  if (bestBtcRun) {
    log(
      `Best BTC run: ${bestBtcRun.label} $${bestBtcRun.pnl} (${+(bestBtcRun.pnl - baselinePnl).toFixed(2)} vs baseline)`
    );
    if (noBtc) {
      const delta = +(bestBtcRun.pnl - noBtc.pnl).toFixed(2);
      log(`BTC vs no-BTC regime: ${delta >= 0 ? "+" : ""}${delta}`);
    }
  }
  log(`Overall best: ${best.label} $${best.pnl}`);
  log(`\nResults: ${RESULTS_FILE()}`);
  log(`Log: ${LOG_FILE()}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
