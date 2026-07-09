const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  FEATURE_NAMES,
  FEATURE_NAMES_WITH_FUNDING_OI,
  extractPullbackSignalFeatures,
  featuresToVector,
  recordPullbackTradeStats,
  tradeStatsRowForSymbol,
  regimeMetricsFromSignal,
  regimeMetricsFromTrade,
} = require("./pullback-signal-features");
const { formatBtcTrendDetail, BTC_SYMBOL } = require("./btc-regime-context");
const { normalizeAiModelScope, modelFileFor } = require("./ai-model-scope");
const {
  humanizeSource,
  formatRegimeStatus,
} = require("./ai-model-status-format");
const {
  loadGbmEnsemble,
  predictForHead,
  isOnnxRuntimeAvailable,
} = require("./pullback-signal-onnx");

const MODEL_BASENAME = "pullback-signal-model";
const MODEL_FILE = (scope = "paper") => modelFileFor(MODEL_BASENAME, scope);

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const PULLBACK_SIGNAL_DEFAULTS = {
  aiPullbackSignalEnabled: false,
  aiPullbackSignalThreshold: 0.52,
  aiPullbackSignalBullThreshold: 0.5,
  aiPullbackSignalBearThreshold: 0.54,
  aiPullbackSignalBtcLookbackHours: 12,
  aiPullbackSignalBtcFastLookbackHours: 1,
  aiPullbackSignalFundingOiEnabled: false,
  aiPullbackSignalOnnxEnabled: false,
  aiPullbackSignalFundingOiGbmEnabled: false,
  aiPullbackSignalGbmBullThreshold: 0.58,
  aiPullbackSignalGbmBearThreshold: 0.6,
};

const BOOTSTRAP_WEIGHTS_BULL = [
  0.2, 0.15, 0.35, -0.2, 0.45, 0.38, 0.42, 0.3, 0.4, 0.25, -0.15, 0.12, 0.2, 0.15, 0.08, 0.05,
];

const BOOTSTRAP_WEIGHTS_BEAR = [
  0.22, 0.18, 0.38, -0.18, 0.48, 0.4, 0.44, 0.32, 0.42, 0.28, -0.12, 0.14, 0.22, 0.18, 0.1, 0.06,
];

const BOOTSTRAP_WEIGHTS_BULL_FUNDING = [
  ...BOOTSTRAP_WEIGHTS_BULL,
  -0.08, 0.1, 0.12,
];

const BOOTSTRAP_WEIGHTS_BEAR_FUNDING = [
  ...BOOTSTRAP_WEIGHTS_BEAR,
  0.1, -0.08, 0.14,
];

function featureNamesForModel(stored) {
  if (Array.isArray(stored?.featureNames) && stored.featureNames.length) {
    return stored.featureNames;
  }
  return FEATURE_NAMES;
}

function bootstrapSubModel(weights, bias, threshold, featLen) {
  const len = featLen ?? weights.length;
  return {
    means: Array(len).fill(0),
    stds: Array(len).fill(1),
    weights: alignFeatureVector(weights, len, 0),
    bias,
    threshold,
    metrics: { samples: 0, positiveRate: null, accuracy: null },
  };
}

const DEFAULT_MODEL = {
  version: 2,
  backend: "logistic",
  featureNames: FEATURE_NAMES,
  bull: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_BULL,
    -0.25,
    PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBullThreshold,
    FEATURE_NAMES.length
  ),
  bear: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_BEAR,
    -0.2,
    PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBearThreshold,
    FEATURE_NAMES.length
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
  return String(signalKind || "") === "pullback_bear";
}

