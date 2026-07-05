const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  FEATURE_NAMES,
  extractPullbackPatternBreakFeatures,
  featuresToVector,
  recordPullbackTradeStats,
  tradeStatsRowForSymbol,
  patternMetricsFromSignal,
  patternMetricsFromTrade,
} = require("./pullback-pattern-break-features");
const { formatBtcTrendDetail, BTC_SYMBOL } = require("./btc-regime-context");
const { normalizeAiModelScope, modelFileFor } = require("./ai-model-scope");
const {
  humanizeSource,
  formatRegimeStatus,
} = require("./ai-model-status-format");

const MODEL_BASENAME = "pullback-pattern-break-model";
const MODEL_FILE = (scope = "paper") => modelFileFor(MODEL_BASENAME, scope);

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const PULLBACK_PATTERN_BREAK_DEFAULTS = {
  aiPullbackPatternBreakEnabled: false,
  aiPullbackPatternBreakThreshold: 0.58,
  aiPullbackPatternBreakBullThreshold: 0.72,
  aiPullbackPatternBreakBearThreshold: 0.7,
  aiPullbackPatternBreakBtcLookbackHours: 24,
};

/** Minimum in-sample rows to enable a regime head at inference (below → filter off, no bootstrap). */
const MIN_HEAD_SAMPLES = 30;

const BOOTSTRAP_WEIGHTS_BULL = [
  0.55, 0.48, 0.52, 0.45, 0.38, -0.35, -0.4, 0.2, 0.28, 0.15, 0.22, -0.25, 0.18, 0.2, 0.16,
  0.24, 0.3, 0.14, 0.12, 0.26, 0.18, 0.2, 0.1, 0.32, -0.12, 0.14, 0.1,
];

const BOOTSTRAP_WEIGHTS_BEAR = [
  0.58, 0.5, 0.54, 0.48, 0.4, -0.38, -0.42, 0.22, 0.3, 0.18, 0.24, -0.28, 0.2, 0.22, 0.18,
  0.26, 0.32, 0.16, 0.14, 0.28, 0.2, 0.22, 0.12, 0.35, -0.14, 0.16, 0.12,
];

function featureNamesForModel(stored) {
  if (Array.isArray(stored?.featureNames) && stored.featureNames.length) {
    return stored.featureNames;
  }
  return FEATURE_NAMES;
}

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

function disabledHeadSubModel() {
  return {
    disabled: true,
    means: [],
    stds: [],
    weights: [],
    bias: 0,
    threshold: null,
    metrics: { samples: 0, positiveRate: null, accuracy: null },
  };
}

function headSampleCount(sub) {
  return num(sub?.metrics?.samples, 0);
}

function isHeadActive(sub) {
  if (sub?.disabled) return false;
  return headSampleCount(sub) >= MIN_HEAD_SAMPLES;
}

const DEFAULT_MODEL = {
  version: 3,
  featureNames: FEATURE_NAMES,
  bull: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_BULL,
    -0.46,
    PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBullThreshold
  ),
  bear: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_BEAR,
    -0.36,
    PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBearThreshold
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

