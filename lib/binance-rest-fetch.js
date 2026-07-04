const { sleep } = require("./rest-queue");

const FUTURES_REST_BASE = "https://fapi.binance.com";

function parseBanUntil(text) {
  const m = String(text ?? "").match(/banned until (\d+)/i);
  return m ? Number(m[1]) : null;
}

async function waitForBan(banUntil, onWait) {
  while (true) {
    const waitMs = banUntil - Date.now();
    if (waitMs <= 0) return;
    const sec = Math.ceil(waitMs / 1000);
    onWait?.(sec);
    await sleep(Math.min(waitMs + 500, 30_000));
  }
}

/**
 * Fetch Binance Futures JSON with timeout, 418/429 ban handling, and retries.
 */
async function fetchFuturesJson(url, options = {}) {
  const {
    timeoutMs = 60_000,
    maxAttempts = 20,
    retryBaseMs = 8_000,
    onRateLimit,
    label = "binance",
  } = options;

  let attempt = 0;
  while (true) {
    let res;
    let text;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      text = await res.text();
    } catch (e) {
      attempt++;
      if (attempt >= maxAttempts) throw e;
      const wait = retryBaseMs * attempt;
      onRateLimit?.({ label, status: "network", waitMs: wait, attempt, message: e.message });
      await sleep(wait);
      continue;
    }

    if (res.status === 418 || res.status === 429) {
      const banUntil = parseBanUntil(text);
      if (banUntil && banUntil > Date.now()) {
        onRateLimit?.({
          label,
          status: res.status,
          banUntil,
          waitMs: banUntil - Date.now(),
          attempt,
          message: text.slice(0, 120),
        });
        await waitForBan(banUntil, (sec) => {
          onRateLimit?.({
            label,
            status: res.status,
            banUntil,
            waitMs: sec * 1000,
            attempt,
            message: `IP banned — waiting ${sec}s`,
          });
        });
        continue;
      }
      attempt++;
      if (attempt >= maxAttempts) {
        throw new Error(`${label} ${res.status} ${text.slice(0, 160)}`);
      }
      const wait = Math.min(180_000, retryBaseMs * attempt);
      onRateLimit?.({ label, status: res.status, waitMs: wait, attempt, message: text.slice(0, 120) });
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      throw new Error(`${label} ${res.status} ${text.slice(0, 160)}`);
    }

    return JSON.parse(text);
  }
}

function parseKlineRows(rows) {
  return rows.map((r) => ({
    openTime: r[0],
    open: +r[1],
    high: +r[2],
    low: +r[3],
    close: +r[4],
    volume: +r[5],
    closeTime: r[6],
  }));
}

function createOlderKlineFetcher({
  interval,
  restQueue,
  batchPauseMs = 600,
  symbolPauseMs = 0,
  onRateLimit,
}) {
  const KLINE_MAX = 1500;

  return async function fetchOlder(symbol, limit, endTime) {
    let all = [];
    let end = endTime;
    let remaining = limit;
    let batches = 0;

    while (remaining > 0) {
      const batch = Math.min(remaining, KLINE_MAX);
      const params = {
        symbol,
        interval,
        limit: String(batch),
        endTime: String(end),
      };
      const url = new URL("/fapi/v1/klines", FUTURES_REST_BASE);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

      const rows = await restQueue.schedule(() =>
        fetchFuturesJson(url.toString(), {
          label: `${symbol} ${interval}`,
          onRateLimit: (info) => {
            restQueue.bumpGap?.(300);
            onRateLimit?.(info);
          },
        })
      );
      batches++;
      if (!rows.length) break;
      const parsed = parseKlineRows(rows);
      all = [...parsed, ...all];
      end = rows[0][0] - 1;
      remaining -= parsed.length;
      if (parsed.length < batch) break;
      if (batchPauseMs > 0) await sleep(batchPauseMs);
    }

    if (symbolPauseMs > 0 && batches > 0) await sleep(symbolPauseMs);
    return all.slice(-limit);
  };
}

module.exports = {
  FUTURES_REST_BASE,
  parseBanUntil,
  waitForBan,
  fetchFuturesJson,
  parseKlineRows,
  createOlderKlineFetcher,
};
