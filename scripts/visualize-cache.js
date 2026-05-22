/**
 * Generate PNG charts from .cache/klines JSON files.
 *
 * npm run visualize
 * npm run visualize -- --symbols VICUSDT,BTCUSDT
 * npm run visualize -- --signals-only --limit 20
 * npm run visualize -- --window 320 --out charts
 */

const fs = require("fs");
const path = require("path");
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");
const annotationPlugin = require("chartjs-plugin-annotation");
const { createConfig, volSpikeMetrics, candleRangePct } = require("../lib/signal-metrics");

const ROOT = path.join(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".cache", "klines");
const CACHE_RE = /^(.+)_(1m|15m|5m|1h|4h|1d)_(\d+)\.json$/;

const DEFAULTS = {
  outDir: path.join(ROOT, "charts"),
  windowBars: 280,
  width: 1400,
  height: 820,
  limit: 0,
};

function parseArgs(argv) {
  const flags = new Set();
  const kv = new Map();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) kv.set(k, v);
      else flags.add(k);
    }
  }
  return { flags, kv };
}

function listCacheEntries() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  return fs
    .readdirSync(CACHE_DIR)
    .filter((f) => CACHE_RE.test(f))
    .map((file) => {
      const m = CACHE_RE.exec(file);
      return {
        file,
        path: path.join(CACHE_DIR, file),
        symbol: m[1],
        interval: m[2],
        limit: Number(m[3]),
      };
    });
}

function readCache(entry) {
  const data = JSON.parse(fs.readFileSync(entry.path, "utf8"));
  return {
    ...entry,
    savedAt: data.savedAt,
    interval: data.interval ?? entry.interval,
    limit: data.limit ?? entry.limit,
    bars: data.bars ?? [],
  };
}

function formatTime(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function sliceWindow(bars, corridorBars, signalCandles, windowBars) {
  const need = corridorBars + signalCandles;
  const tail = bars.slice(-Math.max(need, windowBars));
  const corridorStart = Math.max(0, tail.length - need);
  return { tail, corridorStart, signalStart: tail.length - signalCandles };
}

function statusLabel(m) {
  if (!m) return "INSUFFICIENT DATA";
  return m.passes ? "SIGNAL ✓" : "no signal";
}

function buildChartConfig(symbol, slice, meta, m, cfg) {
  const labels = slice.tail.map((b) => formatTime(b.openTime));
  const closes = slice.tail.map((b) => b.close);
  const ranges = slice.tail.map((b) => candleRangePct(b));
  const n = slice.tail.length;

  const closeColors = slice.tail.map((_, i) => {
    if (i >= slice.signalStart) {
      return slice.tail[i].close >= slice.tail[i].open ? "#22c55e" : "#ef4444";
    }
    return "#64748b";
  });

  const rangeColors = slice.tail.map((_, i) => {
    if (i >= slice.signalStart) return "rgba(34,197,94,0.85)";
    if (i >= slice.corridorStart) return "rgba(56,189,248,0.35)";
    return "rgba(100,116,139,0.25)";
  });

  const corridorHigh = m?.corridorHigh ?? Math.max(...closes);
  const corridorLow = m?.corridorLow ?? Math.min(...closes);

  const title = [
    `${symbol} ${cfg.interval}`,
    statusLabel(m),
    m
      ? `corridor ${corridorLow.toFixed(4)} – ${corridorHigh.toFixed(4)} (${m.corridorWidthPct}% wide)`
      : "",
    m ? `range×${m.rangeRatio} vol↑ ${m.volIncreasing ? "Y" : "N"} break ${m.breaksCorridor ? "Y" : "N"}` : "",
  ]
    .filter(Boolean)
    .join("  |  ");

  return {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "line",
          label: "Close",
          data: closes,
          yAxisID: "yPrice",
          borderColor: "#e2e8f0",
          backgroundColor: closeColors,
          pointBackgroundColor: closeColors,
          pointRadius: slice.tail.map((_, i) => (i >= slice.signalStart ? 5 : 0)),
          pointHoverRadius: 6,
          borderWidth: 1.5,
          tension: 0.05,
          order: 1,
        },
        {
          type: "bar",
          label: "Range %",
          data: ranges,
          yAxisID: "yRange",
          backgroundColor: rangeColors,
          borderWidth: 0,
          order: 2,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: {
          labels: { color: "#cbd5e1" },
        },
        title: {
          display: true,
          text: title,
          color: "#f8fafc",
          font: { size: 14 },
        },
        annotation: {
          annotations: {
            corridorBox: {
              type: "box",
              xMin: slice.corridorStart - 0.5,
              xMax: slice.signalStart - 0.5,
              yMin: corridorLow,
              yMax: corridorHigh,
              yScaleID: "yPrice",
              backgroundColor: "rgba(56,189,248,0.08)",
              borderColor: "rgba(56,189,248,0.45)",
              borderWidth: 1,
            },
            corridorHighLine: {
              type: "line",
              yMin: corridorHigh,
              yMax: corridorHigh,
              yScaleID: "yPrice",
              borderColor: "#38bdf8",
              borderWidth: 2,
              borderDash: [6, 4],
              label: {
                display: true,
                content: `2d high ${corridorHigh.toFixed(6)}`,
                color: "#7dd3fc",
                backgroundColor: "rgba(15,23,42,0.8)",
              },
            },
            corridorLowLine: {
              type: "line",
              yMin: corridorLow,
              yMax: corridorLow,
              yScaleID: "yPrice",
              borderColor: "#475569",
              borderWidth: 1,
              borderDash: [4, 4],
            },
            signalRegion: {
              type: "box",
              xMin: slice.signalStart - 0.5,
              xMax: n - 0.5,
              backgroundColor: "rgba(34,197,94,0.1)",
              borderColor: "rgba(34,197,94,0.6)",
              borderWidth: 1,
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#94a3b8",
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
          },
          grid: { color: "rgba(51,65,85,0.35)" },
        },
        yPrice: {
          type: "linear",
          position: "left",
          ticks: { color: "#94a3b8" },
          grid: { color: "rgba(51,65,85,0.35)" },
        },
        yRange: {
          type: "linear",
          position: "right",
          ticks: { color: "#94a3b8" },
          grid: { drawOnChartArea: false },
          title: { display: true, text: "Range %", color: "#94a3b8" },
        },
      },
    },
  };
}

