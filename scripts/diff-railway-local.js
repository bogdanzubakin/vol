#!/usr/bin/env node
/**
 * Diff local .cache settings/models against .cache/railway-mirror/ from pull-railway-data.
 */
const fs = require("fs");
const path = require("path");
const { dataPath, resolveDataDir } = require("../lib/data-dir");
const { LIVE_CONFIG_KEYS } = require("../lib/signal-metrics");

const ROOT = path.join(__dirname, "..");

const REGIME_KEYS = [
  "aiSfpRegimeEnabled",
  "aiSfpRegimeBullThreshold",
  "aiSfpRegimeBearThreshold",
  "aiRegimeBtcLookbackHours",
  "aiLevelBreakRegimeEnabled",
  "aiLevelBreakRegimeBullThreshold",
  "aiLevelBreakRegimeBearThreshold",
  "aiEarlyExitEnabled",
  "aiEarlyExitThreshold",
];

const SCANNER_HIGHLIGHT = [
  "interval",
  "fastMoveLookbackCandles",
  "minAvgMovePct",
  "topMoveMinPct",
  "sfpLookbackBars",
  "sfpMinSweepPct",
];

const MODEL_FILES = [
  { local: "sfp-regime-model.json", mirror: "sfp-regime-model.json", label: "SFP regime (paper)" },
  {
    local: "sfp-regime-model-live.json",
    mirror: "sfp-regime-model-live.json",
    label: "SFP regime (live)",
  },
  {
    local: "level-break-regime-model.json",
    mirror: "level-break-regime-model.json",
    label: "Level-break regime (paper)",
  },
  {
    local: "level-break-regime-model-live.json",
    mirror: "level-break-regime-model-live.json",
    label: "Level-break regime (live)",
  },
  {
    local: "early-exit-model.json",
    mirror: "early-exit-model.json",
    label: "Early exit (paper)",
  },
  {
    local: "early-exit-model-live.json",
    mirror: "early-exit-model-live.json",
    label: "Early exit (live)",
  },
];

