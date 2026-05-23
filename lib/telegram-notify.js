const { loadEnvFile } = require("./load-env");
const { formatDateTime } = require("./time-format");

const TELEGRAM_API = "https://api.telegram.org";

function maskChatId(chatId) {
  const s = String(chatId);
  if (s.length <= 4) return "****";
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
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

  return {
    enabled: true,
    token: token.trim(),
    chatId: String(chatId).trim(),
    notifyNear,
  };
}

function formatNewSignalMessage(symbol, m, cfg) {
  const lines = [
    `SIGNAL ${symbol}`,
    `Interval: ${cfg.interval}`,
    `Close ${m.close} > corridor high ${m.corridorHigh}`,
    `Range×${m.rangeRatio} · corridor width ${m.corridorWidthPct}%`,
    `Break volume ${m.breakVolumeRatio ?? "—"}× (≥${m.minBreakVolumeMultiplier ?? cfg.minBreakVolumeMultiplier ?? 2}×)`,
    formatDateTime(Date.now()),
  ];
  return lines.join("\n");
}

function formatNearSignalMessage(symbol, m, cfg) {
  const lines = [
    `NEAR BREAK ${symbol}`,
    `Interval: ${cfg.interval}`,
    `${m.breakGapPct}% below corridor high ${m.corridorHigh}`,
    `Close ${m.close} · range×${m.rangeRatio}`,
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
    };
  }

  const { token, chatId, notifyNear } = config;
  let sendChain = Promise.resolve();

  function queueSend(text) {
    sendChain = sendChain
      .then(() => sendMessage({ token, chatId, text }))
      .catch((err) => {
        console.error(`Telegram send failed: ${err.message}`);
      });
    return sendChain;
  }

  return {
    enabled: true,
    chatIdMasked: maskChatId(chatId),
    notifyNear,
    onNewSignal(symbol, m, cfg) {
      if (!m) return;
      const text = formatNewSignalMessage(symbol, m, cfg || { interval });
      queueSend(text);
    },
    onNearSignal(symbol, m, cfg) {
      if (!notifyNear || !m) return;
      const text = formatNearSignalMessage(symbol, m, cfg || { interval });
      queueSend(text);
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

module.exports = {
  resolveTelegramConfig,
  createTelegramNotifier,
  formatNewSignalMessage,
  sendMessage,
};
