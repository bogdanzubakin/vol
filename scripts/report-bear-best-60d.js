#!/usr/bin/env node
/**
 * 60d backtest of best live + bear exit/detection overrides.
 * Prints / saves report by day and by pair.
 *
 *   node scripts/report-bear-best-60d.js --days 60
 *   node scripts/report-bear-best-60d.js --days 60 --extend   # extend kline cache first
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ensureMinHeapMb } = require("../lib/node-mem");
ensureMinHeapMb(16384);

const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { normalizeLiveConfig } = require("../lib/live-bot");
const { applyBarConfig } = require("../lib/signal-metrics");
const { readSymbolBars, loadManifest, barsForDays } = require("../lib/backtest-kline-cache");
const { runPaperBotBacktest } = require("../lib/paper-bot-backtest");
const { reloadModel: reloadSfp } = require("../lib/sfp-regime-model");
const { reloadModel: reloadPbSignal } = require("../lib/pullback-signal-model");
const { reloadModel: reloadPbRegime } = require("../lib/pullback-regime-model");
const { reloadModel: reloadPbPattern } = require("../lib/pullback-pattern-break-model");
const { reloadModel: reloadEarlyExit } = require("../lib/early-exit-model");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");
const { DETECTION_OVERRIDE_BASE_KEYS } = require("../lib/side-config");
const { formatIsoUtcPlus3 } = require("../lib/time-format");

const OUT_FILE = () => dataPath("bear-best-60d-report.json");
const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  let days = 60;
  let extend = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--extend") extend = true;
  }
  return {
    days: Math.max(1, Math.min(60, Math.round(days) || 60)),
    extend,
  };
}

function log(msg) {
  console.error(String(msg));
}

function loadBotConfig() {
  const best10d = readJsonFile(dataPath("live-all-settings-best-10d.json"), null);
  const bearExit = readJsonFile(dataPath("bear-overrides-best-10d.json"), null);
  const local = readJsonFile(dataPath("live-bot-state.json"), null)?.config ?? {};
  return normalizeLiveConfig({
    enabled: true,
    ...local,
    ...(best10d?.patch ?? {}),
    ...(bearExit?.patch ?? {}),
    tradeSfpSignals: true,
    tradeBearishSfpSignals: true,
    tradePullbackSignals: true,
    tradeBearishPullbackSignals: true,
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
    ...scanner,
    ...(detection?.patch ?? {}),
  };
  for (const base of DETECTION_OVERRIDE_BASE_KEYS) {
    if (cfg[`${base}Bear`] === undefined) cfg[`${base}Bear`] = null;
    if (cfg[`${base}Bull`] === undefined) cfg[`${base}Bull`] = null;
  }
  applyBarConfig(cfg);
  return cfg;
}

function cachedSymbolList() {
  const root = path.join(dataPath(), "backtest-klines", "signal");
  if (!fs.existsSync(root)) return [];
  const need = barsForDays("1m", 1); // just ensure file exists
  void need;
  return fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.replace(/\.json\.gz$/, ""))
    .filter((sym) => {
      const sig = readSymbolBars("signal", sym);
      return (sig?.length ?? 0) >= 200;
    })
    .sort();
}

function cacheCoverageDays(symbols) {
  let minDays = Infinity;
  let maxDays = 0;
  let checked = 0;
  for (const sym of symbols.slice(0, 30)) {
    const bars = readSymbolBars("signal", sym);
    if (!bars?.length) continue;
    const d =
      (bars[bars.length - 1].closeTime - bars[0].closeTime) / 86_400_000;
    minDays = Math.min(minDays, d);
    maxDays = Math.max(maxDays, d);
    checked++;
  }
  const manifest = loadManifest();
  return {
    manifestDays: manifest?.days ?? 0,
    sampleMinDays: Number.isFinite(minDays) ? +minDays.toFixed(1) : 0,
    sampleMaxDays: +maxDays.toFixed(1),
    sampleChecked: checked,
  };
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
      // 1m interval uses signal bars as timeline; fall back to mover then signal.
      const cached =
        readCached(sym, "mover", barCount) ?? readCached(sym, "signal", barCount);
      if (cached?.length >= 200) return cached;
      throw new Error(`no 1m cache for ${sym}`);
    },
  };
}

function dayKey(t) {
  const iso =
    t.closedAtIso ??
    (t.closedAt != null ? formatIsoUtcPlus3(t.closedAt) : null);
  return iso ? iso.slice(0, 10) : "unknown";
}

function breakdownByDay(trades) {
  const map = new Map();
  for (const t of trades) {
    const day = dayKey(t);
    if (!map.has(day)) {
      map.set(day, {
        day,
        trades: 0,
        pnl: 0,
        wins: 0,
        bullPnl: 0,
        bearPnl: 0,
        bySignal: {},
      });
    }
    const row = map.get(day);
    const pnl = Number(t.pnl) || 0;
    const kind = t.signalKind || "unknown";
    row.trades++;
    row.pnl += pnl;
    if (pnl > 0) row.wins++;
    if (kind === "sfp" || kind === "pullback") row.bullPnl += pnl;
    if (kind === "sfp_bear" || kind === "pullback_bear") row.bearPnl += pnl;
    if (!row.bySignal[kind]) row.bySignal[kind] = { trades: 0, pnl: 0 };
    row.bySignal[kind].trades++;
    row.bySignal[kind].pnl += pnl;
  }
  return [...map.values()]
    .map((r) => ({
      day: r.day,
      trades: r.trades,
      pnl: +r.pnl.toFixed(2),
      winRate: r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0,
      bullPnl: +r.bullPnl.toFixed(2),
      bearPnl: +r.bearPnl.toFixed(2),
      bySignal: Object.fromEntries(
        Object.entries(r.bySignal).map(([k, v]) => [
          k,
          { trades: v.trades, pnl: +v.pnl.toFixed(2) },
        ])
      ),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function breakdownByPair(trades) {
  const map = new Map();
  for (const t of trades) {
    const sym = t.symbol || "unknown";
    if (!map.has(sym)) {
      map.set(sym, {
        symbol: sym,
        trades: 0,
        pnl: 0,
        wins: 0,
        bullPnl: 0,
        bearPnl: 0,
        bySignal: {},
      });
    }
    const row = map.get(sym);
    const pnl = Number(t.pnl) || 0;
    const kind = t.signalKind || "unknown";
    row.trades++;
    row.pnl += pnl;
    if (pnl > 0) row.wins++;
    if (kind === "sfp" || kind === "pullback") row.bullPnl += pnl;
    if (kind === "sfp_bear" || kind === "pullback_bear") row.bearPnl += pnl;
    if (!row.bySignal[kind]) row.bySignal[kind] = { trades: 0, pnl: 0 };
    row.bySignal[kind].trades++;
    row.bySignal[kind].pnl += pnl;
  }
  return [...map.values()]
    .map((r) => ({
      symbol: r.symbol,
      trades: r.trades,
      pnl: +r.pnl.toFixed(2),
      winRate: r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0,
      bullPnl: +r.bullPnl.toFixed(2),
      bearPnl: +r.bearPnl.toFixed(2),
      bySignal: Object.fromEntries(
        Object.entries(r.bySignal).map(([k, v]) => [
          k,
          { trades: v.trades, pnl: +v.pnl.toFixed(2) },
        ])
      ),
    }))
    .sort((a, b) => b.pnl - a.pnl || b.trades - a.trades);
}

function breakdownBySignal(trades) {
  const out = {};
  for (const k of ["sfp", "sfp_bear", "pullback", "pullback_bear"]) {
    const rows = trades.filter((t) => t.signalKind === k);
    if (!rows.length) continue;
    const pnl = rows.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    out[k] = {
      trades: rows.length,
      pnl: +pnl.toFixed(2),
      winRate: +((100 * rows.filter((t) => (t.pnl ?? 0) > 0).length) / rows.length).toFixed(1),
    };
  }
  return out;
}

function ensureCache(days) {
  log(`Extending kline cache to ${days}d…`);
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "extend-backtest-klines.js"),
      "--to-days",
      String(days),
      "--rest-gap-ms",
      "400",
      "--batch-pause-ms",
      "100",
      "--symbol-pause-ms",
      "0",
    ],
    { cwd: ROOT, env: process.env, encoding: "utf8", stdio: "inherit" }
  );
  if (r.status !== 0) {
    throw new Error(`extend-backtest-klines failed with status ${r.status}`);
  }
}

function printTable(rows, columns) {
  const widths = columns.map((c) =>
    Math.max(
      c.label.length,
      ...rows.map((r) => String(c.fmt ? c.fmt(r[c.key]) : r[c.key] ?? "").length)
    )
  );
  const line = (vals) =>
    vals.map((v, i) => String(v).padStart(widths[i])).join("  ");
  log(line(columns.map((c) => c.label)));
  log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) {
    log(
      line(
        columns.map((c) => (c.fmt ? c.fmt(r[c.key]) : r[c.key] ?? ""))
      )
    );
  }
}

async function main() {
  const { days, extend } = parseArgs(process.argv);

  for (const scope of ["paper", "live"]) {
    reloadSfp(scope);
    reloadPbSignal(scope);
    reloadPbRegime(scope);
    reloadPbPattern(scope);
    reloadEarlyExit(scope);
    reloadExitLevels(scope);
  }

  let symbols = cachedSymbolList();
  if (!symbols.length) throw new Error("No cached symbols");

  const coverage = cacheCoverageDays(symbols);
  log(
    `Cache coverage: manifest ${coverage.manifestDays}d · sample ${coverage.sampleMinDays}–${coverage.sampleMaxDays}d`
  );

  if (extend || coverage.sampleMinDays < days - 0.5) {
    if (!extend) {
      log(
        `Cache too short for ${days}d (have ~${coverage.sampleMinDays}d) — extending…`
      );
    }
    ensureCache(days);
    symbols = cachedSymbolList();
  }

  const botConfig = loadBotConfig();
  const signalCfg = loadSignalConfig();
  const fetchers = createFetchers();
  const detectionPatch =
    readJsonFile(dataPath("bear-detection-best-10d.json"), null)?.patch ?? {};
  const exitPatch =
    readJsonFile(dataPath("bear-overrides-best-10d.json"), null)?.patch ?? {};

  log(
    `\nBear-best ${days}d report · ${symbols.length} symbols · lev ${botConfig.leverage}x · margin $${botConfig.positionSizeUsdt}`
  );
  log(`Exit *Bear: ${JSON.stringify(exitPatch)}`);
  log(`Detection *Bear: ${JSON.stringify(detectionPatch)}`);

  const BATCH = 40;
  const trades = [];
  let elapsedSec = 0;
  const started = Date.now();

  for (let offset = 0; offset < symbols.length; offset += BATCH) {
    const batch = symbols.slice(offset, offset + BATCH);
    const batchNo = Math.floor(offset / BATCH) + 1;
    const batchTotal = Math.ceil(symbols.length / BATCH);
    log(
      `[batch ${batchNo}/${batchTotal}] ${batch[0]}…${batch[batch.length - 1]} (${batch.length})`
    );

    const { result } = await runPaperBotBacktest({
      symbols: batch,
      signalCfg,
      botConfig,
      days,
      fetchKlinesForSymbol: fetchers.fetchKlinesForSymbol,
      fetchKlines1mForSymbol: fetchers.fetchKlines1mForSymbol,
      restGapMs: 0,
      saveLastResult: false,
      saveKlineCache: false,
      modelScope: "paper",
      runMeta: { report: "bear-best-60d", days, batch: batchNo },
    });

    elapsedSec += Number(result.elapsedSec) || 0;
    for (const t of result.closedTrades ?? []) {
      trades.push({
        symbol: t.symbol,
        signalKind: t.signalKind,
        pnl: t.pnl,
        closedAt: t.closedAt,
        closedAtIso: t.closedAtIso,
        openedAt: t.openedAt,
        exitReason: t.exitReason,
      });
    }
    // Drop heavy result ASAP.
    result.closedTrades = null;
    if (global.gc) global.gc();
    log(
      `  → batch trades ${(result.summary?.closedCount ?? "?")} · cum ${trades.length} · ${Math.round((Date.now() - started) / 1000)}s`
    );
  }

  const totalPnl = trades.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
  const byDay = breakdownByDay(trades);
  const byPair = breakdownByPair(trades);
  const bySignal = breakdownBySignal(trades);
  const bullPnl = (bySignal.sfp?.pnl ?? 0) + (bySignal.pullback?.pnl ?? 0);
  const bearPnl =
    (bySignal.sfp_bear?.pnl ?? 0) + (bySignal.pullback_bear?.pnl ?? 0);

  const report = {
    ranAt: new Date().toISOString(),
    days,
    symbolCount: symbols.length,
    cache: cacheCoverageDays(symbols),
    patches: { exit: exitPatch, detection: detectionPatch },
    summary: {
      trades: trades.length,
      pnl: +totalPnl.toFixed(2),
      bullPnl: +bullPnl.toFixed(2),
      bearPnl: +bearPnl.toFixed(2),
      winRate: trades.length
        ? +((100 * trades.filter((t) => (t.pnl ?? 0) > 0).length) / trades.length).toFixed(1)
        : 0,
      elapsedSec: +(elapsedSec || (Date.now() - started) / 1000).toFixed(1),
      pairsTraded: byPair.length,
      profitablePairs: byPair.filter((p) => p.pnl > 0).length,
      losingPairs: byPair.filter((p) => p.pnl < 0).length,
    },
    bySignal,
    byDay,
    byPair,
    topPairs: byPair.slice(0, 30),
    bottomPairs: [...byPair].sort((a, b) => a.pnl - b.pnl).slice(0, 30),
  };

  writeJsonFile(OUT_FILE(), report);

  log("\n=== SUMMARY ===");
  log(
    `PnL $${report.summary.pnl} (bull $${report.summary.bullPnl} / bear $${report.summary.bearPnl}) · ${report.summary.trades} tr · WR ${report.summary.winRate}%`
  );
  log(`bySignal ${JSON.stringify(bySignal)}`);

  log("\n=== BY DAY ===");
  printTable(byDay, [
    { key: "day", label: "day" },
    { key: "trades", label: "tr" },
    { key: "pnl", label: "pnl", fmt: (v) => Number(v).toFixed(2) },
    { key: "bullPnl", label: "bull", fmt: (v) => Number(v).toFixed(2) },
    { key: "bearPnl", label: "bear", fmt: (v) => Number(v).toFixed(2) },
    { key: "winRate", label: "WR%", fmt: (v) => Number(v).toFixed(1) },
  ]);

  log("\n=== TOP PAIRS ===");
  printTable(report.topPairs.slice(0, 25), [
    { key: "symbol", label: "pair" },
    { key: "trades", label: "tr" },
    { key: "pnl", label: "pnl", fmt: (v) => Number(v).toFixed(2) },
    { key: "bullPnl", label: "bull", fmt: (v) => Number(v).toFixed(2) },
    { key: "bearPnl", label: "bear", fmt: (v) => Number(v).toFixed(2) },
    { key: "winRate", label: "WR%", fmt: (v) => Number(v).toFixed(1) },
  ]);

  log("\n=== BOTTOM PAIRS ===");
  printTable(report.bottomPairs.slice(0, 25), [
    { key: "symbol", label: "pair" },
    { key: "trades", label: "tr" },
    { key: "pnl", label: "pnl", fmt: (v) => Number(v).toFixed(2) },
    { key: "bullPnl", label: "bull", fmt: (v) => Number(v).toFixed(2) },
    { key: "bearPnl", label: "bear", fmt: (v) => Number(v).toFixed(2) },
    { key: "winRate", label: "WR%", fmt: (v) => Number(v).toFixed(1) },
  ]);

  log(`\nFull report: ${OUT_FILE()}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
