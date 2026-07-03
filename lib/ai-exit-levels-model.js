const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const {
  FEATURE_NAMES,
  extractExitLevelsFeatures,
  featuresToVector,
} = require("./ai-exit-levels-features");
const {
  oracleSlTpFromBars,
  barsInTradeRange,
  bracketPrices,
} = require("./ai-exit-levels-oracle");
const { resolveLegacyExitLevels } = require("./signal-exit-levels");
const { normalizeAiModelScope, modelFileFor } = require("./ai-model-scope");
const { isShort } = require("./position-side");

const MODEL_BASENAME = "ai-exit-levels";
const MODEL_FILE = (scope = "paper") => modelFileFor(MODEL_BASENAME, scope);

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const AI_EXIT_LEVELS_DEFAULTS = {
  aiExitLevelsEnabled: false,
  /** When true, skip smart/corridor legacy SL/TP rules (AI sets initial bracket). */
  aiExitLevelsLegacyDisabled: true,
  /** predict = model SL/TP %; legacy_scale = multiply legacy distances. */
  aiExitLevelsMode: "predict",
  aiExitLevelsSlScale: 1,
  aiExitLevelsTpScale: 1,
  aiExitLevelsSlClampMin: 0.5,
  aiExitLevelsSlClampMax: 8,
  aiExitLevelsTpClampMin: 1,
  aiExitLevelsTpClampMax: 15,
};

const BOOTSTRAP_SL = [
  0.02, -0.18, 0.12, 0.22, 0.08, 0.06, 0.14, 0.1, 0.08, 0.04, 0.06, 0.05, 0.04, 0.2, 0.16,
];
const BOOTSTRAP_TP = [
  0.04, 0.1, 0.08, 0.14, 0.12, 0.16, 0.2, 0.18, 0.1, 0.08, 0.06, 0.12, 0.14, 0.22, 0.24,
];

function bootstrapRegHead(weights, bias, targetMean = 2) {
  return {
    means: FEATURE_NAMES.map(() => 0),
    stds: FEATURE_NAMES.map(() => 1),
    weights,
    bias: bias ?? targetMean,
    metrics: { samples: 0, mae: null, rmse: null },
  };
}

const DEFAULT_MODEL = {
  version: 1,
  featureNames: FEATURE_NAMES,
  bull: {
    sl: bootstrapRegHead(BOOTSTRAP_SL, 1.8),
    tp: bootstrapRegHead(BOOTSTRAP_TP, 4.2),
  },
  bear: {
    sl: bootstrapRegHead(BOOTSTRAP_SL, 2.0),
    tp: bootstrapRegHead(BOOTSTRAP_TP, 3.8),
  },
  trainedAt: null,
  source: "bootstrap",
};

let cachedModels = {};

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function isBearSignal(signalKind) {
  return String(signalKind || "") === "sfp_bear";
}

function normalizeAiExitLevelsConfig(raw = {}) {
  const d = AI_EXIT_LEVELS_DEFAULTS;
  return {
    aiExitLevelsEnabled: Boolean(raw.aiExitLevelsEnabled),
    aiExitLevelsLegacyDisabled:
      raw.aiExitLevelsLegacyDisabled !== undefined
        ? Boolean(raw.aiExitLevelsLegacyDisabled)
        : d.aiExitLevelsLegacyDisabled,
    aiExitLevelsMode:
      raw.aiExitLevelsMode === "legacy_scale" ? "legacy_scale" : "predict",
    aiExitLevelsSlScale: clamp(num(raw.aiExitLevelsSlScale, d.aiExitLevelsSlScale), 0.5, 2),
    aiExitLevelsTpScale: clamp(num(raw.aiExitLevelsTpScale, d.aiExitLevelsTpScale), 0.5, 2),
    aiExitLevelsSlClampMin: clamp(
      num(raw.aiExitLevelsSlClampMin, d.aiExitLevelsSlClampMin),
      0.2,
      20
    ),
    aiExitLevelsSlClampMax: clamp(
      num(raw.aiExitLevelsSlClampMax, d.aiExitLevelsSlClampMax),
      0.5,
      30
    ),
    aiExitLevelsTpClampMin: clamp(
      num(raw.aiExitLevelsTpClampMin, d.aiExitLevelsTpClampMin),
      0.5,
      30
    ),
    aiExitLevelsTpClampMax: clamp(
      num(raw.aiExitLevelsTpClampMax, d.aiExitLevelsTpClampMax),
      1,
      50
    ),
  };
}

