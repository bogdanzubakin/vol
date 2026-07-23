#!/usr/bin/env node
/**
 * Backtest current live settings on N days, then keep only profitable signal types.
 *
 *   node scripts/select-profitable-signals-5d.js --days 5
 *   node scripts/select-profitable-signals-5d.js --days 5 --apply
 *   node scripts/select-profitable-signals-5d.js --days 5 --apply --push
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const scannerConfig = require("../lib/scanner-config");
const { applyBarConfig } = require("../lib/signal-metrics");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

const SIGNAL_FLAGS = {
  sfp: "tradeSfpSignals",
  sfp_bear: "tradeBearishSfpSignals",
  pullback: "tradePullbackSignals",
  pullback_bear: "tradeBearishPullbackSignals",
  foi: "tradeFoiSignals",
  foi_bear: "tradeBearishFoiSignals",
};

const OUT_FILE = () => dataPath("live-profitable-signals-5d.json");

function parseArgs(argv) {
  let days = 5;
  let apply = false;
  let push = false;
  let probeAll = true;
  let skipBaseline = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--push") push = true;
    else if (argv[i] === "--current-only") probeAll = false;
    else if (argv[i] === "--skip-baseline") skipBaseline = true;
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 5)),
    apply,
    push,
    probeAll,
    skipBaseline,
  };
}

function log(msg) {
  console.error(String(msg));
}

function loadLiveBotConfig() {
  const saved = readJsonFile(dataPath("live-bot-state.json"), {})?.config ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...saved,
    armed: false,
    drawdownStopEnabled: false,
  });
}

function loadSignalConfig() {
  const cfg = {
    interval: "1m",
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
    pullbackMaxBelowMaPct: 1.5,
  };
  scannerConfig.loadInto(cfg);
  applyBarConfig(cfg);
  return cfg;
}

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
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
      const cached = readCached(sym, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no signal cache for ${sym}`);
    },
    async fetchKlines1mForSymbol(sym, barCount) {
      const cached = readCached(sym, "mover", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${sym}`);
    },
  };
}

function reloadModels() {
  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }
}

function breakdownBySignal(trades) {
  const out = {};
  for (const k of Object.keys(SIGNAL_FLAGS)) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    const pnl = rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const tp = rows.filter((t) => t.exitReason === "take_profit").length;
    const sl = rows.filter((t) => t.exitReason === "stop_loss").length;
    out[k] = {
      trades: rows.length,
      pnl: +pnl.toFixed(2),
      winRate: +(
        (100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) /
        rows.length
      ).toFixed(1),
      tpRate: +((100 * tp) / rows.length).toFixed(1),
      slRate: +((100 * sl) / rows.length).toFixed(1),
    };
  }
  return out;
}

function summarize(result) {
  const trades = result.closedTrades ?? [];
  const pnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  return {
    trades: trades.length,
    pnl: +pnl.toFixed(2),
    winRate: trades.length
      ? +(
          (100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) /
          trades.length
        ).toFixed(1)
      : 0,
    bySignal: breakdownBySignal(trades),
    elapsedSec: result.elapsedSec,
  };
}

function signalFlagsFromConfig(cfg) {
  return Object.fromEntries(
    Object.entries(SIGNAL_FLAGS).map(([kind, flag]) => [kind, Boolean(cfg[flag])])
  );
}

function flagsPatchFromBySignal(bySignal, { requireTrades = 1 } = {}) {
  const patch = {};
  const selected = [];
  const rejected = [];
  for (const [kind, flag] of Object.entries(SIGNAL_FLAGS)) {
    const row = bySignal[kind];
    const ok = row && row.trades >= requireTrades && row.pnl > 0;
    patch[flag] = Boolean(ok);
    if (ok) selected.push({ kind, ...row });
    else rejected.push({ kind, ...(row || { trades: 0, pnl: 0 }) });
  }
  return { patch, selected, rejected };
}

async function runBacktest({
  label,
  botConfig,
  signalCfg,
  days,
  symbols,
  fetchers,
  getFundingOiAt,
}) {
  log(`\n[${label}] starting · ${symbols.length} symbols · ${days}d`);
  let lastLoggedSym = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    getFundingOiAt,
    restGapMs: 0,
    saveLastResult: false,
    modelScope: "live",
    runMeta: { cli: "select-profitable-signals", label, days },
    onProgress: (p) => {
      if (p.phase !== "simulate" || !p.symbol) return;
      // Symbol-complete events use done = index+1; per-bar spam uses done = index.
      const completed = Number(p.done);
      if (!Number.isFinite(completed) || completed < 1) return;
      if (p.symbol === lastLoggedSym) return;
      if (completed % 50 !== 0 && completed < symbols.length) return;
      lastLoggedSym = p.symbol;
      log(`[${label}] ${completed}/${symbols.length} · ${p.symbol}`);
    },
  });
  return summarize(result);
}

function applyPatchToBotState(fileName, patch) {
  const file = dataPath(fileName);
  const state = readJsonFile(file, null);
  if (!state?.config) {
    log(`skip apply ${fileName}: missing config`);
    return null;
  }
  state.config = { ...state.config, ...patch };
  writeJsonFile(file, state);
  return state.config;
}

async function pushRailway() {
  const { spawnSync } = require("child_process");
  const env = {
    ...process.env,
    RAILWAY_URL:
      process.env.RAILWAY_URL || "https://vol-production-d574.up.railway.app",
  };
  const r = spawnSync("node", ["scripts/push-railway-data.js"], {
    cwd: path.join(__dirname, ".."),
    env,
    encoding: "utf8",
  });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(`push-railway-data failed (${r.status})`);
}

async function main() {
  const { days, apply, push, probeAll, skipBaseline } = parseArgs(process.argv);
  const symbols = cachedSymbolList();
  if (!symbols.length) throw new Error("No cached symbols");

  reloadModels();
  const { lookup: getFundingOiAt, bySymbol } = loadFundingOiCache(symbols);
  log(`Funding/OI cache symbols with data: ${Object.keys(bySymbol || {}).length}`);

  const base = loadLiveBotConfig();
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();

  log(
    `Select profitable signals · ${days}d · ${symbols.length} symbols · probeAll=${probeAll}`
  );
  log(
    `Current flags: ${JSON.stringify(signalFlagsFromConfig(base))}`
  );
  log(
    `FOI knobs: min=${base.foiMinAbsFundingRate} oi=${base.foiRequireOiConfirm} sfp=${base.foiConfirmSfp} pb=${base.foiConfirmPullback}`
  );

  let baseline = null;
  if (!skipBaseline) {
    baseline = await runBacktest({
      label: "baseline-current",
      botConfig: { ...base },
      signalCfg,
      days,
      symbols,
      fetchers,
      getFundingOiAt,
    });
    log(`baseline pnl $${baseline.pnl} · ${baseline.trades} trades`);
    log(`baseline bySignal ${JSON.stringify(baseline.bySignal)}`);
  }

  let probe = baseline;
  if (probeAll) {
    const allOn = {
      ...base,
      tradeSfpSignals: true,
      tradeBearishSfpSignals: true,
      tradePullbackSignals: true,
      tradeBearishPullbackSignals: true,
      tradeFoiSignals: true,
      tradeBearishFoiSignals: true,
    };
    probe = await runBacktest({
      label: "probe-all-signals",
      botConfig: allOn,
      signalCfg,
      days,
      symbols,
      fetchers,
      getFundingOiAt,
    });
    log(`probe-all pnl $${probe.pnl} · ${probe.trades} trades`);
    log(`probe-all bySignal ${JSON.stringify(probe.bySignal)}`);
  }

  if (!probe?.bySignal) throw new Error("No probe/baseline results to select from");

  const { patch, selected, rejected } = flagsPatchFromBySignal(probe.bySignal);
  log(`\nSelected (pnl>0): ${selected.map((s) => s.kind).join(", ") || "(none)"}`);
  log(
    `Rejected: ${rejected.map((r) => `${r.kind}:${r.pnl}`).join(", ") || "(none)"}`
  );

  const filteredCfg = { ...base, ...patch };
  const filtered = await runBacktest({
    label: "filtered-profitable-only",
    botConfig: filteredCfg,
    signalCfg,
    days,
    symbols,
    fetchers,
    getFundingOiAt,
  });
  log(`filtered pnl $${filtered.pnl} · ${filtered.trades} trades`);
  log(`filtered bySignal ${JSON.stringify(filtered.bySignal)}`);

  const report = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    probeAll,
    skipBaseline,
    baselineFlags: signalFlagsFromConfig(base),
    selectedFlags: signalFlagsFromConfig(filteredCfg),
    patch,
    selected,
    rejected,
    baseline,
    probe,
    filtered,
    deltaVsBaseline:
      baseline != null ? +(filtered.pnl - baseline.pnl).toFixed(2) : null,
  };
  writeJsonFile(OUT_FILE(), report);
  console.log(JSON.stringify(report, null, 2));
  log(`\nReport: ${OUT_FILE()}`);

  if (apply) {
    applyPatchToBotState("live-bot-state.json", patch);
    applyPatchToBotState("paper-bot-state.json", patch);
    log(`Applied signal flags to live + paper state: ${JSON.stringify(patch)}`);
  }
  if (push) {
    if (!apply) log("note: --push without --apply still pushes current local state files");
    await pushRailway();
  }
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
