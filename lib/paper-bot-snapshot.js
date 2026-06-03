const fs = require("fs");
const path = require("path");
const { dataPath } = require("./data-dir");
const { renderPaperBotTradeChart } = require("./chart-render");

const SNAPSHOT_DIR = () => dataPath("paper-bot-snapshots");

function sanitizeSnapshotId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function snapshotPath(snapshotId) {
  return path.join(SNAPSHOT_DIR(), `${sanitizeSnapshotId(snapshotId)}.png`);
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

async function saveTradeSnapshot({ trade, bars, interval = "1m" }) {
  if (!trade?.id || !bars?.length) {
    throw new Error("Trade snapshot requires trade id and bars");
  }
  const snapshotId = sanitizeSnapshotId(trade.id);
  const dir = SNAPSHOT_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = snapshotPath(snapshotId);
  const buffer = await renderPaperBotTradeChart(
    trade.symbol,
    bars,
    trade,
    { interval },
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
  snapshotExists,
  readTradeSnapshot,
  snapshotPath,
  sanitizeSnapshotId,
  SNAPSHOT_DIR,
};
