const path = require("path");
const { ensureFontconfig } = require("./fontconfig-setup");

ensureFontconfig();

const { createCanvas, loadImage } = require("canvas");
const {
  candleRangePct,
  barVolume,
  corridorAvgVolume,
  corridorExcludeBars,
  signalSpan,
  candleFullyAboveCorridor,
} = require("./signal-metrics");
const { applyChartDisplay } = require("../public/chart-display");
const { formatChartAxis, formatDateTime } = require("./time-format");
const {
  ensureChartFonts,
  configureChartJs,
  serverFontFamily,
  applyServerChartFonts,
} = require("./chart-fonts");

/** Single server canvas size — multiple ChartJSNodeCanvas sizes break the annotation plugin. */
const SERVER_CHART_WIDTH = 1075;
const SERVER_CHART_HEIGHT = 840;

const DEFAULTS = {
  width: SERVER_CHART_WIDTH,
  height: SERVER_CHART_HEIGHT,
  windowBars: 280,
  chartsDir: path.join(__dirname, "..", "charts"),
};

const PAPER_BOT_DETAIL_PANE_RATIO = 0.36;
const PAPER_BOT_DETAIL_BAR_PAD = 14;

let canvasRenderer = null;

function resetAnnotationPlugin() {
  const { Chart } = require("chart.js");
  const annotationPlugin = require("chartjs-plugin-annotation");
  try {
    Chart.unregister(annotationPlugin);
  } catch {
    /* not registered */
  }
  Chart.register(annotationPlugin);
}

/** One shared ChartJSNodeCanvas for the process (annotation plugin breaks with multiple instances). */
function getCanvasRenderer(width, height) {
  if (canvasRenderer) return canvasRenderer;

  ensureChartFonts();
  const { ChartJSNodeCanvas } = require("chartjs-node-canvas");
  const annotationPlugin = require("chartjs-plugin-annotation");
  canvasRenderer = new ChartJSNodeCanvas({
    width: width ?? SERVER_CHART_WIDTH,
    height: height ?? SERVER_CHART_HEIGHT,
    backgroundColour: "#0f172a",
    plugins: { modern: [annotationPlugin] },
    chartCallback: (ChartJS) => configureChartJs(ChartJS),
  });
  return canvasRenderer;
}

function getRenderer(opts = {}) {
  return getCanvasRenderer(opts.width ?? DEFAULTS.width, opts.height ?? DEFAULTS.height);
}

function renderChartToBuffer(chartConfig, _width, _height, _extraPlugins = [], opts = {}) {
  resetAnnotationPlugin();
  const out = opts.skipDisplay ? chartConfig : applyChartDisplay(chartConfig);
  const canvas = getCanvasRenderer(SERVER_CHART_WIDTH, SERVER_CHART_HEIGHT);
  const frozen = JSON.parse(JSON.stringify(out));
  return Promise.resolve(canvas.renderToBufferSync(frozen, "image/png"));
}

const HIDDEN_ANNOTATION_LABEL = {
  display: false,
  backgroundColor: "transparent",
  borderWidth: 0,
  callout: { display: false },
};

function sanitizeAnnotations(annotations) {
  const out = {};
  for (const [key, ann] of Object.entries(annotations || {})) {
    if (!ann) continue;
    const copy = { ...ann };
    if (copy.type === "box" && copy.label == null) {
      copy.label = { ...HIDDEN_ANNOTATION_LABEL };
    } else if (copy.label == null) {
      delete copy.label;
    } else if (copy.label.display !== false) {
      copy.label = {
        borderWidth: 0,
        padding: 4,
        callout: { display: false },
        ...copy.label,
      };
    } else {
      copy.label = { ...HIDDEN_ANNOTATION_LABEL, ...copy.label };
    }
    out[key] = copy;
  }
  return out;
}

function paperBotDetailWindow(bars, entryIdx, exitIdx) {
  const start = Math.max(0, entryIdx - PAPER_BOT_DETAIL_BAR_PAD);
  const end = Math.min(bars.length - 1, Math.max(exitIdx, entryIdx) + PAPER_BOT_DETAIL_BAR_PAD);
  return { start, end, slice: bars.slice(start, end + 1) };
}

