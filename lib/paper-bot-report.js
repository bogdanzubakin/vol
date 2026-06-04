const { dataPath, readJsonFile, writeJsonFile } = require("./data-dir");
const { exitReasonLabel } = require("./paper-bot");
const { formatDateTime, TZ_LABEL, OFFSET_MS } = require("./time-format");

const SNAPSHOT_FILE = () => dataPath("paper-bot-report.json");

function pad2(n) {
  return String(n).padStart(2, "0");
}

function shiftedNow() {
  return new Date(Date.now() + OFFSET_MS);
}

function todayKeyUtc3(ms = Date.now()) {
  const d = new Date(ms + OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `$${v.toFixed(2)}`;
}

function fmtUsdDelta(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || Math.abs(v) < 0.005) return "±$0.00";
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function loadSnapshot() {
  const raw = readJsonFile(SNAPSHOT_FILE(), null);
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

function saveSnapshot(snapshot) {
  writeJsonFile(SNAPSHOT_FILE(), snapshot);
}

function msUntilNextWallTime(hour, minute) {
  const now = Date.now();
  const d = shiftedNow();
  let target =
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      hour,
      minute,
      0,
      0
    ) - OFFSET_MS;
  if (target <= now) target += 24 * 60 * 60 * 1000;
  return target - now;
}

function formatOpenLine(p) {
  const move = p.movePctFromEntry ?? 0;
  const moveSign = move >= 0 ? "+" : "";
  const unr = p.unrealizedPnl != null ? fmtUsdDelta(p.unrealizedPnl) : "—";
  const kind = p.signalKind === "fast-corridor" ? "FC" : "SPIKE";
  const entry =
    p.addCount > 0
      ? `${Number(p.initialEntryPrice).toFixed(4)}→${Number(p.entryPrice).toFixed(4)}`
      : Number(p.entryPrice).toFixed(4);
  const last = Number(p.lastPrice).toFixed(4);
  return (
    `• ${p.symbol} ${kind} ${moveSign}${move.toFixed(1)}% · ` +
    `entry ${entry} · last ${last} · uPnL ${unr}` +
    (p.addCount ? ` · +${p.addCount} add` : "")
  );
}

function formatClosedLine(t) {
  const pnl = fmtUsdDelta(t.pnl);
  const reason = exitReasonLabel(t.exitReason);
  return `• ${t.symbol} ${reason} ${pnl} @ ${Number(t.exitPrice).toFixed(4)}`;
}

/**
 * @param {ReturnType<import('./paper-bot').createPaperBot>['getPublicState']>} state
 * @param {object|null} prev - previous morning snapshot
 */
function formatPaperBotReport(state, prev) {
  const s = state.summary ?? {};
  const deposit = s.deposit ?? s.balance ?? 0;
  const equity = s.equity ?? deposit;
  const lines = [
    "Paper bot — morning report",
    `${formatDateTime(Date.now())} ${TZ_LABEL}`,
    "",
    `Deposit (free): ${fmtUsd(deposit)}`,
    `In positions: ${fmtUsd(s.lockedMargin ?? 0)}`,
    `Equity: ${fmtUsd(equity)}`,
    `Unrealized: ${fmtUsdDelta(s.unrealizedPnl ?? 0)}`,
    `Realized (total): ${fmtUsdDelta(s.realizedPnl ?? 0)}`,
    `Total PnL vs $${s.initialDeposit ?? 1000}: ${fmtUsdDelta(s.totalPnl ?? 0)}`,
    `Open: ${s.openCount ?? 0} · Closed (all): ${s.closedCount ?? 0}`,
  ];

  if (prev?.reportedAt) {
    lines.push(
      "",
      "Since last report:",
      `  Deposit ${fmtUsdDelta(deposit - (prev.deposit ?? 0))}`,
      `  Equity ${fmtUsdDelta(equity - (prev.equity ?? 0))}`,
      `  (${formatDateTime(prev.reportedAt)} ${TZ_LABEL})`
    );
  } else {
    lines.push("", "Since last report: (first report — no prior snapshot)");
  }

  const sinceMs = prev?.reportedAt ?? 0;
  const closedRecent = (state.closedTrades ?? []).filter(
    (t) => (t.closedAt ?? 0) > sinceMs
  );
  if (closedRecent.length) {
    lines.push("", `Closed since last report (${closedRecent.length}):`);
    for (const t of closedRecent.slice(0, 8)) {
      lines.push(formatClosedLine(t));
    }
    if (closedRecent.length > 8) {
      lines.push(`… +${closedRecent.length - 8} more`);
    }
  }

  const open = state.openPositions ?? [];
  if (open.length) {
    lines.push("", `Open positions (${open.length}):`);
    for (const p of open.slice(0, 15)) {
      lines.push(formatOpenLine(p));
    }
    if (open.length > 15) {
      lines.push(`… +${open.length - 15} more`);
    }
  } else {
    lines.push("", "Open positions: none");
  }

  const botOn = state.config?.enabled ? "ON" : "OFF";
  lines.push("", `Bot: ${botOn}`);

  let text = lines.join("\n");
  if (text.length > 4000) {
    text = `${text.slice(0, 3990)}\n…(truncated)`;
  }
  return text;
}

function startPaperBotMorningReports(options) {
  const {
    enabled = true,
    hour = 8,
    minute = 0,
    getReportState,
    sendText,
    onSent,
    onError,
  } = options;

  if (!enabled || typeof getReportState !== "function" || typeof sendText !== "function") {
    return () => {};
  }

  let timer = null;
  let sending = false;

  async function sendMorningReport(force = false) {
    if (sending) return;
    const day = todayKeyUtc3();
    const snap = loadSnapshot();
    if (!force && snap?.reportDay === day) return;

    sending = true;
    try {
      const state = getReportState();
      const text = formatPaperBotReport(state, snap);
      await sendText(text);
      const summary = state.summary ?? {};
      saveSnapshot({
        reportDay: day,
        reportedAt: Date.now(),
        deposit: summary.deposit ?? summary.balance ?? 0,
        equity: summary.equity ?? 0,
        totalPnl: summary.totalPnl ?? 0,
        openCount: summary.openCount ?? 0,
      });
      console.error(`Paper bot morning report sent (${day} ${TZ_LABEL})`);
      onSent?.(state);
    } catch (e) {
      console.error(`Paper bot morning report failed: ${e.message}`);
      onError?.(e);
    } finally {
      sending = false;
    }
  }

  function arm() {
    if (timer) clearTimeout(timer);
    const delay = msUntilNextWallTime(hour, minute);
    const fireAt = formatDateTime(Date.now() + delay);
    console.error(
      `Paper bot Telegram report scheduled ${pad2(hour)}:${pad2(minute)} ${TZ_LABEL} (next ${fireAt})`
    );
    timer = setTimeout(async () => {
      await sendMorningReport(false);
      arm();
    }, delay);
  }

  // If we restarted after today's report time and haven't sent yet, send once
  const snap = loadSnapshot();
  const day = todayKeyUtc3();
  const d = shiftedNow();
  const pastReportTime =
    d.getUTCHours() > hour ||
    (d.getUTCHours() === hour && d.getUTCMinutes() >= minute);
  if (pastReportTime && snap?.reportDay !== day) {
    setTimeout(() => sendMorningReport(false), 5000);
  }

  arm();

  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

module.exports = {
  formatPaperBotReport,
  startPaperBotMorningReports,
  loadSnapshot,
  todayKeyUtc3,
};
