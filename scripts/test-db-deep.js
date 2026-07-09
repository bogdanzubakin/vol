#!/usr/bin/env node
/**
 * Deep integration tests for SQLite persistence, live-bot-history, and live-bot forget logic.
 * Usage: node scripts/test-db-deep.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const failures = [];
const passes = [];

function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.error(`  FAIL: ${msg}`);
    return false;
  }
  passes.push(msg);
  console.log(`  ok: ${msg}`);
  return true;
}

function resetRuntime(dataDir) {
  process.env.DATA_DIR = dataDir;
  const libDir = path.join(ROOT, "lib");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(libDir)) {
      delete require.cache[key];
    }
  }
  try {
    const { closeDb } = require(path.join(ROOT, "lib/db/connection"));
    closeDb();
  } catch {
    /* ignore */
  }
}

function makeTrade(id, overrides = {}) {
  const now = Date.now();
  return {
    id,
    symbol: "BTCUSDT",
    signalKind: "sfp",
    side: "LONG",
    entryPrice: 100,
    initialEntryPrice: 100,
    exitPrice: 101,
    quantity: 0.01,
    margin: 50,
    leverage: 2,
    addCount: 0,
    pnl: 0.5,
    pnlPct: 1,
    exitReason: "take_profit",
    openedAt: now - 60_000,
    closedAt: now,
    ...overrides,
  };
}

function makeOpenPos(id, overrides = {}) {
  const now = Date.now();
  return {
    id,
    symbol: "ETHUSDT",
    signalKind: "pullback",
    side: "LONG",
    entryPrice: 3000,
    initialEntryPrice: 3000,
    quantity: 0.1,
    botQuantity: 0.1,
    margin: 50,
    leverage: 2,
    stopLoss: 2900,
    takeProfit: 3100,
    lastPrice: 3000,
    openedAt: now,
    addCount: 0,
    ...overrides,
  };
}

async function testSchemaAndMigration(tmpDir) {
  console.log("\n== schema & migration ==");
  resetRuntime(tmpDir);
  const { migrate, getDb } = require(path.join(ROOT, "lib/db"));
  const { importResult } = migrate();
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert(tables.includes("closed_trades"), "closed_trades table exists");
  assert(tables.includes("open_positions"), "open_positions table exists");
  assert(tables.includes("bot_state"), "bot_state table exists");
  assert(importResult != null, "json import result returned");
  const cols = db
    .prepare("PRAGMA table_info(bot_state)")
    .all()
    .map((c) => c.name);
  assert(cols.includes("current_config_version_id"), "bot_state has current_config_version_id");
}

