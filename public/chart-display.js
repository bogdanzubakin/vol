/** Price pane uses this fraction of chart height (top); range % uses the rest. */
const PRICE_PANE_SHARE = 0.78;

function safeChartArea(chart) {
  const area = chart?.chartArea;
  if (!area || area.width <= 0 || area.height <= 0) return null;
  return area;
}

function fitSplitPanes(chart) {
  const area = safeChartArea(chart);
  if (!area) return;

  const yPrice = chart.scales.yPrice;
  const yRange = chart.scales.yRange;
  if (!yPrice || !yRange) return;

  const priceH = Math.round(area.height * PRICE_PANE_SHARE);

  yPrice.top = area.top;
  yPrice.bottom = area.top + priceH;
  yPrice.height = priceH;
  yPrice.left = area.left;
  yPrice.width = area.width;

  yRange.top = area.top + priceH;
  yRange.bottom = area.bottom;
  yRange.height = area.bottom - yRange.top;
  yRange.left = area.left;
  yRange.width = area.width;
}

function applyChartDisplay(chartConfig) {
  const scales = chartConfig.options?.scales;
  if (!scales?.yPrice || !scales?.yRange) return chartConfig;

  const refit = (scale) => {
    if (scale?.chart) fitSplitPanes(scale.chart);
  };
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
      return xScale.getValueForPixel(area.left + 16);
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
      const priceMidY = area.top + (area.height * PRICE_PANE_SHARE) / 2;
      return yScale.getValueForPixel(priceMidY);
    };

    checklist.position = { x: "start", y: "center" };
    checklist.xAdjust = 0;
    checklist.yAdjust = 0;
    checklist.textAlign = "left";
  }

  return chartConfig;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { applyChartDisplay, PRICE_PANE_SHARE, safeChartArea };
}
