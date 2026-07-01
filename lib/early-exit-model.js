const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const { updatePriceExtremes } = require("./position-side");
const {
  FEATURE_NAMES,
  extractEarlyExitFeatures,
  featuresToVector,
} = require("./early-exit-features");
const { tickBarProgress } = require("./paper-bot-position-exits");

const MODEL_FILE = () => dataPath("early-exit-model.json");

const AI_EXIT_DEFAULTS = {
  aiEarlyExitEnabled: false,
  aiEarlyExitThreshold: 0.62,
  aiEarlyExitMinBars: 2,
  /** Score only once per closed bar in live mode (saves CPU on Railway). */
  aiEarlyExitBarCloseOnly: true,
};

/** Bootstrap weights tuned for stall / giveback / adverse patterns. */
const DEFAULT_MODEL = {
  version: 1,
  featureNames: FEATURE_NAMES,
  means: FEATURE_NAMES.map(() => 0),
  stds: FEATURE_NAMES.map(() => 1),
  weights: [
    0.05, -0.35, 0.55, 0.25, -0.2, 0.15, -0.1, -0.25, 0.12, 0.65, 0.18, -0.3,
    0.04, 0.02, 0.03, 0.45, 0.2,
  ],
  bias: -0.35,
  threshold: AI_EXIT_DEFAULTS.aiEarlyExitThreshold,
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

function normalizeAiExitConfig(raw = {}) {
  return {
    aiEarlyExitEnabled: Boolean(raw.aiEarlyExitEnabled),
    aiEarlyExitThreshold: clamp(
      num(raw.aiEarlyExitThreshold, AI_EXIT_DEFAULTS.aiEarlyExitThreshold),
      0.5,
      0.95
    ),
    aiEarlyExitMinBars: clamp(
      Math.round(num(raw.aiEarlyExitMinBars, AI_EXIT_DEFAULTS.aiEarlyExitMinBars)),
      1,
      30
    ),
    aiEarlyExitBarCloseOnly:
      raw.aiEarlyExitBarCloseOnly !== undefined
        ? Boolean(raw.aiEarlyExitBarCloseOnly)
        : AI_EXIT_DEFAULTS.aiEarlyExitBarCloseOnly,
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
      num(raw.threshold, AI_EXIT_DEFAULTS.aiEarlyExitThreshold),
      0.5,
      0.95
    ),
    trainedAt: raw.trainedAt ?? null,
    source: raw.source ?? "file",
    metrics: raw.metrics ?? {},
  };
}

function loadModelFromDisk() {
  const raw = readJsonFile(MODEL_FILE(), null);
  return normalizeStoredModel(raw);
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
  for (let i = 0; i < x.length; i++) {
    z += (m.weights[i] ?? 0) * x[i];
  }
  return sigmoid(z);
}

function predictEarlyExit(pos, bar, recentBars = [], model = getModel()) {
  const features = extractEarlyExitFeatures(pos, bar, recentBars);
  const vec = featuresToVector(features);
  const probability = scoreFeatures(model, vec);
  return { probability, features, vec };
}

