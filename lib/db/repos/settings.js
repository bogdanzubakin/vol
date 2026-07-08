function getAllUiSettings(db) {
  const rows = db.prepare("SELECT key, value FROM ui_settings").all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function patchUiSettings(db, updates) {
  const del = db.prepare("DELETE FROM ui_settings WHERE key = ?");
  const ins = db.prepare(
    "INSERT INTO ui_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  for (const [key, value] of Object.entries(updates ?? {})) {
    if (value === null || value === undefined) del.run(key);
    else ins.run(key, String(value));
  }
  return getAllUiSettings(db);
}

function getScannerConfig(db) {
  const row = db.prepare("SELECT config_json FROM scanner_config WHERE id = 1").get();
  if (!row) return {};
  try {
    const data = JSON.parse(row.config_json);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function saveScannerConfig(db, config) {
  db.prepare(
    `INSERT INTO scanner_config(id, config_json, updated_at) VALUES(1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`
  ).run(JSON.stringify(config ?? {}), Date.now());
  return getScannerConfig(db);
}

module.exports = {
  getAllUiSettings,
  patchUiSettings,
  getScannerConfig,
  saveScannerConfig,
};