/** Right pane: OHLC candles for the position window (canvas, not Chart.js). */
function drawPaperBotCandlePanel(ctx, rect, symbol, detailBars, trade, detailMeta, cfg = {}) {
  if (!detailBars?.length) return;

  const { x, y, width, height } = rect;
  const interval = cfg.interval ?? "1m";
  const isOpen = Boolean(trade.isOpen || trade.exitReason === "open");
  const font = serverFontFamily();
  const chartTop = y + 38;
  const chartBottom = y + height - 24;
  const chartLeft = x + 46;
  const chartRight = x + width - 10;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = "#94a3b8";
  ctx.font = `12px ${font}`;
  ctx.textAlign = "left";
  ctx.fillText(`${symbol} ${interval} · position candles`, x + 10, y + 20);

  const nums = [];
  for (const b of detailBars) nums.push(b.low, b.high);
  if (Number.isFinite(trade.stopLoss)) nums.push(trade.stopLoss);
  if (Number.isFinite(trade.takeProfit)) nums.push(trade.takeProfit);
  if (Number.isFinite(trade.entryPrice)) nums.push(trade.entryPrice);
  if (Number.isFinite(trade.exitPrice)) nums.push(trade.exitPrice);
  if (Number.isFinite(trade.corridorHigh)) nums.push(trade.corridorHigh);

  let yMin = Math.min(...nums);
  let yMax = Math.max(...nums);
  const span = yMax - yMin || Math.max(Math.abs(yMax) * 0.001, 1e-8);
  yMin -= span * 0.1;
  yMax += span * 0.1;

  const toY = (price) => chartBottom - ((price - yMin) / (yMax - yMin)) * chartH;
  const slot = chartW / Math.max(detailBars.length, 1);
  const bodyW = Math.max(3, slot * 0.62);

  ctx.strokeStyle = "rgba(51,65,85,0.45)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = chartTop + (chartH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(chartLeft, gy);
    ctx.lineTo(chartRight, gy);
    ctx.stroke();
  }

  const drawHLine = (price, color, dash = []) => {
    if (!Number.isFinite(price)) return;
    const py = toY(price);
    ctx.strokeStyle = color;
    ctx.lineWidth = price === trade.entryPrice ? 1 : 2;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(chartLeft, py);
    ctx.lineTo(chartRight, py);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  drawHLine(trade.corridorHigh, "#38bdf8", [4, 4]);
  drawHLine(trade.entryPrice, "#eab308", [3, 3]);
  drawHLine(trade.stopLoss, "#ef4444", [5, 4]);
  drawHLine(trade.takeProfit, "#22c55e", [5, 4]);
  if (Number.isFinite(trade.exitPrice)) {
    drawHLine(
      trade.exitPrice,
      isOpen ? "#38bdf8" : (trade.pnl ?? 0) >= 0 ? "#22c55e" : "#ef4444",
      isOpen ? [4, 4] : []
    );
  }

  for (let i = 0; i < detailBars.length; i++) {
    const b = detailBars[i];
    const cx = chartLeft + slot * i + slot / 2;
    const up = b.close >= b.open;
    const color = up ? "#22c55e" : "#ef4444";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, toY(b.high));
    ctx.lineTo(cx, toY(b.low));
    ctx.stroke();
    const top = Math.min(toY(b.open), toY(b.close));
    const bot = Math.max(toY(b.open), toY(b.close));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1.5, bot - top));
  }

  const drawVMark = (relIdx, color, label) => {
    if (relIdx < 0 || relIdx >= detailBars.length) return;
    const vx = chartLeft + slot * relIdx + slot / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vx, chartTop);
    ctx.lineTo(vx, chartBottom);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `bold 10px ${font}`;
    ctx.textAlign = "left";
    ctx.fillText(label, Math.min(vx + 4, chartRight - 36), chartTop + 14);
  };

  drawVMark(detailMeta.entryRel, "#eab308", "OPEN");
  drawVMark(
    detailMeta.exitRel,
    isOpen ? "#38bdf8" : (trade.pnl ?? 0) >= 0 ? "#22c55e" : "#ef4444",
    isOpen ? "NOW" : "EXIT"
  );

  ctx.fillStyle = "#94a3b8";
  ctx.font = `9px ${font}`;
  ctx.textAlign = "right";
  ctx.fillText(yMax.toFixed(6), chartLeft - 6, chartTop + 4);
  ctx.fillText(yMin.toFixed(6), chartLeft - 6, chartBottom);
  ctx.textAlign = "left";
}

const FOCUSED_THEMES = {
  sfp: {
    label: "SFP · sweep-reclaim",
    accent: "#a78bfa",
    preFill: "rgba(167,139,250,0.1)",
    posFill: "rgba(167,139,250,0.05)",
    sweep: "#fb923c",
    sweepFill: "rgba(251,146,60,0.15)",
  },
  pullback: {
    label: "Pullback · MA touch",
    accent: "#fbbf24",
    preFill: "rgba(251,191,36,0.1)",
    posFill: "rgba(251,191,36,0.05)",
    ma: "#38bdf8",
  },
};

function focusedDetailLines(trade, meta, theme) {
  const isOpen = Boolean(trade.isOpen || trade.exitReason === "open");
  const pnlSign = (trade.pnl ?? 0) >= 0 ? "+" : "";
  const reason = isOpen
    ? "OPEN"
    : trade.exitReason === "take_profit"
      ? "TAKE PROFIT"
      : trade.exitReason === "stop_loss"
        ? "STOP LOSS"
        : trade.exitReason === "false_spike"
          ? "FALSE SPIKE"
          : String(trade.exitReason ?? "CLOSE").toUpperCase();
  const pre = meta.preEntryMinutes ?? 30;
  const lines = [
    `${theme.label} | ${reason} | ${pre}m pre-entry window`,
    `Entry ${Number(trade.initialEntryPrice ?? trade.entryPrice).toFixed(6)} → avg ${Number(trade.entryPrice).toFixed(6)}`,
    isOpen
      ? `Last ${Number(trade.exitPrice).toFixed(6)} | margin $${Number(trade.margin).toFixed(2)}`
      : `Exit ${Number(trade.exitPrice).toFixed(6)} | margin $${Number(trade.margin).toFixed(2)}`,
    `${isOpen ? "Unrealized" : "PnL"} ${pnlSign}$${Number(trade.pnl).toFixed(2)} (${Number(trade.pnlPct).toFixed(2)}%)`,
    `SL ${Number(trade.stopLoss).toFixed(6)} | TP ${Number(trade.takeProfit).toFixed(6)}`,
    `Corridor ${Number(trade.corridorLow).toFixed(6)} – ${Number(trade.corridorHigh).toFixed(6)}`,
  ];
  if (meta.chartTheme === "pullback" && meta.maBars) {
    lines.push(
      `MA${meta.maBars} @ entry ${meta.maAtEntry != null ? Number(meta.maAtEntry).toFixed(6) : "—"}`
    );
  }
  if (meta.chartTheme === "sfp") {
    if (meta.sweepLow != null) {
      lines.push(`Sweep low ${Number(meta.sweepLow).toFixed(6)}`);
    }
    if (meta.reclaimLevel != null) {
      lines.push(`Reclaim ${Number(meta.reclaimLevel).toFixed(6)}`);
    }
  }
  if (trade.addCount) lines.push(`Add-ons: ${trade.addCount}`);
  lines.push(
    isOpen
      ? `Opened ${formatDateTime(trade.openedAt)} | As of ${formatDateTime(trade.asOf ?? trade.closedAt)}`
      : `Opened ${formatDateTime(trade.openedAt)} | Closed ${formatDateTime(trade.closedAt)}`
  );
  return lines.filter(Boolean);
}

