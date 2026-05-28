/** Volume strip at top; price pane below; range % at bottom. */
const VOLUME_PANE_SHARE = 0.14;
const PRICE_PANE_SHARE = 0.64;

function safeChartArea(chart) {
  const area = chart?.chartArea;
  if (!area || area.width <= 0 || area.height <= 0) return null;
  return area;
}

function fitSplitPanes(chart) {
  const area = safeChartArea(chart);
  if (!area) return;

  const yVolume = chart.scales.yVolume;
  const yPrice = chart.scales.yPrice;
  const yRange = chart.scales.yRange;
  if (!yPrice || !yRange) return;

  const volumeH = yVolume ? Math.round(area.height * VOLUME_PANE_SHARE) : 0;
  const priceH = Math.round(area.height * PRICE_PANE_SHARE);
  const rangeTop = area.top + volumeH + priceH;

  if (yVolume && volumeH > 0) {
    yVolume.top = area.top;
    yVolume.bottom = area.top + volumeH;
    yVolume.height = volumeH;
    yVolume.left = area.left;
    yVolume.width = area.width;
  }

  yPrice.top = area.top + volumeH;
  yPrice.bottom = area.top + volumeH + priceH;
  yPrice.height = priceH;
  yPrice.left = area.left;
  yPrice.width = area.width;

  yRange.top = rangeTop;
  yRange.bottom = area.bottom;
  yRange.height = area.bottom - rangeTop;
  yRange.left = area.left;
  yRange.width = area.width;
}

function applyChartDisplay(chartConfig) {
  const scales = chartConfig.options?.scales;
  if (!scales?.yPrice || !scales?.yRange) return chartConfig;

  const refit = (scale) => {
    if (scale?.chart) fitSplitPanes(scale.chart);
  };
  if (scales.yVolume) scales.yVolume.afterFit = refit;
  scales.yPrice.afterFit = refit;
  scales.yRange.afterFit = refit;

  chartConfig.plugins = (chartConfig.plugins || []).filter(
    (p) => p?.id !== "splitPaneLayout" && p?.id !== "splitPanes"
  );
  chartConfig.plugins.push({
    id: "splitPanes",
    afterUpdate(chart) {
      fitSplitPanes(chart);
    },
  });

  for (const ds of chartConfig.data?.datasets || []) {
    ds.clip = true;
  }

  const checklist =
    chartConfig.options?.plugins?.annotation?.annotations?.checklist;
  if (checklist) {
    checklist.xScaleID = checklist.xScaleID || "x";
    checklist.yScaleID = checklist.yScaleID || "yPrice";

    checklist.xValue = (ctx) => {
      const chart = ctx.chart;
      const area = safeChartArea(chart);
      const xScale = chart.scales[checklist.xScaleID] || chart.scales.x;
      if (!xScale) return 0;
      if (!area) return xScale.min ?? 0;
      return xScale.getValueForPixel(area.left + area.width / 2);
    };

    checklist.yValue = (ctx) => {
      const chart = ctx.chart;
      const area = safeChartArea(chart);
      const yScale = chart.scales[checklist.yScaleID] || chart.scales.yPrice;
      if (!yScale) return 0;
      if (!area) {
        const min = yScale.min ?? 0;
        const max = yScale.max ?? min;
        return (min + max) / 2;
      }
      const volumeH = chart.scales.yVolume
        ? area.height * VOLUME_PANE_SHARE
        : 0;
      const priceTopY = area.top + volumeH + 12;
      return yScale.getValueForPixel(priceTopY);
    };

    checklist.position = { x: "center", y: "start" };
    checklist.xAdjust = 0;
    checklist.yAdjust = 0;
    checklist.textAlign = "center";
  }

  return chartConfig;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    applyChartDisplay,
    VOLUME_PANE_SHARE,
    PRICE_PANE_SHARE,
    safeChartArea,
  };
}
