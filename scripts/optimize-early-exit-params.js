#!/usr/bin/env node
/**
 * Train SFP early-exit model + threshold sweep on cached train-bot backtest.
 *
 *   node scripts/optimize-early-exit-params.js --days 10 --cache-only
 *   node scripts/optimize-early-exit-params.js --days 10 --cache-only --quick
 */

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const {
  runPaperBotBacktest,
  loadLastBacktestResult,
} = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk,
  trainFromTrades,
  reloadModel,
  getModelStatus,
  isAiEarlyExitReason,
} = require("../lib/early-exit-model");

const RESULTS_FILE = () => dataPath("early-exit-optimization-results.json");

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 10;
  let cacheOnly = true;
  let quick = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--cache-only") cacheOnly = true;
    else if (argv[i] === "--fetch") cacheOnly = false;
    else if (argv[i] === "--quick") quick = true;
  }
  return {
    days: Math.max(1, Math.min(21, Math.round(days) || 10)),
    cacheOnly,
    quick,
  };
}

function loadBotConfig() {
  const saved = readJsonFile(dataPath("paper-bot-state.json"), {})?.config ?? {};
  return normalizeConfig({
    enabled: true,
    ...saved,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiEarlyExitEnabled: false,
    aiLevelBreakRegimeEnabled: false,
    aiSfpRegimeEnabled: true,
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
    sfpRangeBars: 60,
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

function createFetchers(cacheOnly, signalCfg) {
  function readCached(sym, kind, barCount) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > barCount ? bars.slice(-barCount) : bars;
  }

  async function fetchKlinesForSymbol(sym, barCount) {
    const symbol = String(sym).toUpperCase();
    const cached = readCached(symbol, "signal", barCount);
    if (cached?.length >= barCount) return cached;
    if (cacheOnly) {
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${symbol}`);
    }
    throw new Error("fetch not implemented — use --cache-only");
  }

  async function fetchKlines1mForSymbol(sym, barCount) {
    const symbol = String(sym).toUpperCase();
    const cached = readCached(symbol, "mover", barCount);
    if (cached?.length >= barCount) return cached;
    if (cacheOnly) {
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    }
    throw new Error("fetch not implemented — use --cache-only");
  }

  return { fetchKlinesForSymbol, fetchKlines1mForSymbol };
}

function summarizeRun(result) {
  const s = result.summary ?? {};
  const exits = {};
  let aiExits = 0;
  for (const t of result.closedTrades ?? []) {
    const r = t.exitReason ?? "unknown";
    exits[r] = (exits[r] ?? 0) + 1;
    if (isAiEarlyExitReason(r)) aiExits++;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    regimeSkips: s.sfpRegimeSkips ?? 0,
    aiExits,
    exits,
    symbolsProcessed: result.symbolsProcessed ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runBacktest({ label, botConfig, signalCfg, days, symbols, cacheOnly }) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers(
    cacheOnly,
    signalCfg
  );
  log(`\n=== RUN: ${label} ===`);
  log(
    `AI exit ${botConfig.aiEarlyExitEnabled ? "ON" : "OFF"} · hard ${botConfig.aiEarlyExitHardThreshold} · soft ${botConfig.aiEarlyExitSoftThreshold} · minBars ${botConfig.aiEarlyExitMinBars}`
  );

  const started = Date.now();
  let lastSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol,
    fetchKlines1mForSymbol: signalCfg.interval !== "1m" ? fetchKlines1mForSymbol : null,
    restGapMs: 0,
    runMeta: { optimize: "early-exit", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 50 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      } else if (p.message?.startsWith("Done ")) {
        log(`[${label}] ${p.message}`);
      }
    },
  });

  const summary = summarizeRun(result);
  log(
    `→ ${label}: PnL $${summary.pnl} · ${summary.trades} trades · AI exits ${summary.aiExits} · ${summary.elapsedSec}s`
  );
  return {
    label,
    days,
    ...summary,
    botConfig,
    elapsedTotalSec: Math.round((Date.now() - started) / 1000),
  };
}

async function trainEarlyExitModel(baseBot) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) =>
      !isAiEarlyExitReason(t.exitReason) &&
      (t.signalKind === "sfp" || t.signalKind === "sfp_bear")
  );
  if (trades.length < 20) {
    throw new Error(`Need >=20 SFP trades for early-exit training (got ${trades.length})`);
  }
  log(`\n=== TRAIN early-exit (${trades.length} SFP trades) ===`);

  function fetchBars(symbol, openedAt, closedAt) {
    const sym = String(symbol).toUpperCase();
    const bars =
      readSymbolBars("mover", sym) ?? readSymbolBars("signal", sym) ?? [];
    if (!bars.length) return [];
    const from = openedAt - 120_000;
    const to = closedAt + 120_000;
    return bars.filter((b) => b.closeTime >= from && b.closeTime <= to);
  }

  await trainFromTrades(trades, fetchBars, {
    modelScope: "paper",
    source: "optimize:backtest",
    minThreshold: 0.72,
  });
  reloadModel("paper");
  const st = getModelStatus("paper");
  log(
    `Model saved · hard ${st.hardThreshold} acc ${((st.hardMetrics?.accuracy ?? 0) * 100).toFixed(1)}% · soft ${st.softThreshold} acc ${((st.softMetrics?.accuracy ?? 0) * 100).toFixed(1)}%`
  );
  return st;
}

const HARD_SWEEP_FULL = [0.68, 0.72, 0.76, 0.8, 0.84];
const HARD_SWEEP_QUICK = [0.72, 0.76, 0.8];
const SOFT_SWEEP_FULL = [0.82, 0.86, 0.88, 0.9, 0.92];
const SOFT_SWEEP_QUICK = [0.84, 0.88, 0.92];
const MINBARS_SWEEP_FULL = [6, 9, 12, 15];
const MINBARS_SWEEP_QUICK = [6, 12];

async function main() {
  const args = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();

  const baseBot = loadBotConfig();
  const signalCfg = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols — run train bot with cache first.");
    process.exit(1);
  }

  log(`Early-exit optimization · ${args.days}d · ${symbols.length} symbols · cache-only`);
  const store = { runs: [], days: args.days, symbolCount: symbols.length, cacheOnly: args.cacheOnly };

  const runAndStore = async (label, botPatch = {}) => {
    const botConfig = normalizeConfig({
      ...baseBot,
      ...botPatch,
      aiSfpRegimeEnabled: true,
    });
    const row = await runBacktest({
      label,
      botConfig,
      signalCfg,
      days: args.days,
      symbols,
      cacheOnly: args.cacheOnly,
    });
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(row);
    writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });
    return row;
  };

  const baseline = await runAndStore("baseline_no_ai_exit", {
    aiEarlyExitEnabled: false,
  });

  const modelSt = await trainEarlyExitModel(baseBot);
  const trainedHard = modelSt.hardThreshold ?? 0.76;
  const trainedSoft = modelSt.softThreshold ?? 0.88;

  const trainedRow = await runAndStore("baseline_ai_exit_trained", {
    aiEarlyExitEnabled: true,
    aiEarlyExitHardThreshold: trainedHard,
    aiEarlyExitSoftThreshold: trainedSoft,
    aiEarlyExitMinBars: baseBot.aiEarlyExitMinBars ?? 9,
  });

  const regimeBot = {
    aiEarlyExitEnabled: true,
    aiEarlyExitHardThreshold: trainedHard,
    aiEarlyExitSoftThreshold: trainedSoft,
    aiEarlyExitMinBars: baseBot.aiEarlyExitMinBars ?? 9,
  };

  const HARD = args.quick ? HARD_SWEEP_QUICK : HARD_SWEEP_FULL;
  const SOFT = args.quick ? SOFT_SWEEP_QUICK : SOFT_SWEEP_FULL;
  const MINBARS = args.quick ? MINBARS_SWEEP_QUICK : MINBARS_SWEEP_FULL;

  for (const v of HARD) {
    if (v === trainedHard) continue;
    await runAndStore(`hard_${v}`, { ...regimeBot, aiEarlyExitHardThreshold: v });
  }
  for (const v of SOFT) {
    if (v === trainedSoft) continue;
    await runAndStore(`soft_${v}`, { ...regimeBot, aiEarlyExitSoftThreshold: v });
  }
  for (const v of MINBARS) {
    if (v === regimeBot.aiEarlyExitMinBars) continue;
    await runAndStore(`minBars_${v}`, { ...regimeBot, aiEarlyExitMinBars: v });
  }

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  store.ranking = ranked.map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    aiExits: r.aiExits,
    deltaVsBaseline: +(r.pnl - baseline.pnl).toFixed(2),
  }));
  store.baselinePnl = baseline.pnl;
  store.trainedPnl = trainedRow.pnl;
  store.trainedDelta = +(trainedRow.pnl - baseline.pnl).toFixed(2);
  store.model = { hard: trainedHard, soft: trainedSoft, ...modelSt };
  writeJsonFile(RESULTS_FILE(), { ...store, updatedAt: new Date().toISOString() });

  log("\n=== TOP RUNS (vs no AI exit) ===");
  for (const r of store.ranking.slice(0, 10)) {
    log(`${r.label}: $${r.pnl} (Δ $${r.deltaVsBaseline}) · AI exits ${r.aiExits}`);
  }
  log(`\nBaseline no AI exit: $${baseline.pnl}`);
  log(`Trained thresholds: $${trainedRow.pnl} (Δ $${store.trainedDelta})`);
  log(`Results: ${RESULTS_FILE()}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