function parseArgs(argv) {
  const args = { json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--mirror" && argv[i + 1]) args.mirror = argv[++i];
    else if (a.startsWith("--mirror=")) args.mirror = a.slice(9);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function pick(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffObjects(local, remote, prefix = "") {
  const diffs = [];
  const keys = new Set([
    ...Object.keys(local || {}),
    ...Object.keys(remote || {}),
  ]);
  for (const key of [...keys].sort()) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    const lv = local?.[key];
    const rv = remote?.[key];
    if (
      lv &&
      rv &&
      typeof lv === "object" &&
      typeof rv === "object" &&
      !Array.isArray(lv)
    ) {
      diffs.push(...diffObjects(lv, rv, pathKey));
      continue;
    }
    if (!deepEqual(lv, rv)) {
      diffs.push({ path: pathKey, local: lv, remote: rv });
    }
  }
  return diffs;
}

function roundWeights(weights) {
  return (weights ?? []).map((v) =>
    Number.isFinite(v) ? +Number(v).toFixed(6) : v
  );
}

function modelFingerprint(model) {
  if (!model || typeof model !== "object") return null;
  const fp = {
    version: model.version ?? null,
    source: model.source ?? null,
    trainedAt: model.trainedAt ?? null,
    featureNames: model.featureNames ?? null,
  };
  if (model.bull || model.bear) {
    fp.bullThreshold = model.bull?.threshold ?? null;
    fp.bearThreshold = model.bear?.threshold ?? null;
    fp.bullWeights = roundWeights(model.bull?.weights);
    fp.bearWeights = roundWeights(model.bear?.weights);
  }
  if (model.hard || model.soft) {
    fp.hardThreshold = model.hard?.threshold ?? null;
    fp.softThreshold = model.soft?.threshold ?? null;
    fp.hardWeights = roundWeights(model.hard?.weights);
    fp.softWeights = roundWeights(model.soft?.weights);
  }
  if (model.threshold != null) {
    fp.threshold = model.threshold;
    fp.weights = roundWeights(model.weights);
  }
  return fp;
}

function formatValue(v) {
  if (v === undefined) return "(missing)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function compareSection(title, localObj, remoteObj, keys) {
  const local = keys ? pick(localObj, keys) : localObj;
  const remote = keys ? pick(remoteObj, keys) : remoteObj;
  const diffs = diffObjects(local, remote);
  return { title, diffs, match: diffs.length === 0 };
}

function compareModelFile(label, localFile, mirrorFile) {
  const localModel = readJson(localFile);
  const mirrorModel = readJson(mirrorFile);
  if (!mirrorModel) {
    const statusFile = mirrorFile.replace(/\.json$/, "-status.json");
    const altStatus = mirrorFile.includes("-live")
      ? mirrorFile.replace("-live.json", "-status-live.json")
      : null;
    const status =
      readJson(statusFile) ||
      (altStatus ? readJson(altStatus) : null) ||
      readJson(mirrorFile.replace(".json", `-status-${mirrorFile.includes("-live") ? "live" : "paper"}.json`));
    if (status) {
      return {
        title: label,
        match: false,
        diffs: [
          {
            path: "(full model)",
            local: localModel ? "present" : "missing",
            remote: "status only — redeploy app and re-pull with full=1",
            statusOnly: true,
            remoteStatus: {
              trainedAt: status.trainedAt,
              source: status.source,
              bullThreshold: status.bullThreshold ?? status.threshold,
              bearThreshold: status.bearThreshold,
              btcFeaturesActive: status.btcFeaturesActive,
              featureCount: status.featureCount,
            },
          },
        ],
      };
    }
    return {
      title: label,
      match: false,
      diffs: [
        {
          path: "(file)",
          local: fs.existsSync(localFile) ? "present" : "missing",
          remote: "missing — run pull-railway-data first",
        },
      ],
    };
  }
  const diffs = diffObjects(
    modelFingerprint(localModel),
    modelFingerprint(mirrorModel)
  );
  return { title: label, match: diffs.length === 0, diffs };
}

function printSection(section) {
  if (section.match) {
    console.log(`✓ ${section.title}`);
    return;
  }
  console.log(`✗ ${section.title}`);
  for (const d of section.diffs) {
    console.log(`    ${d.path}`);
    console.log(`      local:  ${formatValue(d.local)}`);
    console.log(`      remote: ${formatValue(d.remote)}`);
    if (d.remoteStatus) {
      console.log(`      remote status: ${JSON.stringify(d.remoteStatus)}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node scripts/diff-railway-local.js [--mirror .cache/railway-mirror] [--json]

Compares local ${resolveDataDir()} against a Railway mirror from pull-railway-data.
`);
    process.exit(0);
  }

  const localDir = resolveDataDir();
  const mirrorDir = path.resolve(
    args.mirror || path.join(ROOT, ".cache", "railway-mirror")
  );
  const meta = readJson(path.join(mirrorDir, "pull-meta.json"));

  if (!fs.existsSync(mirrorDir)) {
    console.error(`Mirror not found: ${mirrorDir}`);
    console.error("Run: ./scripts/pull-railway-data.sh");
    process.exit(1);
  }

  const sections = [];

  const localPaper = readJson(dataPath("paper-bot-state.json"));
  const mirrorPaper = readJson(path.join(mirrorDir, "paper-bot-state.json"));
  sections.push(
    compareSection(
      "Paper bot config (regime + AI)",
      localPaper?.config,
      mirrorPaper?.config,
      REGIME_KEYS
    )
  );

  const localLive = readJson(dataPath("live-bot-state.json"));
  const mirrorLive = readJson(path.join(mirrorDir, "live-bot-state.json"));
  if (mirrorLive) {
    sections.push(
      compareSection(
        "Live bot config (regime + AI)",
        localLive?.config,
        mirrorLive?.config,
        REGIME_KEYS
      )
    );
  }

  const localScanner = readJson(dataPath("scanner-config.json"));
  const mirrorScanner = readJson(path.join(mirrorDir, "scanner-config.json"));
  const scannerKeys = [...new Set([...SCANNER_HIGHLIGHT, ...LIVE_CONFIG_KEYS])];
  sections.push(
    compareSection(
      "Scanner config",
      localScanner,
      mirrorScanner,
      scannerKeys
    )
  );

  for (const { local, mirror, label } of MODEL_FILES) {
    sections.push(
      compareModelFile(
        label,
        dataPath(local),
        path.join(mirrorDir, mirror)
      )
    );
  }

  const backtestSummary = readJson(path.join(mirrorDir, "backtest-summary.json"));
  if (backtestSummary?.lastSummary) {
    const localBacktest = readJson(dataPath("paper-bot-backtest-last.json"));
    const localSummary = localBacktest?.summary ?? null;
    const remoteSummary = backtestSummary.lastSummary;
    const summaryKeys = [
      "totalPnl",
      "closedTrades",
      "winRate",
      "sfpRegimeSkips",
      "sfpBullTrades",
      "sfpBearTrades",
    ];
    sections.push(
      compareSection(
        "Last backtest summary (paper)",
        pick(localSummary, summaryKeys),
        pick(remoteSummary, summaryKeys),
        summaryKeys
      )
    );
  }

  const report = {
    localDir,
    mirrorDir,
    pulledAt: meta?.pulledAt ?? null,
    remoteUrl: meta?.baseUrl ?? null,
    remoteDataDir: meta?.dataDir ?? null,
    sections: sections.map((s) => ({
      title: s.title,
      match: s.match,
      diffs: s.diffs,
    })),
    allMatch: sections.every((s) => s.match),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.allMatch ? 0 : 1);
  }

  console.log(`Local:  ${localDir}`);
  console.log(`Mirror: ${mirrorDir}`);
  if (meta?.baseUrl) console.log(`Remote: ${meta.baseUrl} (pulled ${meta.pulledAt})`);
  console.log("");

  for (const section of sections) {
    printSection(section);
  }

  const mismatches = sections.filter((s) => !s.match).length;
  console.log("");
  if (report.allMatch) {
    console.log("All compared files match.");
    process.exit(0);
  }
  console.log(`${mismatches} section(s) differ.`);
  process.exit(1);
}

main();
