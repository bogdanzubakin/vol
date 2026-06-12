const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { loadLastBacktestResult } = require("./paper-bot-backtest");
const { DEFAULT_CONFIG } = require("./paper-bot");
const { LIVE_CONFIG_KEYS } = require("./signal-metrics");
const { formatIsoUtcPlus3 } = require("./time-format");

const EXPORT_FORMAT_VERSION = 2;
const REPO_ROOT = path.join(__dirname, "..");

const SOURCE_FILES = [
  "package.json",
  "lib/paper-bot.js",
  "lib/paper-bot-simulator.js",
  "lib/paper-bot-backtest.js",
  "lib/signal-metrics.js",
  "lib/scanner-config.js",
];

function readPackageJson() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );
  } catch {
    return { name: "volatility", version: "unknown" };
  }
}

function readGitInfo() {
  const run = (cmd) => {
    try {
      return execSync(cmd, {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const commit = run("git rev-parse HEAD");
  if (!commit) return null;
  return {
    commit,
    commitShort: commit.slice(0, 12),
    branch: run("git rev-parse --abbrev-ref HEAD"),
    dirty: run("git status --porcelain") ? true : false,
  };
}

function readSourceBundle(includeSourceCode = true) {
  if (!includeSourceCode) return null;
  const files = {};
  for (const rel of SOURCE_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    try {
      files[rel] = fs.readFileSync(abs, "utf8");
    } catch {
      files[rel] = null;
    }
  }
  return files;
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function stats(nums) {
  const a = nums.filter((n) => Number.isFinite(n));
  if (!a.length) return null;
  const sum = a.reduce((s, n) => s + n, 0);
  return {
    min: +Math.min(...a).toFixed(4),
    max: +Math.max(...a).toFixed(4),
    avg: +(sum / a.length).toFixed(4),
    median: median(a) != null ? +median(a).toFixed(4) : null,
  };
}

function enrichTrade(trade) {
  const openedAt = trade.openedAt;
  const closedAt = trade.closedAt;
  const durationSec =
    Number.isFinite(openedAt) && Number.isFinite(closedAt)
      ? Math.max(0, Math.floor((closedAt - openedAt) / 1000))
      : null;
  const hadAdds = trade.hadAdds ?? (trade.addCount ?? 0) > 0;
  return {
    ...trade,
    durationSec,
    durationMin: durationSec != null ? +(durationSec / 60).toFixed(1) : null,
    win: (trade.pnl ?? 0) > 0,
    hadAdds,
  };
}

function groupBy(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const key = String(keyFn(t) ?? "unknown");
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        count: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        totalPnl: 0,
        totalMargin: 0,
        withAdds: 0,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    const pnl = t.pnl ?? 0;
    g.totalPnl += pnl;
    g.totalMargin += t.margin ?? 0;
    if (t.hadAdds) g.withAdds += 1;
    if (pnl > 0) g.wins += 1;
    else if (pnl < 0) g.losses += 1;
    else g.breakeven += 1;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    totalPnl: +g.totalPnl.toFixed(4),
    avgPnl: g.count ? +(g.totalPnl / g.count).toFixed(4) : 0,
    avgMargin: g.count ? +(g.totalMargin / g.count).toFixed(4) : 0,
    winRatePct: g.count ? +((100 * g.wins) / g.count).toFixed(2) : 0,
    withAddsPct: g.count ? +((100 * g.withAdds) / g.count).toFixed(2) : 0,
  }));
}

function histogram(trades, valueFn, edges, labelFn) {
  const buckets = edges.map((edge, i) => ({
    from: edge,
    to: edges[i + 1] ?? null,
    label: labelFn ? labelFn(edge, edges[i + 1], i) : `${edge}`,
    count: 0,
    totalPnl: 0,
    wins: 0,
  }));
  for (const t of trades) {
    const v = valueFn(t);
    if (!Number.isFinite(v)) continue;
    let idx = edges.length - 1;
    for (let i = 0; i < edges.length - 1; i++) {
      if (v >= edges[i] && v < edges[i + 1]) {
        idx = i;
        break;
      }
    }
    if (v >= edges[edges.length - 1]) idx = edges.length - 1;
    const b = buckets[idx];
    if (!b) continue;
    b.count += 1;
    b.totalPnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) b.wins += 1;
  }
  return buckets
    .filter((b) => b.count > 0)
    .map((b) => ({
      ...b,
      totalPnl: +b.totalPnl.toFixed(4),
      avgPnl: b.count ? +(b.totalPnl / b.count).toFixed(4) : 0,
      winRatePct: b.count ? +((100 * b.wins) / b.count).toFixed(2) : 0,
    }));
}

function crossTab(trades, rowFn, colFn) {
  const rows = new Map();
  for (const t of trades) {
    const rk = String(rowFn(t) ?? "unknown");
    const ck = String(colFn(t) ?? "unknown");
    if (!rows.has(rk)) rows.set(rk, new Map());
    const row = rows.get(rk);
    if (!row.has(ck)) {
      row.set(ck, { count: 0, totalPnl: 0, wins: 0 });
    }
    const cell = row.get(ck);
    cell.count += 1;
    cell.totalPnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) cell.wins += 1;
  }
  const out = [];
  for (const [rowKey, cols] of rows) {
    for (const [colKey, cell] of cols) {
      out.push({
        row: rowKey,
        col: colKey,
        count: cell.count,
        totalPnl: +cell.totalPnl.toFixed(4),
        avgPnl: cell.count ? +(cell.totalPnl / cell.count).toFixed(4) : 0,
        winRatePct: cell.count ? +((100 * cell.wins) / cell.count).toFixed(2) : 0,
      });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

function dailyPnl(trades) {
  const days = new Map();
  for (const t of trades) {
    const iso = t.closedAtIso ?? (t.closedAt != null ? formatIsoUtcPlus3(t.closedAt) : null);
    const day = iso ? iso.slice(0, 10) : "unknown";
    if (!days.has(day)) {
      days.set(day, { day, count: 0, totalPnl: 0, wins: 0 });
    }
    const d = days.get(day);
    d.count += 1;
    d.totalPnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) d.wins += 1;
  }
  return [...days.values()]
    .map((d) => ({
      ...d,
      totalPnl: +d.totalPnl.toFixed(4),
      winRatePct: d.count ? +((100 * d.wins) / d.count).toFixed(2) : 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function symbolLeaders(perSymbol, trades) {
  const traded = (perSymbol ?? []).filter((r) => !r.error && !r.skipped);
  const withTrades = traded.filter((r) => (r.trades ?? 0) > 0);
  const repeatLosers = withTrades
    .filter((r) => (r.trades ?? 0) >= 2 && (r.pnl ?? 0) < 0)
    .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0));
  const bySymbolTradeCount = groupBy(trades, (t) => t.symbol);
  return {
    universe: traded.length,
    withSignals: traded.filter((r) => (r.signals ?? 0) > 0).length,
    withTrades: withTrades.length,
    zeroSignals: traded.filter((r) => (r.signals ?? 0) === 0).length,
    profitable: withTrades.filter((r) => (r.pnl ?? 0) > 0).length,
    losing: withTrades.filter((r) => (r.pnl ?? 0) < 0).length,
    repeatLosers: repeatLosers.slice(0, 20),
    mostTraded: [...bySymbolTradeCount]
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    topByPnl: [...withTrades].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 25),
    bottomByPnl: [...withTrades].sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0)).slice(0, 25),
  };
}

function signalSnapshotStats(trades) {
  const withSnap = trades.filter((t) => t.signalSnapshot);
  if (!withSnap.length) return null;
  const fields = [
    "corridorWidthPct",
    "aboveCorridorCount",
    "breakVolumeRatio",
    "rangeRatio",
    "bullishCount",
    "breakGapPct",
  ];
  const winners = withSnap.filter((t) => (t.pnl ?? 0) > 0);
  const losers = withSnap.filter((t) => (t.pnl ?? 0) <= 0);
  const fieldStats = {};
  for (const f of fields) {
    fieldStats[f] = {
      all: stats(withSnap.map((t) => t.signalSnapshot?.[f])),
      winners: stats(winners.map((t) => t.signalSnapshot?.[f])),
      losers: stats(losers.map((t) => t.signalSnapshot?.[f])),
    };
  }
  return {
    tradesWithSnapshot: withSnap.length,
    fieldStats,
  };
}

function mfeMaeStats(trades) {
  const withPeak = trades.filter((t) => Number.isFinite(t.peakMovePct));
  if (!withPeak.length) return null;
  return {
    peakMovePct: stats(withPeak.map((t) => t.peakMovePct)),
    troughMovePct: stats(withPeak.map((t) => t.troughMovePct)),
    movePctAtExit: stats(withPeak.map((t) => t.movePctAtExit)),
    winnersPeak: stats(
      withPeak.filter((t) => (t.pnl ?? 0) > 0).map((t) => t.peakMovePct)
    ),
    losersPeak: stats(
      withPeak.filter((t) => (t.pnl ?? 0) <= 0).map((t) => t.peakMovePct)
    ),
    tpCandidates: withPeak.filter(
      (t) =>
        t.exitReason !== "take_profit" &&
        Number.isFinite(t.peakMovePct) &&
        Number.isFinite(t.tpDistancePct) &&
        t.peakMovePct >= t.tpDistancePct * 0.9
    ).length,
  };
}

function computeAnalytics(trades, summary, perSymbol, result) {
  const durations = trades.map((t) => t.durationSec).filter(Number.isFinite);
  const pnls = trades.map((t) => t.pnl ?? 0);
  const margins = trades.map((t) => t.margin ?? 0);

  return {
    summary: summary ?? null,
    tradeCount: trades.length,
    storedTradeCount: result?.closedTradesTotal ?? trades.length,
    truncated:
      (result?.closedTradesTotal ?? trades.length) > trades.length,
    byExitReason: groupBy(trades, (t) => t.exitReason).sort(
      (a, b) => b.count - a.count
    ),
    bySignalKind: groupBy(trades, (t) => t.signalKind).sort(
      (a, b) => b.count - a.count
    ),
    byAddCount: groupBy(trades, (t) => t.addCount ?? 0).sort(
      (a, b) => Number(a.key) - Number(b.key)
    ),
    byHadAdds: groupBy(trades, (t) => (t.hadAdds ? "with_adds" : "no_adds")),
    exitReasonVsAdds: crossTab(
      trades,
      (t) => t.exitReason,
      (t) => (t.hadAdds ? "with_adds" : "no_adds")
    ),
    durationSec: stats(durations),
    durationByExitReason: Object.fromEntries(
      groupBy(trades, (t) => t.exitReason).map((g) => [
        g.key,
        stats(
          trades
            .filter((t) => t.exitReason === g.key)
            .map((t) => t.durationSec)
        ),
      ])
    ),
    pnl: stats(pnls),
    pnlPct: stats(trades.map((t) => t.pnlPct)),
    margin: stats(margins),
    pnlPctHistogram: histogram(
      trades,
      (t) => t.pnlPct ?? 0,
      [-100, -5, -2, -1, -0.5, 0, 0.5, 1, 2, 5, 10, 100],
      (from, to) => (to != null ? `${from} to ${to}%` : `≥${from}%`)
    ),
    durationHistogramMin: histogram(
      trades,
      (t) => (t.durationSec ?? 0) / 60,
      [0, 10, 20, 30, 45, 60, 120, 240, 99999],
      (from, to) => (to != null && to < 99999 ? `${from}-${to}m` : `${from}m+`)
    ),
    dailyPnl: dailyPnl(trades),
    equity: result?.equityCurve ?? null,
    perSymbol: symbolLeaders(perSymbol, trades),
    signalAtEntry: signalSnapshotStats(trades),
    excursion: mfeMaeStats(trades),
    stopLossMoved: {
      count: trades.filter((t) => t.stopMoved).length,
      totalPnl: +trades
        .filter((t) => t.stopMoved)
        .reduce((s, t) => s + (t.pnl ?? 0), 0)
        .toFixed(4),
    },
    corridorWidthPct: stats(
      trades.map((t) => t.corridorWidthPct ?? t.signalSnapshot?.corridorWidthPct)
    ),
    entryAboveCorridorPct: stats(trades.map((t) => t.entryAboveCorridorPct)),
  };
}

function summarizeEvents(events) {
  const list = events ?? [];
  const byType = groupBy(
    list.map((e) => ({ ...e, pnl: 0, margin: 0 })),
    (e) => e.type
  );
  return {
    total: list.length,
    byType: byType.sort((a, b) => b.count - a.count),
    skippedOpens: list.filter((e) => e.type === "SKIP").length,
  };
}

function exportFilename() {
  const stamp = formatIsoUtcPlus3(Date.now())
    .replace(/[:]/g, "-")
    .slice(0, 16);
  return `train-bot-export-${stamp}.json`;
}

/**
 * Build a JSON bundle for offline bot optimisation (settings, trades, analytics, source).
 */
function buildBacktestExport(options = {}) {
  const result = loadLastBacktestResult();
  if (!result?.summary) {
    throw new Error("No train bot results to export — run a backtest first");
  }

  const includeSourceCode = options.includeSourceCode !== false;
  const includeEvents = options.includeEvents !== false;
  const includeEquityCurve = options.includeEquityCurve !== false;
  const pkg = readPackageJson();
  const trades = (result.closedTrades ?? []).map(enrichTrade);

  const bundle = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    readme:
      "Train bot optimisation export (v2). Upload to an AI assistant for parameter tuning. " +
      "Includes enriched per-trade metrics (MFE/MAE, signal snapshot at entry, corridor/SL/TP distances), " +
      "equity curve, event log summary, cross-tabs (exit reason × add-ons), histograms, daily PnL, and per-symbol breakdown.",
    exportedAt: formatIsoUtcPlus3(Date.now()),
    app: {
      name: pkg.name,
      version: pkg.version,
    },
    git: readGitInfo(),
    configSchema: {
      scannerSignalKeys: [...LIVE_CONFIG_KEYS],
      paperBotDefaults: { ...DEFAULT_CONFIG },
      paperBotConfigKeys: Object.keys(DEFAULT_CONFIG),
      tradeFields: [
        "symbol",
        "signalKind",
        "entryPrice",
        "initialEntryPrice",
        "exitPrice",
        "margin",
        "addCount",
        "hadAdds",
        "pnl",
        "pnlPct",
        "exitReason",
        "durationSec",
        "movePctAtExit",
        "peakMovePct",
        "troughMovePct",
        "corridorWidthPct",
        "entryAboveCorridorPct",
        "slDistancePct",
        "tpDistancePct",
        "stopMoved",
        "signalSnapshot",
      ],
    },
    settings: {
      signal: result.signalConfig ?? null,
      paperBot: result.botConfig ?? null,
      interval: result.interval ?? null,
      historyDays: result.days ?? null,
      barCount: result.barCount ?? null,
      runMeta: result.runMeta ?? null,
    },
    backtest: {
      finishedAt: result.finishedAt ?? null,
      elapsedSec: result.elapsedSec ?? null,
      symbolsTotal: result.symbolsTotal ?? null,
      symbolsProcessed: result.symbolsProcessed ?? null,
      symbolsSkipped: result.symbolsSkipped ?? null,
      summary: result.summary ?? null,
      perSymbol: result.perSymbol ?? [],
      topWinners: result.topWinners ?? [],
      topLosers: result.topLosers ?? [],
      openAtEnd: result.openAtEnd ?? [],
      closedTrades: trades,
      closedTradesStored: trades.length,
      closedTradesTotal: result.closedTradesTotal ?? trades.length,
      tradeExportNote:
        (result.closedTradesTotal ?? trades.length) > 2000
          ? "Saved backtests store at most 2000 trades in this export."
          : (result.closedTradesTotal ?? trades.length) > trades.length
            ? "Some trades were truncated in the saved backtest file."
            : null,
    },
    analytics: computeAnalytics(trades, result.summary, result.perSymbol, result),
    sourceCode: readSourceBundle(includeSourceCode),
  };

  if (includeEquityCurve && result.equityCurve) {
    bundle.equityCurve = result.equityCurve;
  }

  if (includeEvents && result.events?.length) {
    bundle.events = {
      summary: summarizeEvents(result.events),
      log: result.events,
    };
  }

  return bundle;
}

module.exports = {
  EXPORT_FORMAT_VERSION,
  buildBacktestExport,
  exportFilename,
  enrichTrade,
  computeAnalytics,
};
