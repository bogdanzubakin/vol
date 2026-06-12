const fs = require("fs");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  analyzeVolSpike,
  fastCorridorMetrics,
  minHistoryBars,
  applyBarConfig,
  pickLiveConfig,
} = require("./signal-metrics");
const { createPaperBotSimulator } = require("./paper-bot-simulator");
const { normalizeConfig } = require("./paper-bot");
const {
  generateBacktestTradeSnapshots,
  clearBacktestSnapshots,
} = require("./paper-bot-snapshot");

const RESULT_FILE = () => dataPath("paper-bot-backtest-last.json");
const DEFAULT_DAYS = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throwIfBacktestAborted(shouldAbort) {
  if (shouldAbort?.()) {
    const err = new Error("Backtest cancelled");
    err.code = "BACKTEST_CANCELLED";
    throw err;
  }
}

function resetBacktestData() {
  try {
    fs.unlinkSync(RESULT_FILE());
  } catch {
    /* no saved result */
  }
  clearBacktestSnapshots();
}

function parseBacktestSymbolList(raw) {
  if (raw == null || raw === "") return [];
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    let sym = String(part).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!sym) continue;
    if (!sym.endsWith("USDT")) sym += "USDT";
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

function resolveBacktestSymbols(body, allSymbols) {
  const universe = new Set(allSymbols);
  const requested = parseBacktestSymbolList(body?.symbols ?? body?.symbolList);
  if (requested.length) {
    const symList = [];
    const unknown = [];
    for (const sym of requested) {
      if (universe.has(sym)) symList.push(sym);
      else unknown.push(sym);
    }
    if (!symList.length) {
      throw new Error(
        `No valid symbols in list (${unknown.length} not in scanner universe)`
      );
    }
    return { symList, unknown, mode: "list", requested: requested.length };
  }

  const maxSymbols = Math.max(
    0,
    Math.min(2000, Number(body?.maxSymbols) || 0)
  );
  const symList =
    maxSymbols > 0 ? allSymbols.slice(0, maxSymbols) : [...allSymbols];
  return {
    symList,
    unknown: [],
    mode: maxSymbols > 0 ? "max" : "all",
    requested: 0,
  };
}

function fastCorridorOptsFromCfg(signalCfg) {
  return {
    fastMoveLookbackCandles: signalCfg.fastMoveLookbackCandles,
    minAvgMovePct: signalCfg.minAvgMovePct,
    minLinearChangePct: signalCfg.minLinearChangePct,
    fastMoveExcludeMult: signalCfg.fastMoveExcludeMult,
    minCorridorWidthPct: signalCfg.fastCorridorMinWidthPct,
    maxCorridorWidthPct: signalCfg.fastCorridorMaxWidthPct,
    corridorWidthTolerancePct: signalCfg.fastCorridorWidthTolerancePct,
    minHalfWaves: signalCfg.fastCorridorMinHalfWaves,
    halfWaveFraction: signalCfg.fastCorridorHalfWaveFraction,
    halfWaveLookbackCandles: signalCfg.fastCorridorHalfWaveLookback,
  };
}

function barsForDays(signalCfg, days) {
  const barMs = signalCfg.barMs || 60_000;
  const barsPerDay = (24 * 60 * 60 * 1000) / barMs;
  return Math.ceil(days * barsPerDay);
}

function cloneCfg(base) {
  const cfg = { ...base };
  applyBarConfig(cfg);
  return cfg;
}

