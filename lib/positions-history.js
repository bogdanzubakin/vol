const fs = require("fs");
const path = require("path");
const { formatIsoUtcPlus3 } = require("./time-format");

const HISTORY_DIR = path.join(__dirname, "..", ".cache");
const HISTORY_FILE = path.join(HISTORY_DIR, "positions-history.json");
const MAX_ITEMS = 2000;

function safeJsonRead(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeJsonWrite(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function positionKey(p) {
  const sym = String(p?.symbol || "").toUpperCase();
  const dir = String(p?.direction || "").toUpperCase();
  return `${sym}:${dir}`;
}

function createPositionsHistoryStore(options = {}) {
  const filePath = options.filePath || HISTORY_FILE;
  const maxItems = options.maxItems || MAX_ITEMS;
  const persisted = safeJsonRead(filePath, { items: [] });
  const items = Array.isArray(persisted?.items) ? persisted.items : [];

  // Track currently open positions in memory by symbol+direction.
  const active = new Map();

  function save() {
    safeJsonWrite(filePath, { items: items.slice(0, maxItems) });
  }

  function ingestSnapshot(snapshot) {
    const now = Date.now();
    if (!snapshot?.enabled || !Array.isArray(snapshot.positions)) return;

    const currentKeys = new Set();
    for (const p of snapshot.positions) {
      const key = positionKey(p);
      if (!key || key === ":") continue;
      currentKeys.add(key);
      const existing = active.get(key);
      if (!existing) {
        active.set(key, {
          key,
          symbol: String(p.symbol || "").toUpperCase(),
          direction: String(p.direction || "").toUpperCase() || "LONG",
          openedAtMs: now,
        });
      }
      const row = active.get(key);
      row.lastPnl = Number.isFinite(Number(p.pnl)) ? Number(p.pnl) : null;
    }

    // Any previously active key absent in the new snapshot is considered closed.
    for (const [key, row] of active.entries()) {
      if (currentKeys.has(key)) continue;
      const closedAtMs = now;
      const durationSec = Math.max(
        0,
        Math.round((closedAtMs - (row.openedAtMs || closedAtMs)) / 1000)
      );
      const id = `${row.symbol}:${row.direction}:${closedAtMs}`;
      items.unshift({
        id,
        symbol: row.symbol,
        direction: row.direction,
        openedAt: formatIsoUtcPlus3(row.openedAtMs || closedAtMs),
        closedAt: formatIsoUtcPlus3(closedAtMs),
        durationSec,
        profit: row.lastPnl,
        comment: "",
      });
      active.delete(key);
    }

    if (items.length > maxItems) items.length = maxItems;
    save();
  }

  function setComment(id, comment) {
    const cleanId = String(id || "").trim();
    if (!cleanId) throw new Error("id is required");
    const row = items.find((x) => x.id === cleanId);
    if (!row) throw new Error("History item not found");
    row.comment = String(comment ?? "").slice(0, 2000);
    save();
    return row;
  }

  function list(snapshotInfo) {
    const enabled = Boolean(snapshotInfo?.enabled);
    return {
      enabled,
      updatedAt: formatIsoUtcPlus3(Date.now()),
      items,
      hint: enabled
        ? null
        : snapshotInfo?.hint ||
          "Set BINANCE_API_KEY and BINANCE_API_SECRET in .env (Futures read)",
    };
  }

  return { ingestSnapshot, setComment, list };
}

module.exports = { createPositionsHistoryStore };
