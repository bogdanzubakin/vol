const WebSocket = require("ws");

const REST_BASE = "https://fapi.binance.com";
const KEEPALIVE_MS = 30 * 60 * 1000;

function createBinanceUserStream(options = {}) {
  const { credentials, trader, onAccountUpdate, onOrderUpdate } = options;
  if (!credentials?.enabled || !credentials.apiKey) {
    return { start: () => {}, stop: () => {} };
  }

  let ws = null;
  let listenKey = null;
  let keepaliveTimer = null;
  let reconnectTimer = null;
  let closed = false;
  let starting = false;

  async function createListenKey() {
    const res = await fetch(`${REST_BASE}/fapi/v1/listenKey`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || `listenKey HTTP ${res.status}`);
    }
    const body = text ? JSON.parse(text) : {};
    if (!body.listenKey) throw new Error("listenKey missing in response");
    return body.listenKey;
  }

  async function keepaliveListenKey() {
    if (!listenKey) return;
    const res = await fetch(`${REST_BASE}/fapi/v1/listenKey`, {
      method: "PUT",
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `listenKey keepalive HTTP ${res.status}`);
    }
  }

  async function deleteListenKey() {
    if (!listenKey) return;
    try {
      await fetch(`${REST_BASE}/fapi/v1/listenKey`, {
        method: "DELETE",
        headers: { "X-MBX-APIKEY": credentials.apiKey },
      });
    } catch {
      /* ignore */
    }
    listenKey = null;
  }

  function scheduleReconnect(ms = 3000) {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, ms);
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const event = msg.e || msg.eventType;
    if (event === "ACCOUNT_UPDATE") {
      const account = msg.a || {};
      trader?.applyWsAccountUpdate?.(account);
      onAccountUpdate?.(account);
      return;
    }
    if (event === "ORDER_TRADE_UPDATE") {
      trader?.invalidateRestCache?.();
      onOrderUpdate?.(msg.o || msg.order);
      return;
    }
    if (event === "listenKeyExpired") {
      void reconnect();
    }
  }

  async function reconnect() {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    await deleteListenKey();
    scheduleReconnect(500);
  }

  async function connect() {
    if (closed || starting) return;
    starting = true;
    try {
      listenKey = await createListenKey();
      const url = `wss://fstream.binance.com/ws/${listenKey}`;
      ws = new WebSocket(url);

      ws.on("open", () => {
        console.error("Binance user data stream connected");
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = setInterval(() => {
          keepaliveListenKey().catch((e) => {
            console.error(`listenKey keepalive: ${e.message}`);
          });
        }, KEEPALIVE_MS);
      });

      ws.on("message", (raw) => handleMessage(raw.toString()));

      ws.on("close", () => {
        ws = null;
        if (!closed) {
          console.error("Binance user data stream closed — reconnecting…");
          scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        console.error(`Binance user data stream: ${err?.message || err}`);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      });
    } catch (e) {
      console.error(`Binance user data stream: ${e.message}`);
      scheduleReconnect(Math.min(60_000, 5000));
    } finally {
      starting = false;
    }
  }

  function start() {
    closed = false;
    void connect();
  }

  function stop() {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    void deleteListenKey();
  }

  return { start, stop };
}

module.exports = { createBinanceUserStream };