async function testConfigVersions(tmpDir) {
  console.log("\n== config_versions ==");
  resetRuntime(tmpDir);
  const { migrate, getDb, repos } = require(path.join(ROOT, "lib/db"));
  migrate();
  const db = getDb();

  const cfg1 = {
    armed: false,
    leverage: 2,
    blockedSymbols: [],
    maxOpenPositions: 4,
    positionSizeUsdt: 50,
  };
  const cfg2 = { ...cfg1, leverage: 3 };
  const pos = makeOpenPos("cv-1", { symbol: "BTCUSDT" });

  const v1 = repos.botState.saveBotRuntime(
    db,
    "live",
    {
      config: cfg1,
      openPositions: [pos],
      symbolSlStreak: {},
      drawdownBaseline: null,
      drawdownTriggeredAt: null,
      historyDayKey: "2026-07-08",
    },
    { gitCommit: "abc123" }
  );
  assert(v1 != null, "saveBotRuntime returns config version id");

  const versions = repos.config.listConfigVersions(db, "live");
  assert(versions.length === 1, "first config creates one version");
  assert(versions[0].gitCommit === "abc123", "git commit stored");
  assert(versions[0].config.leverage === 2, "config snapshot stored");

  const v1again = repos.botState.saveBotRuntime(db, "live", {
    config: cfg1,
    openPositions: [pos],
    symbolSlStreak: {},
    drawdownBaseline: null,
    drawdownTriggeredAt: null,
    historyDayKey: "2026-07-08",
  });
  assert(v1again === v1, "unchanged config reuses version id");
  assert(repos.config.listConfigVersions(db, "live").length === 1, "no duplicate version for same config");

  const loaded1 = repos.botState.loadBotRuntime(db, "live");
  assert(loaded1.configVersionId === v1, "load returns current config version id");
  assert(loaded1.openPositions[0].configVersionId === v1, "open position stamped with config version");

  const v2 = repos.botState.saveBotRuntime(db, "live", {
    config: cfg2,
    openPositions: loaded1.openPositions,
    symbolSlStreak: {},
    drawdownBaseline: null,
    drawdownTriggeredAt: null,
    historyDayKey: "2026-07-08",
  });
  assert(v2 !== v1, "config change creates new version");
  assert(repos.config.listConfigVersions(db, "live").length === 2, "two versions after config change");

  const loaded2 = repos.botState.loadBotRuntime(db, "live");
  assert(loaded2.configVersionId === v2, "current version id updated after config change");
  assert(loaded2.openPositions[0].configVersionId === v1, "open position keeps version from entry");

  const { persistClosedTrade, BOT_TYPE_LIVE } = require(path.join(ROOT, "lib/bot-db-persist"));
  const trade = makeTrade("cv-trade", { configVersionId: v1 });
  persistClosedTrade(BOT_TYPE_LIVE, trade);
  const stored = repos.trades.listClosedTrades(db, { botType: "live" })[0];
  assert(stored.configVersionId === v1, "closed trade stores configVersionId column");
}

async function testBotStateRoundtrip(tmpDir) {
  console.log("\n== bot state roundtrip ==");
  resetRuntime(tmpDir);
  const { getDb, repos, migrate } = require(path.join(ROOT, "lib/db"));
  migrate();
  const db = getDb();
  const pos = makeOpenPos("eth-1", { botQuantity: 0.1, quantity: 0.1 });
  const state = {
    config: { armed: false, leverage: 2, blockedSymbols: ["XRPUSDT"] },
    openPositions: [pos],
    symbolSlStreak: { ETHUSDT: 2 },
    drawdownBaseline: 200,
    drawdownTriggeredAt: null,
    historyDayKey: "2026-07-08",
  };
  repos.botState.saveBotRuntime(db, "live", state);
  repos.botState.appendBotEvent(db, "live", {
    level: "OPEN",
    symbol: "ETHUSDT",
    detail: "test open",
  });

  const loaded = repos.botState.loadBotRuntime(db, "live");
  assert(loaded != null, "loadBotRuntime returns state");
  assert(loaded.openPositions.length === 1, "open position count");
  assert(loaded.openPositions[0].botQuantity === 0.1, "botQuantity persisted");
  assert(loaded.config.blockedSymbols.includes("XRPUSDT"), "blocked symbols persisted");
  assert(loaded.symbolSlStreak.ETHUSDT === 2, "sl streak persisted");
  assert(loaded.log.length >= 1, "bot events loaded as log");
}

