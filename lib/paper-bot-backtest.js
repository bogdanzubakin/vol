const fs = require("fs");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  analyzeSweepReclaim,
  analyzeSweepReject,
  fastMoverPullbackMetrics,
  minHistoryBars,
  applyBarConfig,
  pickLiveConfig,
  barsAtTime,
  fastMoverOptsFromCfg,
  fastMoverLookbackFor1m,
} = require("./signal-metrics");
const { evaluateExtremalSpikeGate } = require("./extremal-spike-gate");
const { createPaperBotSimulator } = require("./paper-bot-simulator");
const { normalizeConfig } = require("./paper-bot");
const {
  generateBacktestTradeSnapshots,
  clearBacktestSnapshots,
} = require("./paper-bot-snapshot");
const {
  clearBacktestKlineCache,
  createBacktestKlineCache,
} = require("./backtest-kline-cache");

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
  clearBacktestRunArtifacts();
  clearBacktestKlineCache();
}

function clearBacktestRunArtifacts() {
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

function barsForDays(signalCfg, days) {
  const barMs = signalCfg.signalBarMs ?? signalCfg.barMs ?? 60_000;
  const barsPerDay = (24 * 60 * 60 * 1000) / barMs;
  return Math.ceil(days * barsPerDay);
}

function cloneCfg(base) {
  const cfg = { ...base };
  applyBarConfig(cfg);
  return cfg;
}

function runSymbolBacktest(sim, symbol, bars, signalCfg, fmOpts, extras = {}) {
  const need = minHistoryBars(signalCfg);
  if (bars.length < need) {
    return { symbol, skipped: true, reason: "insufficient_bars", bars: bars.length, signals: 0 };
  }

  const { botCfg: rawBotCfg = {}, moverBars = null } = extras;
  const botCfg = rawBotCfg ?? {};

  function extremalSpikeAllows(atMs, window, positionSide = "LONG") {
    if ((botCfg.extremalSpikeGateEnabled ?? true) === false) return true;
    const gate = evaluateExtremalSpikeGate(
      barsAtTime(window, atMs),
      { ...signalCfg, ...botCfg },
      atMs,
      { positionSide }
    );
    return !gate.enabled || gate.pass;
  }
  let prevSfp = false;
  let prevSfpBear = false;
  let prevPb = false;
  let sfpEdges = 0;
  let sfpBearEdges = 0;
  let pbEdges = 0;

  for (let i = need; i < bars.length; i++) {
    const window = bars.slice(0, i + 1);
    const bar = bars[i];
    let openedThisBar = false;

    if (signalCfg._tradeSfp) {
      const sfp = analyzeSweepReclaim(window, signalCfg);
      const sfpPass = Boolean(sfp.passes);
      if (sfpPass && !prevSfp && sfp.metrics && extremalSpikeAllows(bar.closeTime, window, "LONG")) {
        const hadOpen = sim.hasOpen(symbol);
        sim.onSfpSignal(symbol, sfp.metrics, bar.closeTime);
        if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
        sfpEdges++;
      }
      prevSfp = sfpPass;
    }

    if (signalCfg._tradeSfpBear) {
      const sfpBear = analyzeSweepReject(window, signalCfg);
      const bearPass = Boolean(sfpBear.passes);
      if (
        bearPass &&
        !prevSfpBear &&
        sfpBear.metrics &&
        extremalSpikeAllows(bar.closeTime, window, "SHORT")
      ) {
        const hadOpen = sim.hasOpen(symbol);
        sim.onSfpBearSignal(symbol, sfpBear.metrics, bar.closeTime);
        if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
        sfpBearEdges++;
      }
      prevSfpBear = bearPass;
    }

    if (signalCfg._tradePullback) {
      const moverWindow = moverBars?.length
        ? barsAtTime(moverBars, bar.closeTime)
        : window;
      const pb = fastMoverPullbackMetrics(window, signalCfg, fmOpts, moverWindow);
      const pbPass = Boolean(pb?.passes);
      if (pbPass && !prevPb && pb && extremalSpikeAllows(bar.closeTime, window, "LONG")) {
        const hadOpen = sim.hasOpen(symbol);
        sim.onPullbackSignal(symbol, pb, bar.closeTime);
        if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
        pbEdges++;
      }
      prevPb = pbPass;
    }

    // Entry is at bar close — do not apply this bar's high/low to SL/TP on the open bar.
    if (sim.hasOpen(symbol) && !openedThisBar) {
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
    signals: sfpEdges + sfpBearEdges + pbEdges,
    sfpSignals: sfpEdges,
    sfpBearSignals: sfpBearEdges,
    pullbackSignals: pbEdges,
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

function formatClosedTradesForExport(trades) {
  return (trades ?? []).map((t) => ({
    ...t,
    openedAtIso: formatIsoUtcPlus3(t.openedAt),
    closedAtIso: formatIsoUtcPlus3(t.closedAt),
    hadAdds: (t.addCount ?? 0) > 0,
  }));
}

async function runPaperBotBacktest(options) {
  const {
    symbols,
    signalCfg: rawSignalCfg,
    botConfig,
    days = DEFAULT_DAYS,
    fetchKlinesForSymbol,
    fetchKlines1mForSymbol = null,
    onProgress,
    restGapMs = 120,
    maxSymbols = 0,
    shouldAbort,
    runMeta = null,
    fetchRegimeBars = null,
  } = options;

  const signalCfg = cloneCfg(rawSignalCfg);
  const fmOpts = fastMoverOptsFromCfg(signalCfg);
  const botCfg = normalizeConfig(botConfig);
  signalCfg._tradeSfp = Boolean(botCfg.tradeSfpSignals);
  signalCfg._tradeSfpBear = Boolean(botCfg.tradeBearishSfpSignals);
  signalCfg._tradePullback = Boolean(botCfg.tradePullbackSignals);

  const barCount = Math.max(
    barsForDays(signalCfg, days),
    minHistoryBars(signalCfg) + 10
  );
  const signalInterval = signalCfg.interval ?? "1m";
  const needs1mMovers =
    signalInterval !== "1m" && Boolean(fetchKlines1mForSymbol);
  const moverBarCount = needs1mMovers
    ? Math.max(
        barsForDays({ signalBarMs: 60_000 }, days),
        fastMoverLookbackFor1m(signalCfg) + 50
      )
    : 0;

  const list = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
  const sim = createPaperBotSimulator(botCfg, { maxEvents: 0 });
  const perSymbol = [];
  const barCache = new Map();
  const moverBarCache = new Map();
  const startedAt = Date.now();
  const klineCache = createBacktestKlineCache({
    days,
    interval: signalInterval,
    symbols: list,
    barCount,
    moverBarCount,
    needs1mMovers,
  });
  const restPause = () => (klineCache.bundleValid ? 0 : restGapMs);
  const progressYield = async () => {
    if (klineCache.bundleValid) await sleep(20);
  };

  if (klineCache.bundleValid) {
    onProgress?.({
      phase: "loading",
      done: 0,
      total: list.length,
      ok: 0,
      skip: 0,
      fromCache: true,
      message: `Using kline cache (${list.length} symbols × ${days}d)…`,
    });
    await progressYield();
  }

  for (let i = 0; i < list.length; i++) {
    throwIfBacktestAborted(shouldAbort);
    const symbol = list[i];
    const okCount = () =>
      perSymbol.filter((r) => !r.error && !r.skipped).length;
    const skipCount = () =>
      perSymbol.filter((r) => r.skipped || r.error).length;

    const loadLabel = klineCache.bundleValid ? "cache" : "fetch";
    onProgress?.({
      phase: "loading",
      done: i,
      total: list.length,
      symbol,
      ok: okCount(),
      skip: skipCount(),
      fromCache: klineCache.bundleValid,
      message: `Loading ${symbol} (${days}d, ${loadLabel})…`,
    });
    await progressYield();

    let bars;
    try {
      bars = await klineCache.loadSignalBars(symbol, fetchKlinesForSymbol);
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
      if (restPause() > 0) await sleep(restPause());
      await progressYield();
      continue;
    }

    barCache.set(symbol, bars);

    let moverBars = bars;
    if (needs1mMovers) {
      try {
        moverBars = await klineCache.loadMoverBars(
          symbol,
          fetchKlines1mForSymbol
        );
        moverBarCache.set(symbol, moverBars);
      } catch {
        moverBars = bars;
      }
    }

    onProgress?.({
      phase: "simulate",
      done: i,
      total: list.length,
      symbol,
      ok: okCount(),
      skip: skipCount(),
      fromCache: klineCache.bundleValid,
      message: `Simulating ${symbol} (${bars.length} bars)…`,
    });
    await progressYield();

    perSymbol.push(
      runSymbolBacktest(sim, symbol, bars, signalCfg, fmOpts, {
        botCfg,
        moverBars,
      })
    );

    onProgress?.({
      phase: "simulate",
      done: i + 1,
      total: list.length,
      symbol,
      ok: okCount(),
      skip: skipCount(),
      fromCache: klineCache.bundleValid,
      message: `Done ${symbol}`,
    });

    if (restPause() > 0) await sleep(restPause());
    await progressYield();
  }

  throwIfBacktestAborted(shouldAbort);

  try {
    await klineCache.saveFromBarCaches(barCache, moverBarCache);
  } catch (e) {
    console.error(`Backtest kline cache save failed: ${e.message}`);
  }

  const cacheStats = klineCache.stats();
  const simState = sim.getState();
  const summary = sim.getSummary();
  const closedTrades = simState.closedTrades;

  const tradesOut = formatClosedTradesForExport(closedTrades);
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
    signalBarsPerDay: Math.round(
      (24 * 60 * 60 * 1000) / (signalCfg.signalBarMs ?? 60_000)
    ),
    simulationBarsPerSymbol: barCount,
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
    runMeta: {
      ...(runMeta ?? {}),
      historyDays: days,
      signalInterval,
      simulationBarsPerSymbol: barCount,
      moverBarsPerSymbol: needs1mMovers ? moverBarCount : null,
      klineCache: cacheStats,
    },
    snapshotsPending: false,
  };

  writeJsonFile(RESULT_FILE(), result);

  return {
    result,
    barCache,
    chartCfg: {
      interval: signalCfg.interval,
      corridorDays: signalCfg.corridorDays,
      corridorExcludeMinutes: signalCfg.corridorExcludeMinutes,
      signalCandles: signalCfg.signalCandles,
    },
  };
}

async function runBacktestSnapshotJob(options) {
  const {
    trades,
    barCache,
    chartCfg,
    onProgress,
    shouldAbort,
    onTradeSnapshot,
  } = options;

  return generateBacktestTradeSnapshots({
    trades,
    barCache,
    chartCfg,
    onProgress,
    shouldAbort,
    onTradeSnapshot,
  });
}

function loadLastBacktestResult() {
  return readJsonFile(RESULT_FILE(), null);
}

module.exports = {
  runPaperBotBacktest,
  runBacktestSnapshotJob,
  loadLastBacktestResult,
  resetBacktestData,
  clearBacktestRunArtifacts,
  parseBacktestSymbolList,
  resolveBacktestSymbols,
  clearBacktestKlineCache,
  DEFAULT_DAYS,
  RESULT_FILE,
};
