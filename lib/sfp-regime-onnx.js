const { createGbmOnnxRuntime, isOnnxRuntimeAvailable, predictGbmProbability } = require("./gbm-onnx-runtime");

const runtime = createGbmOnnxRuntime({
  basename: "sfp-regime-onnx",
  modelPrefix: "sfp-regime",
});

function clearOnnxSessionCache() {
  runtime.clearCache();
}

module.exports = {
  ONNX_BASENAME: runtime.basename,
  onnxDir: runtime.onnxDir,
  onnxModelPathsForScope: runtime.onnxModelPathsForScope,
  gbmModelPath: runtime.gbmModelPath,
  loadGbmEnsemble: runtime.loadGbmEnsemble,
  predictGbmProbability,
  predictForHead: runtime.predictForHead,
  ensureGbmModelsForScope: runtime.ensureGbmModelsForScope,
  isOnnxRuntimeAvailable,
  clearOnnxSessionCache,
};