async function testSaveBotRuntimeTransaction(tmpDir) {
  console.log("\n== saveBotRuntime transaction rollback ==");
  resetRuntime(tmpDir);
  const { getDb, repos, migrate } = require(path.join(ROOT, "lib/db"));
  migrate();
  const db = getDb();
  const pos1 = makeOpenPos("pos-1", { symbol: "BTCUSDT" });
  repos.botState.saveBotRuntime(db, "live", {
    config: { armed: false, leverage: 2, blockedSymbols: [] },
    openPositions: [pos1],
    symbolSlStreak: { BTCUSDT: 2 },
    drawdownBaseline: 100,
    drawdownTriggeredAt: null,
    historyDayKey: "2026-07-08",
  });

  const pos2 = makeOpenPos("pos-2", { symbol: "ETHUSDT" });
  let threw = false;
  try {
    repos.botState.saveBotRuntime(db, "live", {
      config: { armed: true, leverage: 5, blockedSymbols: ["ETHUSDT"] },
      openPositions: [pos2, { ...pos2 }],
      symbolSlStreak: { ETHUSDT: 9 },
      drawdownBaseline: 999,
      drawdownTriggeredAt: Date.now(),
      historyDayKey: "2026-07-09",
    });
  } catch {
    threw = true;
  }
  assert(threw, "duplicate open position id aborts save");

  const loaded = repos.botState.loadBotRuntime(db, "live");
  assert(loaded.openPositions.length === 1, "rollback keeps prior open position count");
  assert(loaded.openPositions[0].id === "pos-1", "rollback keeps prior open position");
  assert(loaded.config.armed === false, "rollback keeps prior config");
  assert(loaded.symbolSlStreak.BTCUSDT === 2, "rollback keeps prior sl streak");
  assert(loaded.symbolSlStreak.ETHUSDT == null, "rollback drops partial sl streak writes");
  assert(loaded.drawdownBaseline === 100, "rollback keeps prior drawdown baseline");
  assert(loaded.historyDayKey === "2026-07-08", "rollback keeps prior history day key");
}

async function testClosedTrades(tmpDir) {
  console.log("\n== closed trades CRUD ==");
  resetRuntime(tmpDir);
  const { getDb, repos, migrate } = require(path.join(ROOT, "lib/db"));
  migrate();
  const db = getDb();
  const { upsertClosedTrade, listClosedTrades, deleteTradesByIds, isArchivableTrade } =
    repos.trades;

  const t1 = makeTrade("t1", { pnl: 1.2, grossPnl: 1.5, commission: -0.2, fundingFee: -0.1, netPnl: 1.2 });
  const t2 = makeTrade("t2", { symbol: "ETHUSDT", signalKind: "pullback", pnl: -0.3 });
  assert(isArchivableTrade(t1), "archivable trade");
  assert(!isArchivableTrade({ signalKind: "unknown", symbol: "X", openedAt: 1, closedAt: 2 }), "non-archivable rejected");

  upsertClosedTrade(db, "live", t1);
  upsertClosedTrade(db, "live", t2);

  const all = listClosedTrades(db, { botType: "live" });
  assert(all.length === 2, "two live trades listed");
  const round = all.find((t) => t.id === "t1");
  assert(round?.grossPnl === 1.5, "trade_json grossPnl roundtrip");
  assert(round?.netPnl === 1.2, "trade_json netPnl roundtrip");

  deleteTradesByIds(db, ["t1"]);
  const after = listClosedTrades(db, { botType: "live" });
  assert(after.length === 1 && after[0].id === "t2", "deleteTradesByIds works");
}

async function testLiveHistoryStore(tmpDir) {
  console.log("\n== live-bot-history store ==");
  resetRuntime(tmpDir);
  const { migrate } = require(path.join(ROOT, "lib/db"));
  migrate();
  const { persistClosedTrade, BOT_TYPE_LIVE } = require(path.join(ROOT, "lib/bot-db-persist"));
  const { createLiveBotHistoryStore } = require(path.join(ROOT, "lib/live-bot-history"));
  const store = createLiveBotHistoryStore({ kv: new Map() });

  const trade = makeTrade("hist-1", { pnl: 2.5 });
  persistClosedTrade(BOT_TYPE_LIVE, trade);
  persistClosedTrade(BOT_TYPE_LIVE, { ...trade, id: "hist-bad", signalKind: "nope", openedAt: 1, closedAt: 2 });

  const listed = await store.list(new URLSearchParams(), []);
  assert(listed.trades.length === 1, "history lists only archivable trades");
  assert(listed.summary.realizedPnl === 2.5, "summary realized PnL");

  store.removeTradeIds(["hist-1"]);
  const afterRemove = await store.list(new URLSearchParams(), []);
  assert(afterRemove.trades.length === 0, "removeTradeIds clears history");

  persistClosedTrade(BOT_TYPE_LIVE, trade);
  store.clear();
  const afterClear = await store.list(new URLSearchParams(), []);
  assert(afterClear.trades.length === 0, "clear() empties live history");
}

