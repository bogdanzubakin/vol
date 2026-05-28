const path = require("path");
const {
  candleRangePct,
  barVolume,
  corridorAvgVolume,
  corridorExcludeBars,
  signalSpan,
} = require("./signal-metrics");
const { applyChartDisplay } = require("../public/chart-display");
const { formatChartAxis, formatDateTime } = require("./time-format");

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

function sliceWindow(bars, cfg, windowBars, opts = {}) {
  const n = cfg.signalCandles;
  const exclude = corridorExcludeBars(cfg);
  const strictWindow = Boolean(opts.strictWindow);
  const need = strictWindow
    ? Math.max(signalSpan(cfg), n + exclude + 2, windowBars)
    : Math.max(
        cfg.corridorBars + n + exclude,
        signalSpan(cfg),
        windowBars
      );
  const tail = bars.slice(-need);
  const signalStart = tail.length - n;
  const corridorEnd = tail.length - n - exclude;
  const corridorStart = Math.max(0, corridorEnd - cfg.corridorBars);
  return { tail, corridorStart, corridorEnd, signalStart, excludeBars: exclude };
}

function checksSummaryLines(checks) {
  return checks.map((c) => {
    const mark = c.positiveOnly
      ? c.pass
        ? "+"
        : "○"
      : c.pass
        ? "✓"
        : "✗";
    return `${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`;
  });
}

