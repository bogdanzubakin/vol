const { createGbmOnnxRuntime, isOnnxRuntimeAvailable, predictGbmProbability } = require("./gbm-onnx-runtime");

const runtime = createGbmOnnxRuntime({
  basename: "pullback-signal-onnx",
  modelPrefix: "pullback-signal",
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
  predictModelProbability: runtime.predictForHead,
  ensureGbmModelsForScope: runtime.ensureGbmModelsForScope,
  isOnnxRuntimeAvailable,
  clearOnnxSessionCache,
};
