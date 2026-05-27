const http = require("http");
const fs = require("fs");
const path = require("path");
const { pickLiveConfig } = require("./signal-metrics");
const { nowIsoUtcPlus3, formatIsoUtcPlus3 } = require("./time-format");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const RESULTS_JSON = path.join(PUBLIC_DIR, "results.json");

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
    getTopMovers,
    getWsDiagnostics,
    getChartData,
    postTelegramSignal,
  } = options;

  const server = http.createServer(async (req, res) => {
    const reqHost = req.headers.host || `127.0.0.1:${port}`;
    const url = new URL(req.url, `http://${reqHost}`);

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

    if (url.pathname === "/api/ws-diagnostics") {
      if (!getWsDiagnostics) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "WebSocket diagnostics require the live scanner",
          })
        );
        return;
      }
      try {
        const body = JSON.stringify(getWsDiagnostics());
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

    const telegramSignalMatch = url.pathname.match(
      /^\/api\/telegram-signal\/([A-Za-z0-9]+)$/
    );
    if (telegramSignalMatch && req.method === "POST") {
      if (!postTelegramSignal) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Telegram send requires the live scanner",
          })
        );
        return;
      }
      try {
        const symbol = telegramSignalMatch[1].toUpperCase();
        const result = await postTelegramSignal(symbol, url.searchParams);
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

  function buildState(
    activeHits,
    nearBreakHits = new Map(),
    signalHistory = new Map()
  ) {
    pruneSignalHistory(signalHistory);

    const hits = [...signalHistory.entries()]
      .map(([symbol, rec]) => {
        const live = activeHits.get(symbol);
        const triggeredAt = rec.triggeredAt ?? live?.triggeredAt;
        return {
          symbol,
          ...rec,
          ...(live ?? {}),
          triggeredAt,
          triggeredAtIso: formatIsoUtcPlus3(triggeredAt),
          signalStatus: live ? "active" : "ended",
        };
      })
      .sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0));

    const nearHits = [...nearBreakHits.entries()]
      .map(([symbol, m]) => ({ symbol, signalStatus: "near", ...m }))
      .sort((a, b) => a.breakGapPct - b.breakGapPct);

    return {
      updatedAt: nowIsoUtcPlus3(),
      ...meta,
      activeCount: activeHits.size,
      signalHistoryCount: hits.length,
      nearBreakCount: nearHits.length,
      hits,
      nearBreakHits: nearHits,
      events: events.slice(0, 50),
    };
  }

  function publish(activeHits, nearBreakHits, signalHistory, force = false) {
    const state = buildState(activeHits, nearBreakHits, signalHistory);
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
