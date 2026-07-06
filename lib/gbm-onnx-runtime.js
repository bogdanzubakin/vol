const fs = require("fs");
const path = require("path");
const { dataPath } = require("./data-dir");

let ortModule = null;
let ortLoadError = null;
const sessionCache = new Map();
const gbmCache = new Map();

function isOnnxRuntimeAvailable() {
  if (ortModule) return true;
  if (ortLoadError) return false;
  try {
    ortModule = require("onnxruntime-node");
    return true;
  } catch (e) {
    ortLoadError = e;
    return false;
  }
}

function extractProbabilityFromOutput(output) {
  if (!output) return 0.5;
  const first = output[Object.keys(output)[0]];
  if (!first) return 0.5;
  const data = first.data;
  if (!data?.length) return 0.5;
  if (data.length === 1) {
    const v = Number(data[0]);
    return v >= 0 && v <= 1 ? v : 1 / (1 + Math.exp(-v));
  }
  if (data.length >= 2) {
    const a = Number(data[0]);
    const b = Number(data[1]);
    if (a >= 0 && a <= 1 && b >= 0 && b <= 1 && Math.abs(a + b - 1) < 0.01) {
      return b;
    }
    return 1 / (1 + Math.exp(-b));
  }
  return 0.5;
}

function predictGbmProbability(ensemble, featureVec) {
  if (!ensemble?.trees?.length) return 0.5;
  const lr = Number(ensemble.learningRate) || 0.1;
  const init = Number(ensemble.initScore) || 0;
  let score = init;
  const vec = featureVec.map((v) => Number(v) || 0);
  for (const tree of ensemble.trees) {
    let node = 0;
    while (tree.children_left[node] !== -1) {
      const feat = tree.feature[node];
      const thr = tree.threshold[node];
      node = vec[feat] <= thr ? tree.children_left[node] : tree.children_right[node];
    }
    score += lr * tree.value[node];
  }
  return 1 / (1 + Math.exp(-score));
}

function createGbmOnnxRuntime({ basename, modelPrefix }) {
  function onnxDir(scope = "paper") {
    return dataPath(`${basename}-${scope}`);
  }

  function onnxModelPathsForScope(scope = "paper", head = "bull") {
    const suffix = head === "bear" ? "bear" : "bull";
    return path.join(onnxDir(scope), `${modelPrefix}-${suffix}.onnx`);
  }

  function gbmModelPath(scope = "paper", head = "bull") {
    const suffix = head === "bear" ? "bear" : "bull";
    return path.join(onnxDir(scope), `${modelPrefix}-${suffix}.gbm.json`);
  }

  function loadGbmEnsemble(scope = "paper", head = "bull") {
    const file = gbmModelPath(scope, head);
    const key = `${basename}:${path.resolve(file)}`;
    if (gbmCache.has(key)) return gbmCache.get(key);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      gbmCache.set(key, raw);
      return raw;
    } catch {
      return null;
    }
  }

  function predictOnnxProbability(modelPath, featureVec) {
    if (!isOnnxRuntimeAvailable()) return 0.5;
    try {
      const key = path.resolve(modelPath);
      if (!sessionCache.has(key)) return 0.5;
      const session = sessionCache.get(key);
      const inputName = session.inputNames[0];
      const tensor = new ortModule.Tensor(
        "float32",
        Float32Array.from(featureVec.map((v) => Number(v) || 0)),
        [1, featureVec.length]
      );
      const output = session.runSync({ [inputName]: tensor });
      return extractProbabilityFromOutput(output);
    } catch {
      return 0.5;
    }
  }

  function predictForHead({ scope, head, featureVec }) {
    const gbm = loadGbmEnsemble(scope, head);
    if (gbm) return predictGbmProbability(gbm, featureVec);
    return predictOnnxProbability(onnxModelPathsForScope(scope, head), featureVec);
  }

  function ensureGbmModelsForScope(scope = "paper", sourceScope = "paper") {
    const dir = onnxDir(scope);
    fs.mkdirSync(dir, { recursive: true });
    let copied = 0;
    const srcDir = onnxDir(sourceScope);
    if (!fs.existsSync(srcDir)) return copied;
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name);
      if (!fs.statSync(src).isFile()) continue;
      if (!/\.(gbm\.json|onnx|json)$/.test(name)) continue;
      const dest = path.join(dir, name);
      if (fs.existsSync(dest)) continue;
      fs.copyFileSync(src, dest);
      copied++;
    }
    return copied;
  }

  function clearCache() {
    for (const key of [...gbmCache.keys()]) {
      if (key.startsWith(`${basename}:`)) gbmCache.delete(key);
    }
  }

  return {
    basename,
    modelPrefix,
    onnxDir,
    onnxModelPathsForScope,
    gbmModelPath,
    loadGbmEnsemble,
    predictGbmProbability,
    predictForHead,
    ensureGbmModelsForScope,
    clearCache,
  };
}

module.exports = {
  createGbmOnnxRuntime,
  isOnnxRuntimeAvailable,
  predictGbmProbability,
};
