const fs = require("fs");
const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { LIVE_CONFIG_KEYS, pickLiveConfig } = require("./signal-metrics");

const CONFIG_FILE = () => dataPath("scanner-config.json");

function getAll() {
  const data = readJsonFile(CONFIG_FILE(), {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function loadInto(cfg) {
  const saved = getAll();
  if (saved.interval && typeof saved.interval === "string") {
    cfg.interval = saved.interval;
  }
  for (const key of LIVE_CONFIG_KEYS) {
    if (saved[key] == null || saved[key] === "") continue;
    const v = Number(saved[key]);
    if (Number.isFinite(v)) cfg[key] = v;
  }
}

function saveFrom(cfg) {
  writeJsonFile(CONFIG_FILE(), pickLiveConfig(cfg));
  return getAll();
}

function migrateFromResultsJson() {
  const target = CONFIG_FILE();
  try {
    if (fs.existsSync(target)) return;
  } catch {
    return;
  }
  const results = readJsonFile(dataPath("results.json"), null);
  if (!results || typeof results !== "object") return;
  const patch = pickLiveConfig(results);
  const hasValues = LIVE_CONFIG_KEYS.some((k) => patch[k] != null);
  if (!hasValues) return;
  writeJsonFile(target, patch);
}

module.exports = {
  getAll,
  loadInto,
  saveFrom,
  migrateFromResultsJson,
  CONFIG_FILE,
};
