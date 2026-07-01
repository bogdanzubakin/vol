const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { formatIsoUtcPlus3 } = require("./time-format");
const { updatePriceExtremes } = require("./position-side");
const {
  FEATURE_NAMES,
  extractSfpEarlyExitFeatures,
  featuresToVector,
} = require("./early-exit-sfp-features");
const { tickBarProgress } = require("./paper-bot-position-exits");
const {
  classifyExitTier,
  futurePathFromBars,
  pnlAtClose,
} = require("./early-exit-path-oracle");

const MODEL_FILE = () => dataPath("early-exit-sfp.json");

const SFP_SIGNAL_KINDS = ["sfp", "sfp_bear"];

const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

const AI_EXIT_DEFAULTS = {
  aiEarlyExitEnabled: false,
  /** Legacy alias — maps to hard threshold when hard/soft not set. */
  aiEarlyExitThreshold: 0.82,
  /** Cut when recovery to positive PnL is unlikely. */
  aiEarlyExitHardThreshold: 0.76,
  /** Trim giveback when recovery is still plausible — higher bar. */
  aiEarlyExitSoftThreshold: 0.88,
  /** After rule-based early abort window (often 8 bars on 5m). */
  aiEarlyExitMinBars: 9,
  /** Score only once per closed bar in live mode (saves CPU on Railway). */
  aiEarlyExitBarCloseOnly: true,
};

const BOOTSTRAP_WEIGHTS_HARD = [
  0.04, -0.48, 0.38, 0.14, -0.4, 0.06, -0.16, -0.36, 0.1, 0.52, 0.12, -0.24, 0.32,
  0.08, 0.06, 0.12, 0.08, -0.18,
];

