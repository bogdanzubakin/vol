#!/usr/bin/env node
/**
 * Run train-bot backtest on Railway and compare with local paper-bot-backtest-last.json.
 *
 *   RAILWAY_URL=... VOL_SESSION_COOKIE_FILE=scripts/.vol-railway-cookie \
 *     node scripts/run-railway-backtest-compare.js --days 10
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { dataPath, readJsonFile } = require("../lib/data-dir");
const { loadLastBacktestResult } = require("../lib/paper-bot-backtest");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  let days = 10;
  let start = true;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--days" && argv[i + 1]) days = Number(argv[++i]);
    else if (argv[i] === "--no-start") start = false;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(`Usage: node scripts/run-railway-backtest-compare.js [--days 10] [--no-start]

Compares local .cache/paper-bot-backtest-last.json with Railway backtest result.
Use --no-start to compare against the last server run without starting a new one.
`);
      process.exit(0);
    }
  }
  return { days: Math.max(1, Math.min(21, Math.round(days) || 10)), start };
}

function readCookie() {
  const inline = process.env.VOL_SESSION_COOKIE?.trim();
  if (inline) return inline;
  const file =
    process.env.VOL_SESSION_COOKIE_FILE?.trim() ||
    path.join(ROOT, "scripts", ".vol-railway-cookie");
  const line = fs.readFileSync(file, "utf8").trim();
  return line.includes("=") ? line : `vol_session=${line}`;
}

function requestJson(baseUrl, method, pathname, body, cookie) {
  const url = new URL(pathname, baseUrl);
  const mod = url.protocol === "https:" ? https : http;
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          Cookie: cookie,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            reject(new Error(`${method} ${pathname} (${res.statusCode}): ${text.slice(0, 300)}`));
            return;
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(baseUrl, cookie, method, pathname, body) {
  const res = await requestJson(baseUrl, method, pathname, body, cookie);
  if (res.status === 401) {
    throw new Error(
      "Unauthorized — refresh scripts/.vol-railway-cookie (log into dashboard → DevTools → vol_session)"
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `${method} ${pathname} (${res.status}): ${res.json?.error || res.text?.slice(0, 200)}`
    );
  }
  return res.json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickSummary(result) {
  const s = result?.summary ?? {};
  const bot = result?.botConfig ?? {};
  const sig = result?.signalConfig ?? {};
  return {
    totalPnl: +(s.totalPnl ?? s.realizedPnl ?? 0).toFixed(2),
    closedTrades: s.closedCount ?? 0,
    wins: s.winCount ?? 0,
    losses: s.lossCount ?? 0,
    winRatePct: s.closedCount
      ? +((100 * (s.winCount ?? 0)) / s.closedCount).toFixed(1)
      : 0,
    sfpBull: s.sfpSignals ?? 0,
    sfpBear: s.sfpBearSignals ?? 0,
    regimeSkips: s.sfpRegimeSkips ?? 0,
    regimeSkipsBull: s.sfpRegimeSkipsBull ?? 0,
    regimeSkipsBear: s.sfpRegimeSkipsBear ?? 0,
    skippedOpen: s.skippedOpen ?? 0,
    days: result?.days ?? null,
    symbols: result?.symbolsProcessed ?? null,
    finishedAt: result?.finishedAt ?? null,
    elapsedSec: result?.elapsedSec ?? null,
    regime: bot.aiSfpRegimeEnabled,
    bullTh: bot.aiSfpRegimeBullThreshold,
    bearTh: bot.aiSfpRegimeBearThreshold,
    btcHours: bot.aiRegimeBtcLookbackHours,
    scanner: `${sig.fastMoveLookbackCandles}/${sig.minAvgMovePct}/${sig.topMoveMinPct}`,
  };
}

function bySignal(trades) {
  const m = {};
  for (const t of trades ?? []) {
    const k = t.signalKind || "?";
    if (!m[k]) m[k] = { n: 0, pnl: 0 };
    m[k].n++;
    m[k].pnl += t.pnl || 0;
  }
  return Object.entries(m).map(([k, v]) => ({
    signal: k,
    trades: v.n,
    pnl: +v.pnl.toFixed(2),
  }));
}

function printCompare(local, remote) {
  const rows = [
    ["Total PnL", local.totalPnl, remote.totalPnl],
    ["Closed trades", local.closedTrades, remote.closedTrades],
    ["Win rate %", local.winRatePct, remote.winRatePct],
    ["SFP bull trades", local.sfpBull, remote.sfpBull],
    ["SFP bear trades", local.sfpBear, remote.sfpBear],
    ["Regime skips", local.regimeSkips, remote.regimeSkips],
    ["Regime skip bull", local.regimeSkipsBull, remote.regimeSkipsBull],
    ["Regime skip bear", local.regimeSkipsBear, remote.regimeSkipsBear],
    ["Other skips", local.skippedOpen, remote.skippedOpen],
    ["Days", local.days, remote.days],
    ["Symbols", local.symbols, remote.symbols],
    ["Regime ON", local.regime, remote.regime],
    ["Bull / bear th", `${local.bullTh}/${local.bearTh}`, `${remote.bullTh}/${remote.bearTh}`],
    ["BTC hours", local.btcHours, remote.btcHours],
    ["Scanner L/A/T", local.scanner, remote.scanner],
    ["Elapsed sec", local.elapsedSec, remote.elapsedSec],
  ];

  console.log("\n=== LOCAL vs RAILWAY ===\n");
  console.log(
    `${"Metric".padEnd(22)} ${"Local".padStart(12)} ${"Railway".padStart(12)} ${"Δ".padStart(10)}`
  );
  console.log("-".repeat(58));
  for (const [label, l, r] of rows) {
    const ln = typeof l === "number";
    const rn = typeof r === "number";
    const delta =
      ln && rn ? (+(r - l).toFixed(2) >= 0 ? "+" : "") + (r - l).toFixed(2) : "—";
    console.log(
      `${label.padEnd(22)} ${String(l).padStart(12)} ${String(r).padStart(12)} ${String(delta).padStart(10)}`
    );
  }

  const localTrades = loadLastBacktestResult()?.closedTrades ?? [];
  const remoteTrades = remote._trades ?? [];
  if (localTrades.length && remoteTrades.length) {
    console.log("\n=== PnL by signal ===\n");
    const lm = bySignal(localTrades);
    const rm = bySignal(remoteTrades);
    const keys = [...new Set([...lm.map((x) => x.signal), ...rm.map((x) => x.signal)])];
    for (const k of keys) {
      const l = lm.find((x) => x.signal === k);
      const r = rm.find((x) => x.signal === k);
      console.log(
        `${k.padEnd(10)} local $${(l?.pnl ?? 0).toFixed(2).padStart(8)} (${l?.trades ?? 0} tr) · railway $${(r?.pnl ?? 0).toFixed(2).padStart(8)} (${r?.trades ?? 0} tr)`
      );
    }
  }

  const pnlDelta = remote.totalPnl - local.totalPnl;
  console.log("\n=== Verdict ===");
  if (Math.abs(pnlDelta) < 1) {
    console.log("PnL match within $1 — configs and data align closely.");
  } else if (pnlDelta < -50) {
    console.log(
      `Railway underperforms by $${Math.abs(pnlDelta).toFixed(2)} — check kline cache vs live fetch, model file, or scanner drift.`
    );
  } else if (pnlDelta > 50) {
    console.log(`Railway outperforms local by $${pnlDelta.toFixed(2)}.`);
  } else {
    console.log(`PnL delta $${pnlDelta.toFixed(2)} — minor drift (data window or cache).`);
  }
}

async function pollBacktest(baseUrl, cookie, maxWaitMs = 90 * 60_000) {
  const started = Date.now();
  let lastMsg = "";
  while (Date.now() - started < maxWaitMs) {
    const st = await api(baseUrl, cookie, "GET", "/api/paper-bot/backtest");
    if (st.error) throw new Error(st.error);
    const p = st.progress ?? {};
    const msg = `${p.phase || "?"} ${p.done ?? 0}/${p.total ?? "?"} ${p.symbol || ""} ${p.message || ""}`;
    if (msg !== lastMsg) {
      console.error(`[railway] ${msg.trim()}`);
      lastMsg = msg;
    }
    if (!st.running) {
      const result = st.result || st.last;
      if (!result?.summary) {
        throw new Error("Backtest finished without result — check Railway logs");
      }
      return result;
    }
    await sleep(15_000);
  }
  throw new Error("Backtest timed out waiting for Railway");
}

async function main() {
  const { days, start } = parseArgs(process.argv);
  const baseUrl = (
    process.env.RAILWAY_URL ||
    process.env.VOL_RAILWAY_URL ||
    "https://vol-production-d574.up.railway.app"
  )
    .trim()
    .replace(/\/$/, "");
  const cookie = readCookie();

  const me = await requestJson(baseUrl, "GET", "/api/auth/me", null, cookie);
  if (me.status === 401 || me.json?.authenticated === false) {
    throw new Error(
      "Session expired — log into the dashboard, copy vol_session to scripts/.vol-railway-cookie"
    );
  }

  const localRaw = loadLastBacktestResult();
  if (!localRaw?.summary) {
    throw new Error("No local backtest — run: node scripts/run-cached-train-backtest.js --days 10 --regime-on");
  }
  const local = pickSummary(localRaw);
  console.log(`Local best run: $${local.totalPnl} · ${local.closedTrades} trades · regime ${local.regime ? "ON" : "OFF"}`);

  let remoteRaw;
  if (start) {
    console.log(`\nStarting Railway backtest: ${days}d · all symbols…`);
    await api(baseUrl, cookie, "POST", "/api/paper-bot/backtest/start", { days });
    remoteRaw = await pollBacktest(baseUrl, cookie);
    writeJsonSafe(dataPath("railway-backtest-last.json"), remoteRaw);
  } else {
    const st = await api(baseUrl, cookie, "GET", "/api/paper-bot/backtest");
    remoteRaw = st.result || st.last;
    if (!remoteRaw?.summary) throw new Error("No Railway backtest result");
  }

  const remote = pickSummary(remoteRaw);
  remote._trades = remoteRaw.closedTrades ?? [];
  console.log(`\nRailway run: $${remote.totalPnl} · ${remote.closedTrades} trades · finished ${remote.finishedAt || "?"}`);
  printCompare(local, remote);
}

function writeJsonSafe(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
