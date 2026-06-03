const fs = require("fs");
const path = require("path");
const { dataPath } = require("./data-dir");
const { renderPaperBotTradeChart } = require("./chart-render");
const { applyBarConfig } = require("./signal-metrics");

const SNAPSHOT_DIR = () => dataPath("paper-bot-snapshots");

function sanitizeSnapshotId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function snapshotPath(snapshotId) {
  return path.join(SNAPSHOT_DIR(), `${sanitizeSnapshotId(snapshotId)}.png`);
}

function barIndexAtOrAfter(bars, timeMs) {
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].closeTime >= timeMs) return i;
  }
  return bars.length - 1;
}

function barIndexAtOrBefore(bars, timeMs) {
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].openTime <= timeMs) return i;
  }
  return 0;
}

/** Log-spaced subsample; denser bars near the end (closer to entry). */
function logSampleBars(bars, targetCount, k = 4) {
  if (!bars?.length) return [];
  if (bars.length <= targetCount) return [...bars];

  const t0 = bars[0].closeTime;
  const t1 = bars[bars.length - 1].closeTime;
  const span = Math.max(t1 - t0, 1);
  const picked = new Map();

  for (let i = 0; i < targetCount; i++) {
    const f = targetCount <= 1 ? 1 : i / (targetCount - 1);
    const u = (Math.exp(k * f) - 1) / (Math.exp(k) - 1);
    const targetTime = t0 + u * span;

    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].closeTime < targetTime) lo = mid + 1;
      else hi = mid;
    }

    let best = lo;
    if (lo > 0) {
      const d0 = Math.abs(bars[lo].closeTime - targetTime);
      const d1 = Math.abs(bars[lo - 1].closeTime - targetTime);
      if (d1 < d0) best = lo - 1;
    }
    picked.set(best, bars[best]);
  }

  return [...picked.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bar]) => bar);
}

/**
 * Map a raw pre-entry bar index to a display index after log sampling.
 */
function mapHistoryBarToDisplay(filtered, rawIdx, sampledHistory) {
  if (!sampledHistory.length) return 0;
  const target = filtered[rawIdx];
  if (!target) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < sampledHistory.length; i++) {
    const d = Math.abs(sampledHistory[i].closeTime - target.closeTime);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Build display bars: log-compressed corridor-days history + full position window.
 */
function buildLogSnapshotBars(bars, trade, cfg) {
  const chartCfg = {
    interval: cfg.interval ?? "1m",
    corridorDays: cfg.corridorDays ?? 2,
    corridorExcludeMinutes: cfg.corridorExcludeMinutes,
    signalCandles: cfg.signalCandles,
    ...cfg,
  };
  applyBarConfig(chartCfg);

  const barMs = chartCfg.barMs;
  const corridorDays = chartCfg.corridorDays;
  const corridorMs = corridorDays * 24 * 60 * 60 * 1000;
  const historyStartMs = trade.openedAt - corridorMs;
  const endMs = trade.closedAt + Math.max(15 * barMs, 5 * barMs);

  const filtered = bars.filter(
    (b) => b.closeTime >= historyStartMs && b.openTime <= endMs
  );
  if (filtered.length < 10) {
    return { displayBars: filtered, meta: { corridorDays } };
  }

  const entryIdx = barIndexAtOrAfter(filtered, trade.openedAt);
  const exitIdx = barIndexAtOrBefore(filtered, trade.closedAt);
  const safeExit = Math.max(entryIdx, exitIdx);

  const n = chartCfg.signalCandles;
  const exclude = chartCfg.corridorExcludeBars;
  const corridorBars = chartCfg.corridorBars;

  const signalStart = Math.max(0, entryIdx - n + 1);
  const corridorEnd = Math.max(0, signalStart - exclude);
  const corridorStart = Math.max(0, corridorEnd - corridorBars);

  const historyBars = filtered.slice(0, entryIdx);
  const positionBars = filtered.slice(entryIdx, safeExit + 1);
  const tailBars = filtered.slice(safeExit + 1, safeExit + 6);

  const historyBudget = Math.max(
    100,
    Math.min(220, Math.round(positionBars.length * 1.6))
  );
  const sampledHistory = logSampleBars(
    historyBars,
    Math.min(historyBudget, historyBars.length)
  );

  const corridorStartIdx = mapHistoryBarToDisplay(
    filtered,
    corridorStart,
    sampledHistory
  );
  const corridorEndIdx = mapHistoryBarToDisplay(
    filtered,
    Math.max(corridorStart, corridorEnd - 1),
    sampledHistory
  );

  const displayBars = [...sampledHistory, ...positionBars, ...tailBars];
  const entryDisplayIdx = sampledHistory.length;
  const exitDisplayIdx = entryDisplayIdx + positionBars.length - 1;

  return {
    displayBars,
    meta: {
      entryIdx: entryDisplayIdx,
      exitIdx: exitDisplayIdx,
      corridorStartIdx: Math.min(corridorStartIdx, corridorEndIdx),
      corridorEndIdx: Math.max(corridorStartIdx, corridorEndIdx),
      corridorDays,
      historyEndIdx: entryDisplayIdx - 1,
      logHistory: sampledHistory.length < historyBars.length,
    },
  };
}

function sliceBarsForTrade(bars, openedAt, closedAt, padBars = 80) {
  if (!bars?.length) return [];
  let start = 0;
  let end = bars.length - 1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].closeTime >= openedAt) {
      start = Math.max(0, i - padBars);
      break;
    }
  }
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].closeTime <= closedAt) {
      end = Math.min(bars.length - 1, i + padBars);
      break;
    }
  }
  if (end <= start) end = Math.min(bars.length - 1, start + padBars * 2);
  return bars.slice(start, end + 1);
}

async function saveTradeSnapshot({ trade, bars, interval = "1m", ...cfg }) {
  if (!trade?.id || !bars?.length) {
    throw new Error("Trade snapshot requires trade id and bars");
  }

  const chartCfg = { interval, ...cfg };
  const { displayBars, meta } = buildLogSnapshotBars(bars, trade, chartCfg);
  if (displayBars.length < 10) {
    throw new Error("Not enough bars for trade snapshot");
  }

  const snapshotId = sanitizeSnapshotId(trade.id);
  const dir = SNAPSHOT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = snapshotPath(snapshotId);
  const buffer = await renderPaperBotTradeChart(
    trade.symbol,
    displayBars,
    trade,
    { ...chartCfg, snapshotMeta: meta, snapshotWidth: 1680 },
    { width: 1680, height: 840 }
  );
  fs.writeFileSync(filePath, buffer);
  return { snapshotId, filePath };
}

function snapshotExists(snapshotId) {
  try {
    return fs.existsSync(snapshotPath(snapshotId));
  } catch {
    return false;
  }
}

function readTradeSnapshot(snapshotId) {
  const filePath = snapshotPath(snapshotId);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

module.exports = {
  saveTradeSnapshot,
  sliceBarsForTrade,
  buildLogSnapshotBars,
  logSampleBars,
  snapshotExists,
  readTradeSnapshot,
  snapshotPath,
  sanitizeSnapshotId,
  SNAPSHOT_DIR,
};