function normalizePullbackSignalConfig(raw = {}) {
  const legacy = clamp(
    num(raw.aiPullbackSignalThreshold, PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalThreshold),
    0.35,
    0.9
  );
  const bullTh = clamp(num(raw.aiPullbackSignalBullThreshold, legacy), 0.35, 0.9);
  const bearTh = clamp(num(raw.aiPullbackSignalBearThreshold, legacy), 0.35, 0.9);
  return {
    aiPullbackSignalEnabled: Boolean(raw.aiPullbackSignalEnabled),
    aiPullbackSignalThreshold: legacy,
    aiPullbackSignalBullThreshold: bullTh,
    aiPullbackSignalBearThreshold: bearTh,
    aiPullbackSignalBtcLookbackHours: clamp(
      Math.round(
        num(
          raw.aiPullbackSignalBtcLookbackHours,
          PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBtcLookbackHours
        )
      ),
      1,
      72
    ),
    aiPullbackSignalBtcFastLookbackHours: clamp(
      Math.round(
        num(
          raw.aiPullbackSignalBtcFastLookbackHours,
          PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBtcFastLookbackHours
        )
      ),
      1,
      24
    ),
    aiPullbackSignalFundingOiEnabled: Boolean(raw.aiPullbackSignalFundingOiEnabled),
    aiPullbackSignalOnnxEnabled: Boolean(raw.aiPullbackSignalOnnxEnabled),
    aiPullbackSignalFundingOiGbmEnabled: Boolean(raw.aiPullbackSignalFundingOiGbmEnabled),
    aiPullbackSignalGbmBullThreshold: clamp(
      num(raw.aiPullbackSignalGbmBullThreshold, PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalGbmBullThreshold),
      0.35,
      0.9
    ),
    aiPullbackSignalGbmBearThreshold: clamp(
      num(raw.aiPullbackSignalGbmBearThreshold, PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalGbmBearThreshold),
      0.35,
      0.9
    ),
  };
}

/** Effective config at runtime (GBM mode enables funding/OI + GBM backend). */
function pullbackSignalRuntimeConfig(raw = {}) {
  const c = normalizePullbackSignalConfig(raw);
  if (!c.aiPullbackSignalFundingOiGbmEnabled) return c;
  return {
    ...c,
    aiPullbackSignalFundingOiEnabled: true,
    aiPullbackSignalOnnxEnabled: true,
    aiPullbackSignalBullThreshold: c.aiPullbackSignalGbmBullThreshold,
    aiPullbackSignalBearThreshold: c.aiPullbackSignalGbmBearThreshold,
  };
}

function alignFeatureVector(vec, len, fill = 0) {
  if (!Array.isArray(vec)) return Array(len).fill(fill);
  if (vec.length === len) return vec.map((v) => num(v, fill));
  if (vec.length > len) return vec.slice(0, len).map((v) => num(v, fill));
  return [...vec.map((v) => num(v, fill)), ...Array(len - vec.length).fill(fill)];
}

