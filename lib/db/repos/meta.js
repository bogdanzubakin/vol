function registerAiModel(db, {
  modelName,
  scope,
  backend = null,
  filePath,
  metrics = null,
  trainedAt = null,
}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO ai_models(model_name, scope, backend, file_path, metrics_json, trained_at, saved_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model_name, scope) DO UPDATE SET
       backend = excluded.backend,
       file_path = excluded.file_path,
       metrics_json = excluded.metrics_json,
       trained_at = excluded.trained_at,
       saved_at = excluded.saved_at`
  ).run(
    modelName,
    scope,
    backend,
    filePath,
    metrics ? JSON.stringify(metrics) : null,
    trainedAt,
    now
  );
}

function listAiModels(db) {
  return db.prepare("SELECT * FROM ai_models ORDER BY saved_at DESC").all();
}

function registerTradeSnapshot(db, {
  id,
  tradeId = null,
  botType = null,
  filePath,
  bytes = null,
  createdAt = Date.now(),
}) {
  db.prepare(
    `INSERT INTO trade_snapshots(id, trade_id, bot_type, file_path, bytes, created_at)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       trade_id = excluded.trade_id,
       bot_type = excluded.bot_type,
       file_path = excluded.file_path,
       bytes = excluded.bytes,
       created_at = excluded.created_at`
  ).run(id, tradeId, botType, filePath, bytes, createdAt);
}

module.exports = {
  registerAiModel,
  listAiModels,
  registerTradeSnapshot,
};
