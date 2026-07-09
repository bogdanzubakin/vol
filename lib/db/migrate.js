const { openDatabase, SCHEMA_SQL, dbFilePath } = require("./connection");

function hasBotStateConfigVersionColumn(db) {
  return db
    .prepare("PRAGMA table_info(bot_state)")
    .all()
    .some((col) => col.name === "current_config_version_id");
}

function migrateV2ConfigVersions(db) {
  if (!hasBotStateConfigVersionColumn(db)) {
    db.exec(
      `ALTER TABLE bot_state
       ADD COLUMN current_config_version_id INTEGER REFERENCES config_versions(id)`
    );
  }

  const { ensureConfigVersion } = require("./repos/config");
  for (const botType of ["paper", "live"]) {
    const row = db
      .prepare(
        "SELECT config_json, current_config_version_id FROM bot_state WHERE bot_type = ?"
      )
      .get(botType);
    if (!row || row.current_config_version_id != null) continue;
    let config;
    try {
      config = JSON.parse(row.config_json);
    } catch {
      config = {};
    }
    const versionId = ensureConfigVersion(db, botType, config, null);
    db.prepare(
      "UPDATE bot_state SET current_config_version_id = ? WHERE bot_type = ?"
    ).run(versionId, botType);
  }
}

function hasDrawdownPnlAnchorColumn(db) {
  return db
    .prepare("PRAGMA table_info(drawdown_state)")
    .all()
    .some((col) => col.name === "pnl_anchor");
}

function migrateV3DrawdownAnchor(db) {
  if (!hasDrawdownPnlAnchorColumn(db)) {
    db.exec("ALTER TABLE drawdown_state ADD COLUMN pnl_anchor REAL");
  }
}

function migrate() {
  const db = openDatabase();
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
  const current = row?.v ?? 0;
  if (current < 1) {
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(
      Date.now()
    );
  }
  if (current < 2) {
    migrateV2ConfigVersions(db);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)").run(
      Date.now()
    );
  }
  if (current < 3) {
    migrateV3DrawdownAnchor(db);
    db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)").run(
      Date.now()
    );
  }

  const { importFromJsonFiles } = require("./json-import");
  const importResult = importFromJsonFiles(db);
  return { db, importResult };
}

module.exports = { migrate, dbFilePath };