async function testJsonImportIdempotent(tmpDir) {
  console.log("\n== json import idempotency ==");
  resetRuntime(tmpDir);
  fs.mkdirSync(tmpDir, { recursive: true });
  const legacy = {
    config: { armed: true, leverage: 3 },
    openPositions: [makeOpenPos("legacy-1")],
    closedTrades: [makeTrade("legacy-t1")],
    log: [{ level: "INFO", symbol: "BTCUSDT", detail: "legacy", at: Date.now() }],
    symbolSlStreak: { BTCUSDT: 1 },
    historyDayKey: "2026-07-01",
  };
  fs.writeFileSync(
    path.join(tmpDir, "paper-bot-state.json"),
    JSON.stringify(legacy)
  );
  fs.writeFileSync(
    path.join(tmpDir, "live-bot-history.json"),
    JSON.stringify({ trades: [makeTrade("hist-json-1")] })
  );

  const { migrate, getDb } = require(path.join(ROOT, "lib/db"));
  const r1 = migrate();
  assert(r1.importResult.imported.paper === true, "paper bot imported from JSON");
  assert(r1.importResult.imported.liveHistory === true, "live history imported");

  const db = getDb();
  const paper = db.prepare("SELECT bot_type FROM bot_state WHERE bot_type='paper'").get();
  assert(paper != null, "paper bot_state row exists");
  const liveHist = db
    .prepare("SELECT COUNT(*) n FROM closed_trades WHERE bot_type='live'")
    .get().n;
  assert(liveHist >= 1, "live trades from history json");

  const r2 = migrate();
  assert(r2.importResult.skipped === true, "second migrate skips import");
}

async function testExternalForgetSync(tmpDir) {
  console.log("\n== live bot auto-forget external increase ==");
  resetRuntime(tmpDir);
  const { migrate, getDb, repos } = require(path.join(ROOT, "lib/db"));
  migrate();
  const db = getDb();

  const pos = makeOpenPos("ext-1", { symbol: "SOLUSDT", botQuantity: 10, quantity: 10 });
  repos.botState.saveBotRuntime(db, "live", {
    config: { armed: false, leverage: 2, blockedSymbols: [], maxOpenPositions: 4, positionSizeUsdt: 50 },
    openPositions: [pos],
    symbolSlStreak: {},
    drawdownBaseline: null,
    drawdownTriggeredAt: null,
    historyDayKey: "2026-07-08",
  });

  repos.botState.insertClosedTrade(db, "live", makeTrade("ext-1"));

  const exPos = {
    positionAmt: 15,
    entryPrice: 100,
    unrealizedProfit: 1,
    leverage: 2,
    markPrice: 101,
  };

  const mockTrader = {
    enabled: true,
    invalidateRestCache: () => {},
    getPositionMap: async () => new Map([["SOLUSDT", exPos]]),
    getPosition: async () => exPos,
  };

  const { createLiveBot } = require(path.join(ROOT, "lib/live-bot"));
  const bot = createLiveBot({ trader: mockTrader });
  const before = (await bot.getPublicState()).openPositions.length;
  assert(before === 1, "one open position before sync");

  await bot.syncFromExchange();
  const after = await bot.getPublicState();
  assert(after.openPositions.length === 0, "position removed after external increase");
  assert(after.config.blockedSymbols.includes("SOLUSDT"), "symbol auto-blocked");
  const staleTrade = repos.trades.listClosedTrades(getDb(), { botType: "live" });
  assert(!staleTrade.some((t) => t.id === "ext-1"), "forget removes stale closed trade from DB");

  bot.flush();
  const reloaded = repos.botState.loadBotRuntime(getDb(), "live");
  assert(reloaded.openPositions.length === 0, "DB has no open positions after forget");
  assert(reloaded.config.blockedSymbols.includes("SOLUSDT"), "blocked symbol persisted in DB");
}