function writeGallery(outDir, items) {
  const rows = items
    .map(
      (it) =>
        `<a href="${it.file}"><figure><img src="${it.file}" width="480" loading="lazy" /><figcaption>${it.symbol} — ${it.status}</figcaption></figure></a>`
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Volatility cache charts</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 24px; }
    h1 { font-size: 1.25rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(500px, 1fr)); gap: 20px; }
    a { color: inherit; text-decoration: none; }
    figure { margin: 0; background: #1e293b; border-radius: 8px; overflow: hidden; }
    img { display: block; width: 100%; height: auto; }
    figcaption { padding: 10px 12px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Volatility cache charts (${items.length})</h1>
  <div class="grid">${rows}</div>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, "index.html"), html);
}

async function main() {
  const { flags, kv } = parseArgs(process.argv);
  const opts = {
    ...DEFAULTS,
    outDir: kv.get("out") ? path.resolve(kv.get("out")) : DEFAULTS.outDir,
    windowBars: Number(kv.get("window")) || DEFAULTS.windowBars,
    width: Number(kv.get("width")) || DEFAULTS.width,
    height: Number(kv.get("height")) || DEFAULTS.height,
    limit: Number(kv.get("limit")) || 0,
  };

  let entries = listCacheEntries();
  if (!entries.length) {
    console.error(`No cache files in ${CACHE_DIR}. Run: node index.js --all`);
    process.exit(1);
  }

  const symFilter = kv.get("symbols");
  if (symFilter) {
    const want = new Set(
      symFilter.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    );
    entries = entries.filter((e) => want.has(e.symbol));
  }

  const renderer = new ChartJSNodeCanvas({
    width: opts.width,
    height: opts.height,
    backgroundColour: "#0f172a",
    plugins: { modern: [annotationPlugin] },
  });

  const gallery = [];
  let done = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (opts.limit > 0 && done >= opts.limit) break;

    const cache = readCache(entry);
    if (!cache.bars.length) {
      skipped++;
      continue;
    }

    const cfg = createConfig({
      interval: cache.interval,
      corridorDays: Number(kv.get("corridor-days")) || 2,
      signalCandles: Number(kv.get("signal-candles")) || 3,
    });

    const m = volSpikeMetrics(cache.bars, cfg);
    if (flags.has("signals-only") && !m?.passes) {
      skipped++;
      continue;
    }

    const slice = sliceWindow(
      cache.bars,
      cfg.corridorBars,
      cfg.signalCandles,
      opts.windowBars
    );

    const chartConfig = buildChartConfig(cache.symbol, slice, cache, m, cfg);
    const outFile = `${cache.symbol}_${cache.interval}.png`;
    const outPath = path.join(opts.outDir, outFile);

    const buffer = await renderer.renderToBuffer(chartConfig, "image/png");
    fs.mkdirSync(opts.outDir, { recursive: true });
    fs.writeFileSync(outPath, buffer);

    gallery.push({
      symbol: cache.symbol,
      file: outFile,
      status: statusLabel(m),
    });
    done++;
    console.error(`Wrote ${outPath}`);
  }

  writeGallery(opts.outDir, gallery);
  console.error(
    `Done: ${done} chart(s) in ${opts.outDir} (skipped ${skipped}). Open ${path.join(opts.outDir, "index.html")}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
