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
const {
  createConfig,
  analyzeVolSpike,
  parseAtTime,
  barsAtTime,
} = require("../lib/signal-metrics");
const { renderSymbolChart } = require("../lib/chart-render");
const { dataPath, migrateLegacyCache } = require("../lib/data-dir");

const ROOT = path.join(__dirname, "..");
migrateLegacyCache();
const CACHE_DIR = dataPath("klines");
const CACHE_RE =
  /^(.+)_(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)(?:_(\d+))?\.json$/;

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
        limit: m[3] ? Number(m[3]) : null,
      };
    });
}

function readCache(entry) {
  const data = JSON.parse(fs.readFileSync(entry.path, "utf8"));
  return {
    ...entry,
    savedAt: data.savedAt,
    interval: data.interval ?? entry.interval,
    limit: data.evalLimit ?? data.limit ?? entry.limit,
    bars: data.bars ?? [],
  };
}

function statusLabel(analysis) {
  if (!analysis.metrics) return "INSUFFICIENT DATA";
  return analysis.passes ? "SIGNAL ✓" : "no signal";
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

    let bars = cache.bars;
    const atParam = kv.get("at");
    let evaluateBarAt = bars.length ? bars[bars.length - 1].closeTime : null;
    if (atParam) {
      const atMs = parseAtTime(atParam);
      bars = barsAtTime(cache.bars, atMs);
      if (!bars.length) {
        skipped++;
        continue;
      }
      evaluateBarAt = bars[bars.length - 1].closeTime;
    }

    const analysis = analyzeVolSpike(bars, cfg);
    if (flags.has("signals-only") && !analysis.passes) {
      skipped++;
      continue;
    }

    const { file } = await renderSymbolChart(cache.symbol, bars, cfg, analysis, {
      evaluateBarAt,
      windowBars: opts.windowBars,
      width: opts.width,
      height: opts.height,
      chartsDir: opts.outDir,
    });
    const outPath = path.join(opts.outDir, file);

    gallery.push({
      symbol: cache.symbol,
      file,
      status: statusLabel(analysis),
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
