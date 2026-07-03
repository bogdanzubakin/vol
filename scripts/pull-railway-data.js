#!/usr/bin/env node
/**
 * Pull Railway dashboard API data into .cache/railway-mirror/ for local diff.
 *
 * Env:
 *   RAILWAY_URL or VOL_RAILWAY_URL — e.g. https://your-app.up.railway.app
 *   VOL_SESSION_COOKIE — full Cookie header value, usually vol_session=...
 *   VOL_SESSION_COOKIE_FILE — file containing the cookie (one line)
 *   VOL_RAILWAY_MIRROR — output dir (default .cache/railway-mirror)
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = { help: false, statusOnly: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--status-only") args.statusOnly = true;
    else if (a === "--url" && argv[i + 1]) args.url = argv[++i];
    else if (a.startsWith("--url=")) args.url = a.slice(6);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  console.log(`Usage: node scripts/pull-railway-data.js [--url https://app.up.railway.app]

Environment:
  RAILWAY_URL / VOL_RAILWAY_URL   Railway dashboard base URL
  VOL_SESSION_COOKIE              Session cookie (vol_session=...) when DASHBOARD_AUTH=1
  VOL_SESSION_COOKIE_FILE         Path to cookie file
  VOL_RAILWAY_MIRROR              Output directory (default: .cache/railway-mirror)

Get the cookie: log into the dashboard in your browser → DevTools → Application →
Cookies → copy the vol_session value, then:
  export VOL_SESSION_COOKIE='vol_session=...'

Or save to ~/.vol-railway-cookie and set VOL_SESSION_COOKIE_FILE.
`);
}

function readCookie() {
  const inline = process.env.VOL_SESSION_COOKIE?.trim();
  if (inline) return inline;
  const file =
    process.env.VOL_SESSION_COOKIE_FILE?.trim() ||
    path.join(process.env.HOME || "", ".vol-railway-cookie");
  try {
    const line = fs.readFileSync(file, "utf8").trim();
    if (line) return line.includes("=") ? line : `vol_session=${line}`;
  } catch {
    /* optional */
  }
  return "";
}

function fetchJson(baseUrl, pathname, cookie) {
  const url = new URL(pathname, baseUrl);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            reject(
              new Error(
                `${pathname} returned non-JSON (${res.statusCode}): ${body.slice(0, 240)}`
              )
            );
            return;
          }
          resolve({ status: res.statusCode, json, body });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`Timeout: ${pathname}`));
    });
    req.end();
  });
}

async function fetchRequired(baseUrl, pathname, cookie) {
  const res = await fetchJson(baseUrl, pathname, cookie);
  if (res.status === 401) {
    throw new Error(
      `Unauthorized on ${pathname} — set VOL_SESSION_COOKIE (dashboard auth is on)`
    );
  }
  if (res.status < 200 || res.status >= 300) {
    const msg = res.json?.error || res.body?.slice(0, 200) || res.status;
    throw new Error(`${pathname} failed (${res.status}): ${msg}`);
  }
  return res.json;
}

async function fetchOptional(baseUrl, pathname, cookie) {
  const res = await fetchJson(baseUrl, pathname, cookie);
  if (res.status === 404 || res.status === 503) {
    return { ok: false, status: res.status, json: res.json };
  }
  if (res.status === 401) {
    throw new Error(
      `Unauthorized on ${pathname} — set VOL_SESSION_COOKIE (dashboard auth is on)`
    );
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, json: res.json, error: res.json?.error };
  }
  return { ok: true, status: res.status, json: res.json };
}

