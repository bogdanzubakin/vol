const { loadEnvFile } = require("./load-env");
const { formatDateTime } = require("./time-format");

const TELEGRAM_API = "https://api.telegram.org";

function maskChatId(chatId) {
  const s = String(chatId);
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}

/** Bot user id is the numeric part before ":" in the token. */
function botIdFromToken(token) {
  const part = String(token).split(":")[0];
  return /^\d+$/.test(part) ? part : null;
}

function isBotSelfChat(token, chatId) {
  const botId = botIdFromToken(token);
  return botId != null && String(chatId).trim() === botId;
}

const CHAT_ID_HELP =
  "TELEGRAM_CHAT_ID must be your user or group chat id, not the bot id. " +
  "Message the bot in Telegram, then run: npm run telegram:chats";

function clarifyTelegramError(err, token, chatId) {
  const msg = err?.message || String(err);
  if (
    isBotSelfChat(token, chatId) ||
    /can't send messages to the bot/i.test(msg)
  ) {
    return new Error(CHAT_ID_HELP);
  }
  if (/chat not found/i.test(msg)) {
    return new Error(`${msg}. ${CHAT_ID_HELP}`);
  }
  return err instanceof Error ? err : new Error(msg);
}

function resolveTelegramConfig(flags = new Set(), kv = new Map()) {
  loadEnvFile();

  if (flags.has("no-telegram")) {
    return { enabled: false };
  }

  const token = kv.get("telegram-token") || process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = kv.get("telegram-chat-id") || process.env.TELEGRAM_CHAT_ID || "";
  if (!token.trim() || !String(chatId).trim()) {
    return { enabled: false };
  }

  const paperBotReport =
    !flags.has("no-paper-bot-report") &&
    process.env.TELEGRAM_PAPER_BOT_REPORT === "1";
  const paperBotReportHour = Number(process.env.PAPER_BOT_REPORT_HOUR);
  const paperBotReportMinute = Number(process.env.PAPER_BOT_REPORT_MINUTE);

  const trimmedToken = token.trim();
  const trimmedChatId = String(chatId).trim();

  if (isBotSelfChat(trimmedToken, trimmedChatId)) {
    console.error(`Telegram disabled: ${CHAT_ID_HELP}`);
    return { enabled: false, misconfigured: true };
  }

  return {
    enabled: true,
    token: trimmedToken,
    chatId: trimmedChatId,
    paperBotReport,
    paperBotReportHour: Number.isFinite(paperBotReportHour)
      ? paperBotReportHour
      : 8,
    paperBotReportMinute: Number.isFinite(paperBotReportMinute)
      ? paperBotReportMinute
      : 0,
  };
}

function exitReasonLabel(reason) {
  if (reason === "take_profit") return "TP";
  if (reason === "stop_loss") return "SL";
  return reason || "—";
}

function signalKindLabel(kind) {
  if (kind === "sfp") return "SFP";
  if (kind === "sfp_bear") return "SFP↓";
  if (kind === "pullback") return "PB";
  if (kind === "pullback_bear") return "PB↓";
  return String(kind || "—").toUpperCase();
}

function formatExitOrdersFailedMessage(pos, detail) {
  const lines = [
    "⚠️ Live bot · exit orders failed",
    `${pos?.symbol ?? "—"} ${signalKindLabel(pos?.signalKind)}`,
    `Entry ${Number(pos?.entryPrice).toFixed(6)} · position closed`,
    detail || "SL/TP could not be placed on exchange",
    formatDateTime(Date.now()),
  ];
  return lines.join("\n");
}

function formatTradeCloseMessage(botLabel, trade) {
  const pnl = Number(trade?.pnl);
  const pnlStr = Number.isFinite(pnl)
    ? pnl >= 0
      ? `+$${pnl.toFixed(2)}`
      : `−$${Math.abs(pnl).toFixed(2)}`
    : "—";
  const pnlPct = Number(trade?.pnlPct);
  const lines = [
    `${botLabel} · ${exitReasonLabel(trade?.exitReason)}`,
    `${trade?.symbol ?? "—"} ${signalKindLabel(trade?.signalKind)}`,
    `Entry ${Number(trade?.entryPrice).toFixed(6)} → exit ${Number(trade?.exitPrice).toFixed(6)}`,
    `PnL ${pnlStr}${Number.isFinite(pnlPct) ? ` (${pnlPct.toFixed(2)}%)` : ""}`,
    formatDateTime(trade?.closedAt ?? Date.now()),
  ];
  return lines.join("\n");
}

function createTelegramNotifier(config) {
  if (!config?.enabled) {
    return {
      enabled: false,
      chatIdMasked: null,
      onTradeClose() {},
      onNonSlTradeClose() {},
      onExitOrdersFailed() {},
      sendText() {
        return Promise.reject(new Error("Telegram not configured"));
      },
    };
  }

  const { token, chatId } = config;
  let sendChain = Promise.resolve();

  function queueSend(text) {
    sendChain = sendChain
      .then(() => sendMessageSafe({ token, chatId, text }))
      .catch((err) => {
        const e = clarifyTelegramError(err, token, chatId);
        console.error(`Telegram send failed: ${e.message}`);
      });
    return sendChain;
  }

  return {
    enabled: true,
    chatIdMasked: maskChatId(chatId),
    onTradeClose(botLabel, trade) {
      if (!trade || trade.exitReason === "exit_orders_failed") return;
      queueSend(formatTradeCloseMessage(botLabel, trade));
    },
    onNonSlTradeClose(botLabel, trade) {
      this.onTradeClose(botLabel, trade);
    },
    onExitOrdersFailed(pos, detail) {
      if (!pos) return;
      queueSend(formatExitOrdersFailedMessage(pos, detail));
    },
    sendText(text) {
      if (!text) return Promise.resolve();
      return sendMessageSafe({ token, chatId, text: String(text) });
    },
  };
}

async function sendMessage({ token, chatId, text }) {
  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok || !body?.ok) {
    const detail = body?.description || res.statusText || "unknown error";
    throw new Error(detail);
  }
  return body;
}

async function sendMessageSafe(opts) {
  try {
    return await sendMessage(opts);
  } catch (err) {
    throw clarifyTelegramError(err, opts.token, opts.chatId);
  }
}

/** List recent chats from getUpdates (after you message the bot). */
async function listTelegramChats(token) {
  const url = `${TELEGRAM_API}/bot${token.trim()}/getUpdates?limit=50`;
  const res = await fetch(url);
  const body = await res.json();
  if (!body?.ok) {
    throw new Error(body?.description || "getUpdates failed");
  }

  const botId = botIdFromToken(token);
  const byChat = new Map();

  for (const u of body.result ?? []) {
    const msg = u.message || u.channel_post || u.edited_message;
    if (!msg?.chat) continue;
    const c = msg.chat;
    if (c.type === "private" && c.id === Number(botId)) continue;

    const key = String(c.id);
    if (!byChat.has(key)) {
      byChat.set(key, {
        id: c.id,
        type: c.type,
        title: c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "—",
        username: c.username ? `@${c.username}` : "",
      });
    }
  }

  return { botId, chats: [...byChat.values()] };
}

module.exports = {
  resolveTelegramConfig,
  createTelegramNotifier,
  formatTradeCloseMessage,
  formatNonSlTradeCloseMessage: formatTradeCloseMessage,
  formatExitOrdersFailedMessage,
  sendMessage,
  sendMessageSafe,
  listTelegramChats,
  botIdFromToken,
  isBotSelfChat,
  CHAT_ID_HELP,
};