async function testManualForget(tmpDir) {
  console.log("\n== live bot manual forget ==");
  resetRuntime(tmpDir);
  const { migrate, getDb, repos } = require(path.join(ROOT, "lib/db"));
  migrate();

  const pos = makeOpenPos("man-1", { symbol: "ADAUSDT" });
  repos.botState.saveBotRuntime(getDb(), "live", {
    config: { armed: false, leverage: 2, blockedSymbols: [], maxOpenPositions: 4, positionSizeUsdt: 50 },
    openPositions: [pos],
    symbolSlStreak: {},
    drawdownBaseline: null,
    drawdownTriggeredAt: null,
    historyDayKey: "2026-07-08",
  });

  const mockTrader = { enabled: true };
  const { createLiveBot } = require(path.join(ROOT, "lib/live-bot"));
  const bot = createLiveBot({ trader: mockTrader });
  await bot.forgetOpenPositions("ADAUSDT");
  bot.flush();

  const loaded = repos.botState.loadBotRuntime(getDb(), "live");
  assert(loaded.openPositions.length === 0, "manual forget clears open positions in DB");
  assert(loaded.config.blockedSymbols.includes("ADAUSDT"), "manual forget blocks symbol");
}

async function testBotAddDoesNotForget(tmpDir) {
  console.log("\n== bot add-on does not trigger forget ==");
  resetRuntime(tmpDir);
  const { migrate } = require(path.join(ROOT, "lib/db"));
  migrate();
  const { normalizeOpenPosition } = require(path.join(ROOT, "lib/paper-bot"));

  function normalizeLiveOpenPosition(pos) {
    normalizeOpenPosition(pos);
    if (pos.botQuantity == null) pos.botQuantity = pos.quantity;
    return pos;
  }

  const EXTERNAL_QTY_TOLERANCE_RATIO = 0.002;
  function qtyIncreaseTolerance(botQty) {
    const b = Number(botQty);
    if (!Number.isFinite(b) || b <= 0) return 0;
    return Math.max(b * EXTERNAL_QTY_TOLERANCE_RATIO, 1e-8);
  }
  function isExternalQuantityIncrease(pos, exchangeQty) {
    normalizeLiveOpenPosition(pos);
    const botQty = Number(pos.botQuantity ?? pos.quantity);
    const exQty = Math.abs(Number(exchangeQty));
    if (!Number.isFinite(botQty) || !Number.isFinite(exQty) || exQty <= 0) return false;
    return exQty > botQty + qtyIncreaseTolerance(botQty);
  }

  const pos = { quantity: 10, botQuantity: 10, entryPrice: 1, signalKind: "sfp" };
  pos.botQuantity = 12;
  pos.quantity = 12;
  assert(!isExternalQuantityIncrease(pos, 12), "after bot add qty matches exchange");
  assert(!isExternalQuantityIncrease(pos, 12.01), "tiny rounding after add ok");
}

async function testAuditHelpers(tmpDir) {
  console.log("\n== exchange audit math ==");
  resetRuntime(tmpDir);
  const { migrate } = require(path.join(ROOT, "lib/db"));
  migrate();

  const incomes = [
    { time: 1000, incomeType: "REALIZED_PNL", income: 10, symbol: "BTCUSDT" },
    { time: 1001, incomeType: "COMMISSION", income: -1.1, symbol: "BTCUSDT" },
    { time: 1002, incomeType: "FUNDING_FEE", income: -0.25, symbol: "BTCUSDT" },
  ];
  const gross = incomes.filter((r) => r.incomeType === "REALIZED_PNL").reduce((s, r) => s + r.income, 0);
  const comm = incomes.filter((r) => r.incomeType === "COMMISSION").reduce((s, r) => s + r.income, 0);
  const fund = incomes.filter((r) => r.incomeType === "FUNDING_FEE").reduce((s, r) => s + r.income, 0);
  const net = gross + comm + fund;
  assert(gross === 10, "gross PnL");
  assert(Math.abs(comm + 1.1) < 1e-9, "commission");
  assert(Math.abs(fund + 0.25) < 1e-9, "funding");
  assert(Math.abs(net - 8.65) < 1e-9, "net PnL = 8.65 example");
}

