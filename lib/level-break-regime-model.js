const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  FEATURE_NAMES,
  extractLevelBreakRegimeFeatures,
  featuresToVector,
  recordLevelBreakTradeStats,
  tradeStatsRowForSymbol,
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
} = require("./level-break-regime-features");
const { formatBtcTrendDetail, BTC_SYMBOL } = require("./btc-regime-context");
const { normalizeAiModelScope, modelFileFor } = require("./ai-model-scope");

const MODEL_BASENAME = "level-break-regime-model";
const MODEL_FILE = (scope = "paper") => modelFileFor(MODEL_BASENAME, scope);

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const LEVEL_BREAK_REGIME_DEFAULTS = {
  aiLevelBreakRegimeEnabled: false,
  aiLevelBreakRegimeThreshold: 0.58,
  aiLevelBreakRegimeBullThreshold: 0.76,
  aiLevelBreakRegimeBearThreshold: 0.74,
  aiRegimeBtcLookbackHours: 12,
};

const BOOTSTRAP_WEIGHTS_BULL = [
  0.3, 0.38, 0.12, 0.44, 0.24, 0.16, -0.1, 0.4, 0.32, 0.28, 0.18, 0.14, 0.14, 0.1,
];

const BOOTSTRAP_WEIGHTS_BEAR = [
  0.44, 0.5, 0.16, 0.6, 0.34, 0.22, -0.08, 0.54, 0.42, 0.36, 0.2, 0.2, 0.18, 0.12,
];

function bootstrapSubModel(weights, bias, threshold) {
  return {
    means: FEATURE_NAMES.map(() => 0),
    stds: FEATURE_NAMES.map(() => 1),
    weights,
    bias,
    threshold,
    metrics: { samples: 0, positiveRate: null, accuracy: null },
  };
}

const DEFAULT_MODEL = {
  version: 2,
  featureNames: FEATURE_NAMES,
  bull: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_BULL,
    -0.46,
    LEVEL_BREAK_REGIME_DEFAULTS.aiLevelBreakRegimeBullThreshold
  ),
  bear: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_BEAR,
    -0.36,
    LEVEL_BREAK_REGIME_DEFAULTS.aiLevelBreakRegimeBearThreshold
  ),
  trainedAt: null,
  source: "bootstrap",
};

let cachedModels = {};

function modelScopeKey(scope) {
  return normalizeAiModelScope(scope);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sigmoid(z) {
  const x = Math.max(-20, Math.min(20, z));
  return 1 / (1 + Math.exp(-x));
}

function isBearSignal(signalKind) {
  return String(signalKind || "") === "level_break_bear";
}

function normalizeLevelBreakRegimeConfig(raw = {}) {
  const legacy = clamp(
    num(raw.aiLevelBreakRegimeThreshold, LEVEL_BREAK_REGIME_DEFAULTS.aiLevelBreakRegimeThreshold),
    0.5,
    0.95
  );
  const bullTh = clamp(
    num(raw.aiLevelBreakRegimeBullThreshold, legacy),
    0.5,
    0.95
  );
  const bearTh = clamp(
    num(raw.aiLevelBreakRegimeBearThreshold, legacy),
    0.5,
    0.95
  );
  return {
    aiLevelBreakRegimeEnabled: Boolean(raw.aiLevelBreakRegimeEnabled),
    aiLevelBreakRegimeThreshold: legacy,
    aiLevelBreakRegimeBullThreshold: bullTh,
    aiLevelBreakRegimeBearThreshold: bearTh,
    aiRegimeBtcLookbackHours: clamp(
      Math.round(
        num(raw.aiRegimeBtcLookbackHours, LEVEL_BREAK_REGIME_DEFAULTS.aiRegimeBtcLookbackHours)
      ),
      1,
      72
    ),
  };
}

function alignFeatureVector(vec, len, fill = 0) {
  if (!Array.isArray(vec)) return Array(len).fill(fill);
  if (vec.length === len) return vec.map((v) => num(v, fill));
  if (vec.length > len) return vec.slice(0, len).map((v) => num(v, fill));
  return [...vec.map((v) => num(v, fill)), ...Array(len - vec.length).fill(fill)];
}

function normalizeSubModel(raw, fallback) {
  const weights = alignFeatureVector(raw?.weights, FEATURE_NAMES.length, 0);
  const means = alignFeatureVector(raw?.means ?? fallback.means, FEATURE_NAMES.length, 0);
  const stds = alignFeatureVector(raw?.stds ?? fallback.stds, FEATURE_NAMES.length, 1);
  for (let i = 0; i < stds.length; i++) {
    if (!Number.isFinite(stds[i]) || stds[i] < 1e-6) stds[i] = 1;
  }
  return {
    means,
    stds,
    weights,
    bias: num(raw.bias, fallback.bias),
    threshold: clamp(num(raw.threshold, fallback.threshold), 0.5, 0.95),
    metrics: raw.metrics ?? fallback.metrics ?? {},
  };
}

function normalizeStoredModel(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_MODEL,
      bull: { ...DEFAULT_MODEL.bull },
      bear: { ...DEFAULT_MODEL.bear },
    };
  }

  if (raw.version >= 2 && raw.bull) {
    return {
      version: 2,
      featureNames: FEATURE_NAMES,
      bull: normalizeSubModel(raw.bull, DEFAULT_MODEL.bull),
      bear: normalizeSubModel(raw.bear, DEFAULT_MODEL.bear),
      trainedAt: raw.trainedAt ?? null,
      source: raw.source ?? "file",
    };
  }

  return {
    ...DEFAULT_MODEL,
    bull: { ...DEFAULT_MODEL.bull },
    bear: { ...DEFAULT_MODEL.bear },
  };
}

