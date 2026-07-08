function notifyModelSaved({ modelName, scope, filePath, backend = "logistic", model = null }) {
  try {
    const { getDb, repos } = require("./index");
    const metrics =
      model?.bull?.metrics ??
      model?.bear?.metrics ??
      model?.metrics ??
      null;
    const trainedAt = model?.trainedAt ? Date.parse(model.trainedAt) : null;
    repos.meta.registerAiModel(getDb(), {
      modelName,
      scope,
      backend: model?.backend ?? backend,
      filePath,
      metrics,
      trainedAt: Number.isFinite(trainedAt) ? trainedAt : null,
    });
  } catch (e) {
    console.error(`ai model registry (${modelName}/${scope}): ${e.message}`);
  }
}

function notifyTradeSnapshotSaved({ id, tradeId, botType, filePath, bytes }) {
  try {
    const { getDb, repos } = require("./index");
    repos.meta.registerTradeSnapshot(getDb(), {
      id,
      tradeId,
      botType,
      filePath,
      bytes,
      createdAt: Date.now(),
    });
  } catch (e) {
    console.error(`trade snapshot registry (${id}): ${e.message}`);
  }
}

module.exports = { notifyModelSaved, notifyTradeSnapshotSaved };