async function testPersistClosedOnClose(tmpDir) {
  console.log("\n== unified live closed trade write path ==");
  resetRuntime(tmpDir);
  const { migrate, getDb, repos } = require(path.join(ROOT, "lib/db"));
  migrate();
  const db = getDb();
  const { persistClosedTrade, BOT_TYPE_LIVE } = require(path.join(ROOT, "lib/bot-db-persist"));

  const trade = makeTrade("close-1", {
    exitOrderId: 999,
    slOrderId: 111,
    tpOrderId: 222,
    exchangeMatchedEpisodeId: "ep-1",
    exchangeTradeFills: [{ orderId: 999, price: 101, qty: 0.01 }],
  });
  persistClosedTrade(BOT_TYPE_LIVE, trade);
  persistClosedTrade(BOT_TYPE_LIVE, { ...trade, snapshotId: "snap-1" });

  const rows = repos.trades.listClosedTrades(db, { botType: "live" });
  assert(rows.length === 1, "single persist path upserts one live trade row");
  const stored = rows[0];
  assert(stored.id === "close-1", "trade id preserved");
  assert(stored.snapshotId === "snap-1", "snapshot patch upserts same row");
  assert(stored.exitOrderId === 999, "exitOrderId preserved via normalize");
  assert(stored.exchangeMatchedEpisodeId === "ep-1", "exchangeMatchedEpisodeId preserved");
}

async function testUiSettings(tmpDir) {
  console.log("\n== ui settings & scanner config ==");
  resetRuntime(tmpDir);
  const { migrate, getDb, repos } = require(path.join(ROOT, "lib/db"));
  migrate();
  const db = getDb();
  repos.settings.patchUiSettings(db, { theme: "dark", tab: "history" });
  const all = repos.settings.getAllUiSettings(db);
  assert(all.theme === "dark", "ui settings patch");
  repos.settings.saveScannerConfig(db, { lookbackBars: 120 });
  assert(repos.settings.getScannerConfig(db).lookbackBars === 120, "scanner config save/load");
}

async function testRealCacheDb() {
  const cacheDir = path.join(ROOT, ".cache");
  const dbFile = path.join(cacheDir, "vol.db");
  if (!fs.existsSync(dbFile)) {
    console.log("\n== real .cache DB: skipped (no vol.db) ==");
    return;
  }
  console.log("\n== real .cache DB integrity ==");
  resetRuntime(cacheDir);
  try {
    const { getDb } = require(path.join(ROOT, "lib/db"));
    const { migrate } = require(path.join(ROOT, "lib/db"));
    migrate();
    const db = getDb();
    const counts = {};
    for (const table of [
      "bot_state",
      "open_positions",
      "closed_trades",
      "bot_events",
      "ui_settings",
      "scanner_config",
      "backtest_runs",
    ]) {
      counts[table] = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    }
    console.log("  counts:", counts);
    const liveOpen = db
      .prepare("SELECT position_json FROM open_positions WHERE bot_type='live'")
      .all();
    for (const row of liveOpen) {
      try {
        const p = JSON.parse(row.position_json);
        if (p.botQuantity == null && p.quantity != null) {
          console.log(`  note: live open ${p.symbol} missing botQuantity (legacy)`);
        }
      } catch (e) {
        failures.push(`corrupt position_json: ${e.message}`);
      }
    }
    const orphanEvents = db
      .prepare(
        `SELECT COUNT(*) n FROM bot_events WHERE bot_type NOT IN ('paper','live','scanner')`
      )
      .get().n;
    assert(orphanEvents === 0, "no invalid bot_type in bot_events");

    const { createLiveBotHistoryStore } = require(path.join(ROOT, "lib/live-bot-history"));
    const store = createLiveBotHistoryStore({ kv: new Map() });
    const hist = await store.list(new URLSearchParams(), []);
    assert(Array.isArray(hist.trades), "real DB history list works");
    console.log(`  live history trades: ${hist.trades.length}, pnl: ${hist.summary?.realizedPnl}`);
  } catch (e) {
    failures.push(`real DB check failed: ${e.message}`);
    console.error(`  FAIL: real DB — ${e.message}`);
  }
}

