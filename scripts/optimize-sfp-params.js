#!/usr/bin/env node
/**
 * SFP / SL / TP parameter sweep using train-bot backtest (cache-first).
 *
 *   node scripts/optimize-sfp-params.js --export ~/Downloads/train-bot-export-....json
 *   node scripts/optimize-sfp-params.js --export ... --cache-only --days 10
 *   node scripts/optimize-sfp-params.js --export ... --phase baseline
 */

const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig, pickLiveConfig } = require("../lib/signal-metrics");
const { normalizeConfig } = require("../lib/paper-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const {
  runPaperBotBacktest,
  resolveBacktestSymbols,
  loadLastBacktestResult,
} = require("../lib/paper-bot-backtest");
const {
  ensureAllDefaultModelsOnDisk,
  trainFromTrades,
  reloadModel,
} = require("../lib/sfp-regime-model");

const AI_KEYS = new Set([
  "aiEarlyExitEnabled",
  "aiEarlyExitThreshold",
  "aiEarlyExitHardThreshold",
  "aiEarlyExitSoftThreshold",
  "aiEarlyExitMinBars",
  "aiEarlyExitBarCloseOnly",
  "aiSfpRegimeEnabled",
  "aiSfpRegimeThreshold",
  "aiSfpRegimeBullThreshold",
  "aiSfpRegimeBearThreshold",
  "aiLevelBreakRegimeEnabled",
  "aiLevelBreakRegimeThreshold",
  "aiLevelBreakRegimeBullThreshold",
  "aiLevelBreakRegimeBearThreshold",
]);

const RESULTS_FILE = () => dataPath("sfp-optimization-results.json");
const LOG_FILE = () => dataPath("sfp-optimization.log");

function log(line, { file = true } = {}) {
  const msg = String(line);
  console.error(msg);
  if (file) fs.appendFileSync(LOG_FILE(), `${msg}\n`);
}

function logProgress(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let exportPath = null;
  let days = 10;
  let cacheOnly = false;
  let phase = "all";
  let restGapMs = 600;
  let quick = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--export" && argv[i + 1]) exportPath = argv[++i];
    else if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--cache-only") cacheOnly = true;
    else if (argv[i] === "--quick") quick = true;
    else if (argv[i] === "--phase" && argv[i + 1]) phase = argv[++i];
    else if (argv[i] === "--rest-gap-ms" && argv[i + 1]) restGapMs = Number(argv[++i]);
  }
  if (!exportPath) {
    console.error("Usage: node scripts/optimize-sfp-params.js --export <path> [--days 10] [--cache-only]");
    process.exit(1);
  }
  return {
    exportPath,
    days: Math.max(1, Math.min(21, Math.round(days) || 10)),
    cacheOnly,
    phase,
    restGapMs: Math.max(80, restGapMs),
    quick,
  };
}

function loadExport(exportPath) {
  const raw = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  const paperBot = { ...(raw.settings?.paperBot ?? {}) };
  const signal = { ...(raw.settings?.signal ?? {}) };
  if (raw.settings?.interval) signal.interval = raw.settings.interval;
  return { paperBot, signal };
}

function paperBotFromExport() {
  return normalizeConfig({
    enabled: true,
    earlyAbortEnabled: false,
    runnerEnabled: false,
    aiSfpRegimeEnabled: false,
    aiEarlyExitEnabled: false,
    aiLevelBreakRegimeEnabled: false,
  });
}

function buildSignalCfg(signalRaw) {
  const cfg = {
    interval: "5m",
    corridorDays: 2,
    corridorExcludeMinutes: 40,
    signalCandles: 3,
    fastMoveLookbackCandles: 15,
    minAvgMovePct: 0.4,
    minLinearChangePct: 0.5,
    fastMoveExcludeMult: 3,
    sfpLookbackBars: 30,
    sfpReclaimBars: 5,
    sfpMinSweepPct: 0.08,
    sfpRangeBars: 60,
    pullbackMaBars: 7,
    pullbackTouchLookback: 12,
    pullbackMaxDistancePct: 0.35,
    pullbackMaxAboveMaPct: 1.5,
    topMoveMinPct: 15,
    levelBreakPivotBars: 4,
    levelBreakLookbackBars: 300,
    levelBreakMinTouches: 5,
    levelBreakTouchPct: 0.25,
    levelBreakMinPct: 0.12,
    levelBreakApproachPct: 0.4,
    levelBreakApproachBars: 8,
    ...signalRaw,
  };
  applyBarConfig(cfg);
  return cfg;
}

