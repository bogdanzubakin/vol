/**
 * Binance USDT-M futures aggTrade: REST recent trades + WS stream.
 *
 * WS: wss://fstream.binance.com/stream?streams=btcusdt@trade
 * REST seed: GET /fapi/v1/aggTrades?symbol=&limit=
 *
 * Note: some environments receive @trade but not @aggTrade; both expose isBuyerMaker `m`.
 */
const WebSocket = require("ws");
const { fetchFuturesJson, FUTURES_REST_BASE } = require("./binance-rest-fetch");
const { sleep } = require("./rest-queue");
const { createTapeBuffer, normalizeAggTrade } = require("./tape-reading-signal");

const FSTREAM_BASE = "wss://fstream.binance.com/stream";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchAggTrades(symbol, options = {}) {
  const sym = String(symbol || "").toUpperCase();
  const limit = Math.min(1000, Math.max(1, options.limit ?? 100));
  const url = new URL("/fapi/v1/aggTrades", FUTURES_REST_BASE);
  url.searchParams.set("symbol", sym);
  url.searchParams.set("limit", String(limit));
  const rows = await fetchFuturesJson(url.toString(), {
    timeoutMs: options.timeoutMs ?? 15_000,
    label: `aggTrades ${sym}`,
  });
  return Array.isArray(rows) ? rows : [];
}

function createAggTradeProvider(options = {}) {
  const streamsPerSocket = options.streamsPerSocket ?? 40;
  const bufferSize = options.bufferSize ?? 250;
  const restGapMs = options.restGapMs ?? 40;

  const buffer = createTapeBuffer(bufferSize);
  let symbolList = [];
  /** @type {((sym: string, trades: object[], last: object) => void)[]} */
  const listeners = [];
  let sockets = [];
  let closed = false;

  function emit(sym, last) {
    const trades = buffer.get(sym);
    for (const fn of listeners) {
      try {
        fn(sym, trades, last);
      } catch {
        /* ignore */
      }
    }
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

  function getTrades(symbol) {
    return buffer.get(symbol);
  }

  async function seedSymbol(symbol, limit = 100) {
    const rows = await fetchAggTrades(symbol, { limit });
    buffer.seed(symbol, rows);
    return buffer.get(symbol);
  }

  async function seedAll({ onProgress, limit = 100 } = {}) {
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < symbolList.length; i++) {
      const sym = symbolList[i];
      try {
        await seedSymbol(sym, limit);
        ok++;
      } catch (e) {
        fail++;
        onProgress?.({ symbol: sym, error: e.message, fail });
      }
      if (restGapMs > 0) await sleep(restGapMs);
      if ((i + 1) % 20 === 0) {
        onProgress?.({ done: i + 1, total: symbolList.length });
      }
    }
    return { ok, fail };
  }

  function handleAggMessage(data) {
    const sym = String(data?.s || "").toUpperCase();
    if (!sym) return;
    // Accept aggTrade or trade (same m / p / q / T fields).
    if (data?.e && data.e !== "aggTrade" && data.e !== "trade") return;
    const last = buffer.push(sym, data);
    if (last) emit(sym, last);
  }

  function startWs() {
    stopWs();
    closed = false;
    if (!symbolList.length) return [];
    const streamNames = symbolList.map((s) => `${s.toLowerCase()}@trade`);
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
          handleAggMessage(data);
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

  function start() {
    startWs();
  }

  function stop() {
    closed = true;
    stopWs();
  }

  return {
    setSymbols,
    getTrades,
    onUpdate,
    seedSymbol,
    seedAll,
    start,
    stop,
    startWs,
    stopWs,
    buffer,
    status() {
      return {
        symbols: symbolList.length,
        buffers: buffer.size,
        sockets: sockets.length,
      };
    },
  };
}

module.exports = {
  FSTREAM_BASE,
  fetchAggTrades,
  createAggTradeProvider,
  normalizeAggTrade,
};
