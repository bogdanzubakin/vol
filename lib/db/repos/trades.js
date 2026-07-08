const { formatIsoUtcPlus3 } = require("../../time-format");

const BOT_SIGNAL_KINDS = new Set([
  "sfp",
  "sfp_bear",
  "pullback",
  "pullback_bear",
]);

function tradeToRow(botType, trade, backtestRunId = null) {
  const openedAt = Number(trade.openedAt) || Date.now();
  const closedAt = Number(trade.closedAt) || Date.now();
  const full = { ...trade };
  return {
    id: String(trade.id),
    bot_type: botType,
    backtest_run_id: trade.backtestRunId ?? backtestRunId ?? null,
    symbol: String(trade.symbol || ""),
    signal_kind: String(trade.signalKind || ""),
    side: trade.side ?? null,
    entry_price: trade.entryPrice ?? null,
    initial_entry_price: trade.initialEntryPrice ?? null,
    exit_price: trade.exitPrice ?? null,
    quantity: trade.quantity ?? null,
    margin: trade.margin ?? null,
    leverage: trade.leverage ?? null,
    add_count: trade.addCount ?? 0,
    pnl: Number(trade.pnl) || 0,
    pnl_pct: trade.pnlPct ?? null,
    exit_reason: trade.exitReason ?? null,
    exit_method: trade.exitMethod ?? null,
    peak_move_pct: trade.peakMovePct ?? null,
    trough_move_pct: trade.troughMovePct ?? null,
    move_pct_at_exit: trade.movePctAtExit ?? null,
    corridor_width_pct: trade.corridorWidthPct ?? null,
    sl_distance_pct: trade.slDistancePct ?? null,
    tp_distance_pct: trade.tpDistancePct ?? null,
    stop_moved: trade.stopMoved ? 1 : 0,
    open_delay_sec: trade.openDelaySec ?? null,
    entry_order_id: trade.entryOrderId ?? null,
    signal_snapshot: trade.signalSnapshot ? JSON.stringify(trade.signalSnapshot) : null,
    exit_path_oracle: trade.exitPathOracle ? JSON.stringify(trade.exitPathOracle) : null,
    trade_json: JSON.stringify(full),
    config_version_id: trade.configVersionId ?? null,
    snapshot_id: trade.snapshotId ?? null,
    opened_at: openedAt,
    closed_at: closedAt,
    decided_at: trade.decidedAt ?? null,
  };
}

function rowToTrade(row) {
  if (!row) return null;
  let trade;
  try {
    trade = JSON.parse(row.trade_json);
  } catch {
    trade = {};
  }
  return {
    ...trade,
    id: row.id,
    symbol: row.symbol,
    signalKind: row.signal_kind,
    side: row.side ?? trade.side,
    pnl: row.pnl,
    pnlPct: row.pnl_pct ?? trade.pnlPct,
    exitReason: row.exit_reason ?? trade.exitReason,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openedAtIso: row.opened_at ? formatIsoUtcPlus3(row.opened_at) : null,
    closedAtIso: row.closed_at ? formatIsoUtcPlus3(row.closed_at) : null,
    snapshotId: row.snapshot_id ?? trade.snapshotId ?? null,
  };
}

