const fs = require("fs");
const path = require("path");

const CHART_FONT = "DejaVu Sans";
const CHART_FONT_MONO = "DejaVu Sans Mono";

let registered = false;

function resolveFontPaths() {
  try {
    const pkgRoot = path.dirname(require.resolve("dejavu-fonts-ttf/package.json"));
    return {
      sans: path.join(pkgRoot, "ttf", "DejaVuSans.ttf"),
      sansBold: path.join(pkgRoot, "ttf", "DejaVuSans-Bold.ttf"),
      mono: path.join(pkgRoot, "ttf", "DejaVuSansMono.ttf"),
    };
  } catch {
    const assets = path.join(__dirname, "..", "assets", "fonts");
    return {
      sans: path.join(assets, "DejaVuSans.ttf"),
      sansBold: path.join(assets, "DejaVuSans-Bold.ttf"),
      mono: path.join(assets, "DejaVuSansMono.ttf"),
    };
  }
}

function ensureChartFonts() {
  if (registered) {
    return { CHART_FONT, CHART_FONT_MONO };
  }

  const { registerFont } = require("canvas");
  const fonts = resolveFontPaths();
  const entries = [
    [fonts.sans, CHART_FONT, "normal"],
    [fonts.sansBold, CHART_FONT, "bold"],
    [fonts.mono, CHART_FONT_MONO, "normal"],
  ];

  for (const [filePath, family, weight] of entries) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Chart font missing: ${filePath}`);
    }
    registerFont(filePath, { family, weight });
  }

  registered = true;
  return { CHART_FONT, CHART_FONT_MONO };
}

function configureChartJs(ChartJS) {
  const { CHART_FONT } = ensureChartFonts();
  ChartJS.defaults.font.family = CHART_FONT;
}

function serverFontFamily(mono = false) {
  const fonts = ensureChartFonts();
  return mono ? fonts.CHART_FONT_MONO : fonts.CHART_FONT;
}

function applyServerChartFonts(chartConfig) {
  const family = serverFontFamily();
  const opts = chartConfig.options || (chartConfig.options = {});
  opts.font = { ...(opts.font || {}), family };

  const plugins = opts.plugins || (opts.plugins = {});
  if (plugins.title?.font) {
    plugins.title.font = { ...plugins.title.font, family };
  }

  for (const scale of Object.values(opts.scales || {})) {
    if (!scale?.ticks) continue;
    scale.ticks.font = { ...(scale.ticks.font || {}), family };
    if (scale.title) {
      scale.title.font = { ...(scale.title.font || {}), family };
    }
  }

  const annotation = plugins.annotation || (plugins.annotation = {});
  annotation.common = {
    ...(annotation.common || {}),
    font: { ...(annotation.common?.font || {}), family, size: 11 },
  };

  for (const ann of Object.values(annotation.annotations || {})) {
    if (!ann) continue;
    if (ann.font) {
      ann.font = { ...ann.font, family: ann.font.family || family };
    }
    if (ann.label) {
      ann.label.borderWidth = ann.label.borderWidth ?? 0;
      ann.label.font = {
        ...(ann.label.font || {}),
        family: ann.label.font?.family || family,
        size: ann.label.font?.size || 11,
      };
    }
  }

  return chartConfig;
}

module.exports = {
  CHART_FONT,
  CHART_FONT_MONO,
  ensureChartFonts,
  configureChartJs,
  serverFontFamily,
  applyServerChartFonts,
};
