const crypto = require("crypto");
const { loadEnvFile } = require("./load-env");

const TELEGRAM_API = "https://api.telegram.org";
const SESSION_COOKIE = "vol_session";
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;

function resolveAuthConfig(options = {}) {
  loadEnvFile();
  const kv = options.kv ?? new Map();
  const botToken =
    kv.get("telegram-token")?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim() ||
    "";
  const explicit =
    process.env.DASHBOARD_AUTH === "1" ||
    process.env.DASHBOARD_AUTH === "true";
  const disabled =
    process.env.DASHBOARD_AUTH === "0" ||
    process.env.DASHBOARD_AUTH === "false" ||
    options.flags?.has("no-auth");
  const enabled = Boolean(botToken) && !disabled && (explicit || Boolean(botToken));
  const secret =
    process.env.DASHBOARD_AUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    (botToken ? crypto.createHash("sha256").update(`vol-auth:${botToken}`).digest("hex") : "");

  const allowIdsRaw =
    process.env.TELEGRAM_AUTH_ALLOW_IDS?.trim() ||
    process.env.TELEGRAM_AUTH_USER_IDS?.trim() ||
    "";
  const allowUserIds = allowIdsRaw
    ? allowIdsRaw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    : null;

  return {
    enabled: enabled && Boolean(secret),
    botToken,
    secret,
    allowUserIds,
    sessionMs: SESSION_MS,
    publicUrl: (process.env.DASHBOARD_PUBLIC_URL || "").replace(/\/$/, ""),
  };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function signSession(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifySession(token, secret) {
  if (!token || !secret) return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const data = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload?.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCookieHeader(payload, secret, maxAgeSec) {
  const token = signSession(payload, secret);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (process.env.NODE_ENV === "production" || process.env.DASHBOARD_SECURE_COOKIE === "1") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseStartParam(text) {
  const m = /^\/start(?:@\w+)?\s+(.+)$/i.exec(String(text || "").trim());
  return m ? m[1].trim() : null;
}

function createTelegramAuth(options = {}) {
  const config = resolveAuthConfig(options);
  const pending = new Map();
  let botUsername = null;
  let updateOffset = 0;
  let pollerTimer = null;
  let pollerRunning = false;

  function publicBaseUrl(req) {
    if (config.publicUrl) return config.publicUrl;
    const host = req?.headers?.host;
    if (!host) return "";
    const proto =
      req.headers["x-forwarded-proto"] === "https" || process.env.PORT
        ? "https"
        : "http";
    return `${proto}://${host}`;
  }

  function isUserAllowed(telegramUserId) {
    if (!config.allowUserIds?.length) return true;
    return config.allowUserIds.includes(String(telegramUserId));
  }

  function getSession(req) {
    if (!config.enabled) return { ok: true, guest: true };
    const cookies = parseCookies(req);
    const payload = verifySession(cookies[SESSION_COOKIE], config.secret);
    if (!payload) return { ok: false };
    return { ok: true, user: payload };
  }

  function prunePending() {
    const now = Date.now();
    for (const [token, rec] of pending) {
      if (rec.expiresAt < now) pending.delete(token);
    }
  }

  function createLogin(req) {
    prunePending();
    const loginToken = `login_${crypto.randomBytes(16).toString("hex")}`;
    const now = Date.now();
    pending.set(loginToken, {
      createdAt: now,
      expiresAt: now + PENDING_MS,
      approved: false,
      telegramUserId: null,
      username: null,
      firstName: null,
    });
    const telegramUrl = botUsername
      ? `https://t.me/${botUsername}?start=${loginToken}`
      : null;
    return {
      loginToken,
      telegramUrl,
      expiresAt: now + PENDING_MS,
      pollMs: 2000,
    };
  }

  function loginStatus(loginToken) {
    prunePending();
    const rec = pending.get(loginToken);
    if (!rec) return { status: "expired" };
    if (rec.expiresAt < Date.now()) {
      pending.delete(loginToken);
      return { status: "expired" };
    }
    if (!rec.approved) return { status: "pending", expiresAt: rec.expiresAt };
    return {
      status: "approved",
      username: rec.username,
      firstName: rec.firstName,
    };
  }

  function completeLogin(loginToken) {
    const rec = pending.get(loginToken);
    if (!rec?.approved || !rec.telegramUserId) {
      return { ok: false, error: "Not approved yet" };
    }
    if (rec.expiresAt < Date.now()) {
      pending.delete(loginToken);
      return { ok: false, error: "Login expired" };
    }
    const exp = Date.now() + config.sessionMs;
    const payload = {
      telegramUserId: rec.telegramUserId,
      username: rec.username,
      firstName: rec.firstName,
      exp,
    };
    pending.delete(loginToken);
    return {
      ok: true,
      setCookie: sessionCookieHeader(
        payload,
        config.secret,
        Math.floor(config.sessionMs / 1000)
      ),
      user: payload,
    };
  }

  async function fetchBotUsername() {
    if (!config.botToken || botUsername) return botUsername;
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${config.botToken}/getMe`);
      const body = await res.json();
      if (body?.ok && body.result?.username) {
        botUsername = body.result.username;
      }
    } catch (e) {
      console.error(`Telegram auth getMe failed: ${e.message}`);
    }
    return botUsername;
  }

  async function sendTelegram(chatId, text) {
    const res = await fetch(`${TELEGRAM_API}/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      throw new Error(body.description || "sendMessage failed");
    }
  }

  async function handleTelegramMessage(msg) {
    const text = msg.text || "";
    const param = parseStartParam(text);
    if (!param?.startsWith("login_")) return;

    const loginToken = param;
    const rec = pending.get(loginToken);
    const user = msg.from;
    const chatId = msg.chat?.id;
    if (!user?.id || !chatId) return;

    if (!rec) {
      await sendTelegram(
        chatId,
        "This login link has expired. Open the dashboard and request a new link."
      );
      return;
    }

    if (!isUserAllowed(user.id)) {
      await sendTelegram(chatId, "You are not allowed to access this dashboard.");
      return;
    }

    rec.approved = true;
    rec.telegramUserId = user.id;
    rec.username = user.username || null;
    rec.firstName = user.first_name || null;
    rec.approvedAt = Date.now();

    await sendTelegram(
      chatId,
      "✅ You are signed in.\n\nReturn to the dashboard in your browser — it should unlock automatically."
    );
  }

  async function pollUpdatesOnce() {
    if (!config.enabled || !config.botToken) return;
    const url = `${TELEGRAM_API}/bot${config.botToken}/getUpdates?timeout=25&offset=${updateOffset}`;
    const res = await fetch(url);
    const body = await res.json();
    if (!body?.ok) {
      console.error(`Telegram auth getUpdates: ${body?.description || res.statusText}`);
      return;
    }
    for (const u of body.result ?? []) {
      updateOffset = Math.max(updateOffset, u.update_id + 1);
      const msg = u.message || u.edited_message;
      if (msg) await handleTelegramMessage(msg);
    }
  }

  async function pollerLoop() {
    if (pollerRunning || !config.enabled) return;
    pollerRunning = true;
    try {
      await pollUpdatesOnce();
    } catch (e) {
      console.error(`Telegram auth poll error: ${e.message}`);
    } finally {
      pollerRunning = false;
      pollerTimer = setTimeout(pollerLoop, 500);
    }
  }

  function startPoller() {
    if (!config.enabled) return;
    fetchBotUsername().then(() => {
      console.error(
        `Dashboard auth: Telegram login enabled (@${botUsername || "bot"}) · session 7 days`
      );
      pollerLoop();
    });
  }

  function stopPoller() {
    if (pollerTimer) clearTimeout(pollerTimer);
    pollerTimer = null;
  }

  function isPublicPath(pathname) {
    if (pathname === "/health") return true;
    if (pathname.startsWith("/api/auth/")) return true;
    if (pathname === "/favicon.svg") return true;
    if (pathname === "/time-format.js") return true;
    return false;
  }

  function handleAuthRoutes(req, res, url) {
    if (!config.enabled) {
      if (url.pathname === "/api/auth/me") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled: false, authenticated: true }));
        return true;
      }
      if (url.pathname === "/api/auth/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled: false, authenticated: true }));
        return true;
      }
      return false;
    }

    if (url.pathname === "/api/auth/config") {
      const session = getSession(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          enabled: true,
          authenticated: session.ok,
          botUsername,
        })
      );
      return true;
    }

    if (url.pathname === "/api/auth/me") {
      const session = getSession(req);
      if (!session.ok) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ enabled: true, authenticated: false }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          enabled: true,
          authenticated: true,
          user: session.user,
        })
      );
      return true;
    }

    if (url.pathname === "/api/auth/start" && req.method === "POST") {
      fetchBotUsername().then(() => {
        const data = createLogin(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      });
      return true;
    }

    if (url.pathname === "/api/auth/status") {
      const token = url.searchParams.get("token") || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(loginStatus(token)));
      return true;
    }

    if (url.pathname === "/api/auth/complete" && req.method === "POST") {
      readJsonBody(req)
        .then((body) => {
          const result = completeLogin(body.loginToken || "");
          if (!result.ok) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": result.setCookie,
          });
          res.end(JSON.stringify({ ok: true, user: result.user }));
        })
        .catch((e) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        });
      return true;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": clearSessionCookieHeader(),
      });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    return false;
  }

  function requireAuth(req, res) {
    if (!config.enabled) return true;
    const session = getSession(req);
    if (session.ok) return true;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized", loginRequired: true }));
    return false;
  }

  return {
    config,
    getSession,
    requireAuth,
    isPublicPath,
    handleAuthRoutes,
    startPoller,
    stopPoller,
    publicBaseUrl,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

module.exports = {
  createTelegramAuth,
  resolveAuthConfig,
  SESSION_COOKIE,
  SESSION_MS,
};
