const { dataPath } = require("./data-dir");

const AI_MODEL_SCOPES = {
  paper: "paper",
  live: "live",
};

/** paper = train bot + paper history; live = live bot closed trades only. */
function normalizeAiModelScope(scope) {
  return String(scope || "paper").toLowerCase() === "live"
    ? AI_MODEL_SCOPES.live
    : AI_MODEL_SCOPES.paper;
}

function modelFileFor(basename, scope = "paper") {
  const s = normalizeAiModelScope(scope);
  if (s === AI_MODEL_SCOPES.live) {
    return dataPath(`${basename}-live.json`);
  }
  return dataPath(`${basename}.json`);
}

function trainingSourceLabel(scope, source) {
  const s = normalizeAiModelScope(scope);
  if (s === AI_MODEL_SCOPES.live) return "live";
  return source ?? "auto";
}

module.exports = {
  AI_MODEL_SCOPES,
  normalizeAiModelScope,
  modelFileFor,
  trainingSourceLabel,
};