function subModelForSignal(stored, signalKind) {
  return isBearSignal(signalKind) ? stored.bear : stored.bull;
}

function thresholdForSignal(regimeCfg, signalKind, subModel) {
  if (isBearSignal(signalKind)) {
    return (
      regimeCfg.aiLevelBreakRegimeBearThreshold ??
      regimeCfg.aiLevelBreakRegimeThreshold ??
      subModel.threshold ??
      0.74
    );
  }
  return (
    regimeCfg.aiLevelBreakRegimeBullThreshold ??
    regimeCfg.aiLevelBreakRegimeThreshold ??
    subModel.threshold ??
    0.76
  );
}

function loadModelFromDisk(scope = "paper") {
  return normalizeStoredModel(readJsonFile(MODEL_FILE(scope), null));
}

function getModel(scope = "paper") {
  const key = modelScopeKey(scope);
  if (!cachedModels[key]) cachedModels[key] = loadModelFromDisk(key);
  return cachedModels[key];
}

function reloadModel(scope = "paper") {
  const key = modelScopeKey(scope);
  cachedModels[key] = loadModelFromDisk(key);
  return cachedModels[key];
}

function saveModel(model, scope = "paper") {
  const key = modelScopeKey(scope);
  const normalized = normalizeStoredModel(model);
  writeJsonFile(MODEL_FILE(key), {
    ...normalized,
    scope: key,
    savedAt: Date.now(),
    savedAtIso: formatIsoUtcPlus3(Date.now()),
  });
  cachedModels[key] = normalized;
  return normalized;
}

function normalizeVector(vec, means, stds) {
  return vec.map((v, i) => {
    const std = stds[i] > 1e-6 ? stds[i] : 1;
    return (v - (means[i] ?? 0)) / std;
  });
}

function scoreSubModel(subModel, featureVec) {
  const m = normalizeSubModel(subModel, DEFAULT_MODEL.bull);
  const x = normalizeVector(featureVec, m.means, m.stds);
  let z = m.bias;
  for (let i = 0; i < x.length; i++) z += (m.weights[i] ?? 0) * x[i];
  return sigmoid(z);
}

function predictLevelBreakRegime(bars, extras = {}, model = getModel()) {
  const signalKind = extras.signalKind ?? "level_break";
  const stored = normalizeStoredModel(model);
  const sub = subModelForSignal(stored, signalKind);
  const metrics = extras.metrics
    ? regimeMetricsFromSignal(extras.metrics, signalKind)
    : null;
  const features = extractLevelBreakRegimeFeatures(bars, {
    metrics,
    tradeStats: extras.tradeStats ?? null,
    signalKind,
    btcBars: extras.btcBars ?? null,
    asOf: extras.asOf ?? null,
    btcLookbackHours:
      extras.btcLookbackHours ??
      normalizeLevelBreakRegimeConfig(extras.regimeCfg ?? {}).aiRegimeBtcLookbackHours ??
      LEVEL_BREAK_REGIME_DEFAULTS.aiRegimeBtcLookbackHours,
  });
  const vec = featuresToVector(features);
  const probability = scoreSubModel(sub, vec);
  return {
    probability,
    features,
    vec,
    signalKind,
    head: isBearSignal(signalKind) ? "bear" : "bull",
  };
}