function runSymbolBacktest(sim, symbol, bars, signalCfg, fcOpts) {
  const need = minHistoryBars(signalCfg);
  if (bars.length < need) {
    return { symbol, skipped: true, reason: "insufficient_bars", bars: bars.length, signals: 0 };
  }

  let prevPass = false;
  let prevFc = false;
  let spikeEdges = 0;
  let fcEdges = 0;

  for (let i = need; i < bars.length; i++) {
    const window = bars.slice(0, i + 1);
    const bar = bars[i];
    const analysis = analyzeVolSpike(window, signalCfg);
    const pass = Boolean(analysis.passes);

    if (pass && !prevPass && analysis.metrics) {
      sim.onSpikeSignal(symbol, analysis.metrics, bar.closeTime);
      spikeEdges++;
    }
    prevPass = pass;

    if (signalCfg._tradeFastCorridor) {
      const fc = fastCorridorMetrics(window, signalCfg, fcOpts);
      const fcPass = Boolean(fc?.fastCorridor);
      if (fcPass && !prevFc && fc) {
        sim.onFastCorridorSignal(symbol, fc, bar.closeTime);
        fcEdges++;
      }
      prevFc = fcPass;
    }

    if (sim.hasOpen(symbol)) {
      sim.processBar(symbol, bar);
    }
  }

  const lastBar = bars[bars.length - 1];
  if (sim.hasOpen(symbol)) {
    sim.closeAllAtBar(lastBar, "backtest_end");
  }

  const symTrades = sim
    .getState()
    .closedTrades.filter((t) => t.symbol === symbol);
  const symPnl = symTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  return {
    symbol,
    bars: bars.length,
    signals: spikeEdges + fcEdges,
    spikeSignals: spikeEdges,
    fcSignals: fcEdges,
    trades: symTrades.length,
    pnl: +symPnl.toFixed(4),
  };
}

function buildEquityCurve(trades, initialDeposit) {
  const sorted = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let equity = initialDeposit;
  let peak = equity;
  const curve = [
    {
      at: null,
      equity: +equity.toFixed(4),
      drawdownPct: 0,
      cumulativePnl: 0,
    },
  ];
  let cumulative = 0;
  for (const t of sorted) {
    const pnl = t.pnl ?? 0;
    cumulative += pnl;
    equity += pnl;
    peak = Math.max(peak, equity);
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    curve.push({
      at: t.closedAt,
      atIso: formatIsoUtcPlus3(t.closedAt),
      symbol: t.symbol,
      tradeId: t.id,
      exitReason: t.exitReason,
      tradePnl: pnl,
      cumulativePnl: +cumulative.toFixed(4),
      equity: +equity.toFixed(4),
      drawdownPct: +drawdownPct.toFixed(2),
    });
  }
  const maxDrawdownPct = curve.reduce(
    (max, p) => Math.max(max, p.drawdownPct ?? 0),
    0
  );
  return { points: curve, maxDrawdownPct: +maxDrawdownPct.toFixed(2) };
}

function formatEventsForExport(events) {
  return (events ?? []).map((e) => ({
    ...e,
    atIso: e.at != null ? formatIsoUtcPlus3(e.at) : null,
  }));
}

