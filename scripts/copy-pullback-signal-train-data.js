#!/usr/bin/env node
/**
 * Copy pullback signal GBM/ONNX train artifacts from compare output to paper + live paths.
 *
 *   node scripts/copy-pullback-signal-train-data.js
 *   node scripts/copy-pullback-signal-train-data.js --to-live-only
 */
const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { onnxDir, clearOnnxSessionCache } = require("../lib/pullback-signal-onnx");
const { reloadModel } = require("../lib/pullback-signal-model");

const SRC_MODEL = () => dataPath("pullback-signal-model-onnx.json");
const SRC_ONNX_DIR = () => onnxDir("paper");
const SAMPLES = () => dataPath("pullback-signal-onnx-samples.json");
const COMPARE = () => dataPath("pullback-signal-funding-onnx-compare.json");

function parseArgs(argv) {
  let toLiveOnly = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--to-live-only") toLiveOnly = true;
  }
  return { toLiveOnly };
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyOnnxDir(fromScope, toScope) {
  const srcDir = onnxDir(fromScope);
  const destDir = onnxDir(toScope);
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Missing source dir: ${srcDir}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const names = fs.readdirSync(srcDir);
  let copied = 0;
  for (const name of names) {
    const src = path.join(srcDir, name);
    if (!fs.statSync(src).isFile()) continue;
    fs.copyFileSync(src, path.join(destDir, name));
    copied++;
  }
  return { destDir, copied, names: names.length };
}

function installModelJson(scope, sourceModel) {
  const file = modelFileFor("pullback-signal-model", scope);
  const payload = {
    ...sourceModel,
    scope,
    source: sourceModel.source ?? "copy:train-data",
    trainedAt: sourceModel.trainedAt ?? Date.now(),
  };
  writeJsonFile(file, payload);
  return file;
}

function main() {
  const { toLiveOnly } = parseArgs(process.argv);
  const model = readJsonFile(SRC_MODEL(), null);
  if (!model) {
    throw new Error(`Missing ${SRC_MODEL()} — run compare first`);
  }

  const onnxCopy = copyOnnxDir("paper", "live");
  const out = {
    ranAt: new Date().toISOString(),
    sourceModel: SRC_MODEL(),
    sourceOnnxDir: SRC_ONNX_DIR(),
    onnxLive: onnxCopy,
    models: {},
    samples: null,
    compare: null,
  };

  if (!toLiveOnly) {
    out.models.paper = installModelJson("paper", model);
    reloadModel("paper");
  }
  out.models.live = installModelJson("live", model);
  reloadModel("live");

  if (fs.existsSync(SAMPLES())) {
    const archive = dataPath("pullback-signal-onnx-samples-archive.json");
    copyFile(SAMPLES(), archive);
    out.samples = { from: SAMPLES(), archive };
  }
  if (fs.existsSync(COMPARE())) {
    const archive = dataPath("pullback-signal-funding-onnx-compare-archive.json");
    copyFile(COMPARE(), archive);
    out.compare = { from: COMPARE(), archive };
  }

  clearOnnxSessionCache();
  writeJsonFile(dataPath("pullback-signal-train-data-copy.json"), out);
  console.log(JSON.stringify(out, null, 2));
}

main();
