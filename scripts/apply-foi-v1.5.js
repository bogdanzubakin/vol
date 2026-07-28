#!/usr/bin/env node
/**
 * Apply FOI v1.5 patch to local paper/live bot state and optionally push to Railway.
 *
 *   node scripts/write-foi-v1.5-patch.js
 *   node scripts/apply-foi-v1.5.js
 *   node scripts/apply-foi-v1.5.js --push
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");

const ROOT = path.join(__dirname, "..");
const MIRROR = path.join(ROOT, ".cache", "railway-mirror");

function log(m) {
  process.stderr.write(String(m) + "\n");
}

function parseArgs(argv) {
  let push = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--push") push = true;
  }
  return { push };
}

function loadPatch() {
  const doc =
    readJsonFile(dataPath("foi-v1.5-patch.json"), null) ||
    (() => {
      spawnSync(process.execPath, [path.join(__dirname, "write-foi-v1.5-patch.js")], {
        cwd: ROOT,
        stdio: "inherit",
      });
      return readJsonFile(dataPath("foi-v1.5-patch.json"), null);
    })();
  if (!doc?.patch) throw new Error("Missing foi-v1.5-patch.json");
  return doc;
}

function applyToFile(file, patch, label) {
  if (!fs.existsSync(file)) {
    log(`skip ${label}: missing ${file}`);
    return false;
  }
  const state = readJsonFile(file, null);
  if (!state?.config) {
    log(`skip ${label}: no config`);
    return false;
  }
  state.config = { ...state.config, ...patch };
  writeJsonFile(file, state);
  log(
    `applied ${label}: trail=${state.config.foiVwapTrailEnabled} arm=${state.config.foiVwapTrailArmPct} pathCosine=${state.config.foiBtcLookalikeMinPathCosine} cold=${state.config.foiColdDayPolicy}`
  );
  return true;
}

function main() {
  const { push } = parseArgs(process.argv);
  const doc = loadPatch();
  const patch = doc.patch;

  const targets = [
    [dataPath("paper-bot-state.json"), "local paper"],
    [dataPath("live-bot-state.json"), "local live"],
    [path.join(MIRROR, "paper-bot-state.json"), "mirror paper"],
    [path.join(MIRROR, "live-bot-state.json"), "mirror live"],
  ];
  let n = 0;
  for (const [file, label] of targets) {
    if (applyToFile(file, patch, label)) n += 1;
  }
  log(`v1.5 applied to ${n} state file(s)`);

  if (!push) {
    log("Tip: re-run with --push to POST paper+live config to Railway");
    return;
  }

  const env = {
    ...process.env,
    RAILWAY_URL:
      process.env.RAILWAY_URL ||
      process.env.VOL_RAILWAY_URL ||
      "https://vol-production-d574.up.railway.app",
    VOL_SESSION_COOKIE_FILE:
      process.env.VOL_SESSION_COOKIE_FILE ||
      path.join(ROOT, "scripts", ".vol-railway-cookie"),
  };
  log(`Pushing config to ${env.RAILWAY_URL} …`);
  const r = spawnSync(process.execPath, [path.join(__dirname, "push-railway-data.js")], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    process.exit(r.status || 1);
  }
  log("Railway paper+live config push done");
}

main();