/** Full-width focused snapshot for SFP / pullback (30m pre-entry + trade). */
function drawPaperBotFocusedChart(canvas, symbol, bars, trade, meta, cfg = {}) {
  if (!bars?.length) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const theme = FOCUSED_THEMES[meta.chartTheme] ?? FOCUSED_THEMES.pullback;
  const interval = cfg.interval ?? "1m";
  const font = serverFontFamily();
  const isOpen = Boolean(trade.isOpen || trade.exitReason === "open");
  const entryIdx = meta.entryIdx ?? findBarIndex(bars, trade.openedAt);
  const exitIdx = meta.exitIdx ?? findBarIndex(bars, trade.closedAt);
  const pnlSign = (trade.pnl ?? 0) >= 0 ? "+" : "";

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = theme.accent;
  ctx.font = `bold 16px ${font}`;
  ctx.textAlign = "left";
  ctx.fillText(
    `${symbol} ${interval} · ${theme.label} · ${pnlSign}$${Number(trade.pnl).toFixed(2)}`,
    16,
    28
  );
  ctx.fillStyle = "#64748b";
  ctx.font = `11px ${font}`;
  ctx.fillText(`${meta.preEntryMinutes ?? 30}m before entry + position`, 16, 46);

  const infoTop = 58;
  const infoLines = focusedDetailLines(trade, meta, theme);
  ctx.fillStyle = "rgba(15,23,42,0.92)";
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1;
  roundRect(ctx, 12, infoTop, width - 24, 8 + infoLines.length * 15, 6);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e2e8f0";
  ctx.font = `10px ${font}`;
  infoLines.forEach((line, i) => {
    ctx.fillText(line, 22, infoTop + 18 + i * 15);
  });

  const chartTop = infoTop + 24 + infoLines.length * 15;
  const volH = Math.round(height * 0.14);
  const chartBottom = height - volH - 18;
  const chartLeft = 54;
  const chartRight = width - 12;
  const chartW = chartRight - chartLeft;
  const chartH = chartBottom - chartTop;

  const nums = [];
  for (const b of bars) nums.push(b.low, b.high);
  [trade.stopLoss, trade.takeProfit, trade.entryPrice, trade.exitPrice, trade.corridorHigh, trade.corridorLow].forEach(
    (v) => {
      if (Number.isFinite(v)) nums.push(v);
    }
  );
  if (Array.isArray(meta.maValues)) {
    for (const v of meta.maValues) if (Number.isFinite(v)) nums.push(v);
  }
  if (Number.isFinite(meta.sweepLow)) nums.push(meta.sweepLow);
  if (Number.isFinite(meta.reclaimLevel)) nums.push(meta.reclaimLevel);

  let yMin = Math.min(...nums);
  let yMax = Math.max(...nums);
  const span = yMax - yMin || Math.max(Math.abs(yMax) * 0.001, 1e-8);
  yMin -= span * 0.08;
  yMax += span * 0.08;
  const toY = (price) => chartBottom - ((price - yMin) / (yMax - yMin)) * chartH;
  const slot = chartW / Math.max(bars.length, 1);
  const bodyW = Math.max(2, slot * 0.62);
  const toX = (i) => chartLeft + slot * i + slot / 2;

  const shade = (fromIdx, toIdx, color) => {
    if (toIdx < fromIdx) return;
    ctx.fillStyle = color;
    ctx.fillRect(
      chartLeft + slot * fromIdx,
      chartTop,
      slot * (toIdx - fromIdx + 1),
      chartH
    );
  };

  shade(0, Math.max(0, entryIdx - 1), theme.preFill);
  if (entryIdx >= 0 && exitIdx >= entryIdx) {
    shade(entryIdx, exitIdx, theme.posFill);
  }

  ctx.strokeStyle = "rgba(51,65,85,0.45)";
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = chartTop + (chartH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(chartLeft, gy);
    ctx.lineTo(chartRight, gy);
    ctx.stroke();
  }

  const drawHLine = (price, color, dash = [], width = 1.5) => {
    if (!Number.isFinite(price)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(chartLeft, toY(price));
    ctx.lineTo(chartRight, toY(price));
    ctx.stroke();
    ctx.setLineDash([]);
  };

  if (trade.corridorHigh != null && trade.corridorLow != null && entryIdx > 0) {
    ctx.fillStyle = "rgba(56,189,248,0.1)";
    ctx.fillRect(
      chartLeft,
      toY(trade.corridorHigh),
      slot * entryIdx,
      Math.max(2, toY(trade.corridorLow) - toY(trade.corridorHigh))
    );
  }

  drawHLine(trade.corridorHigh, "#38bdf8", [5, 4], 1.5);
  drawHLine(trade.corridorLow, "#64748b", [4, 4], 1);
  if (meta.chartTheme === "sfp") {
    drawHLine(meta.sweepLow, theme.sweep, [], 2);
    drawHLine(meta.sweepThreshold, theme.sweep, [3, 3], 1);
    drawHLine(meta.reclaimLevel, "#22d3ee", [4, 3], 1);
  }
  if (meta.chartTheme === "pullback" && Array.isArray(meta.maValues)) {
    ctx.strokeStyle = theme.ma;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < meta.maValues.length; i++) {
      const v = meta.maValues[i];
      if (!Number.isFinite(v)) continue;
      const x = toX(i);
      const y = toY(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  drawHLine(trade.entryPrice, "#eab308", [3, 3], 1);
  drawHLine(trade.stopLoss, "#ef4444", [5, 4], 2);
  drawHLine(trade.takeProfit, "#22c55e", [5, 4], 2);
  if (
    trade.initialStopLoss != null &&
    Math.abs(trade.initialStopLoss - trade.stopLoss) > 1e-10
  ) {
    drawHLine(trade.initialStopLoss, "#f87171", [2, 2], 1);
  }
  drawHLine(
    trade.exitPrice,
    isOpen ? "#38bdf8" : (trade.pnl ?? 0) >= 0 ? "#22c55e" : "#ef4444",
    isOpen ? [4, 4] : [],
    isOpen ? 1 : 2
  );

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const cx = toX(i);
    const up = b.close >= b.open;
    const color = up ? "#22c55e" : "#ef4444";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, toY(b.high));
    ctx.lineTo(cx, toY(b.low));
    ctx.stroke();
    const top = Math.min(toY(b.open), toY(b.close));
    const bot = Math.max(toY(b.open), toY(b.close));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1.5, bot - top));
  }

  const drawVMark = (idx, color, label) => {
    if (idx < 0 || idx >= bars.length) return;
    const vx = toX(idx);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vx, chartTop);
    ctx.lineTo(vx, chartBottom);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = `bold 10px ${font}`;
    ctx.textAlign = "left";
    ctx.fillText(label, Math.min(vx + 4, chartRight - 40), chartTop + 12);
  };

  drawVMark(entryIdx, "#eab308", "OPEN");
  drawVMark(
    exitIdx,
    isOpen ? "#38bdf8" : (trade.pnl ?? 0) >= 0 ? "#22c55e" : "#ef4444",
    isOpen ? "NOW" : "EXIT"
  );

  if (meta.chartTheme === "sfp" && Number.isFinite(meta.sweepLow)) {
    let sweepIdx = -1;
    for (let i = 0; i <= Math.min(entryIdx, bars.length - 1); i++) {
      if (bars[i].low <= meta.sweepLow * 1.001) {
        sweepIdx = i;
        break;
      }
    }
    if (sweepIdx >= 0) {
      const sx = toX(sweepIdx);
      ctx.fillStyle = theme.sweep;
      ctx.beginPath();
      ctx.moveTo(sx, toY(bars[sweepIdx].low) + 10);
      ctx.lineTo(sx - 5, toY(bars[sweepIdx].low) + 18);
      ctx.lineTo(sx + 5, toY(bars[sweepIdx].low) + 18);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.fillStyle = "#94a3b8";
  ctx.font = `9px ${font}`;
  ctx.textAlign = "right";
  ctx.fillText(yMax.toFixed(6), chartLeft - 6, chartTop + 4);
  ctx.fillText(yMin.toFixed(6), chartLeft - 6, chartBottom);

  const volTop = chartBottom + 10;
  const volBottom = height - 14;
  const volMax = Math.max(...bars.map((b) => barVolume(b)), 1);
  ctx.fillStyle = "#64748b";
  ctx.font = `10px ${font}`;
  ctx.textAlign = "left";
  ctx.fillText("Volume", chartLeft, volTop + 10);
  for (let i = 0; i < bars.length; i++) {
    const v = barVolume(bars[i]);
    const h = ((volBottom - volTop - 8) * v) / volMax;
    const cx = toX(i);
    const up = bars[i].close >= bars[i].open;
    ctx.fillStyle = up ? "rgba(34,197,94,0.55)" : "rgba(239,68,68,0.55)";
    ctx.fillRect(cx - bodyW / 2, volBottom - h, bodyW, h);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

async function renderPaperBotFocusedTradeChart(symbol, bars, trade, cfg = {}, opts = {}) {
  const width = opts.width ?? 1680;
  const height = opts.height ?? 840;
  const meta = cfg.snapshotMeta ?? {};
  ensureChartFonts();
  const canvas = createCanvas(width, height);
  drawPaperBotFocusedChart(canvas, symbol, bars, trade, meta, cfg);
  return canvas.toBuffer("image/png");
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

function detectWaveTurns(bars, corridorLow, corridorHigh, halfWaveFraction = 0.5) {
  if (!bars?.length || corridorHigh <= corridorLow) return [];
  const range = corridorHigh - corridorLow;
  const minMove = range * halfWaveFraction;
  if (!Number.isFinite(minMove) || minMove <= 0) return [];

  const turns = [];
  let extreme = bars[0].close;
  let extremeIdx = 0;
  let dir = null;

  for (let i = 1; i < bars.length; i++) {
    const c = bars[i].close;
    if (!Number.isFinite(c)) continue;

    if (dir === null) {
      const up = c - extreme;
      const down = extreme - c;
      if (up >= minMove) {
        dir = "up";
        extreme = c;
        extremeIdx = i;
      } else if (down >= minMove) {
        dir = "down";
        extreme = c;
        extremeIdx = i;
      } else if (c > extreme) {
        extreme = c;
        extremeIdx = i;
      } else if (c < extreme) {
        extreme = c;
        extremeIdx = i;
      }
      continue;
    }

    if (dir === "up") {
      if (c >= extreme) {
        extreme = c;
        extremeIdx = i;
      } else if (extreme - c >= minMove) {
        turns.push({ idx: extremeIdx, price: extreme, dir: "down" });
        dir = "down";
        extreme = c;
        extremeIdx = i;
      }
    } else if (c <= extreme) {
      extreme = c;
      extremeIdx = i;
    } else if (c - extreme >= minMove) {
      turns.push({ idx: extremeIdx, price: extreme, dir: "up" });
      dir = "up";
      extreme = c;
      extremeIdx = i;
    }
  }

  return turns;
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
      const bar = slice.tail[i];
      const above =
        m?.corridorHigh != null &&
        candleFullyAboveCorridor(bar, m.corridorHigh);
      return above ? "rgba(34,197,94,0.85)" : "rgba(239,68,68,0.75)";
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
        ? `corridor ${m.corridorWidthPct}% · ${m.aboveCorridorCount ?? 0}/${m.minAboveCorridorCandles ?? cfg.signalCandles} above high`
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
      font: { size: 11, family: serverFontFamily(true) },
      textAlign: "left",
      backgroundColor: "rgba(15,23,42,0.92)",
      borderColor: passes ? "rgba(34,197,94,0.6)" : "rgba(239,68,68,0.5)",
      borderWidth: 1,
      borderRadius: 6,
      padding: 10,
    },
  };

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
    if (m?.corridorHigh != null) {
      annotations.fastCorridorHigh = {
        type: "line",
        yMin: m.corridorHigh,
        yMax: m.corridorHigh,
        yScaleID: "yPrice",
        borderColor: "#38bdf8",
        borderWidth: 2,
        borderDash: [6, 4],
        label: {
          display: true,
          content: `corridor high ${m.corridorHigh.toFixed(6)}`,
          color: "#7dd3fc",
          backgroundColor: "rgba(15,23,42,0.85)",
        },
      };
    }
    if (m?.corridorLow != null) {
      annotations.fastCorridorLow = {
        type: "line",
        yMin: m.corridorLow,
        yMax: m.corridorLow,
        yScaleID: "yPrice",
        borderColor: "#38bdf8",
        borderWidth: 2,
        borderDash: [6, 4],
        label: {
          display: true,
          content: `corridor low ${m.corridorLow.toFixed(6)}`,
          color: "#7dd3fc",
          backgroundColor: "rgba(15,23,42,0.85)",
        },
      };
    }
  }

  if (isFastCorridor && m?.corridorHigh != null && m?.corridorLow != null) {
    const waveTurns = detectWaveTurns(
      slice.tail,
      m.corridorLow,
      m.corridorHigh,
      m.halfWaveFraction ?? cfg.fastCorridorHalfWaveFraction ?? 0.5
    );
    const wavePoints = waveTurns.map((t) => ({
      x: t.idx,
      y: t.price,
    }));
    const waveLabels = waveTurns.map((t, i) => ({
      type: "label",
      xValue: t.idx,
      yValue: t.price,
      xScaleID: "x",
      yScaleID: "yPrice",
      content: `${i + 1}`,
      color: t.dir === "up" ? "#22c55e" : "#ef4444",
      backgroundColor: "rgba(15,23,42,0.9)",
      borderColor: "rgba(148,163,184,0.45)",
      borderWidth: 1,
      borderRadius: 8,
      padding: 4,
      font: { size: 10, family: serverFontFamily(true) },
      xAdjust: 0,
      yAdjust: -10,
    }));
    for (let i = 0; i < waveLabels.length; i++) {
      annotations[`waveLabel${i + 1}`] = waveLabels[i];
    }
  }

  const datasets = [
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
  ];
  if (!isFastCorridor) {
    datasets.push({
      type: "bar",
      label: "Range %",
      data: ranges,
      yAxisID: "yRange",
      backgroundColor: rangeColors,
      borderWidth: 0,
      order: 2,
    });
  }

  if (isFastCorridor && m?.corridorHigh != null && m?.corridorLow != null) {
    const waveTurns = detectWaveTurns(
      slice.tail,
      m.corridorLow,
      m.corridorHigh,
      m.halfWaveFraction ?? cfg.fastCorridorHalfWaveFraction ?? 0.5
    );
    const wavePoints = waveTurns.map((t) => ({ x: t.idx, y: t.price }));
    if (wavePoints.length > 0) {
      datasets.push({
        type: "line",
        label: "Detected waves",
        data: wavePoints,
        parsing: false,
        yAxisID: "yPrice",
        borderColor: "rgba(56,189,248,0.9)",
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 5,
        pointBackgroundColor: waveTurns.map((t) =>
          t.dir === "up" ? "#22c55e" : "#ef4444"
        ),
        pointBorderWidth: 0,
        tension: 0,
        order: 0,
      });
    }
  }

  if (!isFastCorridor) {
    datasets.splice(1, 0, {
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
    });
  }

  const scales = {
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
  };
  if (!isFastCorridor) {
    scales.yRange = {
      type: "linear",
      position: "right",
      ticks: { color: "#94a3b8" },
      grid: { drawOnChartArea: false },
      title: { display: true, text: "Range %", color: "#94a3b8" },
    };
  }
  if (!isFastCorridor) {
    scales.yVolume = {
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
    };
  }

  return {
    type: "bar",
    data: {
      labels,
      datasets,
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
          font: { size: 14, family: serverFontFamily() },
        },
        annotation: { annotations: sanitizeAnnotations(annotations) },
      },
      scales,
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
  resetAnnotationPlugin();
  const r = getRenderer(opts);
  const chartConfig = applyChartDisplay(
    applyServerChartFonts(chartConfigJson(symbol, slice, analysis, cfg, meta))
  );
  const buffer = r.renderToBufferSync(chartConfig, "image/png");

  const outDir = opts.chartsDir ?? DEFAULTS.chartsDir;
  const outFile = `${symbol}_${cfg.interval}.png`;
  const fs = require("fs");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, outFile), buffer);

  return { buffer, file: outFile, path: path.join(outDir, outFile) };
}