function evaluateLevelBreakRegimeGate(cfg, bars, extras = {}) {
  const regimeCfg = normalizeLevelBreakRegimeConfig(cfg);
  if (!regimeCfg.aiLevelBreakRegimeEnabled) return { pass: true, enabled: false };
  if (!bars?.length) return { pass: true, enabled: true, waiting: true };

  const signalKind = extras.signalKind ?? "level_break";
  const modelScope = normalizeAiModelScope(extras.modelScope);
  const stored = normalizeStoredModel(extras.model ?? getModel(modelScope));
  const sub = subModelForSignal(stored, signalKind);
  const threshold = thresholdForSignal(regimeCfg, signalKind, sub);
  const metrics = extras.metrics
    ? regimeMetricsFromSignal(extras.metrics, signalKind)
    : null;
  const { probability, features, head } = predictLevelBreakRegime(
    bars,
    {
      ...extras,
      metrics: metrics ?? extras.metrics,
      signalKind,
      modelScope,
      regimeCfg,
      btcLookbackHours: regimeCfg.aiRegimeBtcLookbackHours,
    },
    stored
  );

  if (probability < threshold) {
    return { pass: true, enabled: true, probability, features, head, signalKind };
  }

  const side = isBearSignal(signalKind) ? "bear" : "bull";
  const btcNote = formatBtcTrendDetail(features);
  const detail = `bad ${side} level-break regime p=${(probability * 100).toFixed(0)}% · chop ${(
    (features.choppiness ?? 0) * 100
  ).toFixed(0)}% · touches ${((features.levelTouchesNorm ?? 0) * 8).toFixed(0)}${
    btcNote ? ` · ${btcNote}` : ""
  }`;
  return {
    pass: false,
    enabled: true,
    probability,
    features,
    detail,
    head,
    signalKind,
  };
}

function computeFeatureStats(samples) {
  const means = FEATURE_NAMES.map(() => 0);
  const stds = FEATURE_NAMES.map(() => 1);
  if (!samples.length) return { means, stds };
  const n = samples.length;
  for (const s of samples) {
    s.vec.forEach((v, i) => {
      means[i] += v;
    });
  }
  for (let i = 0; i < means.length; i++) means[i] /= n;
  const vars = FEATURE_NAMES.map(() => 0);
  for (const s of samples) {
    s.vec.forEach((v, i) => {
      const d = v - means[i];
      vars[i] += d * d;
    });
  }
  for (let i = 0; i < stds.length; i++) {
    stds[i] = Math.sqrt(vars[i] / n) || 1;
  }
  return { means, stds };
}

function trainLogisticRegression(samples, options = {}) {
  const epochs = options.epochs ?? 140;
  const lr = options.learningRate ?? 0.09;
  const l2 = options.l2 ?? 0.001;
  const { means, stds } = computeFeatureStats(samples);
  const weights = FEATURE_NAMES.map(() => 0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = weights.map(() => 0);
    let gradB = 0;
    for (const s of samples) {
      const x = normalizeVector(s.vec, means, stds);
      let z = bias;
      for (let i = 0; i < x.length; i++) z += weights[i] * x[i];
      const p = sigmoid(z);
      const err = p - s.label;
      for (let i = 0; i < x.length; i++) gradW[i] += err * x[i];
      gradB += err;
    }
    const invN = 1 / samples.length;
    for (let i = 0; i < weights.length; i++) {
      weights[i] -= lr * (gradW[i] * invN + l2 * weights[i]);
    }
    bias -= lr * gradB * invN;
    if (
      options.onProgress &&
      (epoch === 0 || epoch === epochs - 1 || (epoch + 1) % 10 === 0)
    ) {
      options.onProgress({
        phase: "fit",
        head: options.head ?? "model",
        done: epoch + 1,
        total: epochs,
        message: `Fitting ${options.head ?? "model"} (epoch ${epoch + 1}/${epochs})…`,
      });
    }
  }

  const threshold = options.threshold ?? 0.58;
  let correct = 0;
  for (const s of samples) {
    const x = normalizeVector(s.vec, means, stds);
    let z = bias;
    for (let i = 0; i < x.length; i++) z += weights[i] * x[i];
    const pred = sigmoid(z) >= threshold ? 1 : 0;
    if (pred === s.label) correct++;
  }
  const positive = samples.filter((s) => s.label === 1).length;
  return {
    means,
    stds,
    weights,
    bias,
    threshold,
    metrics: {
      samples: samples.length,
      positiveRate: samples.length ? +(positive / samples.length).toFixed(4) : null,
      accuracy: samples.length ? +(correct / samples.length).toFixed(4) : null,
    },
  };
}

