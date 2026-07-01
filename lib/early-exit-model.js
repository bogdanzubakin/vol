/**
 * Early-exit facade — routes to per-signal models (SFP first).
 * Pullback / level-break models can be added alongside early-exit-sfp-model.js.
 */
const sfp = require("./early-exit-sfp-model");

module.exports = {
  AI_EXIT_DEFAULTS: sfp.AI_EXIT_DEFAULTS,
  DEFAULT_MODEL: sfp.DEFAULT_MODEL,
  MODEL_FILE: sfp.MODEL_FILE,
  SFP_SIGNAL_KINDS: sfp.SFP_SIGNAL_KINDS,
  isSfpSignal: sfp.isSfpSignal,
  normalizeAiExitConfig: sfp.normalizeAiExitConfig,
  getModel: sfp.getModel,
  reloadModel: sfp.reloadModel,
  saveModel: sfp.saveModel,
  predictEarlyExit: sfp.predictEarlyExit,
  passesEarlyExitGuards: sfp.passesEarlyExitGuards,
  decodeFeaturePct: sfp.decodeFeaturePct,
  evaluateAiEarlyExit: sfp.evaluateAiEarlyExit,
  buildTrainingSamples: sfp.buildTrainingSamples,
  trainFromTrades: sfp.trainFromTrades,
  getModelStatus: sfp.getModelStatus,
  ensureDefaultModelOnDisk: sfp.ensureDefaultModelOnDisk,
  ensureAllDefaultModelsOnDisk: sfp.ensureAllDefaultModelsOnDisk,
  isAiEarlyExitReason: sfp.isAiEarlyExitReason,
};