function normalizeRegHead(raw, fallback) {
  const weights = Array.isArray(raw?.weights) ? raw.weights.map(Number) : [];
  if (weights.length !== FEATURE_NAMES.length) return { ...fallback };
  return {
    means: (raw.means ?? fallback.means).map((v) => num(v, 0)),
    stds: (raw.stds ?? fallback.stds).map((v) => num(v, 1) || 1),
    weights,
    bias: num(raw.bias, fallback.bias),
    metrics: raw.metrics ?? fallback.metrics ?? {},
  };
}

function normalizeStoredModel(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_MODEL,
      bull: { sl: { ...DEFAULT_MODEL.bull.sl }, tp: { ...DEFAULT_MODEL.bull.tp } },
      bear: { sl: { ...DEFAULT_MODEL.bear.sl }, tp: { ...DEFAULT_MODEL.bear.tp } },
    };
  }
  return {
    version: 1,
    featureNames: FEATURE_NAMES,
    bull: {
      sl: normalizeRegHead(raw.bull?.sl, DEFAULT_MODEL.bull.sl),
      tp: normalizeRegHead(raw.bull?.tp, DEFAULT_MODEL.bull.tp),
    },
    bear: {
      sl: normalizeRegHead(raw.bear?.sl, DEFAULT_MODEL.bear.sl),
      tp: normalizeRegHead(raw.bear?.tp, DEFAULT_MODEL.bear.tp),
    },
    trainedAt: raw.trainedAt ?? null,
    source: raw.source ?? "file",
  };
}

function loadModelFromDisk(scope = "paper") {
  return normalizeStoredModel(readJsonFile(MODEL_FILE(scope), null));
}

function getModel(scope = "paper") {
  const key = normalizeAiModelScope(scope);
  if (!cachedModels[key]) cachedModels[key] = loadModelFromDisk(key);
  return cachedModels[key];
}

function reloadModel(scope = "paper") {
  const key = normalizeAiModelScope(scope);
  cachedModels[key] = loadModelFromDisk(key);
  return cachedModels[key];
}