function normalizePullbackPatternBreakConfig(raw = {}) {
  const legacy = clamp(
    num(raw.aiPullbackPatternBreakThreshold, PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakThreshold),
    0.5,
    0.95
  );
  const bullTh = clamp(
    num(
      raw.aiPullbackPatternBreakBullThreshold,
      PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBullThreshold
    ),
    0.5,
    0.95
  );
  const bearTh = clamp(
    num(
      raw.aiPullbackPatternBreakBearThreshold,
      PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBearThreshold
    ),
    0.5,
    0.95
  );
  return {
    aiPullbackPatternBreakEnabled: Boolean(raw.aiPullbackPatternBreakEnabled),
    aiPullbackPatternBreakThreshold: legacy,
    aiPullbackPatternBreakBullThreshold: bullTh,
    aiPullbackPatternBreakBearThreshold: bearTh,
    aiPullbackPatternBreakBtcLookbackHours: clamp(
      Math.round(
        num(
          raw.aiPullbackPatternBreakBtcLookbackHours,
          PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBtcLookbackHours
        )
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

function normalizeSubModel(raw, fallback, featLen = FEATURE_NAMES.length) {
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
    threshold: raw?.disabled
      ? null
      : clamp(num(raw.threshold, fallback.threshold), 0.5, 0.95),
    disabled: Boolean(raw?.disabled),
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
  const fallbackBull = bootstrapSubModel(
    alignFeatureVector(BOOTSTRAP_WEIGHTS_BULL, featLen, 0),
    -0.46,
    PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBullThreshold
  );
  const fallbackBear = bootstrapSubModel(
    alignFeatureVector(BOOTSTRAP_WEIGHTS_BEAR, featLen, 0),
    -0.36,
    PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBearThreshold
  );

  if (raw.bull && raw.bear) {
    return {
      version: raw.version >= 3 ? 3 : raw.version >= 2 ? 2 : 1,
      featureNames: names,
      bull: normalizeSubModel(raw.bull, fallbackBull, featLen),
      bear: normalizeSubModel(raw.bear, fallbackBear, featLen),
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

function thresholdForSignal(pbCfg, signalKind, subModel) {
  if (isBearSignal(signalKind)) {
    return (
      pbCfg.aiPullbackPatternBreakBearThreshold ??
      pbCfg.aiPullbackPatternBreakThreshold ??
      subModel.threshold ??
      0.7
    );
  }
  return (
    pbCfg.aiPullbackPatternBreakBullThreshold ??
    pbCfg.aiPullbackPatternBreakThreshold ??
    subModel.threshold ??
    0.72
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

function scoreSubModel(subModel, featureVec, featLen = featureVec.length) {
  const m = normalizeSubModel(subModel, DEFAULT_MODEL.bull, featLen);
  const x = normalizeVector(featureVec, m.means, m.stds);
  let z = m.bias;
  for (let i = 0; i < x.length; i++) z += (m.weights[i] ?? 0) * x[i];
  return sigmoid(z);
}

function predictPullbackPatternBreak(bars, extras = {}, model = getModel()) {
  const signalKind = extras.signalKind ?? "pullback";
  const stored = normalizeStoredModel(model);
  const featNames = featureNamesForModel(stored);
  const sub = subModelForSignal(stored, signalKind);
  const metrics = extras.metrics
    ? patternMetricsFromSignal(extras.metrics, signalKind)
    : null;
  const features = extractPullbackPatternBreakFeatures(bars, {
    metrics,
    tradeStats: extras.tradeStats ?? null,
    signalKind,
    btcBars: extras.btcBars ?? null,
    asOf: extras.asOf ?? null,
    btcLookbackHours:
      extras.btcLookbackHours ??
      normalizePullbackPatternBreakConfig(extras.patternBreakCfg ?? extras.regimeCfg ?? {}).aiPullbackPatternBreakBtcLookbackHours ??
      PULLBACK_PATTERN_BREAK_DEFAULTS.aiPullbackPatternBreakBtcLookbackHours,
  });
  const vec = featuresToVector(features, featNames);
  const probability = scoreSubModel(sub, vec, featNames.length);
  return {
    probability,
    features,
    vec,
    signalKind,
    head: isBearSignal(signalKind) ? "bear" : "bull",
  };
}

function evaluatePullbackPatternBreakGate(cfg, bars, extras = {}) {
  const pbCfg = normalizePullbackPatternBreakConfig(cfg);
  if (!pbCfg.aiPullbackPatternBreakEnabled) return { pass: true, enabled: false };
  if (!bars?.length) return { pass: true, enabled: true, waiting: true };

  const signalKind = extras.signalKind ?? "pullback";
  const modelScope = normalizeAiModelScope(extras.modelScope);
  const stored = normalizeStoredModel(extras.model ?? getModel(modelScope));

  if (!isBearSignal(signalKind) && !isHeadActive(stored.bull)) {
    return {
      pass: true,
      enabled: true,
      headDisabled: true,
      head: "bull",
      signalKind,
    };
  }

  const sub = subModelForSignal(stored, signalKind);
  const threshold = thresholdForSignal(pbCfg, signalKind, sub);
  const metrics = extras.metrics
    ? patternMetricsFromSignal(extras.metrics, signalKind)
    : null;
  const { probability, features, head } = predictPullbackPatternBreak(
    bars,
    {
      ...extras,
      metrics: metrics ?? extras.metrics,
      signalKind,
      modelScope,
      patternBreakCfg: pbCfg,
      btcLookbackHours: pbCfg.aiPullbackPatternBreakBtcLookbackHours,
    },
    stored
  );

  if (probability < threshold) {
    return { pass: true, enabled: true, probability, features, head, signalKind };
  }

  const side = isBearSignal(signalKind) ? "bear" : "bull";
  const btcNote = formatBtcTrendDetail(features);
  const detail = `broken ${side} pullback pattern p=${(probability * 100).toFixed(0)}% · corridor ${(
    (features.corridorBreakScore ?? 0) * 100
  ).toFixed(0)}% · reclaim ${((features.reclaimBreakScore ?? 0) * 100).toFixed(0)}% · bounce fail ${(
    (features.failedBounce ?? 0) * 100
  ).toFixed(0)}%${
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
  const dim = samples[0]?.vec?.length ?? FEATURE_NAMES.length;
  const means = Array(dim).fill(0);
  const stds = Array(dim).fill(1);
  if (!samples.length) return { means, stds };
  const n = samples.length;
  for (const s of samples) {
    s.vec.forEach((v, i) => {
      means[i] += v;
    });
  }
  for (let i = 0; i < means.length; i++) means[i] /= n;
  const vars = Array(dim).fill(0);
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
  const dim = samples[0]?.vec?.length ?? FEATURE_NAMES.length;
  const { means, stds } = computeFeatureStats(samples);
  const weights = Array(dim).fill(0);
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

function barsHeldEstimate(trade, barMs = 5 * 60 * 1000) {
  const opened = num(trade.openedAt, 0);
  const closed = num(trade.closedAt, 0);
  if (!opened || !closed || closed <= opened) return null;
  return Math.round((closed - opened) / barMs);
}

/** Tight label: early invalidation/adverse or quick SL only (not all stop-outs). */
function labelBrokenPattern(trade) {
  const reason = String(trade?.exitReason ?? "");
  const held = barsHeldEstimate(trade);
  const pnlPct = num(trade.pnlPct, 0);

  if (reason === "early_invalidation" || reason === "early_adverse") return 1;
  if (reason === "early_stall" && held != null && held <= 10) return 1;
  if (reason === "stop_loss" && held != null && held <= 6) return 1;
  if (pnlPct < -2.5 && held != null && held <= 8) return 1;

  if (pnlPct > 0.4 || reason === "take_profit") return 0;
  return 0;
}

function barsBeforeTime(allBars, atMs, count = 120) {
  const idx = allBars.findIndex((b) => b.closeTime > atMs);
  const end = idx >= 0 ? idx : allBars.length;
  return allBars.slice(Math.max(0, end - count), end);
}

function barsForPatternBreakAtEntry(allBars, openedAt, count = 120) {
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
  const cfg = normalizePullbackPatternBreakConfig(options);
  const labelFn = options.labelFn ?? labelBrokenPattern;
  const featNames = options.featureNames ?? FEATURE_NAMES;
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
    const window = barsForPatternBreakAtEntry(barsForSymbol(trade.symbol), trade.openedAt, 120);
    if (window.length < 20) continue;

    const tradeStats = tradeStatsRowForSymbol(statsMap, trade.symbol);
    const features = extractPullbackPatternBreakFeatures(window, {
      metrics: patternMetricsFromTrade(trade),
      tradeStats,
      signalKind: trade.signalKind,
      btcBars,
      asOf: trade.openedAt,
      btcLookbackHours: cfg.aiPullbackPatternBreakBtcLookbackHours,
    });
    samples.push({
      vec: featuresToVector(features, featNames),
      label: labelFn(trade),
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
  const cfg = normalizePullbackPatternBreakConfig(options);
  const onProgress = options.onProgress;
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
      `Too few broken-pattern labels (bull ${bullPos.length}, bear ${bearPos.length})`
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
    bullSamples.length >= MIN_HEAD_SAMPLES && bullTrain?.length >= 12
      ? trainLogisticRegression(bullTrain, {
          head: "bull",
          threshold: cfg.aiPullbackPatternBreakBullThreshold,
          source: options.source ?? "trained",
          onProgress,
        })
      : disabledHeadSubModel();

  onProgress?.({
    phase: "fit",
    message: `Training bear head (${bearTrain?.length ?? 0} rows)…`,
  });

  const bearModel =
    bearTrain?.length >= 12
      ? trainLogisticRegression(bearTrain, {
          head: "bear",
          threshold: cfg.aiPullbackPatternBreakBearThreshold,
          source: options.source ?? "trained",
          onProgress,
        })
      : { ...DEFAULT_MODEL.bear };

  onProgress?.({
    phase: "saving",
    message: "Saving model…",
  });

  const featNames = options.featureNames ?? FEATURE_NAMES;
  const modelVersion = options.modelVersion ?? 1;

  return saveModel(
    {
      version: modelVersion,
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
  return {
    ok: true,
    path: MODEL_FILE(key),
    scope: key,
    loaded: Boolean(model),
    version: model.version ?? 3,
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
    bullHeadActive: isHeadActive(model.bull),
    bearHeadActive: isHeadActive(model.bear),
    featureCount: FEATURE_NAMES.length,
    defaults: PULLBACK_PATTERN_BREAK_DEFAULTS,
    summary: formatRegimeStatus({
      scope: key,
      source: model.source,
      trainedAt: model.trainedAt,
      bullMetrics: model.bull.metrics,
      bearMetrics: model.bear.metrics,
      version: model.version,
      modelLabel: "pullback pattern break",
      bullThreshold: model.bull.threshold,
      bearThreshold: model.bear.threshold,
      bullHeadActive: isHeadActive(model.bull),
      bearHeadActive: isHeadActive(model.bear),
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
  PULLBACK_PATTERN_BREAK_DEFAULTS,
  MODEL_FILE,
  isBearSignal,
  normalizePullbackPatternBreakConfig,
  getModel,
  reloadModel,
  saveModel,
  predictPullbackPatternBreak,
  evaluatePullbackPatternBreakGate,
  barsForPatternBreakAtEntry,
  barsBeforeTime,
  buildTrainingSamples,
  trainFromTrades,
  labelBrokenPattern,
  barsHeldEstimate,
  FEATURE_NAMES,
  getModelStatus,
  ensureDefaultModelOnDisk,
  ensureAllDefaultModelsOnDisk,
  patternMetricsFromSignal,
  patternMetricsFromTrade,
  thresholdForSignal,
  subModelForSignal,
  isHeadActive,
  headSampleCount,
  MIN_HEAD_SAMPLES,
};
