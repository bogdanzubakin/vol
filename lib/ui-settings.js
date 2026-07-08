const { getDb, repos } = require("./db");

function getAll() {
  return repos.settings.getAllUiSettings(getDb());
}

function patch(updates) {
  if (!updates || typeof updates !== "object") {
    throw new Error("Settings patch must be a JSON object");
  }
  return repos.settings.patchUiSettings(getDb(), updates);
}

module.exports = { getAll, patch };
