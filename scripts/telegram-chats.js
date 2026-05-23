#!/usr/bin/env node
/**
 * List chat ids for TELEGRAM_CHAT_ID.
 * 1. Send any message to your bot in Telegram.
 * 2. Run: npm run telegram:chats
 */

const { loadEnvFile } = require("../lib/load-env");
const { listTelegramChats, botIdFromToken, CHAT_ID_HELP } = require("../lib/telegram-notify");

loadEnvFile();

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in .env first.");
  process.exit(1);
}

const botId = botIdFromToken(token);
console.error(`Bot id (do NOT use as chat id): ${botId}\n`);

listTelegramChats(token)
  .then(({ chats }) => {
    if (!chats.length) {
      console.log("No chats found.");
      console.log("Open Telegram, find your bot, send it a message (e.g. hi), then run this again.");
      process.exit(1);
    }
    console.log("Use one of these in .env as TELEGRAM_CHAT_ID:\n");
    for (const c of chats) {
      console.log(`  TELEGRAM_CHAT_ID=${c.id}`);
      console.log(`    ${c.type} · ${c.title} ${c.username}`.trim());
      console.log();
    }
    console.log(CHAT_ID_HELP);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
