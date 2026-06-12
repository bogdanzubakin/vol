const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { loadLastBacktestResult } = require("./paper-bot-backtest");
const { DEFAULT_CONFIG } = require("./paper-bot");
const { LIVE_CONFIG_KEYS } = require("./signal-metrics");
const { formatIsoUtcPlus3 } = require("./time-format");

const EXPORT_FORMAT_VERSION = 1;
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

function enrichTrade(trade) {
  const openedAt = trade.openedAt;
  const closedAt = trade.closedAt;
  const durationSec =
    Number.isFinite(openedAt) && Number.isFinite(closedAt)
      ? Math.max(0, Math.floor((closedAt - openedAt) / 1000))
      : null;
  return {
    ...trade,
    durationSec,
    win: (trade.pnl ?? 0) > 0,
  };
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
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
        totalPnl: 0,
        totalMargin: 0,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    const pnl = t.pnl ?? 0;
    g.totalPnl += pnl;
    g.totalMargin += t.margin ?? 0;
    if (pnl > 0) g.wins += 1;
    else if (pnl < 0) g.losses += 1;
  }
  return [...groups.values()].map((g) => ({
    ...g,
    totalPnl: +g.totalPnl.toFixed(4),
    avgPnl: g.count ? +(g.totalPnl / g.count).toFixed(4) : 0,
    winRatePct: g.count ? +((100 * g.wins) / g.count).toFixed(2) : 0,
  }));
}

function computeAnalytics(trades, summary, perSymbol) {
  const durations = trades
    .map((t) => t.durationSec)
    .filter((n) => Number.isFinite(n));
  const pnls = trades.map((t) => t.pnl ?? 0);

  const profitable = perSymbol?.filter((r) => (r.pnl ?? 0) > 0).length ?? 0;
  const losing = perSymbol?.filter((r) => (r.pnl ?? 0) < 0).length ?? 0;
  const flat = perSymbol?.filter((r) => (r.pnl ?? 0) === 0).length ?? 0;

  return {
    summary: summary ?? null,
    tradeCount: trades.length,
    byExitReason: groupBy(trades, (t) => t.exitReason).sort(
      (a, b) => b.count - a.count
    ),
    bySignalKind: groupBy(trades, (t) => t.signalKind).sort(
      (a, b) => b.count - a.count
    ),
    durationSec: durations.length
      ? {
          min: Math.min(...durations),
          max: Math.max(...durations),
          avg: Math.round(
            durations.reduce((s, n) => s + n, 0) / durations.length
          ),
          median: median(durations),
        }
      : null,
    pnl: pnls.length
      ? {
          min: +Math.min(...pnls).toFixed(4),
          max: +Math.max(...pnls).toFixed(4),
          avg: +(pnls.reduce((s, n) => s + n, 0) / pnls.length).toFixed(4),
          median: median(pnls) != null ? +median(pnls).toFixed(4) : null,
        }
      : null,
    perSymbol: {
      withTrades: perSymbol?.filter((r) => (r.trades ?? 0) > 0).length ?? 0,
      profitable,
      losing,
      flat,
      topByPnl: [...(perSymbol ?? [])]
        .filter((r) => !r.error && !r.skipped)
        .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
        .slice(0, 25),
      bottomByPnl: [...(perSymbol ?? [])]
        .filter((r) => !r.error && !r.skipped)
        .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
        .slice(0, 25),
    },
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
  const pkg = readPackageJson();
  const trades = (result.closedTrades ?? []).map(enrichTrade);

  return {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    readme:
      "Train bot optimisation export. Upload this file to an AI assistant to tune scanner signal settings and paper-bot rules. " +
      "Includes: backtest run parameters, full trade list, per-symbol stats, derived analytics, config schema defaults, and key bot source files as they were when the backtest ran.",
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
    },
    settings: {
      signal: result.signalConfig ?? null,
      paperBot: result.botConfig ?? null,
      interval: result.interval ?? null,
      historyDays: result.days ?? null,
      barCount: result.barCount ?? null,
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
      tradeExportLimit: trades.length,
      tradeExportNote:
        trades.length >= 500
          ? "Saved backtests store at most 500 trades in this export."
          : null,
    },
    analytics: computeAnalytics(trades, result.summary, result.perSymbol),
    sourceCode: readSourceBundle(includeSourceCode),
  };
}

module.exports = {
  EXPORT_FORMAT_VERSION,
  buildBacktestExport,
  exportFilename,
};
