const fs = require("fs");
const path = require("path");
const { dataPath } = require("./data-dir");
const { renderPaperBotTradeChart } = require("./chart-render");
const { applyBarConfig, sweepReclaimMetrics, smaClose } = require("./signal-metrics");

const SNAPSHOT_DIR = () => dataPath("paper-bot-snapshots");
const BACKTEST_SNAPSHOT_DIR = () => dataPath("paper-bot-backtest-snapshots");
const SNAPSHOT_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function snapshotDir(kind = "live") {
  return kind === "backtest" ? BACKTEST_SNAPSHOT_DIR() : SNAPSHOT_DIR();
}

function sanitizeSnapshotId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function snapshotPath(snapshotId, kind = "live") {
  return path.join(
    snapshotDir(kind),
    `${sanitizeSnapshotId(snapshotId)}.png`
  );
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

const SNAPSHOT_PRE_ENTRY_MINUTES = 30;

function maSeriesForBars(bars, maBars) {
  const n = Math.max(2, Math.round(maBars));
  return bars.map((_, i) => {
    if (i + 1 < n) return null;
    return smaClose(bars.slice(0, i + 1), n);
  });
}

/**
 * SFP / pullback: 30m pre-entry + full position (no log-compressed corridor history).
 */
function buildFocusedSnapshotBars(bars, trade, cfg) {
  const chartCfg = {
    interval: cfg.interval ?? "1m",
    preEntryMinutes: cfg.snapshotPreEntryMinutes ?? SNAPSHOT_PRE_ENTRY_MINUTES,
    ...cfg,
  };
  applyBarConfig(chartCfg);

  const barMs = chartCfg.barMs;
  const preMs = chartCfg.preEntryMinutes * 60 * 1000;
  const historyStartMs = trade.openedAt - preMs;
  const endMs = trade.closedAt + Math.max(15 * barMs, 5 * barMs);

  const filtered = bars.filter(
    (b) => b.closeTime >= historyStartMs && b.openTime <= endMs
  );
  if (filtered.length < 10) {
    return { displayBars: filtered, meta: { chartStyle: "focused", preEntryMinutes: chartCfg.preEntryMinutes } };
  }

  const entryIdx = barIndexAtOrAfter(filtered, trade.openedAt);
  const exitIdx = barIndexAtOrBefore(filtered, trade.closedAt);
  const safeExit = Math.max(entryIdx, exitIdx);
  const tailEnd = Math.min(filtered.length - 1, safeExit + 6);
  const displayBars = filtered.slice(0, tailEnd + 1);
  const entryDisplayIdx = barIndexAtOrAfter(displayBars, trade.openedAt);
  const exitDisplayIdx = barIndexAtOrBefore(displayBars, trade.closedAt);

  const kind = trade.signalKind;
  const meta = {
    chartStyle: "focused",
    chartTheme: kind === "sfp" ? "sfp" : kind === "pullback" ? "pullback" : kind,
    preEntryMinutes: chartCfg.preEntryMinutes,
    entryIdx: entryDisplayIdx,
    exitIdx: exitDisplayIdx,
    corridorStartIdx: 0,
    corridorEndIdx: Math.max(0, entryDisplayIdx - 1),
    historyEndIdx: entryDisplayIdx - 1,
    logHistory: false,
  };

  const entryWindow = displayBars.slice(0, entryDisplayIdx + 1);
  if (kind === "pullback") {
    const maBars = chartCfg.pullbackMaBars ?? 7;
    meta.maBars = maBars;
    meta.maValues = maSeriesForBars(displayBars, maBars);
    const pb = entryWindow.length ? smaClose(entryWindow, maBars) : null;
    meta.maAtEntry = pb;
  }
  if (kind === "sfp") {
    const sfp = entryWindow.length ? sweepReclaimMetrics(entryWindow, chartCfg) : null;
    meta.sweepLow = sfp?.sweepLow ?? null;
    meta.sweepThreshold = sfp?.sweepThreshold ?? null;
    meta.reclaimLevel = sfp?.reclaimLevel ?? trade.corridorLow ?? null;
  }

  return { displayBars, meta };
}

function buildSnapshotBars(bars, trade, cfg) {
  return buildFocusedSnapshotBars(bars, trade, cfg);
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

/** Trade-shaped object for chart render of a still-open position. */
function openPositionToSnapshotTrade(pos) {
  const last = Number(pos.lastPrice ?? pos.entryPrice);
  const pnl =
    pos.unrealizedPnl ??
    (Number.isFinite(pos.quantity) ? pos.quantity * (last - pos.entryPrice) : 0);
  const pnlPct =
    pos.margin > 0 ? (pnl / pos.margin) * 100 : 0;
  const asOf = Date.now();
  return {
    ...pos,
    exitPrice: last,
    closedAt: asOf,
    pnl: +Number(pnl).toFixed(4),
    pnlPct: +Number(pnlPct).toFixed(2),
    exitReason: "open",
    isOpen: true,
    asOf,
  };
}

async function saveOpenPositionSnapshot({ position, bars, interval = "1m", ...cfg }) {
  if (!position?.id || !bars?.length) {
    throw new Error("Open position snapshot requires position id and bars");
  }
  return saveTradeSnapshot({
    trade: openPositionToSnapshotTrade(position),
    bars,
    interval,
    snapshotKind: "live",
    ...cfg,
  });
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

async function saveTradeSnapshot({
  trade,
  bars,
  interval = "1m",
  snapshotKind = "live",
  skipCleanup = false,
  ...cfg
}) {
  if (!trade?.id || !bars?.length) {
    throw new Error("Trade snapshot requires trade id and bars");
  }

  const chartCfg = { interval, ...cfg };
  const { displayBars, meta } = buildSnapshotBars(bars, trade, chartCfg);
  if (displayBars.length < 10) {
    throw new Error("Not enough bars for trade snapshot");
  }

  const snapshotId = sanitizeSnapshotId(trade.id);
  const dir = snapshotDir(snapshotKind);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = snapshotPath(snapshotId, snapshotKind);
  const buffer = await renderPaperBotTradeChart(
    trade.symbol,
    displayBars,
    trade,
    { ...chartCfg, snapshotMeta: meta, snapshotWidth: 1680 },
    { width: 1680, height: 840 }
  );
  fs.writeFileSync(filePath, buffer);
  if (!skipCleanup) cleanOldSnapshots();
  return { snapshotId, filePath };
}

function cleanOldSnapshots(maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  let freedBytes = 0;

  for (const dir of [SNAPSHOT_DIR(), BACKTEST_SNAPSHOT_DIR()]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".png")) continue;
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > cutoff) continue;
        freedBytes += stat.size;
        fs.unlinkSync(full);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }

  return { removed, freedBytes };
}

