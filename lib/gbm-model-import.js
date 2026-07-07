const fs = require("fs");
const path = require("path");
const { dataPath, writeJsonFile } = require("./data-dir");

function gbmOnnxDir(basename, scope = "paper") {
  return dataPath(`${basename}-${scope}`);
}

function readGbmBundles({ basename, modelPrefix, scope = "paper" }) {
  const dir = gbmOnnxDir(basename, scope);
  const bullPath = path.join(dir, `${modelPrefix}-bull.gbm.json`);
  const bearPath = path.join(dir, `${modelPrefix}-bear.gbm.json`);
  const bundles = {};
  try {
    if (fs.existsSync(bullPath)) {
      bundles.bull = JSON.parse(fs.readFileSync(bullPath, "utf8"));
    }
    if (fs.existsSync(bearPath)) {
      bundles.bear = JSON.parse(fs.readFileSync(bearPath, "utf8"));
    }
  } catch {
    return null;
  }
  return Object.keys(bundles).length ? bundles : null;
}

function writeGbmBundles({ basename, modelPrefix, scope = "paper", bundles }) {
  if (!bundles || typeof bundles !== "object") return 0;
  const dir = gbmOnnxDir(basename, scope);
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  if (bundles.bull) {
    writeJsonFile(path.join(dir, `${modelPrefix}-bull.gbm.json`), bundles.bull);
    written++;
  }
  if (bundles.bear) {
    writeJsonFile(path.join(dir, `${modelPrefix}-bear.gbm.json`), bundles.bear);
    written++;
  }
  return written;
}

function copyGbmOnnxDir({ basename, fromScope = "paper", toScope = "live" }) {
  const src = gbmOnnxDir(basename, fromScope);
  const dest = gbmOnnxDir(basename, toScope);
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(src)) {
    const srcPath = path.join(src, name);
    if (!fs.statSync(srcPath).isFile()) continue;
    if (!/\.(gbm\.json|onnx|json)$/.test(name)) continue;
    fs.copyFileSync(srcPath, path.join(dest, name));
    copied++;
  }
  return copied;
}

module.exports = {
  gbmOnnxDir,
  readGbmBundles,
  writeGbmBundles,
  copyGbmOnnxDir,
};
