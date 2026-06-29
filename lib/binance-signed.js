const crypto = require("crypto");

const REST_BASE = "https://fapi.binance.com";
const RECV_WINDOW = 60_000;
const TIME_SYNC_TTL_MS = 5 * 60 * 1000;

let timeOffsetMs = 0;
let timeSyncedAt = 0;
let timeSyncInflight = null;

function binanceTimestamp() {
  return Date.now() + timeOffsetMs;
}

async function syncServerTimeOffset(force = false) {
  const now = Date.now();
  if (!force && timeSyncedAt && now - timeSyncedAt < TIME_SYNC_TTL_MS) {
    return timeOffsetMs;
  }
  if (timeSyncInflight) return timeSyncInflight;

  timeSyncInflight = (async () => {
    const t0 = Date.now();
    const res = await fetch(`${REST_BASE}/fapi/v1/time`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.msg || body?.message || `time sync HTTP ${res.status}`);
    }
    const t1 = Date.now();
    const serverTime = Number(body.serverTime);
    if (!Number.isFinite(serverTime)) {
      throw new Error("time sync: invalid serverTime");
    }
    const rtt = t1 - t0;
    timeOffsetMs = serverTime + Math.floor(rtt / 2) - t1;
    timeSyncedAt = Date.now();
    return timeOffsetMs;
  })().finally(() => {
    timeSyncInflight = null;
  });

  return timeSyncInflight;
}

function signParams(params, apiSecret) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) qs.set(key, String(value));
  }
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(qs.toString())
    .digest("hex");
  qs.set("signature", signature);
  return qs;
}

async function signedFuturesRequest(method, apiPath, params, apiKey, apiSecret) {
  const run = async (forceSync) => {
    await syncServerTimeOffset(forceSync);
    const qs = signParams(
      {
        ...params,
        recvWindow: String(RECV_WINDOW),
        timestamp: String(binanceTimestamp()),
      },
      apiSecret
    );
    const url = `${REST_BASE}${apiPath}?${qs}`;
    const res = await fetch(url, {
      method,
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
      const err = new Error(msg);
      err.code = body?.code;
      throw err;
    }
    return body;
  };

  try {
    return await run(false);
  } catch (e) {
    if (e.code === -1021) return run(true);
    throw e;
  }
}

async function signedFuturesGet(path, params, apiKey, apiSecret) {
  return signedFuturesRequest("GET", path, params, apiKey, apiSecret);
}

module.exports = {
  REST_BASE,
  RECV_WINDOW,
  syncServerTimeOffset,
  signedFuturesRequest,
  signedFuturesGet,
};