/** Tight Y bounds so price movement fills the corridor pane. */
function formatVolumeTick(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "";
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

function priceYBounds(slice, corridorLow, corridorHigh) {
  const lows = slice.tail.map((b) => b.low);
  const highs = slice.tail.map((b) => b.high);
  const yMin = Math.min(...lows, corridorLow);
  const yMax = Math.max(...highs, corridorHigh);
  const span = yMax - yMin || Math.max(Math.abs(yMax) * 0.001, 1e-8);
  const pad = span * 0.22;
  return { min: yMin - pad, max: yMax + pad };
}

function buildChartConfig(symbol, slice, analysis, cfg, meta = {}) {
  const isFastCorridor =
    String(meta?.indicator || "").toLowerCase() === "fastcorridor" ||
    String(meta?.indicator || "").toLowerCase() === "fast-corridor";
  const m = analysis.metrics;
  const checks = analysis.checks ?? [];
  const passes = analysis.passes;
  const labels = slice.tail.map((b) => formatChartAxis(b.openTime));
  const closes = slice.tail.map((b) => b.close);
  const ranges = slice.tail.map((b) => candleRangePct(b));
  const volumes = slice.tail.map((b) => barVolume(b));
  const corridorVolBars = slice.tail.slice(slice.corridorStart, slice.corridorEnd);
  const avgCorridorVol = m?.avgCorridorVolume ?? corridorAvgVolume(corridorVolBars);
  const volMult = cfg.minBreakVolumeMultiplier ?? 5;
  const maxVol = Math.max(
    ...volumes,
    avgCorridorVol * volMult,
    1
  );
  const n = slice.tail.length;

  const volumeColors = slice.tail.map((b) => {
    const v = barVolume(b);
    const up = b.close >= b.open;
    const spike = avgCorridorVol > 0 && v >= avgCorridorVol * volMult;
    if (spike) return up ? "rgba(34,197,94,0.92)" : "rgba(239,68,68,0.92)";
    return up ? "rgba(34,197,94,0.42)" : "rgba(239,68,68,0.42)";
  });

  const closeColors = slice.tail.map((_, i) => {
    if (isFastCorridor) {
      return slice.tail[i].close >= slice.tail[i].open ? "#22c55e" : "#ef4444";
    }
    if (i >= slice.signalStart) {
      return slice.tail[i].close >= slice.tail[i].open ? "#22c55e" : "#ef4444";
    }
    return "#64748b";
  });

  const rangeColors = slice.tail.map((_, i) => {
    if (isFastCorridor) return "rgba(56,189,248,0.35)";
    if (i >= slice.signalStart) {
      if (!m?.volSpike) return "rgba(239,68,68,0.75)";
      return m.volIncreasing
        ? "rgba(34,197,94,0.85)"
        : "rgba(250,204,21,0.75)";
    }
    if (i >= slice.corridorStart && i < slice.corridorEnd) {
      return "rgba(56,189,248,0.35)";
    }
    if (i >= slice.corridorEnd && i < slice.signalStart) {
      return "rgba(148,163,184,0.2)";
    }
    return "rgba(100,116,139,0.25)";
  });

  const corridorHigh = m?.corridorHigh ?? Math.max(...closes);
  const corridorLow = m?.corridorLow ?? Math.min(...closes);
  const priceBounds = priceYBounds(slice, corridorLow, corridorHigh);
  const rangeThreshold = m
    ? m.avgCorridorRange * cfg.minRangeMultiplier
    : null;

  const status = isFastCorridor
    ? passes
      ? "FAST CORRIDOR ✓"
      : m
        ? "NO FAST CORRIDOR"
        : "INSUFFICIENT"
    : passes
      ? "SIGNAL ✓"
      : m
        ? "NO SIGNAL"
        : "INSUFFICIENT";
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);

  const atLabel = meta.evaluateBarAt
    ? ` @ ${formatDateTime(meta.evaluateBarAt)}`
    : "";

  const title = [
    `${symbol} ${cfg.interval}${atLabel}`,
    status,
    isFastCorridor
      ? m
        ? `corridor ${m.corridorWidthPct}% · waves ${m.halfWaves ?? "—"}`
        : ""
      : m
        ? `corridor ${m.corridorWidthPct}% · range×${m.rangeRatio}`
        : "",
  ]
    .filter(Boolean)
    .join("  |  ");

  const annotations = {
    corridorBox: {
      type: "box",
      xMin: slice.corridorStart - 0.5,
      xMax: slice.corridorEnd - 0.5,
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
    excludeRegion:
      slice.excludeBars > 0
        ? {
            type: "box",
            xMin: slice.corridorEnd - 0.5,
            xMax: slice.signalStart - 0.5,
            backgroundColor: "rgba(148,163,184,0.06)",
            borderColor: "rgba(148,163,184,0.25)",
            borderWidth: 1,
            borderDash: [4, 4],
          }
        : undefined,
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

  if (!isFastCorridor && rangeThreshold != null) {
    annotations.rangeThreshold = {
      type: "line",
      yMin: rangeThreshold,
      yMax: rangeThreshold,
      yScaleID: "yRange",
      borderColor: failed.includes("volSpike") || failed.includes("breakVolumeSpike")
        ? "#ef4444"
        : "#a3e635",
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

  if (!isFastCorridor && avgCorridorVol > 0) {
    annotations.corridorAvgVolume = {
      type: "line",
      yMin: avgCorridorVol,
      yMax: avgCorridorVol,
      yScaleID: "yVolume",
      borderColor: "#38bdf8",
      borderWidth: 1,
      borderDash: [2, 2],
      label: {
        display: true,
        content: `corridor avg vol ${formatVolumeTick(avgCorridorVol)}`,
        color: "#7dd3fc",
        backgroundColor: "rgba(15,23,42,0.8)",
        position: "start",
      },
    };
    annotations.breakVolumeThreshold = {
      type: "line",
      yMin: avgCorridorVol * volMult,
      yMax: avgCorridorVol * volMult,
      yScaleID: "yVolume",
      borderColor: failed.includes("breakVolumeSpike") ? "#ef4444" : "#a3e635",
      borderWidth: 1,
      borderDash: [4, 3],
      label: {
        display: true,
        content: `${volMult}× avg ${formatVolumeTick(avgCorridorVol * volMult)}`,
        color: failed.includes("breakVolumeSpike") ? "#fca5a5" : "#d9f99d",
        backgroundColor: "rgba(15,23,42,0.85)",
        position: "end",
      },
    };
  }

  if (!isFastCorridor && m?.avgCorridorRange != null) {
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

  if (isFastCorridor) {
    delete annotations.corridorBox;
    delete annotations.corridorHighLine;
    delete annotations.corridorLowLine;
    delete annotations.excludeRegion;
    delete annotations.signalRegion;
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
          pointRadius: isFastCorridor
            ? 0
            : slice.tail.map((_, i) => (i >= slice.signalStart ? 5 : 0)),
          pointHoverRadius: 6,
          borderWidth: 1.5,
          tension: 0.05,
          order: 1,
        },
        {
          type: "bar",
          label: "Volume",
          data: volumes,
          yAxisID: "yVolume",
          base: maxVol,
          backgroundColor: volumeColors,
          borderWidth: 0,
          barPercentage: 0.92,
          categoryPercentage: 1,
          order: 3,
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
        yVolume: {
          type: "linear",
          position: "left",
          min: 0,
          max: maxVol,
          ticks: {
            color: "#94a3b8",
            maxTicksLimit: 4,
            callback: (v) => formatVolumeTick(v),
          },
          grid: { color: "rgba(51,65,85,0.25)" },
          title: { display: true, text: "Volume", color: "#94a3b8" },
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

function chartConfigJson(symbol, slice, analysis, cfg, meta = {}) {
  return JSON.parse(
    JSON.stringify(buildChartConfig(symbol, slice, analysis, cfg, meta))
  );
}

function getChartPayload(symbol, bars, cfg, analysis, opts = {}) {
  const slice = sliceWindow(
    bars,
    cfg,
    opts.windowBars ?? DEFAULTS.windowBars,
    opts
  );
  const meta = {
    evaluateBarAt: opts.evaluateBarAt ?? null,
    indicator: opts.indicator ?? null,
  };
  return {
    symbol,
    interval: cfg.interval,
    mode: opts.evaluateBarAt ? "historical" : "live",
    evaluateAt: opts.evaluateAt ?? null,
    evaluateBarAt: opts.evaluateBarAt ?? null,
    passes: analysis.passes,
    checks: analysis.checks,
    metrics: analysis.metrics,
    chart: chartConfigJson(symbol, slice, analysis, cfg, meta),
  };
}

async function renderSymbolChart(symbol, bars, cfg, analysis, opts = {}) {
  const slice = sliceWindow(
    bars,
    cfg,
    opts.windowBars ?? DEFAULTS.windowBars,
    opts
  );
  const meta = {
    evaluateBarAt: opts.evaluateBarAt ?? null,
    indicator: opts.indicator ?? null,
  };
  const r = getRenderer(opts);
  const buffer = await r.renderToBuffer(
    applyChartDisplay(chartConfigJson(symbol, slice, analysis, cfg, meta)),
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
