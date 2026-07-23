#!/usr/bin/env node
/**
 * Restore a saved breakpoint snapshot into local paper/live/scanner + FOI models.
 *
 *   node scripts/restore-breakpoint.js 1.0
 *   node scripts/restore-breakpoint.js 1.1
 *   node scripts/restore-breakpoint.js 1.2
 *   node scripts/restore-breakpoint.js 1.3
 *   node scripts/restore-breakpoint.js 1.4
 *   node scripts/restore-breakpoint.js latest
 */
const fs = require("fs");
const path = require("path");
const { dataPath, readJsonFile, writeJsonFile } = require("../lib/data-dir");
const { modelFileFor } = require("../lib/ai-model-scope");
const { reloadModel: reloadExitLevels } = require("../lib/ai-exit-levels-model");

function log(m) {
  console.error(String(m));
}

function resolveVersion(arg) {
  if (!arg || arg === "latest") {
    const latest = readJsonFile(dataPath("breakpoints/latest.json"), null);
    if (!latest?.version) throw new Error("No breakpoints/latest.json");
    return String(latest.version);
  }
  return String(arg);
}

function main() {
  const version = resolveVersion(process.argv[2]);
  const dir = path.join(dataPath(), "breakpoints", version);
  const manifest = readJsonFile(path.join(dir, "manifest.json"), null);
  if (!manifest) {
    console.error(`Missing breakpoint ${version} at ${dir}`);
    process.exit(1);
  }

  const copies = [
    ["paper-bot-state.json", "paper-bot-state.json"],
    ["live-bot-state.json", "live-bot-state.json"],
    ["scanner-config.json", "scanner-config.json"],
    ["foi-1m-both-10d-best.json", "foi-1m-both-10d-best.json"],
    // BP 1.0 eval
    ["foi-1m-loss-reduce-10d.json", "foi-1m-loss-reduce-10d.json"],
    // BP 1.1 eval + parent baseline
    ["foi-1m-sfp-oi-gate-10d.json", "foi-1m-sfp-oi-gate-10d.json"],
    ["foi-1m-sfp-oi-gate-10d-trades.json", "foi-1m-sfp-oi-gate-10d-trades.json"],
    ["foi-1m-adverse-only-10d.json", "foi-1m-adverse-only-10d.json"],
    // BP 1.2 eval
    ["foi-1m-ea-off-10d.json", "foi-1m-ea-off-10d.json"],
    ["foi-1m-ea-off-10d-trades.json", "foi-1m-ea-off-10d-trades.json"],
    // BP 1.3 eval
    ["foi-1m-pb-oi-gate-10d.json", "foi-1m-pb-oi-gate-10d.json"],
    ["foi-1m-pb-oi-gate-10d-trades.json", "foi-1m-pb-oi-gate-10d-trades.json"],
    // BP 1.4 wide confirmation
    ["foi-1m-bp13-wide-10d.json", "foi-1m-bp13-wide-10d.json"],
    ["foi-1m-bp13-wide-10d-trades.json", "foi-1m-bp13-wide-10d-trades.json"],
  ];
  for (const [srcName, destRel] of copies) {
    const src = path.join(dir, srcName);
    if (!fs.existsSync(src)) {
      log(`skip missing ${srcName}`);
      continue;
    }
    fs.copyFileSync(src, dataPath(destRel));
    log(`restored ${destRel}`);
  }

  const modelSrc =
    (fs.existsSync(path.join(dir, "ai-exit-levels.json")) &&
      path.join(dir, "ai-exit-levels.json")) ||
    (fs.existsSync(path.join(dir, "ai-exit-levels-paper.json")) &&
      path.join(dir, "ai-exit-levels-paper.json"));
  if (modelSrc) {
    const modelDir = path.join(dataPath(), "foi-1m-both-models");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.copyFileSync(modelSrc, path.join(modelDir, "ai-exit-levels.json"));
    for (const scope of ["paper", "live"]) {
      const dest = modelFileFor("ai-exit-levels", scope);
      fs.copyFileSync(modelSrc, dest);
      reloadExitLevels(scope);
    }
    log("restored ai-exit-levels → paper + live + foi-1m-both-models");
  }

  writeJsonFile(dataPath("breakpoints/latest.json"), {
    version,
    path: `breakpoints/${version}`,
    savedAt: new Date().toISOString(),
    restoredFrom: manifest.savedAt,
    label: manifest.label,
    pnl: manifest.eval?.pnl ?? null,
  });

  console.log(
    JSON.stringify(
      {
        restored: version,
        label: manifest.label,
        eval: manifest.eval,
        dir,
      },
      null,
      2
    )
  );
}

main();
