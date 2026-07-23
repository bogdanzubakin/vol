#!/usr/bin/env node
/**
 * Validate FOI best patch on full universe (and optional short-only).
 *   node scripts/validate-foi-best-10d.js --days 10
 *   node scripts/validate-foi-best-10d.js --days 10 --only best_short_only
 */
const fs = require("fs");
const path = require("path");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(12288);

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

const BATCH = 50;
const OUT = () => dataPath("foi-validate-best-10d.json");

function log(m) {
  console.error(String(m));
}

function loadBase() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  const foiBest = readJsonFile(dataPath("foi-best-10d.json"), null)?.patch ?? {};
  return { local, best10d, bearExit, foiBest };
}

function makeBot(extra = {}) {
  const { local, best10d, bearExit, foiBest } = loadBase();
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    tradeSfpSignals: false,
    tradeBearishSfpSignals: false,
    tradePullbackSignals: false,
    tradeBearishPullbackSignals: false,
    tradeFoiSignals: true,
    tradeBearishFoiSignals: true,
    foiMinAbsFundingRate: 0.00012,
    foiRequireOiConfirm: true,
    foiConfirmSfp: true,
    foiConfirmPullback: true,
    ...foiBest,
    ...extra,
    armed: false,
    drawdownStopEnabled: false,
    aiRegimeBtcFastLookbackHours: local.aiRegimeBtcFastLookbackHours ?? 2,
    aiPullbackSignalBtcFastLookbackHours:
      local.aiPullbackSignalBtcFastLookbackHours ?? 2,
  });
}

function loadSignalConfig() {
  const scanner = readJsonFile(dataPath("scanner-config.json"), {}) ?? {};
  const detection = readJsonFile(dataPath("bear-detection-best-10d.json"), null);
  const cfg = {
    interval: "1m",
    sfpLookbackBars: 30,
    sfpRangeBars: 45,
    sfpReclaimBars: 5,
    sfpMinSweepPct: 0.08,
    pullbackMaBars: 7,
    pullbackTouchLookback: 12,
    pullbackMaxDistancePct: 0.35,
    pullbackMaxAboveMaPct: 1.5,
    pullbackMaxBelowMaPct: 1.5,
    fastMoveLookbackCandles: 15,
    minAvgMovePct: 0.4,
    minLinearChangePct: 0.5,
    fastMoveExcludeMult: 3,
    ...scanner,
    ...(detection?.patch ?? {}),
  };
  applyBarConfig(cfg);
  return cfg;
}

function symbols() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((s) => (readSymbolBars("signal", s)?.length ?? 0) >= 200)
    .sort();
}

function fetchers() {
  function read(sym, kind, n) {
    const bars = readSymbolBars(kind, sym);
    if (!bars?.length) return null;
    return bars.length > n ? bars.slice(-n) : bars;
  }
  return {
    async fetchKlinesForSymbol(sym, n) {
      const c = read(sym, "signal", n);
      if (c?.length >= 200) return c;
      throw new Error(`no signal ${sym}`);
    },
    async fetchKlines1mForSymbol(sym, n) {
      const c = read(sym, "mover", n) ?? read(sym, "signal", n);
      if (c?.length >= 200) return c;
      throw new Error(`no 1m ${sym}`);
    },
  };
}

function summarize(trades) {
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const by = {};
  for (const k of ["foi", "foi_bear"]) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    by[k] = {
      trades: rows.length,
      pnl: +rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0).toFixed(2),
      winRate: +((100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) / rows.length).toFixed(1),
    };
  }
  return {
    trades: trades.length,
    pnl: +pnl.toFixed(2),
    winRate: trades.length
      ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
      : 0,
    bySignal: by,
  };
}

async function runOne(label, botConfig, days, syms, f, getFundingOiAt, signalCfg) {
  const trades = [];
  const started = Date.now();
  for (let i = 0; i < syms.length; i += BATCH) {
    const batch = syms.slice(i, i + BATCH);
    log(`[${label}] ${i + 1}-${Math.min(i + BATCH, syms.length)}/${syms.length}`);
    const { result } = await runPaperBotBacktest({
      symbols: batch,
      signalCfg,
      botConfig,
      days,
      fetchKlinesForSymbol: f.fetchKlinesForSymbol,
      fetchKlines1mForSymbol: f.fetchKlines1mForSymbol,
      getFundingOiAt,
      restGapMs: 0,
      saveLastResult: false,
      saveKlineCache: false,
      modelScope: "paper",
      runMeta: { validate: "foi-best", label },
    });
    for (const t of result.closedTrades ?? []) {
      trades.push({ symbol: t.symbol, signalKind: t.signalKind, pnl: t.pnl });
    }
    result.closedTrades = null;
    if (global.gc) global.gc();
  }
  const row = { label, ...summarize(trades), elapsedSec: +((Date.now() - started) / 1000).toFixed(1) };
  log(
    `→ ${label}: $${row.pnl} · ${row.trades} tr · WR ${row.winRate}% · ${JSON.stringify(row.bySignal)}`
  );
  return row;
}

