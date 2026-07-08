const { openDatabase, SCHEMA_SQL, dbFilePath } = require("./connection");

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

  const { importFromJsonFiles } = require("./json-import");
  const importResult = importFromJsonFiles(db);
  return { db, importResult };
}

module.exports = { migrate, dbFilePath };