function findBarIndex(bars, timeMs) {
  if (!bars?.length || timeMs == null) return -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].closeTime >= timeMs) return i;
  }
  return bars.length - 1;
}

function buildPaperBotTradeChartConfig(symbol, bars, trade, cfg = {}) {
  const interval = cfg.interval ?? "1m";
  const meta = cfg.snapshotMeta ?? {};
  const corridorDays = meta.corridorDays ?? cfg.corridorDays ?? 2;
  const labels = bars.map((b) => formatChartAxis(b.openTime));
  const closes = bars.map((b) => b.close);
  const lows = bars.map((b) => b.low);
  const highs = bars.map((b) => b.high);

  const corridorHigh = trade.corridorHigh;
  const corridorLow = trade.corridorLow;
  const yMin = Math.min(...lows, corridorLow ?? Infinity, trade.stopLoss ?? Infinity, trade.entryPrice);
  const yMax = Math.max(...highs, corridorHigh ?? -Infinity, trade.takeProfit ?? -Infinity, trade.exitPrice);
  const span = yMax - yMin || Math.max(Math.abs(yMax) * 0.001, 1e-8);
  const pad = span * 0.12;

  const entryIdx =
    meta.entryIdx ?? findBarIndex(bars, trade.openedAt);
  const exitIdx =
    meta.exitIdx ?? findBarIndex(bars, trade.closedAt);
  const corridorStartIdx = meta.corridorStartIdx ?? 0;
  const corridorEndIdx =
    meta.corridorEndIdx ??
    Math.max(0, (meta.historyEndIdx ?? entryIdx) - 1);
  const hasCorridorSpan = corridorEndIdx >= corridorStartIdx;
  const isOpen = Boolean(trade.isOpen || trade.exitReason === "open");
  const pnlSign = (trade.pnl ?? 0) >= 0 ? "+" : "";
  const reason = isOpen
    ? "OPEN"
    : trade.exitReason === "take_profit"
      ? "TAKE PROFIT"
      : trade.exitReason === "stop_loss"
        ? "STOP LOSS"
        : trade.exitReason === "false_spike"
          ? "FALSE SPIKE"
          : String(trade.exitReason ?? "CLOSE").toUpperCase();
  const logNote = meta.logHistory ? " · log history" : "";
  const pnlLabel = isOpen ? "Unrealized" : "PnL";

  const detailLines = [
    `${trade.side ?? "LONG"} ${trade.signalKind ?? "spike"} | ${reason}`,
    `Entry ${Number(trade.initialEntryPrice ?? trade.entryPrice).toFixed(6)} -> avg ${Number(trade.entryPrice).toFixed(6)}`,
    isOpen
      ? `Last ${Number(trade.exitPrice).toFixed(6)} | margin $${Number(trade.margin).toFixed(2)}`
      : `Exit ${Number(trade.exitPrice).toFixed(6)} | margin $${Number(trade.margin).toFixed(2)}`,
    `${pnlLabel} ${pnlSign}$${Number(trade.pnl).toFixed(2)} (${Number(trade.pnlPct).toFixed(2)}%)`,
    `SL ${Number(trade.stopLoss).toFixed(6)} | TP ${Number(trade.takeProfit).toFixed(6)}`,
    `Corridor ${corridorDays}d ${Number(corridorLow).toFixed(6)} - ${Number(corridorHigh).toFixed(6)}`,
    trade.addCount ? `Add-ons: ${trade.addCount}` : null,
    isOpen
      ? `Opened ${formatDateTime(trade.openedAt)} | As of ${formatDateTime(trade.asOf ?? trade.closedAt)}`
      : `Opened ${formatDateTime(trade.openedAt)} | Closed ${formatDateTime(trade.closedAt)}`,
  ].filter(Boolean);

  const corridorXMin = hasCorridorSpan ? corridorStartIdx - 0.5 : 0;
  const corridorXMax = hasCorridorSpan
    ? corridorEndIdx + 0.5
    : Math.max(0, labels.length - 1);
  const snapshotWidth = cfg.snapshotWidth ?? 1680;

  const annotations = {
    corridorBox:
      corridorHigh != null && corridorLow != null && hasCorridorSpan
        ? {
            type: "box",
            xMin: corridorXMin,
            xMax: corridorXMax,
            yMin: corridorLow,
            yMax: corridorHigh,
            yScaleID: "yPrice",
            backgroundColor: "rgba(56,189,248,0.12)",
            borderColor: "rgba(56,189,248,0.55)",
            borderWidth: 1,
          }
        : undefined,
    positionBox:
      entryIdx >= 0 && exitIdx >= entryIdx
        ? {
            type: "box",
            xMin: entryIdx - 0.5,
            xMax: exitIdx + 0.5,
            yMin: yMin - pad,
            yMax: yMax + pad,
            yScaleID: "yPrice",
            backgroundColor: "rgba(234,179,8,0.05)",
            borderColor: "rgba(234,179,8,0.3)",
            borderWidth: 1,
          }
        : undefined,
    historySplit:
      entryIdx > 0
        ? {
            type: "line",
            xMin: entryIdx,
            xMax: entryIdx,
            borderColor: "rgba(148,163,184,0.45)",
            borderWidth: 1,
            borderDash: [5, 5],
            label: {
              display: true,
              content: "entry",
              color: "#cbd5e1",
              backgroundColor: "rgba(15,23,42,0.85)",
              position: "start",
            },
          }
        : undefined,
    slLine: {
      type: "line",
      yMin: trade.stopLoss,
      yMax: trade.stopLoss,
      yScaleID: "yPrice",
      borderColor: "#ef4444",
      borderWidth: 2,
      borderDash: [6, 4],
      label: {
        display: true,
        content: `SL ${Number(trade.stopLoss).toFixed(6)}`,
        color: "#fca5a5",
        backgroundColor: "rgba(15,23,42,0.85)",
      },
    },
    tpLine: {
      type: "line",
      yMin: trade.takeProfit,
      yMax: trade.takeProfit,
      yScaleID: "yPrice",
      borderColor: "#22c55e",
      borderWidth: 2,
      borderDash: [6, 4],
      label: {
        display: true,
        content: `TP ${Number(trade.takeProfit).toFixed(6)}`,
        color: "#86efac",
        backgroundColor: "rgba(15,23,42,0.85)",
      },
    },
    entryLine: {
      type: "line",
      yMin: trade.entryPrice,
      yMax: trade.entryPrice,
      yScaleID: "yPrice",
      borderColor: "#eab308",
      borderWidth: 1,
      borderDash: [3, 3],
    },
    exitLine: {
      type: "line",
      yMin: trade.exitPrice,
      yMax: trade.exitPrice,
      yScaleID: "yPrice",
      borderColor: isOpen
        ? "#38bdf8"
        : (trade.pnl ?? 0) >= 0
          ? "#22c55e"
          : "#ef4444",
      borderWidth: 2,
      ...(isOpen ? { borderDash: [4, 4] } : {}),
      ...(isOpen
        ? {
            label: {
              display: true,
              content: `last ${Number(trade.exitPrice).toFixed(6)}`,
              color: "#7dd3fc",
              backgroundColor: "rgba(15,23,42,0.85)",
              borderWidth: 0,
            },
          }
        : {}),
    },
    entryMark:
      entryIdx >= 0
        ? {
            type: "line",
            xMin: entryIdx,
            xMax: entryIdx,
            borderColor: "#eab308",
            borderWidth: 2,
            label: {
              display: true,
              content: "OPEN",
              color: "#fde047",
              backgroundColor: "rgba(15,23,42,0.85)",
            },
          }
        : undefined,
    exitMark:
      exitIdx >= 0
        ? {
            type: "line",
            xMin: exitIdx,
            xMax: exitIdx,
            borderColor: isOpen
              ? "#38bdf8"
              : (trade.pnl ?? 0) >= 0
                ? "#22c55e"
                : "#ef4444",
            borderWidth: 2,
            label: {
              display: true,
              content: isOpen ? "NOW" : reason,
              color: isOpen
                ? "#7dd3fc"
                : (trade.pnl ?? 0) >= 0
                  ? "#86efac"
                  : "#fca5a5",
              backgroundColor: "rgba(15,23,42,0.85)",
            },
          }
        : undefined,
    details: {
      type: "label",
      xValue: 0,
      yValue: yMin + span * 0.06,
      xScaleID: "x",
      yScaleID: "yPrice",
      content: detailLines,
      color: "#e2e8f0",
      font: { size: 10, family: serverFontFamily() },
      textAlign: "left",
      xAdjust: 12,
      yAdjust: -8,
      adjustScaleRange: false,
      backgroundColor: "rgba(15,23,42,0.92)",
      borderColor: isOpen
        ? "rgba(56,189,248,0.55)"
        : (trade.pnl ?? 0) >= 0
          ? "rgba(34,197,94,0.6)"
          : "rgba(239,68,68,0.5)",
      borderWidth: 1,
      borderRadius: 6,
      padding: 10,
    },
  };

  if (corridorHigh != null) {
    annotations.corridorHighLine = {
      type: "line",
      yMin: corridorHigh,
      yMax: corridorHigh,
      xMin: corridorXMin,
      xMax: corridorXMax,
      yScaleID: "yPrice",
      borderColor: "#38bdf8",
      borderWidth: 2,
      borderDash: [6, 4],
      label: {
        display: true,
        content: `corridor high ${Number(corridorHigh).toFixed(6)}`,
        color: "#7dd3fc",
        backgroundColor: "rgba(15,23,42,0.85)",
        position: "start",
      },
    };
  }
  if (corridorLow != null && hasCorridorSpan) {
    annotations.corridorLowLine = {
      type: "line",
      yMin: corridorLow,
      yMax: corridorLow,
      xMin: corridorXMin,
      xMax: corridorXMax,
      yScaleID: "yPrice",
      borderColor: "#475569",
      borderWidth: 1,
      borderDash: [4, 4],
      label: {
        display: true,
        content: `corridor low ${Number(corridorLow).toFixed(6)}`,
        color: "#94a3b8",
        backgroundColor: "rgba(15,23,42,0.85)",
        position: "start",
      },
    };
  }

  return {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "History",
          data: closes.map((c, i) => (i < entryIdx ? c : null)),
          borderColor: "rgba(100,116,139,0.55)",
          backgroundColor: "rgba(100,116,139,0.08)",
          borderWidth: 1,
          pointRadius: 0,
          spanGaps: false,
          yAxisID: "yPrice",
        },
        {
          label: "Position",
          data: closes.map((c, i) => (i >= entryIdx ? c : null)),
          borderColor: "#94a3b8",
          backgroundColor: "rgba(148,163,184,0.15)",
          borderWidth: 1.75,
          pointRadius: 0,
          spanGaps: false,
          yAxisID: "yPrice",
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: `${symbol} ${interval} · ${corridorDays}d corridor${logNote} · ${reason} · ${pnlLabel} ${pnlSign}$${Number(trade.pnl).toFixed(2)}`,
          color: isOpen
            ? "#7dd3fc"
            : (trade.pnl ?? 0) >= 0
              ? "#86efac"
              : "#fca5a5",
          font: { size: 14, family: serverFontFamily() },
        },
        annotation: { clip: false, annotations: sanitizeAnnotations(annotations) },
      },
      scales: {
        x: {
          ticks: { color: "#64748b", maxTicksLimit: 12 },
          grid: { color: "rgba(51,65,85,0.35)" },
        },
        yPrice: {
          type: "linear",
          position: "left",
          min: yMin - pad,
          max: yMax + pad,
          ticks: { color: "#94a3b8" },
          grid: { color: "rgba(51,65,85,0.35)" },
        },
      },
    },
  };
}