function parseArgs(argv) {
  let days = 10;
  let only = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Math.max(1, Number(argv[++i]) || 10);
    else if (argv[i] === "--only" && argv[i + 1]) only = String(argv[++i]);
  }
  return { days, only };
}

async function main() {
  const { days, only } = parseArgs(process.argv);
  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }
  const syms = symbols();
  const signalCfg = loadSignalConfig();
  const f = fetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(syms);
  const foiBest = readJsonFile(dataPath("foi-best-10d.json"), null)?.patch ?? {};

  log(`Validate FOI best · ${days}d · ${syms.length} symbols${only ? ` · only ${only}` : ""}`);
  log(`patch ${JSON.stringify(foiBest)}`);

  let variants = [
    { label: "baseline_default", bot: makeBot({ ...Object.fromEntries(Object.keys(foiBest).map((k) => [k, undefined])), tradeFoiSignals: true, tradeBearishFoiSignals: true, foiMinAbsFundingRate: 0.00012, foiRequireOiConfirm: true, foiConfirmSfp: true, foiConfirmPullback: true, takeProfitPct: undefined, sfpTakeProfitPct: undefined, takeProfitMinPct: undefined }) },
    { label: "best_both", bot: makeBot({}) },
    {
      label: "best_short_only",
      bot: makeBot({ tradeFoiSignals: false, tradeBearishFoiSignals: true }),
    },
  ];
  if (only) {
    variants = variants.filter((v) => v.label === only);
    if (!variants.length) {
      throw new Error(`Unknown --only ${only} (expected baseline_default|best_both|best_short_only)`);
    }
  }

  // Fix baseline: explicitly clear FOI best overrides
  const baseline = variants.find((v) => v.label === "baseline_default");
  if (baseline) {
    const { local, best10d, bearExit } = loadBase();
    baseline.bot = normalizeLiveConfig({
      enabled: true,
      ...local,
      ...(best10d?.patch ?? {}),
      ...(bearExit?.patch ?? {}),
      tradeSfpSignals: false,
      tradeBearishSfpSignals: false,
      tradePullbackSignals: false,
      tradeBearishPullbackSignals: false,
      tradeFoiSignals: true,
      tradeBearishFoiSignals: true,
      foiMinAbsFundingRate: 0.00012,
      foiMinAbsFundingRateBull: null,
      foiMinAbsFundingRateBear: null,
      foiRequireOiConfirm: true,
      foiConfirmSfp: true,
      foiConfirmPullback: true,
      armed: false,
      drawdownStopEnabled: false,
    });
  }

  const rows = [];
  for (const v of variants) {
    rows.push(await runOne(v.label, v.bot, days, syms, f, getFundingOiAt, signalCfg));
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  const winner = rows[0];
  const out = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: syms.length,
    screenBestPatch: foiBest,
    rows,
    winner: winner.label,
    winnerPnl: winner.pnl,
  };
  writeJsonFile(OUT(), out);
  writeJsonFile(dataPath("foi-best-10d.json"), {
    appliedAt: new Date().toISOString(),
    validatedOn: "full-universe",
    symbolCount: syms.length,
    screenPnl200: readJsonFile(dataPath("foi-best-10d.json"), null)?.bestPnl ?? null,
    baselinePnl: rows.find((r) => r.label === "baseline_default")?.pnl ?? null,
    bestPnl: winner.pnl,
    bestLabel: winner.label,
    patch:
      winner.label === "best_short_only"
        ? { ...foiBest, tradeFoiSignals: false, tradeBearishFoiSignals: true }
        : winner.label === "best_both"
          ? { ...foiBest, tradeFoiSignals: true, tradeBearishFoiSignals: true }
          : {
              tradeFoiSignals: true,
              tradeBearishFoiSignals: true,
              foiMinAbsFundingRate: 0.00012,
              foiRequireOiConfirm: true,
              foiConfirmSfp: true,
              foiConfirmPullback: true,
            },
    bySignal: winner.bySignal,
  });
  log("\n=== WINNER ===");
  log(`${winner.label} · $${winner.pnl} · ${winner.trades} tr · WR ${winner.winRate}%`);
  log(`Saved ${OUT()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
