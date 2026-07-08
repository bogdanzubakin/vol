/** SQLite schema for vol app persistence (v1). */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS db_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_type     TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  git_commit   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_config_versions_bot_created
  ON config_versions(bot_type, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_state (
  bot_type        TEXT PRIMARY KEY CHECK (bot_type IN ('paper', 'live')),
  config_json     TEXT NOT NULL,
  balance         REAL,
  history_day_key TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drawdown_state (
  bot_type        TEXT PRIMARY KEY CHECK (bot_type IN ('paper', 'live')),
  baseline_equity REAL,
  triggered_at    INTEGER
);

CREATE TABLE IF NOT EXISTS symbol_sl_streak (
  bot_type TEXT NOT NULL,
  symbol   TEXT NOT NULL,
  streak   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_type, symbol)
);

CREATE TABLE IF NOT EXISTS open_positions (
  id                 TEXT PRIMARY KEY,
  bot_type           TEXT NOT NULL CHECK (bot_type IN ('paper', 'live')),
  symbol             TEXT NOT NULL,
  position_json      TEXT NOT NULL,
  config_version_id  INTEGER REFERENCES config_versions(id),
  opened_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_open_positions_bot ON open_positions(bot_type);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at          INTEGER,
  finished_at         INTEGER,
  days                INTEGER,
  interval            TEXT,
  bot_config_json     TEXT,
  signal_config_json  TEXT,
  summary_json        TEXT,
  run_meta_json       TEXT,
  result_json         TEXT,
  git_commit          TEXT,
  is_last             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_backtest_runs_last ON backtest_runs(is_last, finished_at DESC);

CREATE TABLE IF NOT EXISTS closed_trades (
  id                  TEXT PRIMARY KEY,
  bot_type            TEXT NOT NULL CHECK (bot_type IN ('paper', 'live', 'backtest')),
  backtest_run_id     INTEGER REFERENCES backtest_runs(id),
  symbol              TEXT NOT NULL,
  signal_kind         TEXT NOT NULL,
  side                TEXT,
  entry_price         REAL,
  initial_entry_price REAL,
  exit_price          REAL,
  quantity            REAL,
  margin              REAL,
  leverage            INTEGER,
  add_count           INTEGER DEFAULT 0,
  pnl                 REAL NOT NULL,
  pnl_pct             REAL,
  exit_reason         TEXT,
  exit_method         TEXT,
  peak_move_pct       REAL,
  trough_move_pct     REAL,
  move_pct_at_exit    REAL,
  corridor_width_pct  REAL,
  sl_distance_pct     REAL,
  tp_distance_pct     REAL,
  stop_moved          INTEGER,
  open_delay_sec      REAL,
  entry_order_id      TEXT,
  signal_snapshot     TEXT,
  exit_path_oracle    TEXT,
  trade_json          TEXT NOT NULL,
  config_version_id   INTEGER REFERENCES config_versions(id),
  snapshot_id         TEXT,
  opened_at           INTEGER NOT NULL,
  closed_at           INTEGER NOT NULL,
  decided_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_closed_trades_closed_at ON closed_trades(closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_closed_trades_bot_closed
  ON closed_trades(bot_type, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_closed_trades_symbol ON closed_trades(symbol);
CREATE INDEX IF NOT EXISTS idx_closed_trades_signal_kind ON closed_trades(signal_kind);
CREATE INDEX IF NOT EXISTS idx_closed_trades_backtest ON closed_trades(backtest_run_id);

CREATE TABLE IF NOT EXISTS bot_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_type  TEXT NOT NULL CHECK (bot_type IN ('paper', 'live', 'scanner')),
  level     TEXT NOT NULL,
  symbol    TEXT,
  detail    TEXT,
  trade_id  TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_events_bot_at ON bot_events(bot_type, at DESC);

CREATE TABLE IF NOT EXISTS signal_hits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol         TEXT NOT NULL,
  signal_kind    TEXT NOT NULL,
  signal_status  TEXT,
  at             INTEGER NOT NULL,
  metrics_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_signal_hits_at ON signal_hits(at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_hits_symbol_kind ON signal_hits(symbol, signal_kind);

CREATE TABLE IF NOT EXISTS ai_models (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name    TEXT NOT NULL,
  scope         TEXT NOT NULL,
  backend       TEXT,
  file_path     TEXT NOT NULL,
  metrics_json  TEXT,
  trained_at    INTEGER,
  saved_at      INTEGER NOT NULL,
  UNIQUE(model_name, scope)
);

CREATE TABLE IF NOT EXISTS trade_snapshots (
  id          TEXT PRIMARY KEY,
  trade_id    TEXT,
  bot_type    TEXT,
  file_path   TEXT NOT NULL,
  bytes       INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_snapshots_trade ON trade_snapshots(trade_id);

CREATE TABLE IF NOT EXISTS ui_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scanner_config (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  config_json  TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
`;

module.exports = { SCHEMA_SQL };
