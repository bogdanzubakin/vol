const http = require("http");
const fs = require("fs");
const path = require("path");

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

function startDashboard(getState, options = {}) {
  const port = options.port ?? 3877;
  const host = options.host ?? "0.0.0.0";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}`);

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

    if (url.pathname.startsWith("/charts/")) {
      const chartPath = path.join(
        __dirname,
        "..",
        "charts",
        path.basename(url.pathname)
      );
      if (!chartPath.startsWith(path.join(__dirname, "..", "charts"))) {
        res.writeHead(403).end();
        return;
      }
      try {
        const data = fs.readFileSync(chartPath);
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(data);
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

  server.listen(port, host, () => {
    console.error(`Dashboard: http://${host}:${port}/`);
  });

  return server;
}

function writeResultsJson(state) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(state, null, 2));
}

function createDashboardPublisher(cfg) {
  const events = [];
  let meta = {
    symbolCount: 0,
    prefetching: false,
    interval: cfg.interval,
    corridorDays: cfg.corridorDays,
    signalCandles: cfg.signalCandles,
  };

  function pushEvent(type, symbol, detail = "") {
    events.unshift({
      at: new Date().toISOString(),
      type,
      symbol,
      detail,
    });
    if (events.length > 200) events.length = 200;
  }

  function setMeta(partial) {
    meta = { ...meta, ...partial };
  }

  function buildState(activeHits) {
    const hits = [...activeHits.entries()]
      .map(([symbol, m]) => ({ symbol, ...m }))
      .sort((a, b) => b.rangeRatio - a.rangeRatio);

    return {
      updatedAt: new Date().toISOString(),
      ...meta,
      activeCount: hits.length,
      hits,
      events: events.slice(0, 50),
    };
  }

  function publish(activeHits, force = false) {
    const state = buildState(activeHits);
    writeResultsJson(state);
    return state;
  }

  return { pushEvent, setMeta, publish, buildState };
}

module.exports = { startDashboard, createDashboardPublisher, RESULTS_JSON };
