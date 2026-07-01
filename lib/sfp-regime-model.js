const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  FEATURE_NAMES,
  extractSfpRegimeFeatures,
  featuresToVector,
} = require("./sfp-regime-features");

const MODEL_FILE = () => dataPath("sfp-regime-model.json");

const SFP_REGIME_DEFAULTS = {
  aiSfpRegimeEnabled: false,
  aiSfpRegimeThreshold: 0.58,
};

const DEFAULT_MODEL = {
  version: 1,
  featureNames: FEATURE_NAMES,
  means: FEATURE_NAMES.map(() => 0),
  stds: FEATURE_NAMES.map(() => 1),
  weights: [
    0.35, 0.42, 0.12, 0.55, 0.28, 0.18, -0.15, 0.48, 0.38, 0.32, 0.08, 0.22,
  ],
  bias: -0.42,
  threshold: SFP_REGIME_DEFAULTS.aiSfpRegimeThreshold,
  trainedAt: null,
  source: "bootstrap",
  metrics: { samples: 0, positiveRate: null, accuracy: null },
};

let cachedModel = null;

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

function normalizeSfpRegimeConfig(raw = {}) {
  return {
    aiSfpRegimeEnabled: Boolean(raw.aiSfpRegimeEnabled),
    aiSfpRegimeThreshold: clamp(
      num(raw.aiSfpRegimeThreshold, SFP_REGIME_DEFAULTS.aiSfpRegimeThreshold),
      0.5,
      0.95
    ),
  };
}

function normalizeStoredModel(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MODEL };
  const weights = Array.isArray(raw.weights) ? raw.weights.map(Number) : [];
  if (weights.length !== FEATURE_NAMES.length) return { ...DEFAULT_MODEL };
  return {
    version: raw.version ?? 1,
    featureNames: FEATURE_NAMES,
    means: (raw.means ?? []).map((v) => num(v, 0)),
    stds: (raw.stds ?? []).map((v) => num(v, 1) || 1),
    weights,
    bias: num(raw.bias, DEFAULT_MODEL.bias),
    threshold: clamp(
      num(raw.threshold, SFP_REGIME_DEFAULTS.aiSfpRegimeThreshold),
      0.5,
      0.95
    ),
    trainedAt: raw.trainedAt ?? null,
    source: raw.source ?? "file",
    metrics: raw.metrics ?? {},
  };
}

function loadModelFromDisk() {
  return normalizeStoredModel(readJsonFile(MODEL_FILE(), null));
}

function getModel() {
  if (!cachedModel) cachedModel = loadModelFromDisk();
  return cachedModel;
}

function reloadModel() {
  cachedModel = loadModelFromDisk();
  return getModel();
}

function saveModel(model) {
  const normalized = normalizeStoredModel(model);
  writeJsonFile(MODEL_FILE(), {
    ...normalized,
    savedAt: Date.now(),
    savedAtIso: formatIsoUtcPlus3(Date.now()),
  });
  cachedModel = normalized;
  return normalized;
}

function normalizeVector(vec, means, stds) {
  return vec.map((v, i) => {
    const std = stds[i] > 1e-6 ? stds[i] : 1;
    return (v - (means[i] ?? 0)) / std;
  });
}

function scoreFeatures(model, featureVec) {
  const m = normalizeStoredModel(model);
  const x = normalizeVector(featureVec, m.means, m.stds);
  let z = m.bias;
  for (let i = 0; i < x.length; i++) z += (m.weights[i] ?? 0) * x[i];
  return sigmoid(z);
}

function predictSfpRegime(bars, extras = {}, model = getModel()) {
  const features = extractSfpRegimeFeatures(bars, extras);
  const vec = featuresToVector(features);
  const probability = scoreFeatures(model, vec);
  return { probability, features, vec };
}

