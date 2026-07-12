#!/usr/bin/env node
/**
 * Incrementally extend backtest kline cache to more history days.
 * Prepends older bars only — existing cached window is not re-fetched.
 *
 *   node scripts/extend-backtest-klines.js --to-days 30
 *   node scripts/extend-backtest-klines.js --to-days 30 --dry-run
 *   node scripts/extend-backtest-klines.js --to-days 30 --no-resume
 */

const {
  barsForDays,
  extendBacktestKlineCache,
  listCachedSymbols,
  loadManifest,
  readSymbolBars,
  symbolAtTarget,
} = require("../lib/backtest-kline-cache");
const { createOlderKlineFetcher } = require("../lib/binance-rest-fetch");
const { createRestQueue } = require("../lib/rest-queue");

function parseArgs(argv) {
  let toDays = 30;
  let restGapMs = 2500;
  let batchPauseMs = 800;
  let symbolPauseMs = 4000;
  let dryRun = false;
  let resume = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--to-days" && argv[i + 1]) toDays = Number(argv[++i]);
    else if (argv[i] === "--rest-gap-ms" && argv[i + 1]) {
      restGapMs = Number(argv[++i]);
    } else if (argv[i] === "--batch-pause-ms" && argv[i + 1]) {
      batchPauseMs = Number(argv[++i]);
    } else if (argv[i] === "--symbol-pause-ms" && argv[i + 1]) {
      symbolPauseMs = Number(argv[++i]);
    } else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--no-resume") resume = false;
    else if (argv[i] === "--resume") resume = true;
  }
  return {
    toDays: Math.max(1, Math.min(60, Math.round(toDays) || 30)),
    restGapMs: Math.max(80, restGapMs),
    batchPauseMs: Math.max(0, batchPauseMs),
    symbolPauseMs: Math.max(0, symbolPauseMs),
    dryRun,
    resume,
  };
}

function onRateLimit(info) {
  if (info.message?.includes("IP banned")) {
    console.error(`[rate-limit] ${info.label} ${info.status} — ${info.message}`);
    return;
  }
  const waitSec = Math.ceil((info.waitMs ?? 0) / 1000);
  console.error(
    `[rate-limit] ${info.label} ${info.status ?? "network"} — wait ${waitSec}s (attempt ${info.attempt ?? "?"})`
  );
}

async function main() {
  const { toDays, restGapMs, batchPauseMs, symbolPauseMs, dryRun, resume } =
    parseArgs(process.argv);
  const manifest = loadManifest();
  const symbols = listCachedSymbols("signal");
  const fromDays = manifest?.days ?? 0;
  const interval = manifest?.interval ?? "5m";
  const needs1m = manifest?.needs1mBars ?? manifest?.needs1mMovers ?? true;

  if (!symbols.length) {
    console.error("No backtest kline cache — run train bot (10d) first.");
    process.exit(1);
  }

  const signalBarCount = barsForDays(interval, toDays);
  const moverBarCount = needs1m ? barsForDays("1m", toDays) : 0;
  let alreadyDone = 0;
  if (resume) {
    for (const sym of symbols) {
      if (symbolAtTarget(sym, signalBarCount, moverBarCount, needs1m)) alreadyDone++;
    }
  }

  if (fromDays >= toDays && alreadyDone >= symbols.length) {
    console.error(
      `Cache already covers ${fromDays}d for all ${symbols.length} symbols (need ${toDays}d).`
    );
    process.exit(0);
  }

  const addSignal = barsForDays(interval, Math.max(0, toDays - fromDays));
  const addMover = needs1m ? barsForDays("1m", Math.max(0, toDays - fromDays)) : 0;

  console.error(
    `Extend backtest cache: ${fromDays}d → ${toDays}d · ${symbols.length} symbols · ${interval}` +
      (needs1m ? " + 1m" : "")
  );
  console.error(
    `Incremental fetch ~${addSignal} signal bars + ~${addMover} 1m bars per symbol (prepend only)`
  );
  console.error(
    `REST gap ${restGapMs}ms · batch pause ${batchPauseMs}ms · symbol pause ${symbolPauseMs}ms` +
      (resume ? ` · resume (${alreadyDone} already complete)` : "")
  );
  if (manifest?.extendCheckpoint) {
    console.error(
      `Previous run checkpoint: ${manifest.extendCheckpoint.done}/${manifest.extendCheckpoint.total} at ${manifest.extendCheckpoint.symbol}`
    );
  }

  if (dryRun) {
    console.error("Dry run — no API calls.");
    process.exit(0);
  }

  const restQueue = createRestQueue({ label: "extend-klines", gapMs: restGapMs });
  const fetchSignalOlder = createOlderKlineFetcher({
    interval,
    restQueue,
    batchPauseMs,
    onRateLimit,
  });
  const fetchMoverOlder = needs1m
    ? createOlderKlineFetcher({
        interval: "1m",
        restQueue,
        batchPauseMs,
        onRateLimit,
      })
    : null;

  const started = Date.now();
  const stats = await extendBacktestKlineCache({
    targetDays: toDays,
    interval,
    symbols,
    needs1m,
    fetchSignalOlder,
    fetchMoverOlder,
    resume,
    symbolPauseMs,
    onProgress: (p) => {
      if (p.error) {
        console.error(`[err] ${p.message}`);
        return;
      }
      if (p.resumed) {
        if ((p.done + 1) % 50 === 0) {
          console.error(`[resume] ${p.done + 1}/${p.total} skipped so far`);
        }
        return;
      }
      if (p.phase !== "done" || !p.symbol) return;
      const sigLen = readSymbolBars("signal", p.symbol)?.length ?? 0;
      const movLen = needs1m ? readSymbolBars("mover", p.symbol)?.length ?? 0 : 0;
      const movPart = needs1m ? ` · 1m ${movLen}/${moverBarCount}` : "";
      console.error(
        `[extend] ${p.done}/${p.total} · ${p.symbol} · ${interval} ${sigLen}/${signalBarCount}${movPart}`
      );
    },
  });

  const elapsed = Math.round((Date.now() - started) / 1000);
  console.error(
    `\nDone in ${elapsed}s · resumed ${stats.resumeSkipped} · signal extended ${stats.signalExtended} · skipped ${stats.signalSkipped}` +
      (needs1m
        ? ` · 1m extended ${stats.moverExtended} · skipped ${stats.moverSkipped}`
        : "") +
      ` · errors ${stats.errors}`
  );
  console.error(
    `Manifest: ${toDays}d · ${signalBarCount}×${interval} · ${needs1m ? `${moverBarCount}×1m · ` : ""}persistent`
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