function evaluateAiEarlyExit(cfg, pos, bar, options = {}) {
  const aiCfg = normalizeAiExitConfig(cfg);
  if (!aiCfg.aiEarlyExitEnabled) return null;

  const bars = pos.barsInTrade ?? 0;
  if (bars < aiCfg.aiEarlyExitMinBars) return null;

  const close = bar?.close;
  if (!Number.isFinite(close)) return null;

  const barKey = bar?.openTime ?? bar?.closeTime ?? null;
  if (aiCfg.aiEarlyExitBarCloseOnly && barKey != null) {
    if (pos.lastAiBarKey === barKey) return null;
    pos.lastAiBarKey = barKey;
  }

  const model = options.model ?? getModel();
  const threshold = aiCfg.aiEarlyExitThreshold ?? model.threshold ?? 0.62;
  const { probability, features } = predictEarlyExit(
    pos,
    bar,
    options.recentBars ?? [],
    model
  );

  if (probability < threshold) return null;

  const detail = `p=${(probability * 100).toFixed(0)}% · fav ${(
    (features.favorableMove ?? 0) * 5
  ).toFixed(2)}% · giveback ${((features.givebackPct ?? 0) * 4).toFixed(2)}%`;

  return {
    reason: "ai_early_exit",
    exitPrice: close,
    detail,
    probability,
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
  const epochs = options.epochs ?? 120;
  const lr = options.learningRate ?? 0.08;
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
      for (let i = 0; i < x.length; i++) {
        gradW[i] += err * x[i];
      }
      gradB += err;
    }
    const invN = 1 / samples.length;
    for (let i = 0; i < weights.length; i++) {
      weights[i] -= lr * (gradW[i] * invN + l2 * weights[i]);
    }
    bias -= lr * gradB * invN;
  }

  let correct = 0;
  const threshold = options.threshold ?? 0.62;
  for (const s of samples) {
    const x = normalizeVector(s.vec, means, stds);
    let z = bias;
    for (let i = 0; i < x.length; i++) z += weights[i] * x[i];
    const p = sigmoid(z);
    const pred = p >= threshold ? 1 : 0;
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

function barsInRange(allBars, openedAt, closedAt) {
  return (allBars ?? []).filter(
    (b) => b.closeTime >= openedAt && b.closeTime <= closedAt + 60_000
  );
}

function simulatePositionAtBars(trade, bars, cfg) {
  const pos = {
    ...trade,
    id: trade.id ?? `${trade.symbol}-sim`,
    peakPrice: trade.entryPrice,
    troughPrice: trade.entryPrice,
    lastPrice: trade.entryPrice,
    barsInTrade: 0,
    recentLows: [],
    recentHighs: [],
    lastBarKey: null,
    runnerMode: false,
    reclaimLevel: trade.corridorLow,
    rejectLevel: trade.corridorHigh,
  };
  const samples = [];
  const margin = num(trade.margin, 1);
  const finalPnl = num(trade.pnl, 0);
  const epsilon = Math.max(0.05, margin * 0.02);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const close = bar.close;
    const low = bar.low ?? close;
    const high = bar.high ?? close;
    pos.lastPrice = close;
    updatePriceExtremes(pos, high, low, close);
    tickBarProgress(pos, bar, cfg);

    if ((pos.barsInTrade ?? 0) < (cfg?.aiEarlyExitMinBars ?? 2)) continue;

    const recent = bars.slice(Math.max(0, i - 11), i + 1);
    const features = extractEarlyExitFeatures(pos, bar, recent);
    const vec = featuresToVector(features);
    const adjustedPnl =
      pos.side === "SHORT"
        ? (pos.entryPrice - close) * pos.quantity
        : (close - pos.entryPrice) * pos.quantity;

    let label = 0;
    if (adjustedPnl > finalPnl + epsilon) label = 1;
    if (finalPnl < 0 && adjustedPnl < 0 && trade.exitReason === "stop_loss") {
      const adv = features.adverseMove * 5;
      if (adv >= 0.4 && (pos.barsInTrade ?? 0) >= 3) label = 1;
    }
    if (
      features.givebackPct > 0.15 &&
      finalPnl < adjustedPnl - epsilon &&
      features.givebackPct * 4 + features.favorableMove * 5 > 0.6
    ) {
      label = 1;
    }

    samples.push({ vec, label });
  }
  return samples;
}

function buildTrainingSamples(trades, fetchBars, cfg = {}) {
  const samples = [];
  for (const trade of trades ?? []) {
    if (!trade?.symbol || !trade.openedAt || !trade.closedAt) continue;
    const bars = fetchBars(trade.symbol, trade.openedAt, trade.closedAt);
    if (!bars?.length) continue;
    const range = barsInRange(bars, trade.openedAt, trade.closedAt);
    if (range.length < 3) continue;
    samples.push(...simulatePositionAtBars(trade, range, cfg));
  }
  return samples;
}

function trainFromTrades(trades, fetchBars, options = {}) {
  const cfg = normalizeAiExitConfig(options);
  let samples = buildTrainingSamples(trades, fetchBars, cfg);
  if (samples.length < 40) {
    throw new Error(
      `Need at least 40 training samples (got ${samples.length}). Run train bot with more trades or use paper bot history.`
    );
  }

  const pos = samples.filter((s) => s.label === 1);
  const neg = samples.filter((s) => s.label === 0);
  if (pos.length < 8) {
    throw new Error(
      `Too few positive exit labels (${pos.length}). Need more varied trade outcomes in history.`
    );
  }
  const maxNeg = Math.max(1, pos.length * 2);
  const negSample =
    neg.length > maxNeg * 3
      ? neg.sort(() => Math.random() - 0.5).slice(0, maxNeg * 3)
      : neg;
  samples = [...pos, ...negSample].sort(() => Math.random() - 0.5);

  const model = trainLogisticRegression(samples, {
    threshold: cfg.aiEarlyExitThreshold,
    source: options.source ?? "trained",
  });
  return saveModel(model);
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
    defaults: AI_EXIT_DEFAULTS,
  };
}

function ensureDefaultModelOnDisk() {
  const raw = readJsonFile(MODEL_FILE(), null);
  if (!raw) saveModel({ ...DEFAULT_MODEL });
}

module.exports = {
  AI_EXIT_DEFAULTS,
  DEFAULT_MODEL,
  MODEL_FILE,
  normalizeAiExitConfig,
  getModel,
  reloadModel,
  saveModel,
  predictEarlyExit,
  evaluateAiEarlyExit,
  buildTrainingSamples,
  trainFromTrades,
  getModelStatus,
  ensureDefaultModelOnDisk,
};
