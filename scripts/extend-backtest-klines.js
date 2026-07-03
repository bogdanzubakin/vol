#!/usr/bin/env node
/**
 * Incrementally extend backtest kline cache to more history days.
 * Prepends older bars only — existing cached window is not re-fetched.
 *
 *   node scripts/extend-backtest-klines.js --to-days 30
 *   node scripts/extend-backtest-klines.js --to-days 30 --dry-run
 */

const {
  barsForDays,
  extendBacktestKlineCache,
  listCachedSymbols,
  loadManifest,
} = require("../lib/backtest-kline-cache");
const { createRestQueue, sleep } = require("../lib/rest-queue");

const REST_BASE = "https://fapi.binance.com";
const KLINE_MAX = 1500;

function parseArgs(argv) {
  let toDays = 30;
  let restGapMs = 300;
  let dryRun = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--to-days" && argv[i + 1]) toDays = Number(argv[++i]);
    else if (argv[i] === "--rest-gap-ms" && argv[i + 1]) {
      restGapMs = Number(argv[++i]);
    } else if (argv[i] === "--dry-run") dryRun = true;
  }
  return {
    toDays: Math.max(1, Math.min(60, Math.round(toDays) || 30)),
    restGapMs: Math.max(50, restGapMs),
    dryRun,
  };
}

function parseKlines(rows) {
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

function createFetcher(interval, restQueue) {
  async function fetchBatch(url, symbol, iv) {
    let attempt = 0;
    while (true) {
      const res = await fetch(url);
      const text = await res.text();
      if (res.status === 429 || res.status === 418) {
        attempt++;
        if (attempt > 8) throw new Error(`${symbol} ${iv} ${res.status}`);
        const wait = Math.min(60_000, 2000 * 2 ** attempt);
        console.error(`[rate-limit] ${symbol} ${iv} ${res.status} — wait ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${symbol} ${iv} ${res.status}`);
      return JSON.parse(text);
    }
  }

  return async function fetchOlder(symbol, limit, endTime) {
    let all = [];
    let end = endTime;
    let remaining = limit;

    while (remaining > 0) {
      const batch = Math.min(remaining, KLINE_MAX);
      const params = {
        symbol,
        interval,
        limit: String(batch),
        endTime: String(end),
      };
      const url = new URL("/fapi/v1/klines", REST_BASE);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const rows = await restQueue.schedule(() => fetchBatch(url, symbol, interval));
      if (!rows.length) break;
      const parsed = parseKlines(rows);
      all = [...parsed, ...all];
      end = rows[0][0] - 1;
      remaining -= parsed.length;
      if (parsed.length < batch) break;
      await sleep(20);
    }

    return all.slice(-limit);
  };
}

async function main() {
  const { toDays, restGapMs, dryRun } = parseArgs(process.argv);
  const manifest = loadManifest();
  const symbols = listCachedSymbols("signal");
  const fromDays = manifest?.days ?? 0;
  const interval = manifest?.interval ?? "5m";
  const needs1m = manifest?.needs1mBars ?? manifest?.needs1mMovers ?? true;

  if (!symbols.length) {
    console.error("No backtest kline cache — run train bot (10d) first.");
    process.exit(1);
  }

  if (fromDays >= toDays) {
    console.error(
      `Cache already covers ${fromDays}d (need ${toDays}d). Nothing to extend.`
    );
    process.exit(0);
  }

  const signalBars = barsForDays(interval, toDays);
  const moverBars = needs1m ? barsForDays("1m", toDays) : 0;
  const addSignal = barsForDays(interval, toDays - fromDays);
  const addMover = needs1m ? barsForDays("1m", toDays - fromDays) : 0;

  console.error(
    `Extend backtest cache: ${fromDays}d → ${toDays}d · ${symbols.length} symbols · ${interval}` +
      (needs1m ? " + 1m" : "")
  );
  console.error(
    `Incremental fetch ~${addSignal} signal bars + ~${addMover} 1m bars per symbol (prepend only)`
  );

  if (dryRun) {
    console.error("Dry run — no API calls.");
    process.exit(0);
  }

  const restQueue = createRestQueue({ label: "extend-klines", gapMs: restGapMs });
  const fetchSignalOlder = createFetcher(interval, restQueue);
  const fetchMoverOlder = needs1m ? createFetcher("1m", restQueue) : null;

  let lastSym = "";
  const started = Date.now();
  const stats = await extendBacktestKlineCache({
    targetDays: toDays,
    interval,
    symbols,
    needs1m,
    fetchSignalOlder,
    fetchMoverOlder,
    onProgress: (p) => {
      if (p.error) {
        console.error(`[err] ${p.message}`);
        return;
      }
      if (p.symbol && p.symbol !== lastSym) {
        lastSym = p.symbol;
        if (p.done % 25 === 0 || p.done + 1 >= symbols.length) {
          console.error(`[extend] ${p.done + 1}/${symbols.length} · ${p.symbol}`);
        }
      }
    },
  });

  const elapsed = Math.round((Date.now() - started) / 1000);
  console.error(
    `\nDone in ${elapsed}s · signal extended ${stats.signalExtended} · skipped ${stats.signalSkipped}` +
      (needs1m
        ? ` · 1m extended ${stats.moverExtended} · skipped ${stats.moverSkipped}`
        : "") +
      ` · errors ${stats.errors}`
  );
  console.error(
    `Manifest: ${toDays}d · ${signalBars}×${interval} · ${needs1m ? `${moverBars}×1m · ` : ""}persistent`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