async function runPaperBotBacktest(options) {
  const {
    symbols,
    signalCfg: rawSignalCfg,
    botConfig,
    days = DEFAULT_DAYS,
    fetchKlinesForSymbol,
    onProgress,
    restGapMs = 120,
    maxSymbols = 0,
    shouldAbort,
    runMeta = null,
  } = options;

  const signalCfg = cloneCfg(rawSignalCfg);
  const fcOpts = fastCorridorOptsFromCfg(signalCfg);
  const botCfg = normalizeConfig(botConfig);
  signalCfg._tradeFastCorridor = Boolean(botCfg.tradeFastCorridorSignals);

  const barCount = Math.max(
    barsForDays(signalCfg, days),
    minHistoryBars(signalCfg) + 10
  );

  const list = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
  const sim = createPaperBotSimulator(botCfg);
  const perSymbol = [];
  const barCache = new Map();
  const startedAt = Date.now();

  for (let i = 0; i < list.length; i++) {
    throwIfBacktestAborted(shouldAbort);
    const symbol = list[i];
    const okCount = () =>
      perSymbol.filter((r) => !r.error && !r.skipped).length;
    const skipCount = () =>
      perSymbol.filter((r) => r.skipped || r.error).length;

    onProgress?.({
      phase: "loading",
      done: i,
      total: list.length,
      symbol,
      ok: okCount(),
      skip: skipCount(),
      message: `Loading ${symbol} (${days}d)…`,
    });

    let bars;
    try {
      bars = await fetchKlinesForSymbol(symbol, barCount);
    } catch (e) {
      const errMsg = e.message || String(e);
      perSymbol.push({ symbol, error: errMsg, bars: 0 });
      onProgress?.({
        phase: "loading",
        done: i + 1,
        total: list.length,
        symbol,
        ok: okCount(),
        skip: skipCount(),
        message: `${symbol}: skipped (${errMsg.slice(0, 72)})`,
      });
      if (restGapMs > 0) await sleep(restGapMs);
      continue;
    }

    barCache.set(symbol, bars);

    onProgress?.({
      phase: "simulate",
      done: i,
      total: list.length,
      symbol,
      ok: okCount(),
      skip: skipCount(),
      message: `Simulating ${symbol} (${bars.length} bars)…`,
    });

    perSymbol.push(runSymbolBacktest(sim, symbol, bars, signalCfg, fcOpts));

    onProgress?.({
      phase: "simulate",
      done: i + 1,
      total: list.length,
      symbol,
      ok: okCount(),
      skip: skipCount(),
      message: `Done ${symbol}`,
    });

    if (restGapMs > 0) await sleep(restGapMs);
  }

  throwIfBacktestAborted(shouldAbort);

  const simState = sim.getState();
  const summary = sim.getSummary();
  const closedTrades = simState.closedTrades;

  await generateBacktestTradeSnapshots({
    trades: closedTrades,
    barCache,
    chartCfg: {
      interval: signalCfg.interval,
      corridorDays: signalCfg.corridorDays,
      corridorExcludeMinutes: signalCfg.corridorExcludeMinutes,
      signalCandles: signalCfg.signalCandles,
    },
    onProgress,
    shouldAbort,
  });

  throwIfBacktestAborted(shouldAbort);

  const tradesOut = closedTrades.slice(0, 2000).map((t) => ({
    ...t,
    openedAtIso: formatIsoUtcPlus3(t.openedAt),
    closedAtIso: formatIsoUtcPlus3(t.closedAt),
    hadAdds: (t.addCount ?? 0) > 0,
  }));
  const equityCurve = buildEquityCurve(
    tradesOut,
    summary.initialDeposit ?? botCfg.initialDeposit
  );
  const bySymbol = perSymbol
    .filter((r) => !r.error && !r.skipped)
    .sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));

  const result = {
    ok: true,
    finishedAt: formatIsoUtcPlus3(Date.now()),
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    days,
    barCount,
    interval: signalCfg.interval,
    signalConfig: pickLiveConfig(signalCfg),
    botConfig: botCfg,
    symbolsTotal: list.length,
    symbolsProcessed: perSymbol.filter((r) => !r.error).length,
    symbolsSkipped: perSymbol.filter((r) => r.skipped || r.error).length,
    summary,
    perSymbol,
    topWinners: bySymbol.filter((r) => (r.pnl ?? 0) > 0).slice(0, 15),
    topLosers: bySymbol
      .filter((r) => (r.pnl ?? 0) < 0)
      .sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
      .slice(0, 15),
    closedTrades: tradesOut,
    closedTradesTotal: closedTrades.length,
    openAtEnd: simState.openPositions,
    events: formatEventsForExport(simState.events),
    equityCurve,
    runMeta,
  };

  writeJsonFile(RESULT_FILE(), result);
  return result;
}

function loadLastBacktestResult() {
  return readJsonFile(RESULT_FILE(), null);
}

module.exports = {
  runPaperBotBacktest,
  loadLastBacktestResult,
  resetBacktestData,
  parseBacktestSymbolList,
  resolveBacktestSymbols,
  DEFAULT_DAYS,
  RESULT_FILE,
};