const UPSERT_SQL = `
INSERT INTO closed_trades (
  id, bot_type, backtest_run_id, symbol, signal_kind, side,
  entry_price, initial_entry_price, exit_price, quantity, margin, leverage,
  add_count, pnl, pnl_pct, exit_reason, exit_method,
  peak_move_pct, trough_move_pct, move_pct_at_exit,
  corridor_width_pct, sl_distance_pct, tp_distance_pct, stop_moved,
  open_delay_sec, entry_order_id, signal_snapshot, exit_path_oracle,
  trade_json, config_version_id, snapshot_id,
  opened_at, closed_at, decided_at
) VALUES (
  @id, @bot_type, @backtest_run_id, @symbol, @signal_kind, @side,
  @entry_price, @initial_entry_price, @exit_price, @quantity, @margin, @leverage,
  @add_count, @pnl, @pnl_pct, @exit_reason, @exit_method,
  @peak_move_pct, @trough_move_pct, @move_pct_at_exit,
  @corridor_width_pct, @sl_distance_pct, @tp_distance_pct, @stop_moved,
  @open_delay_sec, @entry_order_id, @signal_snapshot, @exit_path_oracle,
  @trade_json, @config_version_id, @snapshot_id,
  @opened_at, @closed_at, @decided_at
)
ON CONFLICT(id) DO UPDATE SET
  bot_type = excluded.bot_type,
  backtest_run_id = excluded.backtest_run_id,
  symbol = excluded.symbol,
  signal_kind = excluded.signal_kind,
  side = excluded.side,
  entry_price = excluded.entry_price,
  initial_entry_price = excluded.initial_entry_price,
  exit_price = excluded.exit_price,
  quantity = excluded.quantity,
  margin = excluded.margin,
  leverage = excluded.leverage,
  add_count = excluded.add_count,
  pnl = excluded.pnl,
  pnl_pct = excluded.pnl_pct,
  exit_reason = excluded.exit_reason,
  exit_method = excluded.exit_method,
  peak_move_pct = excluded.peak_move_pct,
  trough_move_pct = excluded.trough_move_pct,
  move_pct_at_exit = excluded.move_pct_at_exit,
  corridor_width_pct = excluded.corridor_width_pct,
  sl_distance_pct = excluded.sl_distance_pct,
  tp_distance_pct = excluded.tp_distance_pct,
  stop_moved = excluded.stop_moved,
  open_delay_sec = excluded.open_delay_sec,
  entry_order_id = excluded.entry_order_id,
  signal_snapshot = excluded.signal_snapshot,
  exit_path_oracle = excluded.exit_path_oracle,
  trade_json = excluded.trade_json,
  config_version_id = excluded.config_version_id,
  snapshot_id = excluded.snapshot_id,
  opened_at = excluded.opened_at,
  closed_at = excluded.closed_at,
  decided_at = excluded.decided_at
`;

function upsertClosedTrade(db, botType, trade, backtestRunId = null) {
  const row = tradeToRow(botType, trade, backtestRunId);
  db.prepare(UPSERT_SQL).run(row);
  return rowToTrade(db.prepare("SELECT * FROM closed_trades WHERE id = ?").get(row.id));
}

function listClosedTrades(db, {
  botType,
  fromMs = null,
  limit = null,
  signalKinds = null,
  order = "DESC",
} = {}) {
  const clauses = ["bot_type = @botType"];
  const params = { botType };
  if (fromMs != null) {
    clauses.push("closed_at >= @fromMs");
    params.fromMs = fromMs;
  }
  if (signalKinds?.length) {
    clauses.push(
      `signal_kind IN (${signalKinds.map((_, i) => `@sk${i}`).join(", ")})`
    );
    signalKinds.forEach((k, i) => {
      params[`sk${i}`] = k;
    });
  }
  let sql = `SELECT * FROM closed_trades WHERE ${clauses.join(" AND ")}
    ORDER BY closed_at ${order === "ASC" ? "ASC" : "DESC"}`;
  if (limit != null) {
    sql += " LIMIT @limit";
    params.limit = limit;
  }
  return db.prepare(sql).all(params).map(rowToTrade);
}

function deleteTradesByIds(db, ids = []) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM closed_trades WHERE id IN (${placeholders})`).run(...ids);
}

function clearBotTrades(db, botType) {
  db.prepare("DELETE FROM closed_trades WHERE bot_type = ?").run(botType);
}

function isArchivableTrade(trade) {
  if (!trade || typeof trade !== "object") return false;
  const kind = String(trade.signalKind || "").trim();
  if (!BOT_SIGNAL_KINDS.has(kind)) return false;
  const symbol = String(trade.symbol || "").trim();
  if (!symbol) return false;
  const openedAt = Number(trade.openedAt);
  const closedAt = Number(trade.closedAt);
  if (!Number.isFinite(openedAt) || !Number.isFinite(closedAt) || closedAt <= 0) {
    return false;
  }
  return true;
}

module.exports = {
  BOT_SIGNAL_KINDS,
  tradeToRow,
  rowToTrade,
  upsertClosedTrade,
  listClosedTrades,
  deleteTradesByIds,
  clearBotTrades,
  isArchivableTrade,
};
