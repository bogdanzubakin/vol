const path = require("path");
const { candleRangePct } = require("./signal-metrics");
const { applyChartDisplay } = require("../public/chart-display");

const DEFAULTS = {
  width: 2100,
  height: 900,
  windowBars: 280,
  chartsDir: path.join(__dirname, "..", "charts"),
};

let renderer = null;

function getRenderer(opts = {}) {
  if (renderer) return renderer;
  const { ChartJSNodeCanvas } = require("chartjs-node-canvas");
  const annotationPlugin = require("chartjs-plugin-annotation");
  renderer = new ChartJSNodeCanvas({
    width: opts.width ?? DEFAULTS.width,
    height: opts.height ?? DEFAULTS.height,
    backgroundColour: "#0f172a",
    plugins: { modern: [annotationPlugin] },
  });
  return renderer;
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

function checksSummaryLines(checks) {
  return checks.map(
    (c) =>
      `${c.pass ? "✓" : "✗"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`
  );
}

/** Tight Y bounds so price movement fills the corridor pane. */
function priceYBounds(slice, corridorLow, corridorHigh) {
  const lows = slice.tail.map((b) => b.low);
  const highs = slice.tail.map((b) => b.high);
  const yMin = Math.min(...lows, corridorLow);
  const yMax = Math.max(...highs, corridorHigh);
  const span = yMax - yMin || Math.max(Math.abs(yMax) * 0.001, 1e-8);
  const pad = span * 0.22;
  return { min: yMin - pad, max: yMax + pad };
}

function buildChartConfig(symbol, slice, analysis, cfg) {
  const m = analysis.metrics;
  const checks = analysis.checks ?? [];
  const passes = analysis.passes;
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
    if (i >= slice.signalStart) {
      const ok = m?.volSpike && m?.volIncreasing;
      return ok ? "rgba(34,197,94,0.85)" : "rgba(239,68,68,0.75)";
    }
    if (i >= slice.corridorStart) return "rgba(56,189,248,0.35)";
    return "rgba(100,116,139,0.25)";
  });

  const corridorHigh = m?.corridorHigh ?? Math.max(...closes);
  const corridorLow = m?.corridorLow ?? Math.min(...closes);
  const priceBounds = priceYBounds(slice, corridorLow, corridorHigh);
  const rangeThreshold = m
    ? m.avgCorridorRange * cfg.minRangeMultiplier
    : null;

  const status = passes ? "SIGNAL ✓" : m ? "NO SIGNAL" : "INSUFFICIENT";
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);

  const title = [
    `${symbol} ${cfg.interval}`,
    status,
    m ? `corridor ${m.corridorWidthPct}% · range×${m.rangeRatio}` : "",
  ]
    .filter(Boolean)
    .join("  |  ");

  const annotations = {
    corridorBox: {
      type: "box",
      xMin: slice.corridorStart - 0.5,
      xMax: slice.signalStart - 0.5,
      yMin: corridorLow,
      yMax: corridorHigh,
      yScaleID: "yPrice",
      backgroundColor: "rgba(56,189,248,0.08)",
      borderColor: failed.includes("corridorFlat")
        ? "rgba(239,68,68,0.7)"
        : "rgba(56,189,248,0.45)",
      borderWidth: failed.includes("corridorFlat") ? 2 : 1,
    },
    corridorHighLine: {
      type: "line",
      yMin: corridorHigh,
      yMax: corridorHigh,
      yScaleID: "yPrice",
      borderColor: failed.includes("breaksCorridor") ? "#ef4444" : "#38bdf8",
      borderWidth: 2,
      borderDash: [6, 4],
      label: {
        display: true,
        content: `corridor high ${corridorHigh.toFixed(6)}`,
        color: failed.includes("breaksCorridor") ? "#fca5a5" : "#7dd3fc",
        backgroundColor: "rgba(15,23,42,0.85)",
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
      backgroundColor: passes
        ? "rgba(34,197,94,0.12)"
        : "rgba(239,68,68,0.08)",
      borderColor: passes
        ? "rgba(34,197,94,0.7)"
        : "rgba(239,68,68,0.55)",
      borderWidth: 2,
    },
    checklist: {
      type: "label",
      xValue: 0,
      yValue: (Math.max(...closes) + Math.min(...closes)) / 2,
      xScaleID: "x",
      yScaleID: "yPrice",
      content: checksSummaryLines(checks),
      color: "#e2e8f0",
      font: { size: 11, family: "ui-monospace, monospace" },
      textAlign: "left",
      backgroundColor: "rgba(15,23,42,0.92)",
      borderColor: passes ? "rgba(34,197,94,0.6)" : "rgba(239,68,68,0.5)",
      borderWidth: 1,
      borderRadius: 6,
      padding: 10,
    },
  };

  if (rangeThreshold != null) {
    annotations.rangeThreshold = {
      type: "line",
      yMin: rangeThreshold,
      yMax: rangeThreshold,
      yScaleID: "yRange",
      borderColor: failed.includes("volSpike") ? "#ef4444" : "#a3e635",
      borderWidth: 2,
      borderDash: [4, 3],
      label: {
        display: true,
        content: `min range ${rangeThreshold.toFixed(3)}% (${cfg.minRangeMultiplier}×)`,
        color: "#d9f99d",
        backgroundColor: "rgba(15,23,42,0.85)",
        position: "start",
      },
    };
  }

  if (m?.avgCorridorRange != null) {
    annotations.avgCorridorRange = {
      type: "line",
      yMin: m.avgCorridorRange,
      yMax: m.avgCorridorRange,
      yScaleID: "yRange",
      borderColor: "#38bdf8",
      borderWidth: 1,
      borderDash: [2, 2],
      label: {
        display: true,
        content: `corridor avg ${m.avgCorridorRange.toFixed(3)}%`,
        color: "#7dd3fc",
        backgroundColor: "rgba(15,23,42,0.8)",
      },
    };
  }

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
        legend: { labels: { color: "#cbd5e1" } },
        title: {
          display: true,
          text: title,
          color: passes ? "#86efac" : "#f8fafc",
          font: { size: 14 },
        },
        annotation: { annotations },
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
          min: priceBounds.min,
          max: priceBounds.max,
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

function chartConfigJson(symbol, slice, analysis, cfg) {
  return JSON.parse(JSON.stringify(buildChartConfig(symbol, slice, analysis, cfg)));
}

function getChartPayload(symbol, bars, cfg, analysis, opts = {}) {
  const slice = sliceWindow(
    bars,
    cfg.corridorBars,
    cfg.signalCandles,
    opts.windowBars ?? DEFAULTS.windowBars
  );
  return {
    symbol,
    interval: cfg.interval,
    passes: analysis.passes,
    checks: analysis.checks,
    metrics: analysis.metrics,
    chart: chartConfigJson(symbol, slice, analysis, cfg),
  };
}

async function renderSymbolChart(symbol, bars, cfg, analysis, opts = {}) {
  const slice = sliceWindow(
    bars,
    cfg.corridorBars,
    cfg.signalCandles,
    opts.windowBars ?? DEFAULTS.windowBars
  );
  const r = getRenderer(opts);
  const buffer = await r.renderToBuffer(
    applyChartDisplay(chartConfigJson(symbol, slice, analysis, cfg)),
    "image/png"
  );

  const outDir = opts.chartsDir ?? DEFAULTS.chartsDir;
  const outFile = `${symbol}_${cfg.interval}.png`;
  const fs = require("fs");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, outFile), buffer);

  return { buffer, file: outFile, path: path.join(outDir, outFile) };
}

module.exports = {
  DEFAULTS,
  getRenderer,
  sliceWindow,
  buildChartConfig,
  getChartPayload,
  renderSymbolChart,
  checksSummaryLines,
};
