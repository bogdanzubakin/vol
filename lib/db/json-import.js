const fs = require("fs");
const { dataPath, readJsonFile } = require("../data-dir");
const { upsertClosedTrade, isArchivableTrade } = require("./repos/trades");

const META_KEY = "json_import_v1";

function metaGet(db, key) {
  const row = db.prepare("SELECT value FROM db_meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

function metaSet(db, key, value) {
  db.prepare(
    "INSERT INTO db_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

function importBotState(db, botType, fileName, { hasBalance = false } = {}) {
  const row = db.prepare("SELECT bot_type FROM bot_state WHERE bot_type = ?").get(botType);
  if (row) return false;

  const raw = readJsonFile(dataPath(fileName), null);
  if (!raw || typeof raw !== "object") return false;

  const now = Date.now();
  db.prepare(
    `INSERT INTO bot_state(bot_type, config_json, balance, history_day_key, updated_at)
     VALUES(?, ?, ?, ?, ?)`
  ).run(
    botType,
    JSON.stringify(raw.config ?? {}),
    hasBalance ? Number(raw.balance) || null : null,
    raw.historyDayKey ?? null,
    now
  );

  if (raw.drawdownBaseline != null || raw.drawdownTriggeredAt != null) {
    db.prepare(
      `INSERT INTO drawdown_state(bot_type, baseline_equity, triggered_at)
       VALUES(?, ?, ?)
       ON CONFLICT(bot_type) DO UPDATE SET
         baseline_equity = excluded.baseline_equity,
         triggered_at = excluded.triggered_at`
    ).run(botType, raw.drawdownBaseline ?? null, raw.drawdownTriggeredAt ?? null);
  }

  const streak = raw.symbolSlStreak ?? {};
  const insStreak = db.prepare(
    `INSERT INTO symbol_sl_streak(bot_type, symbol, streak) VALUES(?, ?, ?)
     ON CONFLICT(bot_type, symbol) DO UPDATE SET streak = excluded.streak`
  );
  for (const [symbol, count] of Object.entries(streak)) {
    const n = Number(count);
    if (!symbol || !Number.isFinite(n)) continue;
    insStreak.run(botType, symbol, n);
  }

  const insPos = db.prepare(
    `INSERT OR REPLACE INTO open_positions(id, bot_type, symbol, position_json, opened_at)
     VALUES(?, ?, ?, ?, ?)`
  );
  for (const pos of raw.openPositions ?? []) {
    if (!pos?.id) continue;
    insPos.run(
      String(pos.id),
      botType,
      String(pos.symbol || ""),
      JSON.stringify(pos),
      Number(pos.openedAt) || now
    );
  }

  for (const trade of raw.closedTrades ?? []) {
    if (!trade?.id) continue;
    upsertClosedTrade(db, botType, trade);
  }

  const insEvent = db.prepare(
    `INSERT INTO bot_events(bot_type, level, symbol, detail, at)
     VALUES(?, ?, ?, ?, ?)`
  );
  for (const ev of raw.log ?? []) {
    if (!ev) continue;
    insEvent.run(
      botType,
      String(ev.level || ev.type || "INFO"),
      ev.symbol ?? null,
      ev.detail ?? ev.message ?? null,
      Number(ev.at) || now
    );
  }

  return true;
}

function importLiveBotHistory(db) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM closed_trades WHERE bot_type = 'live'").get()
    ?.n;
  if (count > 0) return false;

  const raw = readJsonFile(dataPath("live-bot-history.json"), null);
  if (!raw?.trades?.length) return false;

  for (const trade of raw.trades) {
    if (!isArchivableTrade(trade)) continue;
    upsertClosedTrade(db, "live", trade);
  }
  return true;
}

function importUiSettings(db) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM ui_settings").get()?.n;
  if (count > 0) return false;
  const data = readJsonFile(dataPath("ui-settings.json"), {});
  if (!data || typeof data !== "object") return false;
  const ins = db.prepare(
    "INSERT INTO ui_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING"
  );
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    ins.run(key, String(value));
  }
  return true;
}

function importScannerConfig(db) {
  const row = db.prepare("SELECT id FROM scanner_config WHERE id = 1").get();
  if (row) return false;
  const data = readJsonFile(dataPath("scanner-config.json"), null);
  if (!data || typeof data !== "object") return false;
  db.prepare(
    "INSERT INTO scanner_config(id, config_json, updated_at) VALUES(1, ?, ?)"
  ).run(JSON.stringify(data), Date.now());
  return true;
}

function importBacktestLast(db) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM backtest_runs").get()?.n;
  if (count > 0) return false;
  const result = readJsonFile(dataPath("paper-bot-backtest-last.json"), null);
  if (!result?.summary) return false;

  const finishedAt = result.finishedAt ? Date.parse(result.finishedAt) : Date.now();
  const info = db
    .prepare(
      `INSERT INTO backtest_runs(
         started_at, finished_at, days, interval,
         bot_config_json, signal_config_json, summary_json, run_meta_json,
         result_json, is_last
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      finishedAt - (Number(result.elapsedSec) || 0) * 1000,
      finishedAt,
      result.days ?? null,
      result.interval ?? null,
      JSON.stringify(result.botConfig ?? null),
      JSON.stringify(result.signalConfig ?? null),
      JSON.stringify(result.summary ?? null),
      JSON.stringify(result.runMeta ?? null),
      JSON.stringify(result)
    );

  const runId = info.lastInsertRowid;
  for (const trade of result.closedTrades ?? []) {
    if (!trade?.id) continue;
    upsertClosedTrade(db, "backtest", { ...trade, backtestRunId: runId });
  }
  return true;
}

function importPositionsComments(db) {
  const data = readJsonFile(dataPath("positions-history-comments.json"), null);
  if (!data?.comments) return false;
  for (const [tradeId, text] of Object.entries(data.comments)) {
    if (!tradeId || !text) continue;
    const trade = db.prepare("SELECT trade_json FROM closed_trades WHERE id = ?").get(tradeId);
    if (!trade) continue;
    try {
      const parsed = JSON.parse(trade.trade_json);
      parsed.comment = text;
      db.prepare("UPDATE closed_trades SET trade_json = ? WHERE id = ?").run(
        JSON.stringify(parsed),
        tradeId
      );
    } catch {
      /* ignore */
    }
  }
  return true;
}

function registerExistingAiModels(db) {
  const dataDir = dataPath();
  let names;
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return false;
  }
  const ins = db.prepare(
    `INSERT INTO ai_models(model_name, scope, backend, file_path, saved_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(model_name, scope) DO NOTHING`
  );
  let added = false;
  const modelPatterns = [
    { re: /^(.+)-live\.json$/, scope: "live", backend: "logistic" },
    { re: /^(.+)\.json$/, scope: "paper", backend: "logistic" },
  ];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    if (name.includes("state") || name.includes("config") || name.includes("history")) continue;
    for (const pat of modelPatterns) {
      const m = name.match(pat.re);
      if (!m) continue;
      const modelName = m[1]
        .replace(/-live$/, "")
        .replace(/-paper$/, "");
      if (!modelName.includes("model") && !modelName.includes("exit") && !modelName.includes("regime")) {
        continue;
      }
      const full = dataPath(name);
      let mtime = Date.now();
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      ins.run(modelName, pat.scope, pat.backend, full, Math.floor(mtime));
      added = true;
      break;
    }
  }
  return added;
}

function importFromJsonFiles(db) {
  if (metaGet(db, META_KEY) === "1") return { skipped: true };

  const imported = {
    paper: importBotState(db, "paper", "paper-bot-state.json", { hasBalance: true }),
    live: importBotState(db, "live", "live-bot-state.json"),
    liveHistory: importLiveBotHistory(db),
    uiSettings: importUiSettings(db),
    scannerConfig: importScannerConfig(db),
    backtest: importBacktestLast(db),
    comments: importPositionsComments(db),
    aiModels: registerExistingAiModels(db),
  };

  metaSet(db, META_KEY, "1");
  return { skipped: false, imported };
}

module.exports = { importFromJsonFiles, META_KEY };
