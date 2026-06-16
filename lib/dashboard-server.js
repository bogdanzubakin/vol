const http = require("http");
const fs = require("fs");
const path = require("path");
const { pickLiveConfig } = require("./signal-metrics");
const { nowIsoUtcPlus3, formatIsoUtcPlus3 } = require("./time-format");
const {
  dataPath,
  resolveDataDir,
  getStorageInfo,
  cleanStorage,
} = require("./data-dir");
const uiSettings = require("./ui-settings");
const {
  readTradeSnapshot,
  sanitizeSnapshotId,
} = require("./paper-bot-snapshot");
const {
  buildBacktestExport,
  exportFilename,
} = require("./backtest-export");
const { loadLastBacktestResult } = require("./paper-bot-backtest");
const { worstPairsFromPerSymbol } = require("./bot-symbol-blocklist");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const RESULTS_JSON = dataPath("results.json");

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readDashboardHtml() {
  const file = path.join(PUBLIC_DIR, "index.html");
  return fs.readFileSync(file, "utf8");
}

function resolveListenOptions(options = {}) {
  const port = Number(process.env.PORT || options.port || 3877);
  const host = process.env.PORT
    ? "0.0.0.0"
    : options.host || process.env.HOST || "127.0.0.1";
  return { port, host };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function startDashboard(getState, options = {}) {
  const { port, host } = resolveListenOptions(options);
  const {
    onConfigUpdate,
    getPairs,
    getFastMovers,
    getSweepReclaim,
    getPullback,
    getStrategies,
    getTopMovers,
    getChartData,
    getPositions,
    getFuturesBalance,
    getPositionsHistory,
    updatePositionsHistoryComment,
    getPaperBot,
    patchPaperBotConfig,
    resetPaperBot,
    getLiveBot,
    patchLiveBotConfig,
    armLiveBot,
    disarmLiveBot,
    closeLiveBotSymbol,
    closeAllLiveBot,
    syncLiveBot,
    resetLiveBotHistory,
    generatePaperBotOpenSnapshot,
    generateLiveBotOpenSnapshot,
    getBacktestStatus,
    startBacktest,
    stopAndResetBacktest,
    onStorageClean,
    auth,
  } = options;

  const server = http.createServer(async (req, res) => {
    const reqHost = req.headers.host || `127.0.0.1:${port}`;
    const url = new URL(req.url, `http://${reqHost}`);

    if (auth?.handleAuthRoutes(req, res, url)) return;

    if (url.pathname.startsWith("/api/") && auth && !auth.requireAuth(req, res)) {
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      if (!onConfigUpdate) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Config updates require the live scanner (not static results.json mode)",
          })
        );
        return;
      }
      try {
        const patch = await readJsonBody(req);
        const result = await onConfigUpdate(patch);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/pairs") {
      if (!getPairs) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Pair list requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getPairs(url.searchParams));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/fast-movers") {
      if (!getFastMovers) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Fast movers list requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getFastMovers(url.searchParams));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/sweep-reclaim") {
      if (!getSweepReclaim) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Sweep-reclaim list requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getSweepReclaim(url.searchParams));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/pullback") {
      if (!getPullback) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Pullback list requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getPullback(url.searchParams));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/strategies") {
      if (!getStrategies) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Strategy monitor requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getStrategies(url.searchParams));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/top-movers") {
      if (!getTopMovers) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Top movers list requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getTopMovers(url.searchParams));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    const chartDataMatch = url.pathname.match(/^\/api\/chart-data\/([A-Za-z0-9]+)$/);
    if (chartDataMatch && req.method === "GET") {
      if (!getChartData) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Chart data requires the live scanner",
          })
        );
        return;
      }
      try {
        const symbol = chartDataMatch[1].toUpperCase();
        const payload = getChartData(symbol, url.searchParams);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/positions") {
      if (!getPositions) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            enabled: false,
            positions: [],
            hint: "Positions require the live scanner with Binance API keys",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(await getPositions());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/storage-info" && req.method === "GET") {
      try {
        const body = JSON.stringify(getStorageInfo());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/storage-clean" && req.method === "POST") {
      try {
        if (onStorageClean) {
          await Promise.resolve(onStorageClean());
        }
        const result = cleanStorage();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/ui-settings" && req.method === "GET") {
      try {
        const body = JSON.stringify({ settings: uiSettings.getAll() });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/ui-settings" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const patch = body?.patch ?? body?.settings ?? body;
        const settings = uiSettings.patch(patch);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, settings }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/paper-bot" && req.method === "GET") {
      if (!getPaperBot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Paper bot requires the live scanner (not static results.json mode)",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getPaperBot());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (
      url.pathname === "/api/paper-bot/snapshot/generate" &&
      req.method === "POST"
    ) {
      if (!generatePaperBotOpenSnapshot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Paper bot requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = await readJsonBody(req);
        const id = body?.id ?? body?.positionId;
        if (!id) throw new Error("position id required");
        const result = await generatePaperBotOpenSnapshot(String(id));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/paper-bot/config" && req.method === "POST") {
      if (!patchPaperBotConfig) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Paper bot requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = await readJsonBody(req);
        const patch = body?.patch ?? body?.config ?? body;
        const result = patchPaperBotConfig(patch);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    const backtestSnapshotMatch = url.pathname.match(
      /^\/api\/paper-bot\/backtest\/snapshot\/([a-zA-Z0-9._-]+)$/
    );
    if (backtestSnapshotMatch && req.method === "GET") {
      try {
        const snapshotId = sanitizeSnapshotId(backtestSnapshotMatch[1]);
        const png = readTradeSnapshot(snapshotId, "backtest");
        if (!png) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Snapshot not found" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(png);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    const paperBotSnapshotMatch = url.pathname.match(
      /^\/api\/paper-bot\/snapshot\/([a-zA-Z0-9._-]+)$/
    );
    if (paperBotSnapshotMatch && req.method === "GET") {
      try {
        const snapshotId = sanitizeSnapshotId(paperBotSnapshotMatch[1]);
        const png = readTradeSnapshot(snapshotId);
        if (!png) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Snapshot not found" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        res.end(png);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/paper-bot/reset" && req.method === "POST") {
      if (!resetPaperBot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Paper bot requires the live scanner",
          })
        );
        return;
      }
      try {
        const result = resetPaperBot();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/live-bot" && req.method === "GET") {
      if (!getLiveBot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const result = await getLiveBot();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (
      url.pathname === "/api/live-bot/snapshot/generate" &&
      req.method === "POST"
    ) {
      if (!generateLiveBotOpenSnapshot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Live bot requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = await readJsonBody(req);
        const id = body?.id ?? body?.positionId;
        if (!id) throw new Error("position id required");
        const result = await generateLiveBotOpenSnapshot(String(id));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/live-bot/config" && req.method === "POST") {
      if (!patchLiveBotConfig) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const body = await readJsonBody(req);
        const patch = body?.patch ?? body?.config ?? body;
        const result = await patchLiveBotConfig(patch);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/live-bot/arm" && req.method === "POST") {
      if (!armLiveBot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const body = await readJsonBody(req);
        if (body?.confirm !== "ARM") {
          throw new Error('Send { "confirm": "ARM" } to arm live trading');
        }
        const result = await armLiveBot();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/live-bot/disarm" && req.method === "POST") {
      if (!disarmLiveBot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const result = await disarmLiveBot();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/live-bot/sync" && req.method === "POST") {
      if (!syncLiveBot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const result = await syncLiveBot();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/live-bot/reset-history" && req.method === "POST") {
      if (!resetLiveBotHistory) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const result = await resetLiveBotHistory();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/live-bot/close-all" && req.method === "POST") {
      if (!closeAllLiveBot) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const result = await closeAllLiveBot();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    const liveCloseMatch = url.pathname.match(
      /^\/api\/live-bot\/close\/([A-Z0-9]+)$/
    );
    if (liveCloseMatch && req.method === "POST") {
      if (!closeLiveBotSymbol) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Live bot requires the live scanner" }));
        return;
      }
      try {
        const result = await closeLiveBotSymbol(liveCloseMatch[1]);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/paper-bot/backtest" && req.method === "GET") {
      if (!getBacktestStatus) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Backtest requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getBacktestStatus());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (
      url.pathname === "/api/paper-bot/backtest/worst-pairs" &&
      req.method === "GET"
    ) {
      try {
        const result = loadLastBacktestResult();
        if (!result?.perSymbol?.length) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "No train bot results — run a backtest first",
            })
          );
          return;
        }
        const count = Math.max(1, Math.min(200, Number(url.searchParams.get("count")) || 20));
        const minTrades = Math.max(
          1,
          Math.min(50, Number(url.searchParams.get("minTrades")) || 3)
        );
        const rows = worstPairsFromPerSymbol(result.perSymbol, { count, minTrades });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(
          JSON.stringify({
            ok: true,
            count: rows.length,
            symbols: rows.map((r) => r.symbol),
            rows,
            sourceFinishedAt: result.finishedAt ?? null,
            minTrades,
          })
        );
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (
      url.pathname === "/api/paper-bot/backtest/export" &&
      req.method === "GET"
    ) {
      if (!getBacktestStatus) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Backtest requires the live scanner",
          })
        );
        return;
      }
      try {
        const flagOff = (name) => {
          const v = url.searchParams.get(name);
          return v === "0" || v === "false";
        };
        const bundle = buildBacktestExport({
          includeSourceCode: !flagOff("includeSource"),
          includeEvents: !flagOff("includeEvents"),
          includeEquityCurve: !flagOff("includeEquityCurve"),
        });
        const json = JSON.stringify(bundle, null, 2);
        const filename = exportFilename();
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        });
        res.end(json);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (
      url.pathname === "/api/paper-bot/backtest/reset" &&
      req.method === "POST"
    ) {
      if (!stopAndResetBacktest) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Backtest requires the live scanner",
          })
        );
        return;
      }
      try {
        const result = stopAndResetBacktest();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/paper-bot/backtest/start" && req.method === "POST") {
      if (!startBacktest) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Backtest requires the live scanner",
          })
        );
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await startBacktest(body);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/futures-balance") {
      if (!getFuturesBalance) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            enabled: false,
            usdtBalance: null,
            hint: "Futures balance requires the live scanner with Binance API keys",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(await getFuturesBalance());
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/positions-history" && req.method === "GET") {
      if (!getPositionsHistory) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            enabled: false,
            items: [],
            hint: "Position history requires the live scanner with Binance API keys",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(await getPositionsHistory(url.searchParams));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/positions-history/comment" && req.method === "POST") {
      if (!updatePositionsHistoryComment) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Position history comments require the live scanner",
          })
        );
        return;
      }
      try {
        const body = await readJsonBody(req);
        const result = await updatePositionsHistoryComment(body);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message || String(e) }));
      }
      return;
    }

    if (url.pathname === "/api/state") {
      const body = JSON.stringify(getState());
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    if (url.pathname === "/results.json") {
      try {
        const raw = fs.readFileSync(RESULTS_JSON, "utf8");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(raw);
        return;
      } catch {
        res.writeHead(404).end();
        return;
      }
    }

    if (url.pathname === "/report" || url.pathname === "/charts/index.html") {
      const reportPath = path.join(__dirname, "..", "charts", "index.html");
      try {
        const html = fs.readFileSync(reportPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end(
          "Report not found. Run: npm run visualize (generates charts/index.html)"
        );
        return;
      }
    }

    if (url.pathname.startsWith("/charts/")) {
      const chartsDir = path.join(__dirname, "..", "charts");
      const chartPath = path.join(chartsDir, path.basename(url.pathname));
      if (!chartPath.startsWith(chartsDir + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      try {
        const data = fs.readFileSync(chartPath);
        const ext = path.extname(chartPath).toLowerCase();
        const type =
          ext === ".html"
            ? "text/html; charset=utf-8"
            : ext === ".png"
              ? "image/png"
              : "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        res.end(data);
        return;
      } catch {
        res.writeHead(404).end();
        return;
      }
    }

    if (url.pathname === "/time-format.js") {
      try {
        const js = fs.readFileSync(
          path.join(PUBLIC_DIR, "time-format.js"),
          "utf8"
        );
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(js);
        return;
      } catch {
        res.writeHead(404).end();
        return;
      }
    }

    if (url.pathname === "/chart-display.js") {
      try {
        const js = fs.readFileSync(
          path.join(PUBLIC_DIR, "chart-display.js"),
          "utf8"
        );
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(js);
        return;
      } catch {
        res.writeHead(404).end();
        return;
      }
    }

    if (url.pathname === "/favicon.svg") {
      try {
        const svg = fs.readFileSync(path.join(PUBLIC_DIR, "favicon.svg"), "utf8");
        res.writeHead(200, {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(svg);
        return;
      } catch {
        res.writeHead(404).end();
        return;
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      try {
        const html = readDashboardHtml();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Missing public/index.html: ${e.message}`);
        return;
      }
    }

    res.writeHead(404).end("Not found");
  });

  server.on("error", (err) => {
    console.error(`HTTP server error (${host}:${port}):`, err.message);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.error(`Dashboard: http://${host}:${port}/`);
    console.error(`Persistent data: ${resolveDataDir()}`);
    auth?.startPoller?.();
  });

  return server;
}

function writeResultsJson(state) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(state, null, 2));
}

function createDashboardPublisher(cfg, options = {}) {
  const events = [];
  let meta = {
    symbolCount: 0,
    prefetching: false,
    prefetchStatus: null,
    configWritable: Boolean(options.configWritable),
    ...pickLiveConfig(cfg),
  };

  function syncConfigFromCfg() {
    meta = { ...meta, ...pickLiveConfig(cfg) };
  }

  function pushEvent(type, symbol, detail = "") {
    events.unshift({
      at: nowIsoUtcPlus3(),
      type,
      symbol,
      detail,
    });
    if (events.length > 200) events.length = 200;
  }

  function setMeta(partial) {
    meta = { ...meta, ...partial };
  }

  const SIGNAL_RETENTION_MS = 24 * 60 * 60 * 1000;

  function pruneSignalHistory(signalHistory) {
    const cutoff = Date.now() - SIGNAL_RETENTION_MS;
    for (const [sym, rec] of signalHistory) {
      if ((rec.triggeredAt ?? 0) < cutoff) signalHistory.delete(sym);
    }
  }

  function buildSignalHistoryHits(signalHistory, activeHits, signalKind) {
    return [...signalHistory.entries()].map(([symbol, rec]) => {
      const live = activeHits.get(symbol);
      const triggeredAt = rec.triggeredAt ?? live?.triggeredAt;
      return {
        symbol,
        ...rec,
        ...(live ?? {}),
        signalKind,
        triggeredAt,
        triggeredAtIso: formatIsoUtcPlus3(triggeredAt),
        signalStatus: live ? "active" : "ended",
      };
    });
  }

  function buildState(
    sfpActive = new Map(),
    sfpHistory = new Map(),
    pbActive = new Map(),
    pbHistory = new Map()
  ) {
    pruneSignalHistory(sfpHistory);
    pruneSignalHistory(pbHistory);

    const sfpHits = buildSignalHistoryHits(sfpHistory, sfpActive, "sfp");
    const pbHits = buildSignalHistoryHits(pbHistory, pbActive, "pullback");
    const hits = [...sfpHits, ...pbHits].sort(
      (a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0)
    );

    return {
      updatedAt: nowIsoUtcPlus3(),
      ...meta,
      activeCount: sfpActive.size + pbActive.size,
      sfpActiveCount: sfpActive.size,
      pullbackActiveCount: pbActive.size,
      signalHistoryCount: hits.length,
      hits,
      events: events.slice(0, 50),
    };
  }

  function publish(
    sfpActive,
    sfpHistory,
    pbActive,
    pbHistory,
    force = false
  ) {
    const state = buildState(sfpActive, sfpHistory, pbActive, pbHistory);
    writeResultsJson(state);
    return state;
  }

  return { pushEvent, setMeta, publish, buildState, syncConfigFromCfg };
}

module.exports = {
  startDashboard,
  createDashboardPublisher,
  resolveListenOptions,
  RESULTS_JSON,
};
