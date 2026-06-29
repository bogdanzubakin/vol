const { formatIsoUtcPlus3 } = require("./time-format");
const { resolveBinanceCredentials } = require("./binance-positions");
const { signedFuturesGet } = require("./binance-signed");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");

const REST_BASE = "https://fapi.binance.com";
const CACHE_MS = 10000;
const MAX_ITEMS = 2000;
const MAX_SYMBOLS = 200;
const commentsFile = () => dataPath("positions-history-comments.json");

async function signedGet(pathName, params, apiKey, apiSecret) {
  return signedFuturesGet(pathName, params, apiKey, apiSecret);
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

function closeMs(row) {
  return Date.parse(row?.closedAt || "") || 0;
}

function openMs(row) {
  return Date.parse(row?.openedAt || "") || 0;
}

/** Merge partial realized-PnL / scale events for the same symbol into one row. */
function clusterHistoryItems(items, comments, gapMs = 30 * 60 * 1000) {
  const sorted = [...items].sort((a, b) => closeMs(a) - closeMs(b));
  const clusters = [];

  for (const row of sorted) {
    const sym = String(row.symbol || "").toUpperCase();
    if (!sym) continue;
    const t = closeMs(row);
    const profit = Number(row.profit) || 0;
    const last = clusters[clusters.length - 1];

    if (last && last.symbol === sym && t - closeMs(last) <= gapMs) {
      last.profit = +(Number(last.profit || 0) + profit).toFixed(4);
      last.closedAt = row.closedAt || last.closedAt;
      if (row.openedAt) {
        if (!last.openedAt || openMs(row) < openMs(last)) {
          last.openedAt = row.openedAt;
        }
      }
      const start = last.openedAt ? openMs(last) : openMs({ openedAt: last.closedAt });
      const end = closeMs(last);
      last.durationSec =
        last.openedAt && end > start
          ? Math.max(0, Math.round((end - start) / 1000))
          : last.durationSec;
      if (row.direction === "LONG" || row.direction === "SHORT") {
        last.direction = row.direction;
      }
      if (!last.comment && row.comment) last.comment = row.comment;
      last._sourceIds = last._sourceIds || [last.id];
      last._sourceIds.push(row.id);
      last.id = `${sym}:${start}:${end}`;
      continue;
    }

    clusters.push({
      ...row,
      profit: Number.isFinite(profit) ? +profit.toFixed(4) : null,
      _sourceIds: [row.id],
    });
  }

  for (const c of clusters) {
    const start = c.openedAt ? openMs(c) : closeMs(c);
    const end = closeMs(c);
    c.id = `${c.symbol}:${start}:${end}`;
    if (c.openedAt && end > start) {
      c.durationSec = Math.max(0, Math.round((end - start) / 1000));
    }
    const ids = c._sourceIds || [c.id];
    const mergedComment = ids.map((id) => comments[id]).find(Boolean);
    if (mergedComment) c.comment = mergedComment;
    delete c._sourceIds;
  }

  return clusters.sort((a, b) => closeMs(b) - closeMs(a));
}

function enrichClustersFromEpisodes(clusters, episodes, matchMs = 10 * 60 * 1000) {
  const usedEpisodeIds = new Set();
  for (const c of clusters) {
    const t = closeMs(c);
    let best = null;
    let bestGap = Infinity;
    for (const ep of episodes) {
      if (ep.symbol !== c.symbol) continue;
      const gap = Math.abs(closeMs(ep) - t);
      if (gap <= matchMs && gap < bestGap) {
        bestGap = gap;
        best = ep;
      }
    }
    if (best) {
      c.direction = best.direction;
      c.openedAt = best.openedAt;
      c.durationSec = best.durationSec;
      usedEpisodeIds.add(best.id);
    }
  }
  const extras = episodes.filter((ep) => {
    if (usedEpisodeIds.has(ep.id)) return false;
    return !clusters.some(
      (c) =>
        c.symbol === ep.symbol && Math.abs(closeMs(c) - closeMs(ep)) <= matchMs
    );
  });
  return [...clusters, ...extras];
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
  const commentsData = readJsonFile(commentsFile(), { comments: {} });
  const comments =
    commentsData && typeof commentsData.comments === "object"
      ? commentsData.comments
      : {};
  let cache = { at: 0, data: null };

  function saveComments() {
    writeJsonFile(commentsFile(), { comments });
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
      const episodes = [];
      if (symbols.length) {
        for (const symbol of symbols) {
          const trades = await signedGet(
            "/fapi/v1/userTrades",
            { symbol, startTime: String(startTime), limit: "1000" },
            credentials.apiKey,
            credentials.apiSecret
          );
          episodes.push(...buildEpisodesFromTrades(symbol, trades, comments));
        }
      }

      // Primary: realized PnL income, clustered per symbol (merges scale in/out partials).
      const incomeItems = mapIncomeToHistoryItems(rows, comments);
      let items = clusterHistoryItems(incomeItems, comments);
      items = enrichClustersFromEpisodes(items, episodes);
      items = clusterHistoryItems(items, comments);
      items.sort((a, b) => closeMs(b) - closeMs(a));
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
    const text = String(comment ?? "").slice(0, 2000);
    comments[cleanId] = text;
    saveComments();
    if (cache.data?.items?.length) {
      const row = cache.data.items.find((x) => x.id === cleanId);
      if (row) row.comment = text;
    }
    return { id: cleanId, comment: text };
  }

  return { list, setComment };
}

module.exports = { createPositionsHistoryStore };
