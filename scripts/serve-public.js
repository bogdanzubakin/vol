#!/usr/bin/env node
/**
 * Lightweight dashboard server for Railway / static hosting.
 * Serves public/index.html and /api/state from public/results.json.
 * No Binance connections — pair with a local scanner or upload results.json.
 */

const fs = require("fs");
const path = require("path");
const { startDashboard, RESULTS_JSON } = require("../lib/dashboard-server");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(RESULTS_JSON, "utf8"));
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      activeCount: 0,
      hits: [],
      events: [],
      note: "No results.json yet — run the scanner locally or set SCANNER=1",
    };
  }
}

startDashboard(readState);
console.error(`Public dashboard: results from ${RESULTS_JSON}`);
