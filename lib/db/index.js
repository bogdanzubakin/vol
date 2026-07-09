const {
  dbFilePath,
  openDatabase,
  getDb,
  closeDb,
  withTransaction,
} = require("./connection");

function migrate() {
  const { migrate: runMigrate } = require("./migrate");
  return runMigrate();
}

module.exports = {
  dbFilePath,
  openDatabase,
  migrate,
  getDb,
  closeDb,
  withTransaction,
  repos: {
    trades: require("./repos/trades"),
    botState: require("./repos/bot-state"),
    settings: require("./repos/settings"),
    backtest: require("./repos/backtest"),
    signals: require("./repos/signals"),
    meta: require("./repos/meta"),
    config: require("./repos/config"),
  },
};
