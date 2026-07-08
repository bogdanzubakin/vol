const path = require("path");
const { dataPath } = require("../data-dir");
const { SCHEMA_SQL } = require("./schema");

let dbInstance = null;

function dbFilePath() {
  return dataPath("vol.db");
}

function openDatabase() {
  if (dbInstance) return dbInstance;
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (e) {
    throw new Error(`better-sqlite3 is required: ${e.message}`);
  }
  const file = dbFilePath();
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  dbInstance = db;
  return db;
}

function getDb() {
  if (!dbInstance) {
    const { migrate } = require("./migrate");
    migrate();
  }
  return dbInstance;
}

function closeDb() {
  if (!dbInstance) return;
  try {
    dbInstance.close();
  } catch {
    /* ignore */
  }
  dbInstance = null;
}

function withTransaction(fn) {
  const db = getDb();
  return db.transaction(fn)();
}

module.exports = {
  dbFilePath,
  openDatabase,
  getDb,
  closeDb,
  withTransaction,
  SCHEMA_SQL,
};
