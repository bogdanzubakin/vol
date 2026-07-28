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
const { evaluateFoiLong, evaluateFoiBear, foiCrowdingOk } = require("./foi-signal");
const {
  evaluateFalseBreakoutLong,
  evaluateFalseBreakoutBear,
} = require("./false-breakout-signal");
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

const SIM_YIELD_EVERY_DEFAULT = (() => {
  const raw = process.env.BACKTEST_SIM_YIELD_EVERY;
  if (raw === undefined || raw === "") return 200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
})();
const SIM_PROGRESS_MIN_MS = 5000;
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/** First index with closeTime > asOfMs; bars.length if all <= asOf. O(log n). */
function endIndexAfterAsOf(bars, asOfMs) {
  if (!bars?.length) return 0;
  if (asOfMs == null || !Number.isFinite(asOfMs)) return bars.length;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeTime <= asOfMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

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
  const simYieldEvery =
    extras.simYieldEvery != null ? extras.simYieldEvery : SIM_YIELD_EVERY_DEFAULT;

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
  const needsPriceWindow =
    signalCfg._tradeSfp ||
    signalCfg._tradeSfpBear ||
    signalCfg._tradePullback ||
    signalCfg._tradePullbackBear ||
    signalCfg._tradeFalseBreakout ||
    signalCfg._tradeFalseBreakoutBear;

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
  let prevFb = false;
  let prevFbBear = false;
  let sfpEdges = 0;
  let sfpBearEdges = 0;
  let pbEdges = 0;
  let pbBearEdges = 0;
  let foiEdges = 0;
  let foiBearEdges = 0;
  let fbEdges = 0;
  let fbBearEdges = 0;
  let signalIdx = -1;
  const tradesBefore = sim.getClosedTrades().length;

  for (let i = 0; i < timeline.length; i++) {
    const bar = timeline[i];
    const shouldReport =
      i === 0 ||
      i === timeline.length - 1 ||
      (simYieldEvery > 0 && i % simYieldEvery === 0) ||
      Date.now() - lastProgressAt >= SIM_PROGRESS_MIN_MS;
    if (shouldReport) {
      onProgress?.(i, timeline.length);
      lastProgressAt = Date.now();
      if (i > 0 && simYieldEvery > 0) await yieldToLoop();
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
      let window = null;
      let moverWindow = null;
      const getWindow = () => {
        if (!window) window = barsWindowAt(signals, signalIdx, need);
        return window;
      };
      const getMoverWindow = () => {
        if (moverWindow) return moverWindow;
        const base = getWindow();
        moverWindow = base;
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
        return moverWindow;
      };
      if (needsPriceWindow) {
        getWindow();
        getMoverWindow();
      }

      if (signalCfg._tradeSfp) {
        const sfp = analyzeSweepReclaim(getWindow(), signalCfg);
        const sfpPass = Boolean(sfp.passes);
        if (
          sfpPass &&
          !prevSfp &&
          sfp.metrics &&
          extremalSpikeAllows(signalBar.closeTime, getWindow(), "LONG")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onSfpSignal(symbol, sfp.metrics, signalBar.closeTime);
          if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
          sfpEdges++;
        }
        prevSfp = sfpPass;
      }

      if (signalCfg._tradeSfpBear) {
        const sfpBear = analyzeSweepReject(getWindow(), signalCfg);
        const bearPass = Boolean(sfpBear.passes);
        if (
          bearPass &&
          !prevSfpBear &&
          sfpBear.metrics &&
          extremalSpikeAllows(signalBar.closeTime, getWindow(), "SHORT")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onSfpBearSignal(symbol, sfpBear.metrics, signalBar.closeTime);
          if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
          sfpBearEdges++;
        }
        prevSfpBear = bearPass;
      }

      if (signalCfg._tradePullback) {
        const pb = fastMoverPullbackMetrics(
          getWindow(),
          signalCfg,
          fmOpts,
          getMoverWindow()
        );
        const pbPass = Boolean(pb?.passes);
        if (
          pbPass &&
          !prevPb &&
          pb &&
          extremalSpikeAllows(signalBar.closeTime, getWindow(), "LONG")
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
          getWindow(),
          signalCfg,
          fmOpts,
          getMoverWindow()
        );
        const pbBearPass = Boolean(pbBear?.passes);
        if (
          pbBearPass &&
          !prevPbBear &&
          pbBear &&
          extremalSpikeAllows(signalBar.closeTime, getWindow(), "SHORT")
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
          let foiPass = false;
          let foi = null;
          if (foiCrowdingOk(fundingOi, mergedCfg, "long")) {
            foi = evaluateFoiLong(
              getWindow(),
              mergedCfg,
              fundingOi,
              fmOpts,
              getMoverWindow()
            );
            foiPass = Boolean(foi?.passes);
          }
          if (
            foiPass &&
            !prevFoi &&
            foi &&
            extremalSpikeAllows(signalBar.closeTime, getWindow(), "LONG")
          ) {
            const hadOpen = sim.hasOpen(symbol);
            sim.onFoiSignal(symbol, foi, signalBar.closeTime);
            if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
            foiEdges++;
          }
          prevFoi = foiPass;
        }

        if (signalCfg._tradeFoiBear) {
          let foiBearPass = false;
          let foiBear = null;
          if (foiCrowdingOk(fundingOi, mergedCfg, "short")) {
            foiBear = evaluateFoiBear(
              getWindow(),
              mergedCfg,
              fundingOi,
              fmOpts,
              getMoverWindow()
            );
            foiBearPass = Boolean(foiBear?.passes);
          }
          if (
            foiBearPass &&
            !prevFoiBear &&
            foiBear &&
            extremalSpikeAllows(signalBar.closeTime, getWindow(), "SHORT")
          ) {
            const hadOpen = sim.hasOpen(symbol);
            sim.onFoiBearSignal(symbol, foiBear, signalBar.closeTime);
            if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
            foiBearEdges++;
          }
          prevFoiBear = foiBearPass;
        }
      }

      if (signalCfg._tradeFalseBreakout) {
        const fb = evaluateFalseBreakoutLong(getWindow(), {
          ...signalCfg,
          ...botCfg,
        });
        const fbPass = Boolean(fb?.passes);
        if (
          fbPass &&
          !prevFb &&
          fb &&
          extremalSpikeAllows(signalBar.closeTime, getWindow(), "LONG")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onFalseBreakoutSignal(symbol, fb, signalBar.closeTime);
          if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
          fbEdges++;
        }
        prevFb = fbPass;
      }

      if (signalCfg._tradeFalseBreakoutBear) {
        const fbBear = evaluateFalseBreakoutBear(getWindow(), {
          ...signalCfg,
          ...botCfg,
        });
        const fbBearPass = Boolean(fbBear?.passes);
        if (
          fbBearPass &&
          !prevFbBear &&
          fbBear &&
          extremalSpikeAllows(signalBar.closeTime, getWindow(), "SHORT")
        ) {
          const hadOpen = sim.hasOpen(symbol);
          sim.onFalseBreakoutBearSignal(symbol, fbBear, signalBar.closeTime);
          if (!hadOpen && sim.hasOpen(symbol)) openedThisBar = true;
          fbBearEdges++;
        }
        prevFbBear = fbBearPass;
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
    signals: sfpEdges + sfpBearEdges + pbEdges + pbBearEdges + foiEdges + foiBearEdges + fbEdges + fbBearEdges,
    sfpSignals: sfpEdges,
    sfpBearSignals: sfpBearEdges,
    pullbackSignals: pbEdges,
    pullbackBearSignals: pbBearEdges,
    foiSignals: foiEdges,
    foiBearSignals: foiBearEdges,
    falseBreakoutSignals: fbEdges,
    falseBreakoutBearSignals: fbBearEdges,
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
    /** Bypass on-disk kline bundle (use fetchKlines* for shifted windows). */
    forceKlineFetch = false,
    /** Optional shared FOI follow-through regime tracker across batches. */
    foiFollowthroughTracker = null,
    /** Optional shared FOI cold-day tracker across batches. */
    foiColdDayTracker = null,
    /** Optional shared FOI mid-day cold-pause tracker across batches. */
    foiMiddayColdPauseTracker = null,
    /**
     * Yield to event loop every N sim bars (0 = never).
     * Default: BACKTEST_SIM_YIELD_EVERY or 200. CLI batch jobs should pass 0.
     */
    simYieldEvery = SIM_YIELD_EVERY_DEFAULT,
  } = options;

  const botCfg = normalizeConfig(botConfig);
  const signalCfg = cloneCfg(rawSignalCfg);
  signalCfg._tradeSfp = Boolean(botCfg.tradeSfpSignals);
  signalCfg._tradeSfpBear = Boolean(botCfg.tradeBearishSfpSignals);
  signalCfg._tradePullback = Boolean(botCfg.tradePullbackSignals);
  signalCfg._tradePullbackBear = Boolean(botCfg.tradeBearishPullbackSignals);
  signalCfg._tradeFoi = Boolean(botCfg.tradeFoiSignals);
  signalCfg._tradeFoiBear = Boolean(botCfg.tradeBearishFoiSignals);
  signalCfg._tradeFalseBreakout = Boolean(botCfg.tradeFalseBreakoutSignals);
  signalCfg._tradeFalseBreakoutBear = Boolean(
    botCfg.tradeBearishFalseBreakoutSignals
  );
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
    forceFetch: Boolean(forceKlineFetch),
  });
  const sim = createPaperBotSimulator(botCfg, {
    maxEvents: 25_000,
    modelScope,
    ...(foiFollowthroughTracker ? { foiFollowthroughTracker } : {}),
    ...(foiColdDayTracker ? { foiColdDayTracker } : {}),
    ...(foiMiddayColdPauseTracker ? { foiMiddayColdPauseTracker } : {}),
    getRecentBars: (symbol, asOf, limit = 12) => {
      const bars = simBarCache.get(symbol) ?? barCache.get(symbol);
      if (!bars?.length) return [];
      const end = endIndexAfterAsOf(bars, asOf);
      return bars.slice(Math.max(0, end - limit), end);
    },
    getBarsForRegime: (symbol, asOf) => {
      const bars = simBarCache.get(symbol) ?? barCache.get(symbol);
      if (!bars?.length) return [];
      const end = endIndexAfterAsOf(bars, asOf);
      // 400×1m ≈ 6.5h — FOI BTC lookalike 4h + VWAP120 trail window.
      return bars.slice(Math.max(0, end - 400), end);
    },
    getBtcBarsForRegime: (asOf) => {
      const bars = btcBarCache.bars;
      if (!bars.length) return [];
      if (asOf == null) return bars;
      const end = endIndexAfterAsOf(bars, asOf);
      return bars.slice(Math.max(0, end - 400), end);
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
    if (simYieldEvery > 0) await progressYield();

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
      if (simYieldEvery > 0) await progressYield();
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

    // Prefetch next symbol's signal bars (I/O only; sim order unchanged).
    const nextSymbol = list[i + 1];
    const prefetchPromise =
      nextSymbol && typeof fetchKlinesForSymbol === "function"
        ? klineCache
            .loadSignalBars(nextSymbol, fetchKlinesForSymbol)
            .catch(() => null)
        : null;

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
    if (simYieldEvery > 0) await progressYield();

    perSymbol.push(
      await runSymbolBacktest(sim, symbol, bars, signalCfg, fmOpts, {
        botCfg,
        moverBars,
        simBars,
        getFundingOiAt,
        simYieldEvery,
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

    if (prefetchPromise) await prefetchPromise;

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
    if (simYieldEvery > 0) await progressYield();
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