function evaluateSfpRegimeGate(cfg, bars, extras = {}) {
  const regimeCfg = normalizeSfpRegimeConfig(cfg);
  if (!regimeCfg.aiSfpRegimeEnabled) return { pass: true, enabled: false };
  if (!bars?.length) return { pass: true, enabled: true, waiting: true };

  const model = extras.model ?? getModel();
  const threshold = regimeCfg.aiSfpRegimeThreshold ?? model.threshold ?? 0.58;
  const { probability, features } = predictSfpRegime(bars, extras, model);
  if (probability < threshold) {
    return { pass: true, enabled: true, probability, features };
  }
  const detail = `bad regime p=${(probability * 100).toFixed(0)}% · chop ${(
    (features.choppiness ?? 0) * 100
  ).toFixed(0)}% · vol ${((features.recentVolPct ?? 0) * 2).toFixed(2)}%`;
  return { pass: false, enabled: true, probability, features, detail };
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
    version: 1,
    featureNames: FEATURE_NAMES,
    means,
    stds,
    weights,
    bias,
    threshold,
    trainedAt: Date.now(),
    source: options.source ?? "trained",
    metrics: {
      samples: samples.length,
      positiveRate: samples.length ? +(positive / samples.length).toFixed(4) : null,
      accuracy: samples.length ? +(correct / samples.length).toFixed(4) : null,
    },
  };
}

function isSfpTrade(trade) {
  const k = trade?.signalKind;
  return k === "sfp" || k === "sfp_bear";
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

function buildTrainingSamples(trades, fetchBars, tradeStatsMap) {
  const samples = [];
  for (const trade of trades ?? []) {
    if (!isSfpTrade(trade) || !trade.openedAt) continue;
    const bars = fetchBars(trade.symbol, trade.openedAt, trade.openedAt);
    const window = barsBeforeTime(bars, trade.openedAt, 120);
    if (window.length < 20) continue;
    const stats = tradeStatsMap?.get(trade.symbol) ?? null;
    const features = extractSfpRegimeFeatures(window, {
      metrics: {
        corridorWidthPct: trade.corridorHigh && trade.corridorLow
          ? ((trade.corridorHigh - trade.corridorLow) /
              ((trade.corridorHigh + trade.corridorLow) / 2)) *
            100
          : null,
        barsSinceSweep: 3,
      },
      tradeStats: stats,
    });
    samples.push({
      vec: featuresToVector(features),
      label: labelBadRegime(trade),
    });
  }
  return samples;
}

function trainFromTrades(trades, fetchBars, options = {}) {
  const cfg = normalizeSfpRegimeConfig(options);
  const sfpTrades = (trades ?? []).filter(isSfpTrade);
  if (sfpTrades.length < 12) {
    throw new Error(
      `Need at least 12 SFP closed trades for training (got ${sfpTrades.length})`
    );
  }
  const { buildSymbolTradeStatsMap } = require("./sfp-regime-features");
  const statsMap = buildSymbolTradeStatsMap(sfpTrades);
  let samples = buildTrainingSamples(sfpTrades, fetchBars, statsMap);
  if (samples.length < 30) {
    throw new Error(
      `Need at least 30 training samples with kline history (got ${samples.length})`
    );
  }
  const pos = samples.filter((s) => s.label === 1);
  const neg = samples.filter((s) => s.label === 0);
  if (pos.length < 6 || neg.length < 6) {
    throw new Error(
      `Need balanced SFP outcomes for training (${pos.length} bad / ${neg.length} good)`
    );
  }
  const maxNeg = Math.max(neg.length, pos.length * 2);
  const negSample =
    neg.length > maxNeg ? neg.sort(() => Math.random() - 0.5).slice(0, maxNeg) : neg;
  samples = [...pos, ...negSample].sort(() => Math.random() - 0.5);

  return saveModel(
    trainLogisticRegression(samples, {
      threshold: cfg.aiSfpRegimeThreshold,
      source: options.source ?? "trained",
    })
  );
}

function getModelStatus() {
  const model = getModel();
  return {
    ok: true,
    path: MODEL_FILE(),
    loaded: Boolean(model),
    source: model.source,
    trainedAt: model.trainedAt ? formatIsoUtcPlus3(model.trainedAt) : null,
    threshold: model.threshold,
    metrics: model.metrics,
    featureCount: FEATURE_NAMES.length,
    defaults: SFP_REGIME_DEFAULTS,
  };
}

function ensureDefaultModelOnDisk() {
  if (!readJsonFile(MODEL_FILE(), null)) saveModel({ ...DEFAULT_MODEL });
}

module.exports = {
  SFP_REGIME_DEFAULTS,
  MODEL_FILE,
  normalizeSfpRegimeConfig,
  getModel,
  reloadModel,
  saveModel,
  predictSfpRegime,
  evaluateSfpRegimeGate,
  buildTrainingSamples,
  trainFromTrades,
  getModelStatus,
  ensureDefaultModelOnDisk,
};