function clearBacktestSnapshots() {
  const dir = BACKTEST_SNAPSHOT_DIR();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".png")) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generateBacktestTradeSnapshots({
  trades,
  barCache,
  chartCfg,
  onProgress,
  shouldAbort,
  onTradeSnapshot,
  delayMs = 25,
}) {
  clearBacktestSnapshots();
  const list = trades.filter((t) => t?.id && t?.symbol);
  const pendingBySymbol = new Map();
  for (const trade of list) {
    pendingBySymbol.set(
      trade.symbol,
      (pendingBySymbol.get(trade.symbol) ?? 0) + 1
    );
  }

  let ok = 0;
  let failed = 0;

  for (let i = 0; i < list.length; i++) {
    if (shouldAbort?.()) break;
    const trade = list[i];
    const bars = barCache.get(trade.symbol);
    onProgress?.({
      phase: "snapshots",
      done: i,
      total: list.length,
      symbol: trade.symbol,
      ok,
      failed,
      message: `Preview ${i + 1}/${list.length} · ${trade.symbol}…`,
    });

    if (!bars?.length) {
      failed++;
      continue;
    }

    try {
      const { snapshotId } = await saveTradeSnapshot({
        trade,
        bars,
        snapshotKind: "backtest",
        skipCleanup: true,
        ...chartCfg,
      });
      trade.snapshotId = snapshotId;
      onTradeSnapshot?.(trade, snapshotId);
      ok++;
    } catch {
      failed++;
    }

    const left = (pendingBySymbol.get(trade.symbol) ?? 1) - 1;
    if (left <= 0) {
      pendingBySymbol.delete(trade.symbol);
      barCache.delete(trade.symbol);
    } else {
      pendingBySymbol.set(trade.symbol, left);
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  barCache.clear();
  cleanOldSnapshots();

  onProgress?.({
    phase: "snapshots",
    done: list.length,
    total: list.length,
    ok,
    failed,
    message: `Previews ${ok} ok · ${failed} skipped`,
  });

  return { ok, failed };
}

function snapshotExists(snapshotId, kind = "live") {
  try {
    return fs.existsSync(snapshotPath(snapshotId, kind));
  } catch {
    return false;
  }
}

function readTradeSnapshot(snapshotId, kind = "live") {
  const filePath = snapshotPath(snapshotId, kind);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

module.exports = {
  openPositionToSnapshotTrade,
  saveOpenPositionSnapshot,
  saveTradeSnapshot,
  sliceBarsForTrade,
  buildLogSnapshotBars,
  buildFocusedSnapshotBars,
  buildSnapshotBars,
  logSampleBars,
  generateBacktestTradeSnapshots,
  clearBacktestSnapshots,
  cleanOldSnapshots,
  SNAPSHOT_MAX_AGE_MS,
  snapshotExists,
  readTradeSnapshot,
  snapshotPath,
  sanitizeSnapshotId,
  SNAPSHOT_DIR,
  BACKTEST_SNAPSHOT_DIR,
  snapshotDir,
};