function applyPersistedConfig(paperBot, signalCfg) {
  const statePath = dataPath("paper-bot-state.json");
  const state = readJsonFile(statePath, {}) ?? {};
  writeJsonFile(statePath, {
    ...state,
    config: paperBot,
    savedAt: Date.now(),
  });
  scannerConfig.saveFrom(signalCfg);
}

function listExchangeSymbols() {
  const info = readJsonFile(dataPath("futures-exchangeInfo.json"), null);
  return info?.symbols ?? [];
}

function cachedSymbolList(days, require1m = true) {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  if (!fs.existsSync(root)) return [];
  const files = fs.readdirSync(root).filter((f) => f.endsWith(".json.gz"));
  const out = [];
  for (const file of files) {
    const sym = file.replace(/\.json\.gz$/, "");
    const bars = readSymbolBars("signal", sym);
    if (!bars?.length) continue;
    if (require1m) {
      const sim = readSymbolBars("mover", sym);
      if (!sim?.length) continue;
    }
    out.push(sym);
  }
  return out.sort();
}

function summarizeRun(result) {
  const s = result.summary ?? {};
  const exits = {};
  for (const t of result.closedTrades ?? []) {
    const r = t.exitReason ?? "unknown";
    exits[r] = (exits[r] ?? 0) + 1;
  }
  return {
    days: result.days,
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    skippedOpen: s.skippedOpen ?? 0,
    regimeSkips: s.sfpRegimeSkips ?? 0,
    symbolsProcessed: result.symbolsProcessed ?? 0,
    symbolsTotal: result.symbolsTotal ?? 0,
    symbolsSkipped: result.symbolsSkipped ?? 0,
    elapsedSec: result.elapsedSec ?? 0,
    exits,
    botConfig: result.botConfig,
    signalConfig: result.signalConfig,
  };
}

function createFetchers({ cacheOnly, restGapMs, signalCfg, symbols }) {
  const { createRestQueue, sleep } = require("../lib/rest-queue");
  const { mergeBarsByOpenTime } = require("../lib/kline-cache");
  const REST_BASE = "https://fapi.binance.com";
  const KLINE_MAX = 1500;

  const restQueue = createRestQueue({ label: "sfp-opt", gapMs: restGapMs });

  async function getJson(pathName, params) {
    return restQueue.schedule(async () => {
      const url = new URL(pathName, REST_BASE);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) throw new Error(`${pathName} ${res.status} ${text.slice(0, 120)}`);
      return JSON.parse(text);
    });
  }

  function parseKlines(rows) {
    return rows.map((r) => ({
      openTime: r[0],
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
      volume: +r[5],
      closeTime: r[6],
    }));
  }

  async function fetchInterval(sym, interval, barCount) {
    let all = [];
    let endTime;
    let remaining = barCount;
    while (remaining > 0) {
      const batch = Math.min(remaining, KLINE_MAX);
      const params = { symbol: sym, interval, limit: String(batch) };
      if (endTime !== undefined) params.endTime = String(endTime);
      const rows = await getJson("/fapi/v1/klines", params);
      if (!rows.length) break;
      const parsed = parseKlines(rows);
      all = [...parsed, ...all];
      endTime = rows[0][0] - 1;
      remaining -= parsed.length;
      if (parsed.length < batch) break;
      await sleep(40);
    }
    return all.slice(-barCount);
  }

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
    const fetched = await fetchInterval(symbol, signalCfg.interval, barCount);
    return fetched;
  }

  async function fetchKlines1mForSymbol(sym, barCount) {
    const symbol = String(sym).toUpperCase();
    const cached = readCached(symbol, "mover", barCount);
    if (cached?.length >= barCount) return cached;
    if (cacheOnly) {
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${symbol}`);
    }
    return fetchInterval(symbol, "1m", barCount);
  }

  return { fetchKlinesForSymbol, fetchKlines1mForSymbol };
}

async function runBacktest({
  label,
  botConfig,
  signalCfg,
  days,
  symbols,
  cacheOnly,
  restGapMs,
}) {
  const { fetchKlinesForSymbol, fetchKlines1mForSymbol } = createFetchers({
    cacheOnly,
    restGapMs,
    signalCfg,
    symbols,
  });

  log(`\n=== RUN: ${label} ===`);
  log(
    `Bot: corridor ${botConfig.maxSfpCorridorWidthPct}% · SFP TP ${botConfig.sfpTakeProfitPct}% · SL ${botConfig.stopLossBelowCorridorPct}% · regime ${botConfig.aiSfpRegimeEnabled ? "ON" : "OFF"}`
  );
  log(`Signal: ${signalCfg.interval} · sweep ${signalCfg.sfpMinSweepPct}% · ${symbols.length} symbols`);

  const started = Date.now();
  let lastSimSymbol = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol,
    fetchKlines1mForSymbol: signalCfg.interval !== "1m" ? fetchKlines1mForSymbol : null,
    restGapMs: cacheOnly ? 0 : restGapMs,
    runMeta: { optimize: true, label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== lastSimSymbol) {
        lastSimSymbol = p.symbol;
        if (p.done % 25 === 0 || p.done + 1 >= symbols.length) {
          logProgress(`[${label}] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      } else if (p.message?.startsWith("Done ")) {
        logProgress(`[${label}] ${p.message}`);
      }
    },
  });

  const summary = summarizeRun(result);
  log(
    `→ ${label}: PnL $${summary.pnl} · ${summary.trades} trades · WR ${summary.wins}/${summary.losses} · regime skips ${summary.regimeSkips} · ${summary.elapsedSec}s`
  );
  return { label, ...summary, elapsedTotalSec: Math.round((Date.now() - started) / 1000) };
}

