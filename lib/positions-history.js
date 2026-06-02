const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { formatIsoUtcPlus3 } = require("./time-format");
const { resolveBinanceCredentials } = require("./binance-positions");

const REST_BASE = "https://fapi.binance.com";
const CACHE_MS = 10000;
const MAX_ITEMS = 2000;
const MAX_SYMBOLS = 200;
const COMMENTS_FILE = path.join(
  __dirname,
  "..",
  ".cache",
  "positions-history-comments.json"
);

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

async function signedGet(pathName, params, apiKey, apiSecret) {
  const timestamp = Date.now();
  const qs = new URLSearchParams({ ...params, timestamp: String(timestamp) });
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(qs.toString())
    .digest("hex");
  qs.set("signature", signature);

  const url = `${REST_BASE}${pathName}?${qs}`;
  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body?.msg || body?.message || text || res.statusText;
    throw new Error(msg);
  }
  return body;
}

function mapIncomeToHistoryItems(rows, comments) {
  return (rows || []).map((r) => {
    const symbol = String(r.symbol || "").toUpperCase();
    const timeMs = Number(r.time);
    const profit = Number(r.income);
    const id =
      r.tranId != null
        ? `${symbol}:${r.tranId}`
        : `${symbol}:${timeMs}:${Number.isFinite(profit) ? profit : "na"}`;
    return {
      id,
      symbol,
      direction: "N/A",
      openedAt: null,
      closedAt: Number.isFinite(timeMs) ? formatIsoUtcPlus3(timeMs) : null,
      durationSec: null,
      profit: Number.isFinite(profit) ? +profit.toFixed(4) : null,
      comment: comments[id] || "",
    };
  });
}

function toMinuteKey(symbol, closedAt, profit) {
  const ms = Date.parse(closedAt || "") || 0;
  const minute = Math.floor(ms / 60000);
  const p = Number.isFinite(Number(profit)) ? Number(profit).toFixed(4) : "na";
  return `${String(symbol || "").toUpperCase()}:${minute}:${p}`;
}

function sideDelta(side, qty) {
  return String(side).toUpperCase() === "BUY" ? qty : -qty;
}

function bucketDelta(positionSide, side, qty) {
  const ps = String(positionSide || "BOTH").toUpperCase();
  if (ps === "LONG") return { bucket: "LONG", delta: sideDelta(side, qty) };
  if (ps === "SHORT") return { bucket: "SHORT", delta: sideDelta(side, qty) * -1 };
  return { bucket: "BOTH", delta: sideDelta(side, qty) };
}

function closeRecordId(symbol, direction, openedAtMs, closedAtMs) {
  return `${symbol}:${direction}:${openedAtMs}:${closedAtMs}`;
}