function isLevelBreakTrade(trade) {
  const k = trade?.signalKind;
  return k === "level_break" || k === "level_break_bear";
}

function labelBadRegime(trade) {
  const pnl = num(trade.pnl, 0);
  const pnlPct = num(trade.pnlPct, 0);
  if (trade.exitReason === "stop_loss") return 1;
  if (pnl < 0 || pnlPct < -0.5) return 1;
  if (pnl > 0 && pnlPct > 0.2) return 0;
  return pnl <= 0 ? 1 : 0;
}

function barsBeforeTime(allBars, atMs, count = 120) {
  const idx = allBars.findIndex((b) => b.closeTime > atMs);
  const end = idx >= 0 ? idx : allBars.length;
  return allBars.slice(Math.max(0, end - count), end);
}

function barsForRegimeAtEntry(allBars, openedAt, count = 120) {
  if (!allBars?.length || openedAt == null) return [];
  return barsBeforeTime(allBars, openedAt, count);
}

function readSymbolBarsForTraining(fetchBars, symbol) {
  const sym = String(symbol || "").toUpperCase();
  const raw = fetchBars(sym);
  return Array.isArray(raw) ? raw : [];
}

async function buildTrainingSamples(trades, fetchBars, options = {}) {
  const samples = [];
  const cfg = normalizeLevelBreakRegimeConfig(options);
  const list = [...(trades ?? [])].sort(
    (a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0)
  );
  const total = list.length;
  const reportEvery = Math.max(1, Math.min(25, Math.floor(total / 40) || 1));
  const symbolBars = new Map();
  const statsMap = new Map();
  const btcBars =
    options.btcBars ??
    readSymbolBarsForTraining(
      options.fetchBtcBars ?? ((sym) => fetchBars(sym)),
      BTC_SYMBOL
    );

  function barsForSymbol(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!symbolBars.has(sym)) {
      symbolBars.set(sym, readSymbolBarsForTraining(fetchBars, sym));
    }
    return symbolBars.get(sym) ?? [];
  }

  for (let i = 0; i < total; i++) {
    const trade = list[i];
    if (!isLevelBreakTrade(trade) || !trade.openedAt) continue;
    const window = barsForRegimeAtEntry(barsForSymbol(trade.symbol), trade.openedAt, 120);
    if (window.length < 20) continue;

    const tradeStats = tradeStatsRowForSymbol(statsMap, trade.symbol);
    const features = extractLevelBreakRegimeFeatures(window, {
      metrics: regimeMetricsFromTrade(trade),
      tradeStats,
      signalKind: trade.signalKind,
      btcBars,
      asOf: trade.openedAt,
      btcLookbackHours: cfg.aiRegimeBtcLookbackHours,
    });
    samples.push({
      vec: featuresToVector(features),
      label: labelBadRegime(trade),
      signalKind: trade.signalKind,
    });
    recordLevelBreakTradeStats(statsMap, trade);

    if (i % reportEvery === 0 || i === total - 1) {
      options.onProgress?.({
        phase: "samples",
        done: i + 1,
        total,
        symbol: trade.symbol,
        samples: samples.length,
        message: `Building samples ${i + 1}/${total} (${trade.symbol}) · ${samples.length} rows`,
      });
      await yieldToLoop();
    }
  }
  return samples;
}

function balanceSamples(pos, neg, capMul = 2) {
  const maxNeg = Math.max(1, pos.length * capMul);
  const negSample =
    neg.length > maxNeg * 3
      ? neg.sort(() => Math.random() - 0.5).slice(0, maxNeg * 3)
      : neg;
  return [...pos, ...negSample].sort(() => Math.random() - 0.5);
}