async function trainRegimeModel(botConfig) {
  const trades = (loadLastBacktestResult()?.closedTrades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (trades.length < 12) {
    throw new Error(`Need >=12 SFP trades for regime training (got ${trades.length})`);
  }
  log(`\n=== TRAIN SFP regime (${trades.length} trades) ===`);

  function fetchBars(symbol) {
    const sym = String(symbol).toUpperCase();
    return (
      readSymbolBars("mover", sym) ??
      readSymbolBars("signal", sym) ??
      []
    );
  }

  await trainFromTrades(trades, fetchBars, {
    ...botConfig,
    modelScope: "paper",
    source: "optimize:backtest",
  });
  reloadModel("paper");
  log("Regime model saved.");
}

function loadResults() {
  return readJsonFile(RESULTS_FILE(), { runs: [], exportPath: null, updatedAt: null });
}

function saveResults(data) {
  writeJsonFile(RESULTS_FILE(), { ...data, updatedAt: new Date().toISOString() });
}

function baselineBotConfig() {
  return paperBotFromExport();
}

function baselineSignal(exportSignal) {
  return buildSignalCfg(exportSignal);
}

const BOT_SWEEPS_FULL = [
  { key: "maxSfpCorridorWidthPct", values: [7, 9, 11, 13] },
  { key: "sfpTakeProfitPct", values: [2.5, 3, 3.5, 4, 4.5] },
  { key: "stopLossBelowCorridorPct", values: [1.5, 2, 2.5, 3] },
  { key: "stopLossFallbackPnlPct", values: [1.5, 2, 2.5] },
  { key: "takeProfitMinPct", values: [1, 1.5, 2] },
];

const BOT_SWEEPS_QUICK = [
  { key: "maxSfpCorridorWidthPct", values: [7, 9, 11, 13] },
  { key: "sfpTakeProfitPct", values: [2.5, 3.5, 4.5] },
  { key: "stopLossBelowCorridorPct", values: [1.5, 2, 2.5, 3] },
];

const SIGNAL_SWEEPS_FULL = [{ key: "sfpMinSweepPct", values: [0.08, 0.1, 0.12, 0.15] }];
const SIGNAL_SWEEPS_QUICK = [{ key: "sfpMinSweepPct", values: [0.08, 0.12, 0.15] }];

const REGIME_SWEEPS_FULL = [
  { key: "aiSfpRegimeBullThreshold", values: [0.72, 0.76, 0.78, 0.82] },
  { key: "aiSfpRegimeBearThreshold", values: [0.68, 0.72, 0.74, 0.78] },
];

const REGIME_SWEEPS_QUICK = [
  { key: "aiSfpRegimeBullThreshold", values: [0.72, 0.76, 0.82] },
  { key: "aiSfpRegimeBearThreshold", values: [0.68, 0.74, 0.78] },
];

async function main() {
  const args = parseArgs(process.argv);
  ensureAllDefaultModelsOnDisk();
  try {
    fs.writeFileSync(LOG_FILE(), "");
  } catch {
    /* ignore */
  }

  const { paperBot: exportPaper, signal: exportSignal } = loadExport(args.exportPath);
  const baseBot = baselineBotConfig();
  const baseSignal = baselineSignal(exportSignal);
  applyPersistedConfig(baseBot, baseSignal);

  const universe = listExchangeSymbols();
  let symbols = cachedSymbolList(args.days, true);
  if (!symbols.length) {
    const { symList } = resolveBacktestSymbols({}, universe);
    symbols = symList;
  } else if (!args.cacheOnly) {
    const { symList } = resolveBacktestSymbols({}, universe);
    symbols = symList;
  }

  log(
    `Applied export (non-AI) · ${args.days}d · ${args.cacheOnly ? "cache-only" : "fetch"} · earlyAbort OFF · runner OFF`
  );
  log(`Symbols: ${symbols.length} · signal ${baseSignal.interval}`);

  const store = loadResults();
  store.exportPath = args.exportPath;
  store.days = args.days;
  store.cacheOnly = args.cacheOnly;
  store.symbolCount = symbols.length;

  const runAndStore = async (label, botPatch = {}, signalPatch = {}) => {
    const botConfig = normalizeConfig({ ...baseBot, ...botPatch });
    const signalCfg = buildSignalCfg({ ...baseSignal, ...signalPatch });
    const row = await runBacktest({
      label,
      botConfig,
      signalCfg,
      days: args.days,
      symbols,
      cacheOnly: args.cacheOnly,
      restGapMs: args.restGapMs,
    });
    store.runs = store.runs.filter((r) => r.label !== label);
    store.runs.push(row);
    saveResults(store);
    return row;
  };

  const want = (name) => args.phase === "all" || args.phase === name;

  if (want("baseline")) {
    await runAndStore("baseline_no_regime", { aiSfpRegimeEnabled: false });
  }

  if (want("train") || want("regime") || args.phase === "all") {
    if (!store.runs.some((r) => r.label === "baseline_no_regime")) {
      await runAndStore("baseline_no_regime", { aiSfpRegimeEnabled: false });
    }
    await trainRegimeModel(baseBot);
    store.regimeTrainedAt = new Date().toISOString();
    saveResults(store);
  }

  if (want("regime") || args.phase === "all") {
    await runAndStore("baseline_regime_on", {
      aiSfpRegimeEnabled: true,
    });
  }

  if (want("sweep") || args.phase === "all") {
    const regimeBot = {
      aiSfpRegimeEnabled: true,
    };
    const BOT_SWEEPS = args.quick ? BOT_SWEEPS_QUICK : BOT_SWEEPS_FULL;
    const SIGNAL_SWEEPS = args.quick ? SIGNAL_SWEEPS_QUICK : SIGNAL_SWEEPS_FULL;
    const REGIME_SWEEPS = args.quick ? REGIME_SWEEPS_QUICK : REGIME_SWEEPS_FULL;

    for (const sweep of BOT_SWEEPS) {
      for (const v of sweep.values) {
        if (v === baseBot[sweep.key]) continue;
        const label = `bot_${sweep.key}_${v}`;
        await runAndStore(label, { ...regimeBot, [sweep.key]: v });
      }
    }

    for (const sweep of SIGNAL_SWEEPS) {
      for (const v of sweep.values) {
        if (v === baseSignal[sweep.key]) continue;
        const label = `sig_${sweep.key}_${v}`;
        await runAndStore(label, regimeBot, { [sweep.key]: v });
      }
    }

    for (const sweep of REGIME_SWEEPS) {
      for (const v of sweep.values) {
        const baseTh = baseBot[sweep.key];
        if (v === baseTh) continue;
        const label = `regime_${sweep.key}_${v}`;
        await runAndStore(label, { ...regimeBot, [sweep.key]: v });
      }
    }
  }

  const ranked = [...store.runs].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
  store.ranking = ranked.slice(0, 15).map((r) => ({
    label: r.label,
    pnl: r.pnl,
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    regimeSkips: r.regimeSkips,
  }));
  saveResults(store);

  log("\n=== TOP RUNS ===");
  for (const r of store.ranking.slice(0, 10)) {
    log(`${r.label}: $${r.pnl} · ${r.trades} trades · skips ${r.regimeSkips}`);
  }
  log(`\nResults: ${RESULTS_FILE()}`);
}

main().catch((e) => {
  log(`FATAL: ${e.message || e}`);
  console.error(e);
  process.exit(1);
});
