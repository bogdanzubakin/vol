#!/usr/bin/env node
/**
 * Push local .cache settings and AI models to Railway.
 *
 * Env: RAILWAY_URL, VOL_SESSION_COOKIE or VOL_SESSION_COOKIE_FILE
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { dataPath, resolveDataDir } = require("../lib/data-dir");

const ROOT = path.join(__dirname, "..");

function readCookie() {
  const inline = process.env.VOL_SESSION_COOKIE?.trim();
  if (inline) return inline;
  const file =
    process.env.VOL_SESSION_COOKIE_FILE?.trim() ||
    path.join(ROOT, "scripts", ".vol-railway-cookie");
  try {
    const line = fs.readFileSync(file, "utf8").trim();
    if (line) return line.includes("=") ? line : `vol_session=${line}`;
  } catch {
    /* optional */
  }
  return "";
}

function readJsonOptional(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function requestJson(baseUrl, method, pathname, body, cookie) {
  const url = new URL(pathname, baseUrl);
  const mod = url.protocol === "https:" ? https : http;
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method,
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            reject(
              new Error(`${method} ${pathname} non-JSON (${res.statusCode}): ${text.slice(0, 300)}`)
            );
            return;
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`Timeout: ${pathname}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(baseUrl, cookie, method, pathname, body) {
  const res = await requestJson(baseUrl, method, pathname, body, cookie);
  if (res.status === 401) {
    throw new Error(`Unauthorized on ${pathname} — set VOL_SESSION_COOKIE`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `${method} ${pathname} failed (${res.status}): ${res.json?.error || res.text?.slice(0, 200)}`
    );
  }
  return res.json;
}

function stripModelMeta(model) {
  const { scope, savedAt, savedAtIso, ...rest } = model;
  return rest;
}

function applySfpThresholds(model, botConfig) {
  const m = { ...model };
  if (m.bull && botConfig?.aiSfpRegimeBullThreshold != null) {
    m.bull = { ...m.bull, threshold: botConfig.aiSfpRegimeBullThreshold };
  }
  if (m.bear && botConfig?.aiSfpRegimeBearThreshold != null) {
    m.bear = { ...m.bear, threshold: botConfig.aiSfpRegimeBearThreshold };
  }
  return m;
}

function applyLevelBreakThresholds(model, botConfig) {
  const m = { ...model };
  if (m.bull && botConfig?.aiLevelBreakRegimeBullThreshold != null) {
    m.bull = { ...m.bull, threshold: botConfig.aiLevelBreakRegimeBullThreshold };
  }
  if (m.bear && botConfig?.aiLevelBreakRegimeBearThreshold != null) {
    m.bear = { ...m.bear, threshold: botConfig.aiLevelBreakRegimeBearThreshold };
  }
  return m;
}

function applyEarlyExitThresholds(model, botConfig) {
  const m = { ...model };
  if (m.hard && botConfig?.aiEarlyExitHardThreshold != null) {
    m.hard = { ...m.hard, threshold: botConfig.aiEarlyExitHardThreshold };
  }
  if (m.soft && botConfig?.aiEarlyExitSoftThreshold != null) {
    m.soft = { ...m.soft, threshold: botConfig.aiEarlyExitSoftThreshold };
  }
  if (m.threshold != null && botConfig?.aiEarlyExitThreshold != null) {
    m.threshold = botConfig.aiEarlyExitThreshold;
  }
  return m;
}

async function pushModel(baseUrl, cookie, apiPath, scope, modelFile, botConfig, applyThresholds) {
  if (!fs.existsSync(modelFile)) {
    return { skipped: true, reason: "file missing" };
  }
  const raw = readJsonOptional(modelFile);
  if (!raw) return { skipped: true, reason: "invalid json" };
  const model = applyThresholds(stripModelMeta(raw), botConfig);
  const result = await api(baseUrl, cookie, "PUT", apiPath, {
    scope,
    model: {
      ...model,
      source: model.source ?? `import:local:${scope}`,
      trainedAt: model.trainedAt ?? Date.now(),
    },
  });
  return { skipped: false, result };
}

async function main() {
  const baseUrl = (
    process.env.RAILWAY_URL ||
    process.env.VOL_RAILWAY_URL ||
    ""
  )
    .trim()
    .replace(/\/$/, "");
  if (!baseUrl) {
    console.error("Set RAILWAY_URL");
    process.exit(1);
  }

  const cookie = readCookie();
  const dataDir = resolveDataDir();
  const paperConfig = readJsonOptional(dataPath("paper-bot-state.json"))?.config;
  const liveConfig = readJsonOptional(dataPath("live-bot-state.json"))?.config;

  console.log(`Pushing local config from ${dataDir}`);
  console.log(`Target: ${baseUrl}\n`);

  const scanner = readJsonOptional(dataPath("scanner-config.json"));
  if (scanner) {
    process.stdout.write("  scanner-config … ");
    await api(baseUrl, cookie, "POST", "/api/config", scanner);
    console.log("ok");
  } else {
    console.log("  scanner-config … skip (missing)");
  }

  if (paperConfig) {
    process.stdout.write("  paper-bot config … ");
    await api(baseUrl, cookie, "POST", "/api/paper-bot/config", paperConfig);
    console.log("ok");
  }

  if (liveConfig) {
    process.stdout.write("  live-bot config … ");
    await api(baseUrl, cookie, "POST", "/api/live-bot/config", liveConfig);
    console.log("ok");
  }

  const uiSettings = readJsonOptional(dataPath("ui-settings.json"));
  if (uiSettings) {
    process.stdout.write("  ui-settings … ");
    await api(baseUrl, cookie, "POST", "/api/ui-settings", uiSettings);
    console.log("ok");
  }

  const models = [
    {
      label: "SFP regime (paper)",
      path: "/api/sfp-regime-model",
      scope: "paper",
      file: dataPath("sfp-regime-model.json"),
      bot: paperConfig,
      apply: applySfpThresholds,
    },
    {
      label: "SFP regime (live)",
      path: "/api/sfp-regime-model",
      scope: "live",
      file: dataPath("sfp-regime-model-live.json"),
      bot: liveConfig,
      apply: applySfpThresholds,
    },
    {
      label: "Level-break regime (paper)",
      path: "/api/level-break-regime-model",
      scope: "paper",
      file: dataPath("level-break-regime-model.json"),
      bot: paperConfig,
      apply: applyLevelBreakThresholds,
    },
    {
      label: "Level-break regime (live)",
      path: "/api/level-break-regime-model",
      scope: "live",
      file: dataPath("level-break-regime-model-live.json"),
      bot: liveConfig,
      apply: applyLevelBreakThresholds,
    },
    {
      label: "Early exit (paper)",
      path: "/api/early-exit-model",
      scope: "paper",
      file: dataPath("early-exit-sfp.json"),
      bot: paperConfig,
      apply: applyEarlyExitThresholds,
    },
    {
      label: "Early exit (live)",
      path: "/api/early-exit-model",
      scope: "live",
      file: dataPath("early-exit-sfp-live.json"),
      bot: liveConfig,
      apply: applyEarlyExitThresholds,
    },
  ];

  for (const m of models) {
    process.stdout.write(`  ${m.label} … `);
    const out = await pushModel(
      baseUrl,
      cookie,
      m.path,
      m.scope,
      m.file,
      m.bot,
      m.apply
    );
    if (out.skipped) {
      console.log(`skip (${out.reason})`);
    } else {
      const st = out.result?.status ?? {};
      console.log(`ok — source=${st.source ?? "?"}`);
    }
  }

  console.log("\nDone. Verify:");
  console.log("  node scripts/pull-railway-data.js && node scripts/diff-railway-local.js");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
