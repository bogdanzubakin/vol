const fs = require("fs");
const { dataPath, readJsonFile } = require("./data-dir");
const { getDb, repos } = require("./db");
const { LIVE_CONFIG_KEYS, pickLiveConfig } = require("./signal-metrics");

const CONFIG_FILE = () => dataPath("scanner-config.json");

function getAll() {
  const fromDb = repos.settings.getScannerConfig(getDb());
  if (Object.keys(fromDb).length) return fromDb;
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
  const patch = pickLiveConfig(cfg);
  repos.settings.saveScannerConfig(getDb(), patch);
  return getAll();
}

function migrateFromResultsJson() {
  const dbConfig = repos.settings.getScannerConfig(getDb());
  if (Object.keys(dbConfig).length) return;
  try {
    if (fs.existsSync(CONFIG_FILE())) return;
  } catch {
    return;
  }
  const results = readJsonFile(dataPath("results.json"), null);
  if (!results || typeof results !== "object") return;
  const patch = pickLiveConfig(results);
  const hasValues = LIVE_CONFIG_KEYS.some((k) => patch[k] != null);
  if (!hasValues) return;
  repos.settings.saveScannerConfig(getDb(), patch);
}

module.exports = {
  getAll,
  loadInto,
  saveFrom,
  migrateFromResultsJson,
  CONFIG_FILE,
};