async function testExchangeCloseMatch(tmpDir) {
  console.log("\n== exchange close match (SL/TP inference) ==");
  resetRuntime(tmpDir);
  const { buildEpisodesFromTrades } = require(path.join(ROOT, "lib/live-bot-history"));
  const {
    pickMatchingEpisode,
    inferExitReasonFromPrices,
  } = require(path.join(ROOT, "lib/live-bot-exchange-close"));

  const symbol = "BTCUSDT";
  const openTime = Date.now() - 120_000;
  const closeTime = Date.now() - 30_000;
  const trades = [
    {
      symbol,
      side: "BUY",
      positionSide: "BOTH",
      qty: "0.01",
      price: "100",
      time: openTime,
      realizedPnl: "0",
      commission: "0.01",
      orderId: 111,
    },
    {
      symbol,
      side: "SELL",
      positionSide: "BOTH",
      qty: "0.01",
      price: "103",
      time: closeTime,
      realizedPnl: "0.03",
      commission: "0.01",
      orderId: 222,
    },
  ];
  const episodes = buildEpisodesFromTrades(symbol, trades);
  const pos = {
    symbol,
    side: "LONG",
    entryOrderId: 111,
    openedAt: openTime,
    exchangeOpenedAt: openTime,
    stopLoss: 97,
    takeProfit: 103,
    entryPrice: 100,
  };
  const ep = pickMatchingEpisode(episodes, pos, Date.now());
  assert(ep != null, "episode matched by entry order id");
  assert(inferExitReasonFromPrices(pos, 97) === "stop_loss", "infers stop_loss near SL");
  assert(inferExitReasonFromPrices(pos, 103) === "take_profit", "infers take_profit near TP");
  assert(ep.grossPnlFromFills === 0.03, "realized PnL from exchange fills");
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vol-db-test-"));
  console.log(`Temp root: ${tmpRoot}`);

  const tests = [
    ["schema", testSchemaAndMigration],
    ["config-versions", testConfigVersions],
    ["bot-state", testBotStateRoundtrip],
    ["bot-state-tx", testSaveBotRuntimeTransaction],
    ["trades", testClosedTrades],
    ["history", testLiveHistoryStore],
    ["import", testJsonImportIdempotent],
    ["external-forget", testExternalForgetSync],
    ["manual-forget", testManualForget],
    ["bot-add", testBotAddDoesNotForget],
    ["audit", testAuditHelpers],
    ["exchange-close", testExchangeCloseMatch],
    ["persist-close", testPersistClosedOnClose],
    ["settings", testUiSettings],
  ];

  try {
    for (const [name, fn] of tests) {
      const tmpDir = path.join(tmpRoot, name);
      fs.mkdirSync(tmpDir, { recursive: true });
      await fn(tmpDir);
    }
    await testRealCacheDb();
  } finally {
    try {
      resetRuntime(tmpRoot);
      const { closeDb } = require(path.join(ROOT, "lib/db/connection"));
      closeDb();
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Passed: ${passes.length}`);
  console.log(`Failed: ${failures.length}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nAll deep DB tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
