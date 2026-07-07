#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const base = (process.env.RAILWAY_URL || process.env.VOL_RAILWAY_URL || "").replace(/\/$/, "");
const cookieFile =
  process.env.VOL_SESSION_COOKIE_FILE?.trim() ||
  path.join(ROOT, "scripts", ".vol-railway-cookie");
const out = path.resolve(process.env.VOL_RAILWAY_MIRROR || path.join(ROOT, ".cache", "railway-mirror"));

function readCookie() {
  const inline = process.env.VOL_SESSION_COOKIE?.trim();
  if (inline) return inline;
  const line = fs.readFileSync(cookieFile, "utf8").trim();
  return line.includes("=") ? line : `vol_session=${line}`;
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    https.get(
      url,
      { headers: { Accept: "application/json", Cookie: readCookie() } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch {
            reject(new Error(`${pathname} ${res.statusCode}: ${body.slice(0, 120)}`));
          }
        });
      }
    ).on("error", reject);
  });
}

async function main() {
  const apis = [
    ["/api/pullback-signal-model?scope=live&full=1", "pullback-signal-model-live.json"],
    ["/api/pullback-signal-model?scope=paper&full=1", "pullback-signal-model.json"],
    ["/api/ai-exit-levels-model?scope=live&full=1", "ai-exit-levels-live.json"],
    ["/api/pullback-regime-model?scope=live&full=1", "pullback-regime-model-live.json"],
  ];
  for (const [api, file] of apis) {
    const { status, json } = await get(api);
    if (status !== 200) {
      console.error(`skip ${file} (${status})`);
      continue;
    }
    const model = json.model ?? json;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, file), `${JSON.stringify(model, null, 2)}\n`);
    console.log(`ok ${file}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