async function renderPaperBotTradeChart(symbol, bars, trade, cfg = {}, opts = {}) {
  const meta = cfg.snapshotMeta ?? {};
  if (meta.chartStyle === "focused") {
    return renderPaperBotFocusedTradeChart(symbol, bars, trade, cfg, opts);
  }

  const totalWidth = opts.width ?? 1680;
  const height = opts.height ?? 840;
  const gap = 2;
  const detailWidth = Math.round(totalWidth * PAPER_BOT_DETAIL_PANE_RATIO);
  const mainWidth = totalWidth - detailWidth - gap;

  const mainConfig = applyServerChartFonts(
    buildPaperBotTradeChartConfig(symbol, bars, trade, {
      ...cfg,
      snapshotWidth: mainWidth,
    })
  );

  const entryIdx = meta.entryIdx ?? findBarIndex(bars, trade.openedAt);
  const exitIdx = meta.exitIdx ?? findBarIndex(bars, trade.closedAt);
  const { start, end, slice: detailBars } = paperBotDetailWindow(
    bars,
    entryIdx,
    exitIdx
  );

  ensureChartFonts();
  const mainBuf = await renderChartToBuffer(mainConfig, mainWidth, height, [], {
    skipDisplay: true,
  });

  const canvas = createCanvas(totalWidth, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, totalWidth, height);

  const mainImg = await loadImage(mainBuf);
  ctx.drawImage(mainImg, 0, 0, mainWidth, height);
  ctx.fillStyle = "#334155";
  ctx.fillRect(mainWidth, 0, gap, height);
  drawPaperBotCandlePanel(
    ctx,
    { x: mainWidth + gap, y: 0, width: detailWidth, height },
    symbol,
    detailBars,
    trade,
    { entryRel: entryIdx - start, exitRel: exitIdx - start },
    cfg
  );

  return canvas.toBuffer("image/png");
}

module.exports = {
  DEFAULTS,
  getRenderer,
  sliceWindow,
  buildChartConfig,
  buildPaperBotTradeChartConfig,
  getChartPayload,
  renderSymbolChart,
  renderPaperBotTradeChart,
  checksSummaryLines,
};