async function trainFromTrades(trades, fetchBars, options = {}) {
  const cfg = normalizeLevelBreakRegimeConfig(options);
  const onProgress = options.onProgress;
  const lbTrades = (trades ?? []).filter(isLevelBreakTrade);
  if (lbTrades.length < 12) {
    throw new Error(
      `Need at least 12 level-break closed trades for training (got ${lbTrades.length})`
    );
  }

  onProgress?.({
    phase: "samples",
    done: 0,
    total: lbTrades.length,
    message: `Building samples from ${lbTrades.length} level-break trades…`,
  });

  const allSamples = await buildTrainingSamples(lbTrades, fetchBars, {
    ...options,
    onProgress,
  });
  if (allSamples.length < 30) {
    throw new Error(
      `Need at least 30 training samples with kline history (got ${allSamples.length})`
    );
  }

  const bullSamples = allSamples.filter((s) => s.signalKind === "level_break");
  const bearSamples = allSamples.filter((s) => s.signalKind === "level_break_bear");
  const bullPos = bullSamples.filter((s) => s.label === 1);
  const bullNeg = bullSamples.filter((s) => s.label === 0);
  const bearPos = bearSamples.filter((s) => s.label === 1);
  const bearNeg = bearSamples.filter((s) => s.label === 0);

  if (bullPos.length < 4 && bearPos.length < 4) {
    throw new Error(
      `Too few bad-regime labels (bull ${bullPos.length}, bear ${bearPos.length})`
    );
  }

  onProgress?.({
    phase: "balance",
    samples: allSamples.length,
    bull: bullSamples.length,
    bear: bearSamples.length,
    message: `Balancing bull ${bullSamples.length} / bear ${bearSamples.length} samples…`,
  });
  await yieldToLoop();

  const bullTrain =
    bullPos.length >= 4
      ? balanceSamples(
          bullPos.map((s) => ({ vec: s.vec, label: 1 })),
          bullNeg.map((s) => ({ vec: s.vec, label: 0 }))
        )
      : null;

  const bearTrain =
    bearPos.length >= 4
      ? balanceSamples(
          bearPos.map((s) => ({ vec: s.vec, label: 1 })),
          bearNeg.map((s) => ({ vec: s.vec, label: 0 }))
        )
      : null;

  onProgress?.({
    phase: "fit",
    message: `Training bull head (${bullTrain?.length ?? 0} rows)…`,
  });

  const bullModel =
    bullTrain?.length >= 12
      ? trainLogisticRegression(bullTrain, {
          head: "bull",
          threshold: cfg.aiLevelBreakRegimeBullThreshold,
          source: options.source ?? "trained",
          onProgress,
        })
      : { ...DEFAULT_MODEL.bull };

  onProgress?.({
    phase: "fit",
    message: `Training bear head (${bearTrain?.length ?? 0} rows)…`,
  });

  const bearModel =
    bearTrain?.length >= 12
      ? trainLogisticRegression(bearTrain, {
          head: "bear",
          threshold: cfg.aiLevelBreakRegimeBearThreshold,
          source: options.source ?? "trained",
          onProgress,
        })
      : { ...DEFAULT_MODEL.bear };

  onProgress?.({
    phase: "saving",
    message: "Saving model…",
  });

  return saveModel(
    {
      version: 2,
      featureNames: FEATURE_NAMES,
      bull: bullModel,
      bear: bearModel,
      trainedAt: Date.now(),
      source: options.source ?? "trained",
    },
    options.modelScope
  );
}

function getModelStatus(scope = "paper") {
  const key = modelScopeKey(scope);
  const model = normalizeStoredModel(getModel(key));
  return {
    ok: true,
    path: MODEL_FILE(key),
    scope: key,
    loaded: Boolean(model),
    version: model.version ?? 2,
    source: model.source,
    trainedAt: model.trainedAt ? formatIsoUtcPlus3(model.trainedAt) : null,
    threshold: model.bull.threshold,
    bullThreshold: model.bull.threshold,
    bearThreshold: model.bear.threshold,
    metrics: model.bull.metrics,
    bullMetrics: model.bull.metrics,
    bearMetrics: model.bear.metrics,
    featureCount: FEATURE_NAMES.length,
    defaults: LEVEL_BREAK_REGIME_DEFAULTS,
  };
}

function ensureDefaultModelOnDisk(scope = "paper") {
  const key = modelScopeKey(scope);
  if (!readJsonFile(MODEL_FILE(key), null)) {
    saveModel(
      {
        ...DEFAULT_MODEL,
        bull: { ...DEFAULT_MODEL.bull },
        bear: { ...DEFAULT_MODEL.bear },
      },
      key
    );
  }
}

function ensureAllDefaultModelsOnDisk() {
  ensureDefaultModelOnDisk("paper");
  ensureDefaultModelOnDisk("live");
}

module.exports = {
  LEVEL_BREAK_REGIME_DEFAULTS,
  MODEL_FILE,
  isBearSignal,
  normalizeLevelBreakRegimeConfig,
  getModel,
  reloadModel,
  saveModel,
  predictLevelBreakRegime,
  evaluateLevelBreakRegimeGate,
  barsForRegimeAtEntry,
  barsBeforeTime,
  buildTrainingSamples,
  trainFromTrades,
  getModelStatus,
  ensureDefaultModelOnDisk,
  ensureAllDefaultModelsOnDisk,
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
  thresholdForSignal,
  subModelForSignal,
};