const BOOTSTRAP_WEIGHTS_SOFT = [
  -0.02, -0.22, 0.18, 0.08, -0.12, 0.04, -0.08, -0.14, 0.06, 0.28, 0.08, -0.1, 0.42,
  0.06, 0.04, 0.06, 0.04, 0.24,
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

/** SFP sweep/reclaim — hard + soft logistic heads (v2). */
const DEFAULT_MODEL = {
  version: 2,
  signal: "sfp",
  featureNames: FEATURE_NAMES,
  hard: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_HARD,
    -0.74,
    AI_EXIT_DEFAULTS.aiEarlyExitHardThreshold
  ),
  soft: bootstrapSubModel(
    BOOTSTRAP_WEIGHTS_SOFT,
    -0.92,
    AI_EXIT_DEFAULTS.aiEarlyExitSoftThreshold
  ),
  trainedAt: null,
  source: "bootstrap",
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
  const legacyTh = clamp(
    num(raw.aiEarlyExitThreshold, AI_EXIT_DEFAULTS.aiEarlyExitThreshold),
    0.5,
    0.95
  );
  const hardTh = clamp(
    num(raw.aiEarlyExitHardThreshold, legacyTh),
    0.5,
    0.95
  );
  const softTh = clamp(
    num(raw.aiEarlyExitSoftThreshold, AI_EXIT_DEFAULTS.aiEarlyExitSoftThreshold),
    0.5,
    0.95
  );
  return {
    aiEarlyExitEnabled: Boolean(raw.aiEarlyExitEnabled),
    aiEarlyExitThreshold: hardTh,
    aiEarlyExitHardThreshold: hardTh,
    aiEarlyExitSoftThreshold: Math.max(softTh, hardTh + 0.04),
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

function isSfpSignal(signalKind) {
  const k = String(signalKind || "");
  return k === "sfp" || k === "sfp_bear";
}

function isSfpTrade(trade) {
  return isSfpSignal(trade?.signalKind);
}

function normalizeSubModel(raw, fallback) {
  const weights = Array.isArray(raw?.weights) ? raw.weights.map(Number) : [];
  if (weights.length !== FEATURE_NAMES.length) return { ...fallback };
  return {
    means: (raw.means ?? fallback.means).map((v) => num(v, 0)),
    stds: (raw.stds ?? fallback.stds).map((v) => num(v, 1) || 1),
    weights,
    bias: num(raw.bias, fallback.bias),
    threshold: clamp(num(raw.threshold, fallback.threshold), 0.5, 0.95),
    metrics: raw.metrics ?? fallback.metrics ?? {},
  };
}

function legacySubModelFromV1(raw) {
  return normalizeSubModel(
    {
      means: raw.means,
      stds: raw.stds,
      weights: raw.weights,
      bias: raw.bias,
      threshold: raw.threshold,
      metrics: raw.metrics,
    },
    DEFAULT_MODEL.hard
  );
}

function normalizeStoredModel(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      ...DEFAULT_MODEL,
      hard: { ...DEFAULT_MODEL.hard },
      soft: { ...DEFAULT_MODEL.soft },
    };
  }

  if (raw.version >= 2 && raw.hard) {
    return {
      version: 2,
      signal: "sfp",
      featureNames: FEATURE_NAMES,
      hard: normalizeSubModel(raw.hard, DEFAULT_MODEL.hard),
      soft: normalizeSubModel(raw.soft, DEFAULT_MODEL.soft),
      trainedAt: raw.trainedAt ?? null,
      source: raw.source ?? "file",
    };
  }

  const legacy = legacySubModelFromV1(raw);
  if (!legacy.weights?.length) {
    return {
      ...DEFAULT_MODEL,
      hard: { ...DEFAULT_MODEL.hard },
      soft: { ...DEFAULT_MODEL.soft },
    };
  }

  return {
    version: 2,
    signal: "sfp",
    featureNames: FEATURE_NAMES,
    hard: legacy,
    soft: { ...DEFAULT_MODEL.soft },
    trainedAt: raw.trainedAt ?? null,
    source: raw.source ?? "file",
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

function scoreFeatures(subModel, featureVec) {
  const m = normalizeSubModel(subModel, DEFAULT_MODEL.hard);
  const x = normalizeVector(featureVec, m.means, m.stds);
  let z = m.bias;
  for (let i = 0; i < x.length; i++) {
    z += (m.weights[i] ?? 0) * x[i];
  }
  return sigmoid(z);
}

function predictEarlyExit(pos, bar, recentBars = [], model = getModel()) {
  const features = extractSfpEarlyExitFeatures(pos, bar, recentBars);
  const vec = featuresToVector(features);
  const stored = normalizeStoredModel(model);
  const hardProbability = scoreFeatures(stored.hard, vec);
  const softProbability = scoreFeatures(stored.soft, vec);
  return {
    probability: hardProbability,
    hardProbability,
    softProbability,
    features,
    vec,
  };
}

/** Decode tanh-scaled features back to rough % units (matches detail strings). */
function decodeFeaturePct(features) {
  return {
    favorable: (features.favorableMove ?? 0) * 5,
    adverse: (features.adverseMove ?? 0) * 5,
    giveback: (features.givebackPct ?? 0) * 4,
    unrealized: (features.unrealizedPnlPct ?? 0) * 8,
    tpProgress: features.tpProgress ?? 0,
    corridorBreak: features.corridorBreak ?? 0,
  };
}

/**
 * Block exits on chop / shallow giveback — model should not cut trades that
 * often recover to breakeven SL or early stall.
 */
function passesEarlyExitGuards(pos, features) {
  const {
    favorable: favPct,
    adverse: advPct,
    giveback: givebackPct,
    unrealized: unrealPct,
    tpProgress,
    corridorBreak,
  } = decodeFeaturePct(features);

  const deteriorating =
    advPct >= 0.5 ||
    givebackPct >= 1.25 ||
    corridorBreak >= 0.65 ||
    (unrealPct < -0.25 && advPct >= 0.32);

  if (!deteriorating) return false;

  if (unrealPct > 0.15 && givebackPct < 1.6 && tpProgress < 0.9) return false;

  if (favPct > 0.55 && advPct < 0.4 && givebackPct < 1.0) return false;

  if (
    pos.stopMoved &&
    unrealPct > -0.45 &&
    unrealPct < 0.2 &&
    advPct < 0.65 &&
    givebackPct < 1.4
  ) {
    return false;
  }

  return true;
}

/** Recovery to positive PnL still plausible — prefer soft trim over hard cut. */
function recoveryLikely(pos, features) {
  const {
    favorable: favPct,
    adverse: advPct,
    giveback: givebackPct,
    unrealized: unrealPct,
    corridorBreak,
  } = decodeFeaturePct(features);

  const peakFav = (features.peakFavorable ?? 0) * 5;
  const wasPositive = peakFav > 0.2 || unrealPct > 0.08;

  if (wasPositive && givebackPct >= 0.35 && corridorBreak < 0.55) return true;

  if (
    unrealPct > -0.55 &&
    unrealPct < 0.12 &&
    advPct < 0.5 &&
    givebackPct < 0.85 &&
    corridorBreak < 0.45
  ) {
    return true;
  }

  if (favPct > 0.35 && advPct < 0.42 && givebackPct < 1.1) return true;

  return false;
}

function passesSoftExitGuards(pos, features) {
  const {
    favorable: favPct,
    adverse: advPct,
    giveback: givebackPct,
    unrealized: unrealPct,
    corridorBreak,
  } = decodeFeaturePct(features);

  const peakFav = (features.peakFavorable ?? 0) * 5;
  const wasPositive = peakFav > 0.2;

  if (!wasPositive && unrealPct < -0.15) return false;
  if (corridorBreak >= 0.75) return false;
  if (givebackPct < 0.45 && unrealPct > 0.05) return false;
  if (advPct >= 0.85 && !wasPositive) return false;

  if (
    wasPositive &&
    givebackPct >= 0.5 &&
    unrealPct > -0.35 &&
    corridorBreak < 0.65
  ) {
    return true;
  }

  if (unrealPct > 0.12 && givebackPct >= 0.55 && tpProgress(features) < 0.92) {
    return true;
  }

  if (favPct > 0.45 && givebackPct >= 0.4 && advPct < 0.55) return true;

  return false;
}

function tpProgress(features) {
  return features.tpProgress ?? 0;
}

function isAiEarlyExitReason(reason) {
  const r = String(reason ?? "");
  return (
    r === "ai_early_exit" ||
    r === "ai_early_exit_hard" ||
    r === "ai_early_exit_soft"
  );
}

function evaluateAiEarlyExit(cfg, pos, bar, options = {}) {
  const aiCfg = normalizeAiExitConfig(cfg);
  if (!aiCfg.aiEarlyExitEnabled) return null;
  if (!isSfpSignal(pos.signalKind)) return null;

  const bars = pos.barsInTrade ?? 0;
  if (bars < aiCfg.aiEarlyExitMinBars) return null;

  const close = bar?.close;
  if (!Number.isFinite(close)) return null;

  const barKey = bar?.openTime ?? bar?.closeTime ?? null;
  if (aiCfg.aiEarlyExitBarCloseOnly && barKey != null) {
    if (pos.lastAiBarKey === barKey) return null;
    pos.lastAiBarKey = barKey;
  }

  const model = normalizeStoredModel(options.model ?? getModel());
  const hardThreshold =
    aiCfg.aiEarlyExitHardThreshold ?? model.hard.threshold ?? 0.76;
  const softThreshold =
    aiCfg.aiEarlyExitSoftThreshold ?? model.soft.threshold ?? 0.88;

  const { hardProbability, softProbability, features } = predictEarlyExit(
    pos,
    bar,
    options.recentBars ?? [],
    model
  );

  const pct = decodeFeaturePct(features);
  const recovery = recoveryLikely(pos, features);

  if (
    hardProbability >= hardThreshold &&
    passesEarlyExitGuards(pos, features) &&
    !recovery
  ) {
    const detail = `SFP hard p=${(hardProbability * 100).toFixed(0)}% · fav ${pct.favorable.toFixed(
      2
    )}% · adv ${pct.adverse.toFixed(2)}% · no recovery`;
    return {
      reason: "ai_early_exit_hard",
      exitPrice: close,
      detail,
      probability: hardProbability,
      exitKind: "hard",
    };
  }

  if (
    recovery &&
    softProbability >= softThreshold &&
    passesSoftExitGuards(pos, features)
  ) {
    const detail = `SFP soft p=${(softProbability * 100).toFixed(0)}% · giveback ${pct.giveback.toFixed(
      2
    )}% · fav ${pct.favorable.toFixed(2)}% · recovery likely`;
    return {
      reason: "ai_early_exit_soft",
      exitPrice: close,
      detail,
      probability: softProbability,
      exitKind: "soft",
    };
  }

  return null;
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

  if (options.onProgress) {
    options.onProgress({
      phase: "threshold",
      head: options.head ?? "model",
      message: `Tuning ${options.head ?? "model"} threshold…`,
    });
  }

  const threshold = pickExitThreshold(samples, means, stds, weights, bias, options);

  let correct = 0;
  for (const s of samples) {
    const p = scoreSample(s.vec, means, stds, weights, bias);
    const pred = p >= threshold ? 1 : 0;
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

function scoreSample(vec, means, stds, weights, bias) {
  const x = normalizeVector(vec, means, stds);
  let z = bias;
  for (let i = 0; i < x.length; i++) z += weights[i] * x[i];
  return sigmoid(z);
}

/** Prefer high precision — false exits hurt live PnL more than missed cuts. */
function pickExitThreshold(samples, means, stds, weights, bias, options = {}) {
  const minTh = options.minThreshold ?? 0.75;
  const maxTh = options.maxThreshold ?? 0.92;
  const fallback = clamp(
    num(options.threshold, AI_EXIT_DEFAULTS.aiEarlyExitThreshold),
    minTh,
    maxTh
  );
  if (!samples.length) return fallback;

  let best = { threshold: fallback, score: -1 };
  for (let th = minTh; th <= maxTh + 1e-6; th += 0.02) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const s of samples) {
      const p = scoreSample(s.vec, means, stds, weights, bias);
      const pred = p >= th ? 1 : 0;
      if (pred === 1 && s.label === 1) tp++;
      else if (pred === 1 && s.label === 0) fp++;
      else if (pred === 0 && s.label === 1) fn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const score = precision * 0.8 + recall * 0.2;
    if (score > best.score || (Math.abs(score - best.score) < 1e-6 && th > best.threshold)) {
      best = { threshold: +th.toFixed(2), score, precision, recall };
    }
  }
  return best.threshold;
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
    signalSnapshot: trade.signalSnapshot ?? null,
    entryAboveCorridorPct: trade.entryAboveCorridorPct,
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
  let peakPnlSoFar = 0;

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
    const features = extractSfpEarlyExitFeatures(pos, bar, recent);
    const vec = featuresToVector(features);
    const currentPnl = pnlAtClose(pos, close);
    peakPnlSoFar = Math.max(peakPnlSoFar, currentPnl);

    const { maxFuturePnl } = futurePathFromBars(bars, i, pos);
    const tier = classifyExitTier({
      currentPnl,
      finalPnl,
      maxFuturePnl,
      peakPnlSoFar,
      margin,
    });

    samples.push({
      vec,
      labelHard: tier === "hard" ? 1 : 0,
      labelSoft: tier === "soft" ? 1 : 0,
      tier,
    });
  }
  return samples;
}

async function buildTrainingSamples(trades, fetchBars, cfg = {}, options = {}) {
  const samples = [];
  const list = trades ?? [];
  const total = list.length;
  const reportEvery = Math.max(1, Math.min(25, Math.floor(total / 40) || 1));

  for (let i = 0; i < total; i++) {
    const trade = list[i];
    if (!trade?.symbol || !trade.openedAt || !trade.closedAt) continue;
    const bars = fetchBars(trade.symbol, trade.openedAt, trade.closedAt);
    if (!bars?.length) continue;
    const range = barsInRange(bars, trade.openedAt, trade.closedAt);
    if (range.length < 3) continue;
    samples.push(...simulatePositionAtBars(trade, range, cfg));

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

async function trainFromTrades(trades, fetchBars, options = {}) {
  const cfg = normalizeAiExitConfig(options);
  const onProgress = options.onProgress;
  const sampleCfg = { ...cfg, aiEarlyExitMinBars: 2 };

  const sfpTrades = (trades ?? []).filter(
    (t) => isSfpTrade(t) && !isAiEarlyExitReason(t.exitReason)
  );
  if (sfpTrades.length < 8) {
    throw new Error(
      `Need at least 8 SFP closed trades for training (got ${sfpTrades.length})`
    );
  }

  onProgress?.({
    phase: "samples",
    done: 0,
    total: sfpTrades.length,
    message: `Building SFP samples from ${sfpTrades.length} trades…`,
  });

  let samples = await buildTrainingSamples(sfpTrades, fetchBars, sampleCfg, {
    onProgress,
  });
  if (samples.length < 30) {
    throw new Error(
      `Need at least 30 SFP training samples with kline history (got ${samples.length})`
    );
  }

  const hardPos = samples.filter((s) => s.labelHard === 1);
  const softPos = samples.filter((s) => s.labelSoft === 1);
  const hold = samples.filter((s) => s.labelHard === 0 && s.labelSoft === 0);

  if (hardPos.length < 4 && softPos.length < 4) {
    throw new Error(
      `Too few SFP exit labels (hard ${hardPos.length}, soft ${softPos.length}). Run train bot with more SFP trades.`
    );
  }

  onProgress?.({
    phase: "balance",
    samples: samples.length,
    hard: hardPos.length,
    soft: softPos.length,
    hold: hold.length,
    message: `Balancing ${samples.length} SFP samples (hard ${hardPos.length} / soft ${softPos.length} / hold ${hold.length})…`,
  });
  await yieldToLoop();

  function balanceHead(posRows, holdRows, capMul = 2) {
    const maxHold = Math.max(1, posRows.length * capMul);
    const holdSample =
      holdRows.length > maxHold * 3
        ? holdRows.sort(() => Math.random() - 0.5).slice(0, maxHold * 3)
        : holdRows;
    return [...posRows, ...holdSample].sort(() => Math.random() - 0.5);
  }

  const hardSamples = balanceHead(
    hardPos.map((s) => ({ vec: s.vec, label: 1 })),
    hold.map((s) => ({ vec: s.vec, label: 0 }))
  );
  const softSamples = balanceHead(
    softPos.map((s) => ({ vec: s.vec, label: 1 })),
    hold.map((s) => ({ vec: s.vec, label: 0 }))
  );

  onProgress?.({
    phase: "fit",
    done: 0,
    total: (options.epochs ?? 120) * 2,
    samples: hardSamples.length + softSamples.length,
    message: `Training hard head (${hardSamples.length} rows)…`,
  });

  const hardModel =
    hardPos.length >= 4
      ? trainLogisticRegression(hardSamples, {
          head: "hard",
          threshold: cfg.aiEarlyExitHardThreshold,
          minThreshold: 0.72,
          maxThreshold: 0.9,
          source: options.source ?? "trained",
          onProgress,
          epochs: options.epochs ?? 120,
        })
      : { ...DEFAULT_MODEL.hard };

  onProgress?.({
    phase: "fit",
    message: `Training soft head (${softSamples.length} rows)…`,
  });

  const softModel =
    softPos.length >= 4
      ? trainLogisticRegression(softSamples, {
          head: "soft",
          threshold: cfg.aiEarlyExitSoftThreshold,
          minThreshold: 0.82,
          maxThreshold: 0.94,
          source: options.source ?? "trained",
          onProgress,
          epochs: options.epochs ?? 120,
        })
      : { ...DEFAULT_MODEL.soft };

  onProgress?.({
    phase: "saving",
    message: "Saving model…",
  });

  return saveModel({
    version: 2,
    signal: "sfp",
    featureNames: FEATURE_NAMES,
    hard: hardModel,
    soft: softModel,
    trainedAt: Date.now(),
    source: options.source ?? "trained",
  });
}

function getModelStatus() {
  const model = normalizeStoredModel(getModel());
  const hard = model.hard;
  const soft = model.soft;
  return {
    ok: true,
    signal: "sfp",
    signalKinds: SFP_SIGNAL_KINDS,
    path: MODEL_FILE(),
    loaded: Boolean(model),
    version: model.version ?? 2,
    source: model.source,
    trainedAt: model.trainedAt ? formatIsoUtcPlus3(model.trainedAt) : null,
    threshold: hard.threshold,
    hardThreshold: hard.threshold,
    softThreshold: soft.threshold,
    metrics: hard.metrics,
    hardMetrics: hard.metrics,
    softMetrics: soft.metrics,
    featureCount: FEATURE_NAMES.length,
    defaults: AI_EXIT_DEFAULTS,
  };
}

function ensureDefaultModelOnDisk() {
  const raw = readJsonFile(MODEL_FILE(), null);
  if (!raw) saveModel({ ...DEFAULT_MODEL });
}

module.exports = {
  SFP_SIGNAL_KINDS,
  AI_EXIT_DEFAULTS,
  DEFAULT_MODEL,
  MODEL_FILE,
  isSfpSignal,
  isSfpTrade,
  isAiEarlyExitReason,
  normalizeAiExitConfig,
  getModel,
  reloadModel,
  saveModel,
  predictEarlyExit,
  passesEarlyExitGuards,
  passesSoftExitGuards,
  recoveryLikely,
  decodeFeaturePct,
  evaluateAiEarlyExit,
  buildTrainingSamples,
  trainFromTrades,
  getModelStatus,
  ensureDefaultModelOnDisk,
};
