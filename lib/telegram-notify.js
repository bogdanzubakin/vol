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

  const notifyNear =
    flags.has("telegram-near") ||
    process.env.TELEGRAM_NOTIFY_NEAR === "1" ||
    process.env.TELEGRAM_NOTIFY_NEAR === "true";

  const paperBotReport =
    !flags.has("no-paper-bot-report") &&
    process.env.TELEGRAM_PAPER_BOT_REPORT !== "0";
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
    notifyNear,
    paperBotReport,
    paperBotReportHour: Number.isFinite(paperBotReportHour)
      ? paperBotReportHour
      : 8,
    paperBotReportMinute: Number.isFinite(paperBotReportMinute)
      ? paperBotReportMinute
      : 0,
  };
}

function formatNewSignalMessage(symbol, m, cfg) {
  const lines = [
    `SIGNAL ${symbol}`,
    `Interval: ${cfg.interval}`,
    `Close ${m.close} > corridor high ${m.corridorHigh}`,
    `${m.aboveCorridorCount}/${m.minAboveCorridorCandles} candles above high · corridor width ${m.corridorWidthPct}%`,
    `Break volume ${m.breakVolumeRatio ?? "—"}× (≥${m.minBreakVolumeMultiplier ?? cfg.minBreakVolumeMultiplier ?? 5}×)`,
    formatDateTime(Date.now()),
  ];
  return lines.join("\n");
}

function formatNearSignalMessage(symbol, m, cfg) {
  const lines = [
    `NEAR BREAK ${symbol}`,
    `Interval: ${cfg.interval}`,
    `${m.breakGapPct}% below corridor high ${m.corridorHigh}`,
    `Close ${m.close} · ${m.aboveCorridorCount}/${m.minAboveCorridorCandles} above high`,
    formatDateTime(Date.now()),
  ];
  return lines.join("\n");
}

function formatFastCorridorMessage(symbol, m, cfg) {
  const lines = [
    `FAST CORRIDOR ${symbol}`,
    `Interval: ${cfg.interval}`,
    `Close ${m.close} · corridor ${m.corridorWidthPct}% (${m.corridorLow} – ${m.corridorHigh})`,
    `Avg move ${m.avgMovePct}% · ${m.halfWaves} half-waves`,
    formatDateTime(Date.now()),
  ];
  return lines.join("\n");
}

function createTelegramNotifier(config, { interval = "1m" } = {}) {
  if (!config?.enabled) {
    return {
      enabled: false,
      chatIdMasked: null,
      onNewSignal() {},
      onNearSignal() {},
      onFastCorridorSignal() {},
      sendNewSignal() {
        return Promise.reject(new Error("Telegram not configured"));
      },
      sendText() {
        return Promise.reject(new Error("Telegram not configured"));
      },
    };
  }

  const { token, chatId, notifyNear } = config;
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
    notifyNear,
    onNewSignal(symbol, m, cfg) {
      if (!m) return;
      queueSend(formatNewSignalMessage(symbol, m, cfg || { interval }));
    },
    onNearSignal(symbol, m, cfg) {
      if (!notifyNear || !m) return;
      queueSend(formatNearSignalMessage(symbol, m, cfg || { interval }));
    },
    onFastCorridorSignal(symbol, m, cfg) {
      if (!m) return;
      queueSend(formatFastCorridorMessage(symbol, m, cfg || { interval }));
    },
    sendNewSignal(symbol, m, cfg) {
      if (!m) return Promise.reject(new Error("No metrics for signal message"));
      const text = formatNewSignalMessage(symbol, m, cfg || { interval });
      return sendMessageSafe({ token, chatId, text });
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
  formatNewSignalMessage,
  formatFastCorridorMessage,
  sendMessage,
  sendMessageSafe,
  listTelegramChats,
  botIdFromToken,
  isBotSelfChat,
  CHAT_ID_HELP,
};