function saveModel(model, scope = "paper") {
  const key = normalizeAiModelScope(scope);
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

function ensureDefaultModelOnDisk(scope = "paper") {
  const file = MODEL_FILE(scope);
  if (!readJsonFile(file, null)) saveModel(DEFAULT_MODEL, scope);
}

function ensureAllDefaultModelsOnDisk() {
  ensureDefaultModelOnDisk("paper");
  ensureDefaultModelOnDisk("live");
}

function normalizeVector(vec, means, stds) {
  return vec.map((v, i) => {
    const std = stds[i] > 1e-6 ? stds[i] : 1;
    return (v - (means[i] ?? 0)) / std;
  });
}

function predictReg(head, vec) {
  const h = normalizeRegHead(head, DEFAULT_MODEL.bull.sl);
  const x = normalizeVector(vec, h.means, h.stds);
  let y = h.bias;
  for (let i = 0; i < x.length; i++) y += (h.weights[i] ?? 0) * x[i];
  return y;
}

function clampSlTp(slPct, tpPct, cfg) {
  const ai = normalizeAiExitLevelsConfig(cfg);
  const sl = clamp(slPct, ai.aiExitLevelsSlClampMin, ai.aiExitLevelsSlClampMax);
  let tp = clamp(tpPct, ai.aiExitLevelsTpClampMin, ai.aiExitLevelsTpClampMax);
  if (tp < sl * 0.45) tp = sl * 0.65;
  return { slPct: +sl.toFixed(3), tpPct: +tp.toFixed(3) };
}

function predictExitLevelPcts(metrics, entry, cfg, signalKind, options = {}) {
  const modelScope = normalizeAiModelScope(options.modelScope);
  const stored = normalizeStoredModel(options.model ?? getModel(modelScope));
  const head = isBearSignal(signalKind) ? stored.bear : stored.bull;
  const legacy = resolveLegacyExitLevels(signalKind, metrics, entry, {
    ...cfg,
    smartExitLevelsEnabled: cfg.smartExitLevelsEnabled !== false,
  });
  const legacySl = Math.abs(((entry - legacy.stopLoss) / entry) * 100);
  const legacyTp = Math.abs(((legacy.takeProfit - entry) / entry) * 100);
  const features = extractExitLevelsFeatures(metrics, entry, cfg, signalKind, {
    legacySlDistPct: legacySl,
    legacyTpDistPct: legacyTp,
    signalSnapshot: options.signalSnapshot,
  });
  const vec = featuresToVector(features);
  const aiCfg = normalizeAiExitLevelsConfig(cfg);

  let slPct = predictReg(head.sl, vec);
  let tpPct = predictReg(head.tp, vec);

  if (aiCfg.aiExitLevelsMode === "legacy_scale") {
    slPct = legacySl * aiCfg.aiExitLevelsSlScale;
    tpPct = legacyTp * aiCfg.aiExitLevelsTpScale;
  }

  return {
    ...clampSlTp(slPct, tpPct, cfg),
    features,
    vec,
    legacySlPct: +legacySl.toFixed(3),
    legacyTpPct: +legacyTp.toFixed(3),
    head: isBearSignal(signalKind) ? "bear" : "bull",
  };
}

function resolveAiExitLevels(signalKind, metrics, entry, cfg, options = {}) {
  const aiCfg = normalizeAiExitLevelsConfig(cfg);
  if (!aiCfg.aiExitLevelsEnabled) return null;

  const short =
    signalKind === "sfp_bear" ||
    signalKind === "level_break_bear" ||
    options.side === "SHORT";
  const { slPct, tpPct, legacySlPct, legacyTpPct, head } = predictExitLevelPcts(
    metrics,
    entry,
    cfg,
    signalKind,
    options
  );
  const { stopLoss, takeProfit } = bracketPrices(entry, slPct, tpPct, short);

  return {
    stopLoss,
    takeProfit,
    exitMethod: "ai_levels",
    aiSlPct: slPct,
    aiTpPct: tpPct,
    legacySlPct,
    legacyTpPct,
    head,
    limits: null,
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

function trainLinearReg(samples, options = {}) {
  const epochs = options.epochs ?? 100;
  const lr = options.learningRate ?? 0.06;
  const l2 = options.l2 ?? 0.002;
  const { means, stds } = computeFeatureStats(samples);
  const weights = FEATURE_NAMES.map(() => 0);
  let bias =
    samples.length > 0
      ? samples.reduce((s, x) => s + x.target, 0) / samples.length
      : 2;

  for (let ep = 0; ep < epochs; ep++) {
    for (const s of samples) {
      const x = normalizeVector(s.vec, means, stds);
      let pred = bias;
      for (let i = 0; i < x.length; i++) pred += weights[i] * x[i];
      const err = pred - s.target;
      bias -= lr * err;
      for (let i = 0; i < x.length; i++) {
        weights[i] -= lr * (err * x[i] + l2 * weights[i]);
      }
    }
  }

  let absErr = 0;
  for (const s of samples) {
    const x = normalizeVector(s.vec, means, stds);
    let pred = bias;
    for (let i = 0; i < x.length; i++) pred += weights[i] * x[i];
    absErr += Math.abs(pred - s.target);
  }
  const mae = samples.length ? absErr / samples.length : null;

  return {
    means,
    stds,
    weights,
    bias: +bias.toFixed(4),
    metrics: {
      samples: samples.length,
      mae: mae != null ? +mae.toFixed(4) : null,
    },
  };
}

async function buildTrainingSamples(trades, fetchBars, cfg, options = {}) {
  const samples = { bull: [], bear: [] };
  const list = trades ?? [];
  const total = list.length;
  const reportEvery = Math.max(1, Math.min(25, Math.floor(total / 40) || 1));

  for (let i = 0; i < total; i++) {
    const trade = list[i];
    if (!trade?.symbol || !trade.openedAt || !trade.closedAt) continue;
    const bars = fetchBars(trade.symbol, trade.openedAt, trade.closedAt);
    if (!bars?.length) continue;
    const range = barsInTradeRange(bars, trade.openedAt, trade.closedAt);
    if (range.length < 2) continue;

    const oracle = oracleSlTpFromBars(trade, range, cfg);
    if (!oracle) continue;

    const entry = num(trade.entryPrice);
    const metrics = trade.signalSnapshot ?? {};
    const signalKind = trade.signalKind ?? "sfp";
    const legacy = resolveLegacyExitLevels(signalKind, metrics, entry, cfg);
    const legacySl = Math.abs(((entry - legacy.stopLoss) / entry) * 100);
    const legacyTp = Math.abs(((legacy.takeProfit - entry) / entry) * 100);
    const features = extractExitLevelsFeatures(metrics, entry, cfg, signalKind, {
      legacySlDistPct: legacySl,
      legacyTpDistPct: legacyTp,
      signalSnapshot: trade.signalSnapshot,
    });
    const vec = featuresToVector(features);
    const bucket = isBearSignal(signalKind) ? "bear" : "bull";
    samples[bucket].push({
      vec,
      slTarget: oracle.slPct,
      tpTarget: oracle.tpPct,
      oraclePnl: oracle.oraclePnl,
      legacyPnl: oracle.legacyPnl,
    });

    if (i % reportEvery === 0 || i === total - 1) {
      options.onProgress?.({
        phase: "samples",
        done: i + 1,
        total,
        symbol: trade.symbol,
        bull: samples.bull.length,
        bear: samples.bear.length,
      });
      await yieldToLoop();
    }
  }
  return samples;
}

async function trainFromTrades(trades, fetchBars, options = {}) {
  const cfg = options.botConfig ?? options;
  const onProgress = options.onProgress;
  const sfpTrades = (trades ?? []).filter(
    (t) => t.signalKind === "sfp" || t.signalKind === "sfp_bear"
  );
  if (sfpTrades.length < 12) {
    throw new Error(`Need at least 12 SFP trades (got ${sfpTrades.length})`);
  }

  onProgress?.({
    phase: "samples",
    message: `Building exit-level samples from ${sfpTrades.length} trades…`,
  });

  const grouped = await buildTrainingSamples(sfpTrades, fetchBars, cfg, { onProgress });
  if (grouped.bull.length + grouped.bear.length < 20) {
    throw new Error(
      `Need at least 20 oracle samples (got ${grouped.bull.length + grouped.bear.length})`
    );
  }

  function trainBucket(rows, fallback) {
    const slSamples = rows.map((r) => ({ vec: r.vec, target: r.slTarget }));
    const tpSamples = rows.map((r) => ({ vec: r.vec, target: r.tpTarget }));
    return {
      sl: trainLinearReg(slSamples, options),
      tp: trainLinearReg(tpSamples, options),
    };
  }

  const model = {
    version: 1,
    featureNames: FEATURE_NAMES,
    bull: trainBucket(grouped.bull, DEFAULT_MODEL.bull),
    bear: trainBucket(
      grouped.bear.length >= 8 ? grouped.bear : grouped.bull,
      DEFAULT_MODEL.bear
    ),
    trainedAt: Date.now(),
    source: options.source ?? "train:backtest",
  };

  if (grouped.bear.length < 8) {
    model.bear = { ...model.bull };
  }

  const scope = normalizeAiModelScope(options.scope);
  saveModel(model, scope);
  onProgress?.({ phase: "done", message: "AI exit-levels model saved" });
  return model;
}

function getModelStatus(scope = "paper") {
  const m = getModel(scope);
  return {
    scope: normalizeAiModelScope(scope),
    file: MODEL_FILE(scope),
    trainedAt: m.trainedAt,
    source: m.source,
    bull: {
      slMae: m.bull?.sl?.metrics?.mae,
      tpMae: m.bull?.tp?.metrics?.mae,
      samples: m.bull?.sl?.metrics?.samples,
    },
    bear: {
      slMae: m.bear?.sl?.metrics?.mae,
      tpMae: m.bear?.tp?.metrics?.mae,
      samples: m.bear?.sl?.metrics?.samples,
    },
  };
}

function getModelData(scope = "paper") {
  return getModel(scope);
}

module.exports = {
  AI_EXIT_LEVELS_DEFAULTS,
  DEFAULT_MODEL,
  MODEL_FILE,
  normalizeAiExitLevelsConfig,
  getModel,
  reloadModel,
  saveModel,
  ensureDefaultModelOnDisk,
  ensureAllDefaultModelsOnDisk,
  predictExitLevelPcts,
  resolveAiExitLevels,
  trainFromTrades,
  getModelStatus,
  getModelData,
  isBearSignal,
};
