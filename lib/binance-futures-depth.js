/**
 * Binance USDT-M futures order book: REST snapshot + optional depth WS.
 *
 * Streams: wss://fstream.binance.com/stream?streams=btcusdt@depth20@100ms
 */
const WebSocket = require("ws");
const { fetchFuturesJson, FUTURES_REST_BASE } = require("./binance-rest-fetch");
const { sleep } = require("./rest-queue");

const FSTREAM_BASE = "wss://fstream.binance.com/stream";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * REST: GET /fapi/v1/depth?symbol=&limit=
 * @returns {{ symbol, bids: [price,qty][], asks: [price,qty][], asOfMs }}
 */
async function fetchDepthSnapshot(symbol, options = {}) {
  const sym = String(symbol || "").toUpperCase();
  const limit = options.limit ?? 20;
  const url = new URL("/fapi/v1/depth", FUTURES_REST_BASE);
  url.searchParams.set("symbol", sym);
  url.searchParams.set("limit", String(limit));
  const data = await fetchFuturesJson(url.toString(), {
    timeoutMs: options.timeoutMs ?? 15_000,
    label: `depth ${sym}`,
  });
  return {
    symbol: sym,
    bids: data.bids ?? [],
    asks: data.asks ?? [],
    lastUpdateId: data.lastUpdateId ?? null,
    asOfMs: Date.now(),
  };
}

/**
 * In-memory depth books + REST poll and/or WS partial depth.
 */
function createOrderBookDepthProvider(options = {}) {
  const levels = options.levels ?? 20;
  const streamsPerSocket = options.streamsPerSocket ?? 40;
  const restGapMs = options.restGapMs ?? 40;
  const pollMs = options.pollMs ?? 0; // 0 = no REST poll
  const speed = options.speed === "1000ms" ? "1000ms" : "100ms";

  /** @type {Map<string, object>} */
  const books = new Map();
  let symbolList = [];
  /** @type {((sym: string, book: object) => void)[]} */
  const listeners = [];
  let sockets = [];
  let closed = false;
  let pollTimer = null;
  let pollInflight = null;

  function emit(sym, book) {
    books.set(sym, book);
    for (const fn of listeners) {
      try {
        fn(sym, book);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  function getBook(symbol) {
    return books.get(String(symbol || "").toUpperCase()) ?? null;
  }

  function onUpdate(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function setSymbols(symbols) {
    symbolList = [
      ...new Set((symbols ?? []).map((s) => String(s).toUpperCase())),
    ].sort();
  }

  async function refreshSymbol(symbol) {
    const book = await fetchDepthSnapshot(symbol, { limit: levels });
    emit(book.symbol, book);
    return book;
  }

  async function refreshAll({ onProgress } = {}) {
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < symbolList.length; i++) {
      const sym = symbolList[i];
      try {
        await refreshSymbol(sym);
        ok++;
      } catch (e) {
        fail++;
        onProgress?.({ symbol: sym, error: e.message, fail });
      }
      if (restGapMs > 0) await sleep(restGapMs);
      if ((i + 1) % 25 === 0) {
        onProgress?.({ done: i + 1, total: symbolList.length });
      }
    }
    return { ok, fail };
  }

  function handleDepthMessage(data) {
    const sym = String(data?.s || "").toUpperCase();
    if (!sym) return;
    // Partial book depth stream: b/a arrays
    const bids = data.b ?? data.bids ?? [];
    const asks = data.a ?? data.asks ?? [];
    if (!bids.length && !asks.length) return;
    emit(sym, {
      symbol: sym,
      bids,
      asks,
      lastUpdateId: data.u ?? data.lastUpdateId ?? null,
      asOfMs: Date.now(),
    });
  }

  function startWs() {
    stopWs();
    closed = false;
    if (!symbolList.length) return [];
    const streamNames = symbolList.map(
      (s) => `${s.toLowerCase()}@depth${levels}@${speed}`
    );
    const batches = chunk(streamNames, streamsPerSocket);
    sockets = batches.map((batch, batchIdx) => {
      const url = `${FSTREAM_BASE}?streams=${batch.join("/")}`;
      let reconnectMs = 1000;
      let ws;
      let shardClosed = false;

      const connect = () => {
        if (closed || shardClosed) return;
        ws = new WebSocket(url);
        ws.on("open", () => {
          reconnectMs = 1000;
        });
        ws.on("message", (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          const data = msg.data ?? msg;
          if (data?.e && data.e !== "depthUpdate" && !data.b && !data.bids) {
            // depth20 partial often has no e, just bids/asks + lastUpdateId
          }
          handleDepthMessage(data);
        });
        ws.on("close", () => {
          if (closed || shardClosed) return;
          setTimeout(connect, reconnectMs);
          reconnectMs = Math.min(30_000, reconnectMs * 1.5);
        });
        ws.on("error", () => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        });
      };
      connect();
      return {
        index: batchIdx,
        close() {
          shardClosed = true;
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
        },
      };
    });
    return sockets;
  }

  function stopWs() {
    for (const s of sockets) s.close?.();
    sockets = [];
  }

  function startPoll() {
    stopPoll();
    if (!(pollMs > 0)) return;
    pollTimer = setInterval(() => {
      if (pollInflight) return;
      pollInflight = refreshAll().finally(() => {
        pollInflight = null;
      });
    }, pollMs);
    pollTimer.unref?.();
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function start({ ws = true, poll = false } = {}) {
    if (ws) startWs();
    if (poll || pollMs > 0) startPoll();
  }

  function stop() {
    closed = true;
    stopWs();
    stopPoll();
  }

  return {
    setSymbols,
    getBook,
    onUpdate,
    refreshSymbol,
    refreshAll,
    start,
    stop,
    startWs,
    stopWs,
    status() {
      return {
        symbols: symbolList.length,
        books: books.size,
        sockets: sockets.length,
        levels,
        speed,
        pollMs,
      };
    },
  };
}

module.exports = {
  FSTREAM_BASE,
  fetchDepthSnapshot,
  createOrderBookDepthProvider,
};
