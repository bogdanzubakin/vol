#!/usr/bin/env node
/**
 * Upload local SFP regime model files to Railway (paper + live).
 *
 * Requires PUT /api/sfp-regime-model on the deployed app.
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function applyConfigThresholds(model, botConfig) {
  const m = { ...model };
  if (m.bull && botConfig?.aiSfpRegimeBullThreshold != null) {
    m.bull = { ...m.bull, threshold: botConfig.aiSfpRegimeBullThreshold };
  }
  if (m.bear && botConfig?.aiSfpRegimeBearThreshold != null) {
    m.bear = { ...m.bear, threshold: botConfig.aiSfpRegimeBearThreshold };
  }
  return m;
}

function putJson(baseUrl, pathname, body, cookie) {
  const url = new URL(pathname, baseUrl);
  const mod = url.protocol === "https:" ? https : http;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
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
            reject(new Error(`Invalid JSON (${res.statusCode}): ${text.slice(0, 300)}`));
            return;
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("Timeout")));
    req.write(payload);
    req.end();
  });
}

async function pushScope(baseUrl, cookie, scope, modelFile, botStateFile) {
  if (!fs.existsSync(modelFile)) {
    throw new Error(`Missing model file: ${modelFile}`);
  }
  const raw = readJson(modelFile);
  const botState = fs.existsSync(botStateFile) ? readJson(botStateFile) : null;
  const model = applyConfigThresholds(raw, botState?.config);
  const { scope: _s, savedAt, savedAtIso, ...modelPayload } = model;

  const res = await putJson(
    baseUrl,
    "/api/sfp-regime-model",
    {
      scope,
      model: {
        ...modelPayload,
        source: modelPayload.source ?? `import:local:${scope}`,
        trainedAt: modelPayload.trainedAt ?? Date.now(),
      },
    },
    cookie
  );

  if (res.status === 401) {
    throw new Error("Unauthorized — set VOL_SESSION_COOKIE");
  }
  if (res.status === 404 || res.status === 405) {
    throw new Error(
      `PUT /api/sfp-regime-model not available (${res.status}) — deploy latest app first`
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(res.json?.error || res.text?.slice(0, 200) || res.status);
  }
  return res.json;
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

  const uploads = [
    {
      scope: "paper",
      model: dataPath("sfp-regime-model.json"),
      state: dataPath("paper-bot-state.json"),
    },
    {
      scope: "live",
      model: dataPath("sfp-regime-model-live.json"),
      state: dataPath("live-bot-state.json"),
    },
  ];

  console.log(`Pushing SFP regime models from ${dataDir}`);
  console.log(`Target: ${baseUrl}\n`);

  for (const { scope, model, state } of uploads) {
    process.stdout.write(`  ${scope} … `);
    const result = await pushScope(baseUrl, cookie, scope, model, state);
    const st = result.status ?? result;
    console.log(
      `ok — source=${st.source ?? "?"}, bull=${st.bullThreshold ?? st.threshold ?? "?"}, bear=${st.bearThreshold ?? "?"}`
    );
  }

  console.log("\nDone. Verify: node scripts/pull-railway-data.js && node scripts/diff-railway-local.js");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
