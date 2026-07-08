function saveBacktestRun(db, result, { gitCommit = null } = {}) {
  db.prepare("UPDATE backtest_runs SET is_last = 0").run();

  const finishedAt = result.finishedAt ? Date.parse(result.finishedAt) : Date.now();
  const elapsedMs = (Number(result.elapsedSec) || 0) * 1000;
  const info = db
    .prepare(
      `INSERT INTO backtest_runs(
         started_at, finished_at, days, interval,
         bot_config_json, signal_config_json, summary_json, run_meta_json,
         result_json, git_commit, is_last
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      finishedAt - elapsedMs,
      finishedAt,
      result.days ?? null,
      result.interval ?? null,
      JSON.stringify(result.botConfig ?? null),
      JSON.stringify(result.signalConfig ?? null),
      JSON.stringify(result.summary ?? null),
      JSON.stringify(result.runMeta ?? null),
      JSON.stringify(result),
      gitCommit,
      1
    );

  return Number(info.lastInsertRowid);
}

function loadLastBacktestResult(db) {
  const row = db
    .prepare(
      "SELECT result_json FROM backtest_runs WHERE is_last = 1 ORDER BY finished_at DESC LIMIT 1"
    )
    .get();
  if (!row?.result_json) return null;
  try {
    return JSON.parse(row.result_json);
  } catch {
    return null;
  }
}

function clearBacktestRuns(db) {
  db.prepare("DELETE FROM backtest_runs").run();
  db.prepare("DELETE FROM closed_trades WHERE bot_type = 'backtest'").run();
}

module.exports = {
  saveBacktestRun,
  loadLastBacktestResult,
  clearBacktestRuns,
};
