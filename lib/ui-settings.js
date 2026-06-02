const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");

const SETTINGS_FILE = () => dataPath("ui-settings.json");

function getAll() {
  const data = readJsonFile(SETTINGS_FILE(), {});
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function patch(updates) {
  if (!updates || typeof updates !== "object") {
    throw new Error("Settings patch must be a JSON object");
  }
  const current = getAll();
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      next[key] = String(value);
    }
  }
  writeJsonFile(SETTINGS_FILE(), next);
  return next;
}

module.exports = { getAll, patch };