function buildEpisodesFromTrades(symbol, trades, comments) {
  const rows = [];
  const state = {
    LONG: { qty: 0, openAt: null, pnl: 0, direction: "LONG" },
    SHORT: { qty: 0, openAt: null, pnl: 0, direction: "SHORT" },
    BOTH: { qty: 0, openAt: null, pnl: 0, direction: null },
  };

  const sorted = [...(trades || [])].sort((a, b) => Number(a.time) - Number(b.time));

  for (const t of sorted) {
    const qty = Number(t.qty);
    const tm = Number(t.time);
    const realized = Number(t.realizedPnl);
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(tm)) continue;

    const { bucket, delta } = bucketDelta(t.positionSide, t.side, qty);
    const s = state[bucket];
    const prev = s.qty;
    const next = prev + delta;

    if (bucket === "BOTH") {
      const prevSign = Math.sign(prev);
      const nextSign = Math.sign(next);

      if (prev === 0 && next !== 0) {
        s.openAt = tm;
        s.direction = next > 0 ? "LONG" : "SHORT";
        s.pnl = Number.isFinite(realized) ? realized : 0;
      } else if (prev !== 0 && next === 0) {
        s.pnl += Number.isFinite(realized) ? realized : 0;
        const openedAtMs = s.openAt || tm;
        const closedAtMs = tm;
        const id = closeRecordId(symbol, s.direction || (prev > 0 ? "LONG" : "SHORT"), openedAtMs, closedAtMs);
        rows.push({
          id,
          symbol,
          direction: s.direction || (prev > 0 ? "LONG" : "SHORT"),
          openedAt: formatIsoUtcPlus3(openedAtMs),
          closedAt: formatIsoUtcPlus3(closedAtMs),
          durationSec: Math.max(0, Math.round((closedAtMs - openedAtMs) / 1000)),
          profit: +s.pnl.toFixed(4),
          comment: comments[id] || "",
        });
        s.openAt = null;
        s.direction = null;
        s.pnl = 0;
      } else if (prev !== 0 && next !== 0 && prevSign !== nextSign) {
        // Position flipped in a single trade: close old and open new at same timestamp.
        s.pnl += Number.isFinite(realized) ? realized : 0;
        const openedAtMs = s.openAt || tm;
        const closedAtMs = tm;
        const oldDir = prev > 0 ? "LONG" : "SHORT";
        const id = closeRecordId(symbol, oldDir, openedAtMs, closedAtMs);
        rows.push({
          id,
          symbol,
          direction: oldDir,
          openedAt: formatIsoUtcPlus3(openedAtMs),
          closedAt: formatIsoUtcPlus3(closedAtMs),
          durationSec: Math.max(0, Math.round((closedAtMs - openedAtMs) / 1000)),
          profit: +s.pnl.toFixed(4),
          comment: comments[id] || "",
        });
        s.openAt = tm;
        s.direction = next > 0 ? "LONG" : "SHORT";
        s.pnl = 0;
      } else if (prev !== 0) {
        s.pnl += Number.isFinite(realized) ? realized : 0;
      }
      s.qty = next;
      continue;
    }

    // Hedge mode buckets LONG/SHORT use absolute open size in that bucket.
    if (prev <= 0 && next > 0) {
      s.openAt = tm;
      s.pnl = Number.isFinite(realized) ? realized : 0;
    } else if (prev > 0 && next <= 0) {
      s.pnl += Number.isFinite(realized) ? realized : 0;
      const openedAtMs = s.openAt || tm;
      const closedAtMs = tm;
      const id = closeRecordId(symbol, s.direction, openedAtMs, closedAtMs);
      rows.push({
        id,
        symbol,
        direction: s.direction,
        openedAt: formatIsoUtcPlus3(openedAtMs),
        closedAt: formatIsoUtcPlus3(closedAtMs),
        durationSec: Math.max(0, Math.round((closedAtMs - openedAtMs) / 1000)),
        profit: +s.pnl.toFixed(4),
        comment: comments[id] || "",
      });
      s.openAt = next > 0 ? tm : null;
      s.pnl = 0;
    } else if (prev > 0) {
      s.pnl += Number.isFinite(realized) ? realized : 0;
    }
    s.qty = Math.max(0, next);
  }

  return rows;
}

function incomeWindow(rows) {
  let minTime = Number.POSITIVE_INFINITY;
  const symbolSet = new Set();
  for (const r of rows || []) {
    const tm = Number(r.time);
    const sym = String(r.symbol || "").toUpperCase();
    if (Number.isFinite(tm)) minTime = Math.min(minTime, tm);
    if (sym) symbolSet.add(sym);
  }
  if (!Number.isFinite(minTime)) minTime = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const symbols = [...symbolSet].slice(0, MAX_SYMBOLS);
  return {
    startTime: Math.max(0, minTime - 3 * 24 * 60 * 60 * 1000),
    symbols,
  };
}

