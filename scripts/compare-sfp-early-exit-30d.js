#!/usr/bin/env node
/**
 * 30d A/B: SFP AI early exit ON vs OFF (full live stack).
 *
 *   node scripts/compare-sfp-early-exit-30d.js --days 30
 */
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb();

const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { loadFundingOiCache } = require("../lib/funding-oi-cache");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { reloadModel: reloadEarlyExit, isAiEarlyExitReason } = require("../lib/early-exit-model");
const { onnxDir: pbOnnxDir } = require("../lib/pullback-signal-onnx");
const { onnxDir: sfpOnnxDir } = require("../lib/sfp-regime-onnx");

const MIRROR = path.join(".cache", "railway-mirror");
const OUT_FILE = () => dataPath("sfp-early-exit-30d-compare.json");

function log(line) {
  console.error(String(line));
}

function parseArgs(argv) {
  let days = 30;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
  }
  return { days: Math.max(1, Math.min(60, Math.round(days) || 30)) };
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyOnnxDir(fromScope, toScope, onnxDirFn) {
  const src = onnxDirFn(fromScope);
  const dest = onnxDirFn(toScope);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    if (fs.statSync(srcPath).isFile()) fs.copyFileSync(srcPath, path.join(dest, name));
  }
}

function installLiveArtifacts() {
  const pairs = [
    ["sfp-regime-model-live.json", modelFileFor("sfp-regime-model", "paper")],
    ["pullback-signal-model-live.json", modelFileFor("pullback-signal-model", "paper")],
    ["ai-exit-levels-live.json", modelFileFor("ai-exit-levels", "paper")],
    ["early-exit-model-live.json", dataPath("early-exit-sfp.json")],
  ];
  for (const [srcName, dest] of pairs) {
    copyFile(path.join(MIRROR, srcName), dest);
  }
  copyOnnxDir("live", "paper", pbOnnxDir);
  copyOnnxDir("live", "paper", sfpOnnxDir);
  reloadSfp("paper");
  reloadPbSignal("paper");
  reloadExitLevels("paper");
  reloadEarlyExit("paper");
}

function loadLiveConfig() {
  const raw = readJsonFile(path.join(MIRROR, "live-bot-state.json"), {}).config || {};
  return normalizeLiveConfig({ enabled: true, ...raw });
}

function loadSignalConfig() {
  const scannerRaw = readJsonFile(path.join(MIRROR, "scanner-config.json"), {});
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
    pullbackMaxBelowMaPct: 1.5,
    ...scannerRaw,
  };
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

function breakdownBySignal(trades) {
  const kinds = ["sfp", "sfp_bear", "pullback", "pullback_bear"];
  const out = {};
  for (const k of kinds) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    const pnl = rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const aiExit = rows.filter((t) => isAiEarlyExitReason(t.exitReason)).length;
    out[k] = {
      trades: rows.length,
      pnl: +pnl.toFixed(2),
      winRate: +((100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) / rows.length).toFixed(1),
      aiExits: aiExit,
    };
  }
  return out;
}

function breakdownByExit(trades) {
  const map = new Map();
  for (const t of trades) {
    const r = t.exitReason || "unknown";
    if (!map.has(r)) map.set(r, { count: 0, pnl: 0 });
    const row = map.get(r);
    row.count++;
    row.pnl += Number(t.pnl) || 0;
  }
  return [...map.entries()]
    .map(([reason, v]) => ({
      reason,
      count: v.count,
      pnl: +v.pnl.toFixed(2),
    }))
    .sort((a, b) => b.count - a.count);
}

function summarize(result) {
  const s = result.summary ?? {};
  const trades = result.closedTrades ?? [];
  let aiExits = 0;
  let aiExitPnl = 0;
  let sfpAiExits = 0;
  for (const t of trades) {
    if (!isAiEarlyExitReason(t.exitReason)) continue;
    aiExits++;
    aiExitPnl += Number(t.pnl) || 0;
    if (t.signalKind === "sfp" || t.signalKind === "sfp_bear") sfpAiExits++;
  }
  return {
    pnl: +(s.realizedPnl ?? 0).toFixed(2),
    trades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    winRate: s.closedCount
      ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
      : 0,
    sfpRegimeSkips: s.sfpRegimeSkips ?? 0,
    pbSignalSkips: s.pullbackSignalSkips ?? 0,
    aiExits,
    sfpAiExits,
    aiExitPnl: +aiExitPnl.toFixed(2),
    bySignal: breakdownBySignal(trades),
    byExitReason: breakdownByExit(trades),
    elapsedSec: result.elapsedSec ?? 0,
  };
}

