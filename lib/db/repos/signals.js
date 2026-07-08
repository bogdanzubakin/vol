function recordSignalHit(db, { symbol, signalKind, signalStatus = "active", at = Date.now(), metrics = null }) {
  db.prepare(
    `INSERT INTO signal_hits(symbol, signal_kind, signal_status, at, metrics_json)
     VALUES(?, ?, ?, ?, ?)`
  ).run(
    symbol,
    signalKind,
    signalStatus,
    at,
    metrics ? JSON.stringify(metrics) : null
  );
}

function pruneSignalHits(db, olderThanMs) {
  db.prepare("DELETE FROM signal_hits WHERE at < ?").run(olderThanMs);
}

function listRecentSignalHits(db, { limit = 500, fromMs = null } = {}) {
  let sql = "SELECT * FROM signal_hits";
  const params = {};
  if (fromMs != null) {
    sql += " WHERE at >= @fromMs";
    params.fromMs = fromMs;
  }
  sql += " ORDER BY at DESC LIMIT @limit";
  params.limit = limit;
  return db.prepare(sql).all(params);
}

module.exports = {
  recordSignalHit,
  pruneSignalHits,
  listRecentSignalHits,
};