function normalizeSubModel(raw, fallback, featLen) {
  const weights = alignFeatureVector(raw?.weights, featLen, 0);
  const means = alignFeatureVector(raw?.means ?? fallback.means, featLen, 0);
  const stds = alignFeatureVector(raw?.stds ?? fallback.stds, featLen, 1);
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

  const names = featureNamesForModel(raw);
  const featLen = names.length;
  const withFunding = featLen > FEATURE_NAMES.length;
  const fallbackBull = bootstrapSubModel(
    withFunding ? BOOTSTRAP_WEIGHTS_BULL_FUNDING : BOOTSTRAP_WEIGHTS_BULL,
    -0.25,
    PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBullThreshold,
    featLen
  );
  const fallbackBear = bootstrapSubModel(
    withFunding ? BOOTSTRAP_WEIGHTS_BEAR_FUNDING : BOOTSTRAP_WEIGHTS_BEAR,
    -0.2,
    PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBearThreshold,
    featLen
  );

  if (raw.version >= 2 && raw.bull) {
    return {
      version: raw.version,
      backend: raw.backend === "onnx" ? "onnx" : "logistic",
      featureNames: names,
      bull: normalizeSubModel(raw.bull, fallbackBull, featLen),
      bear: normalizeSubModel(raw.bear, fallbackBear, featLen),
      trainedAt: raw.trainedAt ?? null,
      source: raw.source ?? "file",
      onnxBullPath: raw.onnxBullPath ?? null,
      onnxBearPath: raw.onnxBearPath ?? null,
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

function thresholdForSignal(signalCfg, signalKind, subModel) {
  const c = normalizePullbackSignalConfig(signalCfg);
  if (isBearSignal(signalKind)) {
    return c.aiPullbackSignalBearThreshold ?? subModel?.threshold ?? 0.54;
  }
  return c.aiPullbackSignalBullThreshold ?? subModel?.threshold ?? 0.5;
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
  try {
    const { notifyModelSaved } = require("./db/registry-hooks");
    notifyModelSaved({
      modelName: MODEL_BASENAME,
      scope: key,
      filePath: MODEL_FILE(key),
      model: normalized,
    });
  } catch {
    /* ignore */
  }
  return normalized;
}

function normalizeVector(vec, means, stds) {
  return vec.map((v, i) => {
    const std = stds[i] > 1e-6 ? stds[i] : 1;
    return (v - (means[i] ?? 0)) / std;
  });
}

function scoreSubModel(subModel, featureVec) {
  const featLen = featureVec.length;
  const m = normalizeSubModel(subModel, bootstrapSubModel([], 0, 0.5, featLen), featLen);
  const x = normalizeVector(featureVec, m.means, m.stds);
  let z = m.bias;
  for (let i = 0; i < x.length; i++) z += (m.weights[i] ?? 0) * x[i];
  return sigmoid(z);
}

function resolveFeatureNames(stored, signalCfg, extras = {}) {
  if (Array.isArray(extras.featureNames) && extras.featureNames.length) {
    return extras.featureNames;
  }
  const cfg = pullbackSignalRuntimeConfig(signalCfg ?? extras);
  if (cfg.aiPullbackSignalFundingOiEnabled) {
    return FEATURE_NAMES_WITH_FUNDING_OI;
  }
  return featureNamesForModel(stored);
}

function buildFeatureExtras(bars, extras, signalKind, signalCfg) {
  const metrics = extras.metrics
    ? regimeMetricsFromSignal(extras.metrics, signalKind)
    : null;
  const fundingOi =
    extras.fundingOi ??
    extras.getFundingOiAt?.(extras.symbol, extras.asOf ?? null) ??
    null;
  return {
    metrics,
    tradeStats: extras.tradeStats ?? null,
    signalKind,
    symbol: extras.symbol ?? null,
    btcBars: extras.btcBars ?? null,
    asOf: extras.asOf ?? null,
    btcLookbackHours:
      extras.btcLookbackHours ??
      normalizePullbackSignalConfig(signalCfg ?? extras.signalCfg ?? {})
        .aiPullbackSignalBtcLookbackHours ??
      PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBtcLookbackHours,
    btcFastLookbackHours:
      extras.btcFastLookbackHours ??
      normalizePullbackSignalConfig(signalCfg ?? extras.signalCfg ?? {})
        .aiPullbackSignalBtcFastLookbackHours ??
      PULLBACK_SIGNAL_DEFAULTS.aiPullbackSignalBtcFastLookbackHours,
    fundingOi,
    getFundingOiAt: extras.getFundingOiAt ?? null,
  };
}

function predictPullbackSignal(bars, extras = {}, model = getModel()) {
  const signalKind = extras.signalKind ?? "pullback";
  const signalCfg = pullbackSignalRuntimeConfig(extras.signalCfg ?? extras);
  const stored = normalizeStoredModel(model);
  const sub = subModelForSignal(stored, signalKind);
  const featNames = resolveFeatureNames(stored, signalCfg, extras);
  const featureExtras = buildFeatureExtras(bars, { ...extras, signalCfg }, signalKind, signalCfg);
  const features = extractPullbackSignalFeatures(bars, featureExtras);
  const vec = featuresToVector(features, featNames);

  let probability;
  let backend = stored.backend ?? "logistic";
  const useOnnx = Boolean(signalCfg.aiPullbackSignalOnnxEnabled);
  if (useOnnx) {
    const head = isBearSignal(signalKind) ? "bear" : "bull";
    const scope = extras.modelScope ?? "paper";
    const gbm = loadGbmEnsemble(scope, head);
    if (gbm) {
      probability = predictForHead({ scope, head, featureVec: vec });
      backend = "gbm";
    } else {
      probability = scoreSubModel(sub, vec);
      backend = "logistic";
    }
  } else {
    probability = scoreSubModel(sub, vec);
    backend = "logistic";
  }

  return {
    probability,
    features,
    vec,
    signalKind,
    head: isBearSignal(signalKind) ? "bear" : "bull",
    backend,
    featureNames: featNames,
  };
}

function evaluatePullbackSignalGate(cfg, bars, extras = {}) {
  const signalCfg = pullbackSignalRuntimeConfig(cfg);
  if (!signalCfg.aiPullbackSignalEnabled) return { pass: true, enabled: false };
  if (!bars?.length) return { pass: true, enabled: true, waiting: true };

  const signalKind = extras.signalKind ?? "pullback";
  const modelScope = normalizeAiModelScope(extras.modelScope);
  const stored = normalizeStoredModel(extras.model ?? getModel(modelScope));
  const sub = subModelForSignal(stored, signalKind);
  const threshold = thresholdForSignal(signalCfg, signalKind, sub);
  const { probability, features, head, backend } = predictPullbackSignal(
    bars,
    {
      ...extras,
      signalKind,
      modelScope,
      signalCfg,
      btcLookbackHours: signalCfg.aiPullbackSignalBtcLookbackHours,
      btcFastLookbackHours: signalCfg.aiPullbackSignalBtcFastLookbackHours,
    },
    stored
  );

  if (probability >= threshold) {
    return {
      pass: true,
      enabled: true,
      probability,
      features,
      head,
      signalKind,
      threshold,
      backend,
    };
  }

  const side = isBearSignal(signalKind) ? "bear" : "bull";
  const btcNote = formatBtcTrendDetail(features);
  const detail = `weak ${side} pullback signal p=${(probability * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}% · break ${(
    (features.breakStrength ?? 0) * 100
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
    threshold,
    backend,
  };
}

function computeFeatureStats(samples, featLen) {
  const means = Array(featLen).fill(0);
  const stds = Array(featLen).fill(1);
  if (!samples.length) return { means, stds };
  const n = samples.length;
  for (const s of samples) {
    s.vec.forEach((v, i) => {
      means[i] += v;
    });
  }
  for (let i = 0; i < means.length; i++) means[i] /= n;
  const vars = Array(featLen).fill(0);
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
  const featLen = samples[0]?.vec?.length ?? FEATURE_NAMES.length;
  const epochs = options.epochs ?? 140;
  const lr = options.learningRate ?? 0.09;
  const l2 = options.l2 ?? 0.001;
  const { means, stds } = computeFeatureStats(samples, featLen);
  const weights = Array(featLen).fill(0);
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

function isPullbackTrade(trade) {
  const k = trade?.signalKind;
  return k === "pullback" || k === "pullback_bear";
}

function labelGoodSignal(trade) {
  const pnl = num(trade.pnl, 0);
  const pnlPct = num(trade.pnlPct, 0);
  if (pnl > 0 || pnlPct > 0.15) return 1;
  if (trade.exitReason === "take_profit") return 1;
  if (trade.exitReason === "stop_loss") return 0;
  return pnl >= 0 ? 1 : 0;
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
  const cfg = normalizePullbackSignalConfig(options);
  const featNames =
    options.featureNames ??
    (cfg.aiPullbackSignalFundingOiEnabled
      ? FEATURE_NAMES_WITH_FUNDING_OI
      : FEATURE_NAMES);
  const getFundingOiAt = options.getFundingOiAt ?? null;
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
    if (!isPullbackTrade(trade) || !trade.openedAt) continue;
    const window = barsForRegimeAtEntry(barsForSymbol(trade.symbol), trade.openedAt, 120);
    if (window.length < 20) continue;

    const tradeStats = tradeStatsRowForSymbol(statsMap, trade.symbol);
    const fundingOi = getFundingOiAt?.(trade.symbol, trade.openedAt) ?? null;
    const features = extractPullbackSignalFeatures(window, {
      metrics: regimeMetricsFromTrade(trade),
      tradeStats,
      signalKind: trade.signalKind,
      symbol: trade.symbol,
      btcBars,
      asOf: trade.openedAt,
      btcLookbackHours: cfg.aiPullbackSignalBtcLookbackHours,
      btcFastLookbackHours: cfg.aiPullbackSignalBtcFastLookbackHours,
      fundingOi,
    });
    samples.push({
      vec: featuresToVector(features, featNames),
      label: labelGoodSignal(trade),
      signalKind: trade.signalKind,
    });
    recordPullbackTradeStats(statsMap, trade);

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
  const cfg = normalizePullbackSignalConfig(options);
  const onProgress = options.onProgress;
  const featNames =
    options.featureNames ??
    (cfg.aiPullbackSignalFundingOiEnabled
      ? FEATURE_NAMES_WITH_FUNDING_OI
      : FEATURE_NAMES);
  const lbTrades = (trades ?? []).filter(isPullbackTrade);
  if (lbTrades.length < 12) {
    throw new Error(
      `Need at least 12 pullback closed trades for training (got ${lbTrades.length})`
    );
  }

  onProgress?.({
    phase: "samples",
    done: 0,
    total: lbTrades.length,
    message: `Building samples from ${lbTrades.length} pullback trades…`,
  });

  const allSamples = await buildTrainingSamples(lbTrades, fetchBars, {
    ...options,
    onProgress,
    featureNames: featNames,
  });
  if (allSamples.length < 30) {
    throw new Error(
      `Need at least 30 training samples with kline history (got ${allSamples.length})`
    );
  }

  const bullSamples = allSamples.filter((s) => s.signalKind === "pullback");
  const bearSamples = allSamples.filter((s) => s.signalKind === "pullback_bear");
  const bullPos = bullSamples.filter((s) => s.label === 1);
  const bullNeg = bullSamples.filter((s) => s.label === 0);
  const bearPos = bearSamples.filter((s) => s.label === 1);
  const bearNeg = bearSamples.filter((s) => s.label === 0);

  if (bullPos.length < 4 && bearPos.length < 4) {
    throw new Error(
      `Too few winning pullback labels (bull ${bullPos.length}, bear ${bearPos.length})`
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
          threshold: cfg.aiPullbackSignalBullThreshold,
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
          threshold: cfg.aiPullbackSignalBearThreshold,
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
      backend: "logistic",
      featureNames: featNames,
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
  const names = featureNamesForModel(model);
  return {
    ok: true,
    path: MODEL_FILE(key),
    scope: key,
    loaded: Boolean(model),
    version: model.version ?? 2,
    backend: model.backend ?? "logistic",
    source: model.source,
    sourceLabel: humanizeSource(model.source),
    trainedAt: model.trainedAt ? formatIsoUtcPlus3(model.trainedAt) : null,
    trainedAtMs: model.trainedAt ?? null,
    threshold: model.bull.threshold,
    bullThreshold: model.bull.threshold,
    bearThreshold: model.bear.threshold,
    metrics: model.bull.metrics,
    bullMetrics: model.bull.metrics,
    bearMetrics: model.bear.metrics,
    featureCount: names.length,
    featureNames: names,
    gbmAvailable: Boolean(loadGbmEnsemble(key, "bull") && loadGbmEnsemble(key, "bear")),
    onnxAvailable: isOnnxRuntimeAvailable(),
    defaults: PULLBACK_SIGNAL_DEFAULTS,
    summary: formatRegimeStatus({
      scope: key,
      source: model.source,
      trainedAt: model.trainedAt,
      bullMetrics: model.bull.metrics,
      bearMetrics: model.bear.metrics,
      version: model.version,
      modelLabel: "pullback signal",
      bullThreshold: model.bull.threshold,
      bearThreshold: model.bear.threshold,
    }),
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
  PULLBACK_SIGNAL_DEFAULTS,
  MODEL_FILE,
  FEATURE_NAMES,
  FEATURE_NAMES_WITH_FUNDING_OI,
  featureNamesForModel,
  isBearSignal,
  normalizePullbackSignalConfig,
  pullbackSignalRuntimeConfig,
  getModel,
  reloadModel,
  saveModel,
  predictPullbackSignal,
  evaluatePullbackSignalGate,
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
  labelGoodSignal,
};