function writeJson(outDir, name, data) {
  const file = path.join(outDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}


async function pullModel(outDir, baseUrl, cookie, apiPath, scope, fileBase) {
  const fullPath = `${apiPath}?scope=${scope}&full=1`;
  const res = await fetchOptional(baseUrl, fullPath, cookie);
  const statusName = `${fileBase}-status.json`;
  if (!res.ok) {
    const fallback = await fetchOptional(
      baseUrl,
      `${apiPath}?scope=${scope}`,
      cookie
    );
    if (fallback.ok) {
      writeJson(outDir, statusName, fallback.json);
      return { file: statusName, full: false };
    }
    return { file: null, full: false, error: res.error || res.status };
  }
  const { model, training, ...status } = res.json;
  writeJson(outDir, statusName, { ...status, training });
  if (model) {
    const modelFile = scope === "live" ? `${fileBase}-live.json` : `${fileBase}.json`;
    writeJson(outDir, modelFile, model);
    return { file: modelFile, full: true };
  }
  return { file: statusName, full: false };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  const baseUrl = (args.url || process.env.RAILWAY_URL || process.env.VOL_RAILWAY_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (!baseUrl) {
    console.error("Missing RAILWAY_URL or VOL_RAILWAY_URL");
    usage();
    process.exit(1);
  }

  const cookie = readCookie();
  const outDir = path.resolve(
    process.env.VOL_RAILWAY_MIRROR || path.join(ROOT, ".cache", "railway-mirror")
  );
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Pulling from ${baseUrl}`);
  console.log(`Writing to ${outDir}`);

  const authConfig = await fetchRequired(baseUrl, "/api/auth/config", cookie);
  writeJson(outDir, "auth-config.json", authConfig);
  if (authConfig.enabled && !cookie) {
    console.warn(
      "Warning: dashboard auth is enabled but VOL_SESSION_COOKIE is not set — API calls may fail."
    );
  }

  const storageInfo = await fetchRequired(baseUrl, "/api/storage-info", cookie);
  writeJson(outDir, "storage-info.json", storageInfo);

  let scannerConfig = null;
  const scannerRes = await fetchOptional(baseUrl, "/api/scanner-config", cookie);
  if (scannerRes.ok && scannerRes.json?.config) {
    scannerConfig = scannerRes.json.config;
    writeJson(outDir, "scanner-config.json", scannerConfig);
  }

  const paperBot = await fetchRequired(baseUrl, "/api/paper-bot", cookie);
  writeJson(outDir, "paper-bot-state.json", { config: paperBot.config ?? {} });

  const liveRes = await fetchOptional(baseUrl, "/api/live-bot", cookie);
  if (liveRes.ok) {
    writeJson(outDir, "live-bot-state.json", {
      config: liveRes.json?.config ?? {},
    });
  }

  const backtestRes = await fetchOptional(baseUrl, "/api/paper-bot/backtest", cookie);
  if (backtestRes.ok) {
    const bt = backtestRes.json;
    if (!scannerConfig && bt.signalConfig) {
      scannerConfig = bt.signalConfig;
      writeJson(outDir, "scanner-config.json", scannerConfig);
    }
    writeJson(outDir, "backtest-summary.json", {
      running: bt.running,
      error: bt.error,
      signalConfig: bt.signalConfig ?? null,
      lastSummary: bt.last?.summary ?? null,
      lastBotConfig: bt.last?.botConfig ?? null,
      lastSignalConfig: bt.last?.signalConfig ?? null,
      finishedAt: bt.last?.finishedAt ?? null,
      days: bt.last?.days ?? null,
      klineCache: bt.klineCache ?? null,
    });
  }

  const modelApis = [
    { path: "/api/sfp-regime-model", base: "sfp-regime-model" },
    { path: "/api/level-break-regime-model", base: "level-break-regime-model" },
    { path: "/api/early-exit-model", base: "early-exit-model" },
  ];

  const pulledModels = [];
  if (!args.statusOnly) {
    for (const { path: apiPath, base } of modelApis) {
      for (const scope of ["paper", "live"]) {
        const result = await pullModel(outDir, baseUrl, cookie, apiPath, scope, base);
        if (result.file) {
          pulledModels.push({ scope, file: result.file, full: result.full });
        }
      }
    }
  } else {
    for (const { path: apiPath, base } of modelApis) {
      for (const scope of ["paper", "live"]) {
        const res = await fetchOptional(
          baseUrl,
          `${apiPath}?scope=${scope}`,
          cookie
        );
        if (res.ok) {
          const name = `${base}-status-${scope}.json`;
          writeJson(outDir, name, res.json);
          pulledModels.push({ scope, file: name, full: false });
        }
      }
    }
  }

  const meta = {
    pulledAt: new Date().toISOString(),
    baseUrl,
    authEnabled: Boolean(authConfig.enabled),
    dataDir: storageInfo?.dataDir ?? null,
    mirrorDir: outDir,
    models: pulledModels,
    statusOnly: args.statusOnly,
  };
  writeJson(outDir, "pull-meta.json", meta);

  console.log("Done.");
  console.log(`  auth: ${authConfig.enabled ? "enabled" : "disabled"}`);
  console.log(`  remote DATA_DIR: ${meta.dataDir ?? "unknown"}`);
  console.log(`  models: ${pulledModels.map((m) => m.file).join(", ") || "none"}`);
  console.log(`\nRun: node scripts/diff-railway-local.js`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
