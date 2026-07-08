const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { DEFAULT_CONFIG } = require("./paper-bot");
const { LIVE_CONFIG_KEYS } = require("./signal-metrics");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  enrichTrade,
  computeAnalytics,
  tradeExportIntegrity,
} = require("./backtest-export");
const {
  readTradeSnapshot,
  snapshotExists,
  snapshotPath,
} = require("./paper-bot-snapshot");

const EXPORT_FORMAT_VERSION = 2;
const REPO_ROOT = path.join(__dirname, "..");

const SOURCE_FILES = [
  "package.json",
  "lib/live-bot.js",
  "lib/live-bot-history.js",
  "lib/paper-bot.js",
  "lib/paper-bot-simulator.js",
  "lib/signal-metrics.js",
  "lib/scanner-config.js",
  "lib/signal-exit-levels.js",
  "lib/early-exit-path-oracle.js",
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

function buildPerSymbolFromTrades(trades) {
  const bySym = new Map();
  for (const t of trades) {
    const sym = t.symbol;
    if (!bySym.has(sym)) {
      bySym.set(sym, {
        symbol: sym,
        trades: 0,
        pnl: 0,
        grossPnl: 0,
        commission: 0,
        fundingFee: 0,
        netPnl: 0,
        wins: 0,
        losses: 0,
      });
    }
    const row = bySym.get(sym);
    row.trades += 1;
    row.pnl += t.pnl ?? 0;
    row.grossPnl += t.grossPnl ?? t.pnl ?? 0;
    row.commission += t.commission ?? 0;
    row.fundingFee += t.fundingFee ?? 0;
    row.netPnl += t.netPnl ?? t.pnl ?? 0;
    if ((t.netPnl ?? t.pnl ?? 0) > 0) row.wins += 1;
    else if ((t.netPnl ?? t.pnl ?? 0) < 0) row.losses += 1;
  }
  return [...bySym.values()]
    .map((r) => ({
      symbol: r.symbol,
      trades: r.trades,
      pnl: +r.pnl.toFixed(4),
      grossPnl: +r.grossPnl.toFixed(4),
      commission: +r.commission.toFixed(4),
      fundingFee: +r.fundingFee.toFixed(4),
      netPnl: +r.netPnl.toFixed(4),
      winRate: r.trades ? +((100 * r.wins) / r.trades).toFixed(1) : 0,
      wins: r.wins,
      losses: r.losses,
    }))
    .sort((a, b) => b.trades - a.trades);
}

function buildEquityCurve(trades) {
  const sorted = [...trades].sort(
    (a, b) => (Number(a.closedAt) || 0) - (Number(b.closedAt) || 0)
  );
  let cumulative = 0;
  return sorted.map((t) => {
    cumulative += t.netPnl ?? t.pnl ?? 0;
    return {
      at: t.closedAt,
      atIso: t.closedAtIso ?? (t.closedAt ? formatIsoUtcPlus3(t.closedAt) : null),
      symbol: t.symbol,
      signalKind: t.signalKind,
      tradeId: t.id,
      pnl: t.netPnl ?? t.pnl,
      grossPnl: t.grossPnl ?? t.pnl,
      commission: t.commission ?? 0,
      fundingFee: t.fundingFee ?? 0,
      cumulativePnl: +cumulative.toFixed(4),
      exitReason: t.exitReason,
    };
  });
}

function attachSnapshotMeta(trades, includeSnapshots = false) {
  if (!includeSnapshots) {
    return trades.map((t) => {
      if (!t.snapshotId) return t;
      return {
        ...t,
        snapshot: {
          id: t.snapshotId,
          exists: snapshotExists(t.snapshotId, "live"),
          path: snapshotPath(t.snapshotId, "live"),
        },
      };
    });
  }
  return trades.map((t) => {
    if (!t.snapshotId) return t;
    const exists = snapshotExists(t.snapshotId, "live");
    const meta = {
      id: t.snapshotId,
      exists,
      path: snapshotPath(t.snapshotId, "live"),
    };
    if (exists) {
      const buf = readTradeSnapshot(t.snapshotId, "live");
      if (buf) {
        meta.mime = "image/png";
        meta.base64 = buf.toString("base64");
        meta.bytes = buf.length;
      }
    }
    return { ...t, snapshot: meta };
  });
}

function exportFilename() {
  const stamp = formatIsoUtcPlus3(Date.now())
    .replace(/[:]/g, "-")
    .slice(0, 16);
  return `live-bot-history-export-${stamp}.json`;
}

/**
 * Build a JSON bundle for offline analysis / reproduction of live bot trades.
 */
function buildLiveBotHistoryExport(options = {}) {
  const history = options.history;
  if (!history?.summary) {
    throw new Error("No live bot history to export");
  }

  const includeSourceCode = options.includeSourceCode !== false;
  const includeSnapshots = options.includeSnapshots === true;
  const includeEquityCurve = options.includeEquityCurve !== false;
  const pkg = readPackageJson();
  const rawTrades = history.trades ?? [];
  const trades = attachSnapshotMeta(
    rawTrades.map(enrichTrade),
    includeSnapshots
  );
  const perSymbol = buildPerSymbolFromTrades(trades);
  const equityCurve = buildEquityCurve(trades);
  const pseudoResult = {
    closedTradesTotal: trades.length,
    equityCurve,
    summary: history.summary,
    perSymbol,
    botConfig: options.liveBotConfig ?? null,
  };
  const integrity = tradeExportIntegrity(trades, history.summary, pseudoResult);

  const bundle = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    readme:
      "Live bot history export (v1). Upload to an AI assistant for trade analysis, comparison, and reproduction. " +
      "Includes enriched per-trade metrics (MFE/MAE, signal snapshot at entry, corridor/SL/TP distances, exit path oracle), " +
      "Binance audit trail (REALIZED_PNL / COMMISSION / FUNDING_FEE income events and matched user trade fills), " +
      "live bot + scanner settings at export time, equity curve, hourly/daily PnL series, cross-tabs, histograms, and per-symbol breakdown. " +
      "Set includeSnapshots=1 to embed PNG chart snapshots (larger file).",
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
        "side",
        "entryPrice",
        "initialEntryPrice",
        "exitPrice",
        "margin",
        "leverage",
        "marginType",
        "addCount",
        "hadAdds",
        "pnl",
        "pnlPct",
        "grossPnl",
        "commission",
        "fundingFee",
        "netPnl",
        "exitReason",
        "exitMethod",
        "durationSec",
        "openDelaySec",
        "movePctAtExit",
        "peakMovePct",
        "troughMovePct",
        "corridorWidthPct",
        "entryAboveCorridorPct",
        "slDistancePct",
        "tpDistancePct",
        "stopMoved",
        "decidedAt",
        "exchangeOpenedAt",
        "entryOrderId",
        "signalSnapshot",
        "exitPathOracle",
        "snapshotId",
        "exchangeIncomeEvents",
        "exchangeTradeFills",
      ],
    },
    settings: {
      signal: options.signalConfig ?? null,
      scanner: options.scannerConfig ?? null,
      liveBot: options.liveBotConfig ?? null,
      interval: options.interval ?? null,
      primaryInterval: options.primaryInterval ?? null,
      timezone: "UTC+3",
    },
    runtime: {
      liveBotSummary: options.liveBotSummary ?? null,
      fromDate: history.fromDate ?? null,
      updatedAt: history.updatedAt ?? null,
      exchangeAuditEnabled: Boolean(history.exchangeAuditEnabled),
      armed: options.liveBotConfig?.armed ?? null,
      enabled: options.liveBotConfig?.enabled ?? null,
      blockedSymbols: options.liveBotConfig?.blockedSymbols ?? [],
    },
    history: {
      summary: history.summary ?? null,
      byHour: history.byHour ?? [],
      byDay: history.byDay ?? [],
      closedTrades: trades,
      closedTradesStored: trades.length,
      closedTradesTotal: trades.length,
      perSymbol,
      tradeExportNote: integrity.ok ? null : integrity.issues.join(" "),
    },
    exchangeAudit: {
      enabled: Boolean(history.exchangeAuditEnabled),
      tradeCountWithAudit: trades.filter(
        (t) => Array.isArray(t.exchangeIncomeEvents) && t.exchangeIncomeEvents.length
      ).length,
      incomeEventCount: trades.reduce(
        (sum, t) => sum + (Array.isArray(t.exchangeIncomeEvents) ? t.exchangeIncomeEvents.length : 0),
        0
      ),
      fillCount: trades.reduce(
        (sum, t) => sum + (Array.isArray(t.exchangeTradeFills) ? t.exchangeTradeFills.length : 0),
        0
      ),
    },
    transactionsIntegrity: integrity,
    analytics: computeAnalytics(trades, history.summary, perSymbol, pseudoResult),
    sourceCode: readSourceBundle(includeSourceCode),
  };

  if (includeEquityCurve) {
    bundle.equityCurve = equityCurve;
  }

  return bundle;
}

module.exports = {
  EXPORT_FORMAT_VERSION,
  buildLiveBotHistoryExport,
  exportFilename,
};
