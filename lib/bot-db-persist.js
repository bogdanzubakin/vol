const BOT_TYPE_PAPER = "paper";
const BOT_TYPE_LIVE = "live";

function dbApi() {
  return require("./db");
}

function loadBotState(botType, fallbackFactory) {
  try {
    const { getDb, repos } = dbApi();
    const loaded = repos.botState.loadBotRuntime(getDb(), botType);
    if (loaded) return loaded;
  } catch (e) {
    console.error(`loadBotState(${botType}) failed: ${e.message}`);
  }
  return fallbackFactory();
}

function persistBotState(botType, state, options = {}) {
  try {
    const { getDb, repos } = dbApi();
    repos.botState.saveBotRuntime(getDb(), botType, state, options);
  } catch (e) {
    console.error(`persistBotState(${botType}) failed: ${e.message}`);
  }
}

function appendBotEvent(botType, level, symbol, detail, tradeId = null) {
  try {
    const { getDb, repos } = dbApi();
    repos.botState.appendBotEvent(getDb(), botType, {
      level,
      symbol,
      detail,
      tradeId,
      at: Date.now(),
    });
  } catch (e) {
    console.error(`appendBotEvent(${botType}) failed: ${e.message}`);
  }
}

function persistClosedTrade(botType, trade) {
  try {
    const { getDb, repos } = dbApi();
    repos.botState.insertClosedTrade(getDb(), botType, trade);
  } catch (e) {
    console.error(`persistClosedTrade(${botType}) failed: ${e.message}`);
  }
}

function clearBotHistory(botType) {
  try {
    const { getDb, repos } = dbApi();
    repos.botState.clearBotHistory(getDb(), botType);
  } catch (e) {
    console.error(`clearBotHistory(${botType}) failed: ${e.message}`);
  }
}

module.exports = {
  BOT_TYPE_PAPER,
  BOT_TYPE_LIVE,
  loadBotState,
  persistBotState,
  appendBotEvent,
  persistClosedTrade,
  clearBotHistory,
};
