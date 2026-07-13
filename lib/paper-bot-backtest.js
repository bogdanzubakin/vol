const fs = require("fs");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { getDb, repos } = require("./db");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  analyzeSweepReclaim,
  analyzeSweepReject,
  fastMoverPullbackMetrics,
  fastMoverPullbackBearMetrics,
  minHistoryBars,
  applyBarConfig,
  pickLiveConfig,
  barsAtTime,
  fastMoverOptsFromCfg,
  fastMoverLookbackFor1m,
} = require("./signal-metrics");
const { evaluateFoiLong, evaluateFoiBear } = require("./foi-signal");
const { evaluateExtremalSpikeGate } = require("./extremal-spike-gate");
const { createPaperBotSimulator } = require("./paper-bot-simulator");
const { BTC_SYMBOL } = require("./btc-regime-context");
const { normalizeConfig } = require("./paper-bot");
const {
  generateBacktestTradeSnapshots,
  clearBacktestSnapshots,
} = require("./paper-bot-snapshot");
const { upsertClosedTrade } = require("./db/repos/trades");
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
  try {
    repos.backtest.clearBacktestRuns(getDb());
  } catch (e) {
    console.error(`clearBacktestRuns: ${e.message}`);
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

const SIM_YIELD_EVERY = 200;
const SIM_PROGRESS_MIN_MS = 5000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** Signal analyzers only read the tail — avoid O(n²) full-history slices. */
function barsWindowAt(bars, endIdx, windowBars) {
  const end = endIdx + 1;
  const start = Math.max(0, end - windowBars);
  return bars.slice(start, end);
}

async function runSymbolBacktest(sim, symbol, signalBars, signalCfg, fmOpts, extras = {}) {
  const need = minHistoryBars(signalCfg);
  const signals = signalBars;
  const timeline = extras.simBars ?? signalBars;
  const use1mSim = timeline !== signals;

  if (signals.length < need) {
    return { symbol, skipped: true, reason: "insufficient_bars", bars: signals.length, signals: 0 };
  }
  if (!timeline.length) {
    return { symbol, skipped: true, reason: "insufficient_sim_bars", bars: 0, signals: 0 };
  }

  const { botCfg: rawBotCfg = {}, moverBars = null, onProgress, getFundingOiAt = null } =
    extras;
  const botCfg = rawBotCfg ?? {};
  const moverWindowBars =
    (fmOpts.fastMoveLookbackCandles ?? signalCfg.fastMoveLookbackCandles ?? 10) + 40;
  let moverEndIdx = -1;
  let lastProgressAt = 0;

  function extremalSpikeAllows(atMs, window, positionSide = "LONG") {
    if (!botCfg.extremalSpikeGateEnabled) return true;
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
  let prevPbBear = false;
  let prevFoi = false;
  let prevFoiBear = false;
  let sfpEdges = 0;
  let sfpBearEdges = 0;
  let pbEdges = 0;
  let pbBearEdges = 0;
  let foiEdges = 0;
  let foiBearEdges = 0;
  let signalIdx = -1;
  const tradesBefore = sim.getClosedTrades().length;

  for (let i = 0; i < timeline.length; i++) {
    const bar = timeline[i];
    const shouldReport =
      i === 0 ||
      i === timeline.length - 1 ||
      i % SIM_YIELD_EVERY === 0 ||
      Date.now() - lastProgressAt >= SIM_PROGRESS_MIN_MS;
    if (shouldReport) {
      onProgress?.(i, timeline.length);
      lastProgressAt = Date.now();
      if (i > 0) await yieldToLoop();
    }

    while (
      signalIdx + 1 < signals.length &&
      signals[signalIdx + 1].closeTime <= bar.closeTime
    ) {
      signalIdx++;
    }

    let openedThisBar = false;
    const signalBarClosed =
      signalIdx >= need - 1 && signals[signalIdx].closeTime === bar.closeTime;

    if (signalBarClosed) {
      const signalBar = signals[signalIdx];
      const window = barsWindowAt(signals, signalIdx, need);
      let moverWindow = window;
      if (moverBars?.length && moverBars !== signals) {
        while (
          moverEndIdx + 1 < moverBars.length &&
          moverBars[moverEndIdx + 1].closeTime <= signalBar.closeTime
        ) {
          moverEndIdx++;
        }
        if (moverEndIdx >= 0) {
          moverWindow = barsWindowAt(moverBars, moverEndIdx, moverWindowBars);
        }
      }

      if (signalCfg._tradeSfp) {
        const sfp = analyzeSweepReclaim(window, signalCfg);
        const sfpPass = Boolean(sfp.passes);
        if (
          sfpPass &&
          !prevSfp &&
          sfp.metrics &&
          extremalSpikeAllows(signalBar.closeTime, window, "LONG")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onSfpSignal(symbol, sfp.metrics, signalBar.closeTime);
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
          extremalSpikeAllows(signalBar.closeTime, window, "SHORT")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onSfpBearSignal(symbol, sfpBear.metrics, signalBar.closeTime);
          if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
          sfpBearEdges++;
        }
        prevSfpBear = bearPass;
      }

      if (signalCfg._tradePullback) {
        const pb = fastMoverPullbackMetrics(window, signalCfg, fmOpts, moverWindow);
        const pbPass = Boolean(pb?.passes);
        if (
          pbPass &&
          !prevPb &&
          pb &&
          extremalSpikeAllows(signalBar.closeTime, window, "LONG")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onPullbackSignal(symbol, pb, signalBar.closeTime);
          if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
          pbEdges++;
        }
        prevPb = pbPass;
      }

      if (signalCfg._tradePullbackBear) {
        const pbBear = fastMoverPullbackBearMetrics(
          window,
          signalCfg,
          fmOpts,
          moverWindow
        );
        const pbBearPass = Boolean(pbBear?.passes);
        if (
          pbBearPass &&
          !prevPbBear &&
          pbBear &&
          extremalSpikeAllows(signalBar.closeTime, window, "SHORT")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onPullbackBearSignal(symbol, pbBear, signalBar.closeTime);
          if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
          pbBearEdges++;
        }
        prevPbBear = pbBearPass;
      }

      if (signalCfg._tradeFoi || signalCfg._tradeFoiBear) {
        const fundingOi =
          typeof getFundingOiAt === "function"
            ? getFundingOiAt(symbol, signalBar.closeTime)
            : null;
        const mergedCfg = { ...signalCfg, ...botCfg };

        if (signalCfg._tradeFoi) {
          const foi = evaluateFoiLong(
            window,
            mergedCfg,
            fundingOi,
            fmOpts,
            moverWindow
          );
          const foiPass = Boolean(foi?.passes);
          if (
            foiPass &&
            !prevFoi &&
            foi &&
            extremalSpikeAllows(signalBar.closeTime, window, "LONG")
          ) {
            const hadOpen = sim.hasOpen(symbol);
            sim.onFoiSignal(symbol, foi, signalBar.closeTime);
            if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
            foiEdges++;
          }
          prevFoi = foiPass;
        }

        if (signalCfg._tradeFoiBear) {
          const foiBear = evaluateFoiBear(
            window,
            mergedCfg,
            fundingOi,
            fmOpts,
            moverWindow
          );
          const foiBearPass = Boolean(foiBear?.passes);
          if (
            foiBearPass &&
            !prevFoiBear &&
            foiBear &&
            extremalSpikeAllows(signalBar.closeTime, window, "SHORT")
          ) {
            const hadOpen = sim.hasOpen(symbol);
            sim.onFoiBearSignal(symbol, foiBear, signalBar.closeTime);
            if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
            foiBearEdges++;
          }
          prevFoiBear = foiBearPass;
        }
      }
    }

    if (sim.hasOpen(symbol) && !openedThisBar) {
      sim.processBar(symbol, bar);
    }
  }

  onProgress?.(timeline.length, timeline.length);

  const lastBar = timeline[timeline.length - 1];
  if (sim.hasOpen(symbol)) {
    sim.closeAllAtBar(lastBar, "backtest_end");
  }

  const symTrades = sim.getClosedTrades().slice(tradesBefore);
  const symPnl = symTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);

  return {
    symbol,
    bars: timeline.length,
    signalBars: signals.length,
    simInterval: use1mSim ? "1m" : signalCfg.interval ?? "1m",
    signals: sfpEdges + sfpBearEdges + pbEdges + pbBearEdges + foiEdges + foiBearEdges,
    sfpSignals: sfpEdges,
    sfpBearSignals: sfpBearEdges,
    pullbackSignals: pbEdges,
    pullbackBearSignals: pbBearEdges,
    foiSignals: foiEdges,
    foiBearSignals: foiBearEdges,
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
    saveKlineCache = true,
    saveLastResult = true,
    getFundingOiAt = null,
    modelScope = "paper",
  } = options;

  const botCfg = normalizeConfig(botConfig);
  const signalCfg = cloneCfg(rawSignalCfg);
  signalCfg._tradeSfp = Boolean(botCfg.tradeSfpSignals);
  signalCfg._tradeSfpBear = Boolean(botCfg.tradeBearishSfpSignals);
  signalCfg._tradePullback = Boolean(botCfg.tradePullbackSignals);
  signalCfg._tradePullbackBear = Boolean(botCfg.tradeBearishPullbackSignals);
  signalCfg._tradeFoi = Boolean(botCfg.tradeFoiSignals);
  signalCfg._tradeFoiBear = Boolean(botCfg.tradeBearishFoiSignals);
  const fmOpts = fastMoverOptsFromCfg(signalCfg);

  const barCount = Math.max(
    barsForDays(signalCfg, days),
    minHistoryBars(signalCfg) + 10
  );
  const signalInterval = signalCfg.interval ?? "1m";
  const needs1mBars =
    signalInterval !== "1m" && Boolean(fetchKlines1mForSymbol);
  const simBarCount = needs1mBars
    ? Math.max(
        barsForDays({ signalBarMs: 60_000 }, days),
        fastMoverLookbackFor1m(signalCfg) + 50
      )
    : barCount;

  const list = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols;
  const regimeStatsMap = new Map();
  const btcBarCache = { bars: [] };
  const perSymbol = [];
  const barCache = new Map();
  const simBarCache = new Map();
  const moverBarCache = new Map();
  const startedAt = Date.now();
  const klineCache = createBacktestKlineCache({
    days,
    interval: signalInterval,
    symbols: list,
    barCount,
    moverBarCount: simBarCount,
    needs1mBars,
  });
  const sim = createPaperBotSimulator(botCfg, {
    maxEvents: 25_000,
    modelScope,
    getRecentBars: (symbol, asOf, limit = 12) => {
      const bars = simBarCache.get(symbol) ?? barCache.get(symbol);
      if (!bars?.length) return [];
      let end = bars.length;
      if (asOf != null) {
        const idx = bars.findIndex((b) => b.closeTime > asOf);
        end = idx >= 0 ? idx : bars.length;
      }
      return bars.slice(Math.max(0, end - limit), end);
    },
    getBarsForRegime: (symbol, asOf) => {
      const bars = simBarCache.get(symbol) ?? barCache.get(symbol);
      if (!bars?.length) return [];
      let end = bars.length;
      if (asOf != null) {
        const idx = bars.findIndex((b) => b.closeTime > asOf);
        end = idx >= 0 ? idx : bars.length;
      }
      return bars.slice(Math.max(0, end - 120), end);
    },
    getBtcBarsForRegime: (asOf) => {
      const bars = btcBarCache.bars;
      if (!bars.length) return [];
      if (asOf == null) return bars;
      const idx = bars.findIndex((b) => b.closeTime > asOf);
      const end = idx >= 0 ? idx : bars.length;
      return bars.slice(0, end);
    },
    getFundingOiAt,
    tradeStatsMap: regimeStatsMap,
  });
  const restPause = () => (klineCache.bundleValid ? 0 : restGapMs);
  const progressYield = async () => {
    if (klineCache.bundleValid) await yieldToLoop();
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

  async function ensureBtcBarsLoaded() {
    if (btcBarCache.bars.length) return;
    const btcCount = Math.max(simBarCount, 800);
    try {
      if (typeof fetchRegimeBars === "function") {
        const fetched = await fetchRegimeBars(BTC_SYMBOL, days);
        if (Array.isArray(fetched) && fetched.length) {
          btcBarCache.bars = fetched;
          return;
        }
      }
      if (needs1mBars && fetchKlines1mForSymbol) {
        btcBarCache.bars = await klineCache.loadMoverBars(BTC_SYMBOL, (sym) =>
          fetchKlines1mForSymbol(sym, btcCount)
        );
      } else {
        btcBarCache.bars = await klineCache.loadSignalBars(BTC_SYMBOL, (sym) =>
          fetchKlinesForSymbol(sym, btcCount)
        );
      }
    } catch (e) {
      if (e.code === "BACKTEST_CANCELLED" || e.code === "QUEUE_RESET") throw e;
      console.error(`Backtest ${BTC_SYMBOL} bars: ${e.message}`);
    }
  }

  onProgress?.({
    phase: "loading",
    message: `Loading ${BTC_SYMBOL} for regime context…`,
  });
  await ensureBtcBarsLoaded();
  await progressYield();

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
      if (e.code === "BACKTEST_CANCELLED" || e.code === "QUEUE_RESET") throw e;
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

    let simBars = bars;
    let moverBars = bars;
    if (needs1mBars) {
      try {
        simBars = await klineCache.loadMoverBars(symbol, fetchKlines1mForSymbol);
        moverBars = simBars;
        simBarCache.set(symbol, simBars);
        moverBarCache.set(symbol, simBars);
      } catch (e) {
        if (e.code === "BACKTEST_CANCELLED" || e.code === "QUEUE_RESET") throw e;
        console.error(`Backtest ${symbol}: 1m bars failed (${e.message}), using signal bars`);
        simBars = bars;
        moverBars = bars;
      }
    } else {
      simBarCache.set(symbol, bars);
    }

    onProgress?.({
      phase: "simulate",
      done: i,
      total: list.length,
      symbol,
      ok: okCount(),
      skip: skipCount(),
      fromCache: klineCache.bundleValid,
      message: `Simulating ${symbol} (${simBars.length}×${needs1mBars ? "1m" : signalInterval} bars)…`,
    });
    await progressYield();

    perSymbol.push(
      await runSymbolBacktest(sim, symbol, bars, signalCfg, fmOpts, {
        botCfg,
        moverBars,
        simBars,
        getFundingOiAt,
        onProgress: (barIdx, barTotal) => {
          onProgress?.({
            phase: "simulate",
            done: i,
            total: list.length,
            symbol,
            ok: okCount(),
            skip: skipCount(),
            fromCache: klineCache.bundleValid,
            message: `Simulating ${symbol} (${barIdx}/${barTotal} bars)…`,
          });
        },
      })
    );

    if (needs1mBars) {
      simBarCache.delete(symbol);
    }
    if (!saveKlineCache) {
      barCache.delete(symbol);
      moverBarCache.delete(symbol);
      simBarCache.delete(symbol);
    }

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

  if (saveKlineCache) {
    try {
      onProgress?.({
        phase: "saving",
        done: list.length,
        total: list.length,
        message: `Saving kline cache (${barCache.size} symbols)…`,
      });
      await klineCache.saveFromBarCaches(barCache, moverBarCache);
    } catch (e) {
      console.error(`Backtest kline cache save failed: ${e.message}`);
    }
  }

  await yieldToLoop();

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
    simulationBarsPerSymbol: needs1mBars ? simBarCount : barCount,
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
      simulationInterval: needs1mBars ? "1m" : signalInterval,
      simulationBarsPerSymbol: needs1mBars ? simBarCount : barCount,
      signalBarsPerSymbol: barCount,
      moverBarsPerSymbol: needs1mBars ? simBarCount : null,
      klineCache: cacheStats,
    },
    snapshotsPending: false,
  };

  if (saveLastResult) {
    try {
      const runId = repos.backtest.saveBacktestRun(getDb(), result);
      const db = getDb();
      for (const trade of result.closedTrades ?? []) {
        if (!trade?.id) continue;
        upsertClosedTrade(db, "backtest", trade, runId);
      }
    } catch (e) {
      console.error(`backtest DB save failed: ${e.message}`);
    }
    writeJsonFile(RESULT_FILE(), result, { compact: true });
  }

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
  try {
    const fromDb = repos.backtest.loadLastBacktestResult(getDb());
    if (fromDb) return fromDb;
  } catch (e) {
    console.error(`loadLastBacktestResult DB: ${e.message}`);
  }
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
