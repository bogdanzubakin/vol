#!/usr/bin/env node
/**
 * Lightweight dashboard server for Railway / static hosting.
 * Serves public/index.html and /api/state from public/results.json.
 * No Binance connections — pair with a local scanner or upload results.json.
 */

const fs = require("fs");
const path = require("path");
const { startDashboard, RESULTS_JSON } = require("../lib/dashboard-server");
const { nowIsoUtcPlus3 } = require("../lib/time-format");
const { createTelegramAuth } = require("../lib/telegram-auth");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_JSON, "utf8"));
  } catch {
    return {
      updatedAt: nowIsoUtcPlus3(),
      activeCount: 0,
      hits: [],
      events: [],
      note: "No results.json yet — run the scanner locally or set SCANNER=1",
    };
  }
}

const auth = createTelegramAuth({});

startDashboard(readState, { auth });
console.error(`Public dashboard: results from ${RESULTS_JSON}`);
