function stableConfigJson(config) {
  return JSON.stringify(config ?? {});
}

function resolveGitCommit() {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA;
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    const { execSync } = require("child_process");
    return execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function saveConfigVersion(db, botType, config, gitCommit = null) {
  const info = db
    .prepare(
      `INSERT INTO config_versions(bot_type, config_json, git_commit, created_at)
       VALUES(?, ?, ?, ?)`
    )
    .run(botType, stableConfigJson(config), gitCommit, Date.now());
  return Number(info.lastInsertRowid);
}

function getLatestConfigVersion(db, botType) {
  return db
    .prepare(
      `SELECT id, config_json, git_commit, created_at
       FROM config_versions
       WHERE bot_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`
    )
    .get(botType);
}

function ensureConfigVersion(db, botType, config, gitCommit = null) {
  const json = stableConfigJson(config);
  const latest = getLatestConfigVersion(db, botType);
  if (latest && latest.config_json === json) {
    return latest.id;
  }
  return saveConfigVersion(db, botType, config, gitCommit);
}

function listConfigVersions(db, botType, { limit = 50 } = {}) {
  return db
    .prepare(
      `SELECT id, bot_type, config_json, git_commit, created_at
       FROM config_versions
       WHERE bot_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(botType, limit)
    .map((row) => {
      let config;
      try {
        config = JSON.parse(row.config_json);
      } catch {
        config = {};
      }
      return {
        id: row.id,
        botType: row.bot_type,
        config,
        gitCommit: row.git_commit ?? null,
        createdAt: row.created_at,
      };
    });
}

module.exports = {
  stableConfigJson,
  resolveGitCommit,
  saveConfigVersion,
  getLatestConfigVersion,
  ensureConfigVersion,
  listConfigVersions,
};