function parseFromDate(searchParams) {
  const raw = String(searchParams?.get("fromDate") || "").trim();
  if (!raw) return null;
  // Interpret date as UTC+3 local day start for dashboard consistency.
  const ms = Date.parse(`${raw}T00:00:00+03:00`);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function createPositionsHistoryStore(options = {}) {
  const kv = options.kv ?? new Map();
  const credentials = resolveBinanceCredentials(kv);
  const commentsData = safeJsonRead(COMMENTS_FILE, { comments: {} });
  const comments =
    commentsData && typeof commentsData.comments === "object"
      ? commentsData.comments
      : {};
  let cache = { at: 0, data: null };

  function saveComments() {
    safeJsonWrite(COMMENTS_FILE, { comments });
  }

  async function list(searchParams) {
    const now = Date.now();
    const fromDateMs = parseFromDate(searchParams);
    const fromDateKey = fromDateMs == null ? "" : String(fromDateMs);
    if (
      cache.data &&
      now - cache.at < CACHE_MS &&
      cache.fromDateKey === fromDateKey
    ) {
      return cache.data;
    }

    if (!credentials.enabled) {
      const out = {
        enabled: false,
        updatedAt: formatIsoUtcPlus3(now),
        items: [],
        hint: "Set BINANCE_API_KEY and BINANCE_API_SECRET in .env (Futures read)",
      };
      cache = { at: now, data: out, fromDateKey };
      return out;
    }

    try {
      const rows = await signedGet(
        "/fapi/v1/income",
        {
          incomeType: "REALIZED_PNL",
          limit: "1000",
          ...(fromDateMs != null
            ? { startTime: String(Math.max(0, fromDateMs - 3 * 24 * 60 * 60 * 1000)) }
            : {}),
        },
        credentials.apiKey,
        credentials.apiSecret
      );
      const { startTime, symbols } = incomeWindow(rows);
      let reconstructed = [];
      if (symbols.length) {
        for (const symbol of symbols) {
          const trades = await signedGet(
            "/fapi/v1/userTrades",
            { symbol, startTime: String(startTime), limit: "1000" },
            credentials.apiKey,
            credentials.apiSecret
          );
          reconstructed.push(...buildEpisodesFromTrades(symbol, trades, comments));
        }
      }

      const incomeItems = mapIncomeToHistoryItems(rows, comments);
      const seen = new Set(
        reconstructed.map((x) => toMinuteKey(x.symbol, x.closedAt, x.profit))
      );
      const incomeFallback = incomeItems.filter(
        (x) => !seen.has(toMinuteKey(x.symbol, x.closedAt, x.profit))
      );

      // Keep reconstructed episodes when available, and fill missing entries from income.
      let items = [...reconstructed, ...incomeFallback]
        .sort(
          (a, b) =>
            (Date.parse(b.closedAt || "") || 0) - (Date.parse(a.closedAt || "") || 0)
        );
      if (fromDateMs != null) {
        items = items.filter(
          (x) => (Date.parse(x.closedAt || "") || 0) >= fromDateMs
        );
      }
      items = items
        .slice(0, MAX_ITEMS);
      const out = {
        enabled: true,
        updatedAt: formatIsoUtcPlus3(now),
        fromDate: fromDateMs != null ? formatIsoUtcPlus3(fromDateMs) : null,
        items,
        hint: null,
      };
      cache = { at: now, data: out, fromDateKey };
      return out;
    } catch (e) {
      const out = {
        enabled: true,
        updatedAt: formatIsoUtcPlus3(now),
        fromDate: fromDateMs != null ? formatIsoUtcPlus3(fromDateMs) : null,
        items: [],
        hint: null,
        error: e.message || String(e),
      };
      cache = { at: now, data: out, fromDateKey };
      return out;
    }
  }

  function setComment(id, comment) {
    const cleanId = String(id || "").trim();
    if (!cleanId) throw new Error("id is required");
    comments[cleanId] = String(comment ?? "").slice(0, 2000);
    saveComments();
    if (cache.data?.items?.length) {
      const row = cache.data.items.find((x) => x.id === cleanId);
      if (row) row.comment = comments[cleanId];
    }
    return { id: cleanId, comment: comments[cleanId] };
  }

  return { list, setComment };
}

module.exports = { createPositionsHistoryStore };
