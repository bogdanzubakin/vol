const { formatIsoUtcPlus3 } = require("../../time-format");
const { upsertClosedTrade, listClosedTrades, deleteTradesByIds, clearBotTrades } = require("./trades");

const EVENT_TRIM_ABOVE = 2000;
const EVENT_KEEP = 500;

function saveConfigVersion(db, botType, config, gitCommit = null) {
  const info = db
    .prepare(
      `INSERT INTO config_versions(bot_type, config_json, git_commit, created_at)
       VALUES(?, ?, ?, ?)`
    )
    .run(botType, JSON.stringify(config ?? {}), gitCommit, Date.now());
  return Number(info.lastInsertRowid);
}

function loadBotRuntime(db, botType) {
  const stateRow = db.prepare("SELECT * FROM bot_state WHERE bot_type = ?").get(botType);
  if (!stateRow) return null;

  let config;
  try {
    config = JSON.parse(stateRow.config_json);
  } catch {
    config = {};
  }

  const dd = db.prepare("SELECT * FROM drawdown_state WHERE bot_type = ?").get(botType);
  const streakRows = db
    .prepare("SELECT symbol, streak FROM symbol_sl_streak WHERE bot_type = ?")
    .all(botType);
  const symbolSlStreak = {};
  for (const r of streakRows) symbolSlStreak[r.symbol] = r.streak;

  const openPositions = db
    .prepare("SELECT position_json FROM open_positions WHERE bot_type = ? ORDER BY opened_at")
    .all(botType)
    .map((r) => {
      try {
        return JSON.parse(r.position_json);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const closedTrades = listClosedTrades(db, { botType, limit: 500, order: "DESC" });
  const log = db
    .prepare(
      `SELECT level, symbol, detail, at FROM bot_events
       WHERE bot_type = ? ORDER BY at DESC LIMIT 200`
    )
    .all(botType)
    .map((r) => ({
      type: r.level,
      level: r.level,
      symbol: r.symbol,
      detail: r.detail,
      at: r.at,
      atIso: r.at ? formatIsoUtcPlus3(r.at) : null,
    }));

  return {
    config,
    balance: stateRow.balance,
    historyDayKey: stateRow.history_day_key,
    openPositions,
    closedTrades,
    log,
    symbolSlStreak,
    drawdownBaseline: dd?.baseline_equity ?? null,
    drawdownTriggeredAt: dd?.triggered_at ?? null,
  };
}

function saveBotRuntime(db, botType, state, { balance = undefined } = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO bot_state(bot_type, config_json, balance, history_day_key, updated_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(bot_type) DO UPDATE SET
       config_json = excluded.config_json,
       balance = excluded.balance,
       history_day_key = excluded.history_day_key,
       updated_at = excluded.updated_at`
  ).run(
    botType,
    JSON.stringify(state.config ?? {}),
    balance !== undefined ? balance : state.balance ?? null,
    state.historyDayKey ?? null,
    now
  );

  db.prepare(
    `INSERT INTO drawdown_state(bot_type, baseline_equity, triggered_at)
     VALUES(?, ?, ?)
     ON CONFLICT(bot_type) DO UPDATE SET
       baseline_equity = excluded.baseline_equity,
       triggered_at = excluded.triggered_at`
  ).run(
    botType,
    state.drawdownBaseline ?? null,
    state.drawdownTriggeredAt ?? null
  );

  db.prepare("DELETE FROM symbol_sl_streak WHERE bot_type = ?").run(botType);
  const insStreak = db.prepare(
    "INSERT INTO symbol_sl_streak(bot_type, symbol, streak) VALUES(?, ?, ?)"
  );
  for (const [symbol, streak] of Object.entries(state.symbolSlStreak ?? {})) {
    const n = Number(streak);
    if (!symbol || !Number.isFinite(n)) continue;
    insStreak.run(botType, symbol, n);
  }

  db.prepare("DELETE FROM open_positions WHERE bot_type = ?").run(botType);
  const insPos = db.prepare(
    `INSERT INTO open_positions(id, bot_type, symbol, position_json, opened_at)
     VALUES(?, ?, ?, ?, ?)`
  );
  for (const pos of state.openPositions ?? []) {
    if (!pos?.id) continue;
    insPos.run(
      String(pos.id),
      botType,
      String(pos.symbol || ""),
      JSON.stringify(pos),
      Number(pos.openedAt) || now
    );
  }
}

function appendBotEvent(db, botType, { level, symbol, detail, tradeId = null, at = Date.now() }) {
  db.prepare(
    `INSERT INTO bot_events(bot_type, level, symbol, detail, trade_id, at)
     VALUES(?, ?, ?, ?, ?, ?)`
  ).run(botType, level, symbol ?? null, detail ?? null, tradeId, at);

  const count = db.prepare("SELECT COUNT(*) AS n FROM bot_events WHERE bot_type = ?").get(botType)?.n;
  if (count > EVENT_TRIM_ABOVE) {
    db.prepare(
      `DELETE FROM bot_events WHERE bot_type = ? AND id NOT IN (
         SELECT id FROM bot_events WHERE bot_type = ? ORDER BY at DESC LIMIT ?
       )`
    ).run(botType, botType, EVENT_KEEP);
  }
}

function clearBotHistory(db, botType) {
  clearBotTrades(db, botType);
  db.prepare("DELETE FROM bot_events WHERE bot_type = ?").run(botType);
}

function insertClosedTrade(db, botType, trade) {
  return upsertClosedTrade(db, botType, trade);
}

module.exports = {
  saveConfigVersion,
  loadBotRuntime,
  saveBotRuntime,
  appendBotEvent,
  clearBotHistory,
  insertClosedTrade,
  deleteTradesByIds: deleteTradesByIds,
};