async function runOne({ label, botConfig, signalCfg, days, symbols, getFundingOiAt, fetchers }) {
  log(`\n=== ${label} ===`);
  log(
    `AI early exit ${botConfig.aiEarlyExitEnabled ? "ON" : "OFF"} · hard ${botConfig.aiEarlyExitHardThreshold} · soft ${botConfig.aiEarlyExitSoftThreshold} · minBars ${botConfig.aiEarlyExitMinBars}`
  );
  let last = "";
  const { result } = await runPaperBotBacktest({
    symbols,
    signalCfg,
    botConfig,
    days,
    fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
    fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
    restGapMs: 0,
    saveKlineCache: false,
    saveLastResult: false,
    getFundingOiAt,
    runMeta: { compare: "sfp-early-exit", label },
    onProgress: (p) => {
      if (p.phase === "simulate" && p.symbol && p.symbol !== last) {
        last = p.symbol;
        if (p.done % 100 === 0 || p.done + 1 >= symbols.length) {
          log(`[${label}] ${p.done + 1}/${symbols.length}`);
        }
      }
    },
  });
  const row = summarize(result);
  log(
    `→ $${row.pnl} · ${row.trades} tr · win ${row.winRate}% · AI exits ${row.aiExits} (SFP ${row.sfpAiExits}) · AI exit PnL $${row.aiExitPnl}`
  );
  return {
    label,
    aiEarlyExitEnabled: Boolean(botConfig.aiEarlyExitEnabled),
    ...row,
  };
}

async function main() {
  const { days } = parseArgs(process.argv);
  installLiveArtifacts();
  const baseBot = loadLiveConfig();
  const signalCfg = loadSignalConfig();
  const symbols = cachedSymbolList();
  if (!symbols.length) {
    console.error("No cached symbols.");
    process.exit(1);
  }
  const fetchers = createFetchers();
  const { lookup: getFundingOiAt } = loadFundingOiCache(symbols);

  log(`SFP early-exit compare · ${days}d · ${symbols.length} symbols · full live stack`);
  log(
    `Live: SFP GBM ${baseBot.aiSfpRegimeFundingOiGbmEnabled} · PB GBM ${baseBot.aiPullbackSignalFundingOiGbmEnabled} · exit levels ${baseBot.aiExitLevelsEnabled}`
  );

  const off = await runOne({
    label: "early_exit_off",
    botConfig: { ...baseBot, aiEarlyExitEnabled: false },
    signalCfg,
    days,
    symbols,
    getFundingOiAt,
    fetchers,
  });

  const on = await runOne({
    label: "early_exit_on",
    botConfig: { ...baseBot, aiEarlyExitEnabled: true },
    signalCfg,
    days,
    symbols,
    getFundingOiAt,
    fetchers,
  });

  const report = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    liveEarlyExit: {
      enabled: baseBot.aiEarlyExitEnabled,
      hard: baseBot.aiEarlyExitHardThreshold,
      soft: baseBot.aiEarlyExitSoftThreshold,
      minBars: baseBot.aiEarlyExitMinBars,
      barCloseOnly: baseBot.aiEarlyExitBarCloseOnly,
    },
    runs: [off, on],
    delta: {
      pnl: +(on.pnl - off.pnl).toFixed(2),
      trades: on.trades - off.trades,
      aiExits: on.aiExits - off.aiExits,
      sfpPnl:
        on.bySignal.sfp && off.bySignal.sfp
          ? +((on.bySignal.sfp.pnl + (on.bySignal.sfp_bear?.pnl ?? 0)) -
              (off.bySignal.sfp.pnl + (off.bySignal.sfp_bear?.pnl ?? 0))).toFixed(2)
          : null,
    },
    verdict:
      on.pnl > off.pnl
        ? "early_exit_on_better"
        : on.pnl < off.pnl
          ? "early_exit_off_better"
          : "tie",
  };

  writeJsonFile(OUT_FILE(), report);

  log("\n=== SFP AI EARLY EXIT 30D COMPARE ===");
  log(`OFF: $${off.pnl} · ${off.trades} tr · win ${off.winRate}%`);
  log(` ON: $${on.pnl} · ${on.trades} tr · win ${on.winRate}% · AI exits ${on.aiExits} ($${on.aiExitPnl})`);
  log(`Δ PnL: $${report.delta.pnl} · verdict: ${report.verdict}`);
  log(`Results: ${OUT_FILE()}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e.stack || e.message || e);
  process.exit(1);
});
