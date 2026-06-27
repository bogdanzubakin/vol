/** Fixed display timezone: UTC+3 */
const OFFSET_MS = 3 * 60 * 60 * 1000;
const TZ_LABEL = "UTC+3";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function shifted(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n + OFFSET_MS);
}

function formatDateTime(ms) {
  const d = shifted(ms);
  if (!d) return "—";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

function formatTime(ms) {
  const d = shifted(ms);
  if (!d) return "—";
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function formatTimeShort(ms) {
  const d = shifted(ms);
  if (!d) return "—";
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function formatChartAxis(ms) {
  return formatDateTime(ms);
}

function formatIsoUtcPlus3(ms) {
  const d = shifted(ms);
  if (!d) return null;
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+03:00`
  );
}

/** datetime-local value interpreted as UTC+3 wall time → UTC epoch ms */
function datetimeLocalValueToUtcMs(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  return Date.UTC(y, mo, d, h, mi) - OFFSET_MS;
}

/** UTC epoch ms → datetime-local string in UTC+3 */
function utcMsToDatetimeLocalValue(ms) {
  const d = shifted(ms);
  if (!d) return "";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

/** Parse display ISO (UTC+3 wall time, with or without +03:00) → UTC epoch ms */
function parseDisplayIso(s) {
  if (s == null || s === "") return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const str = String(s).trim().replace(" ", "T");
  if (/[+-]\d{2}:?\d{2}$|Z$/i.test(str)) {
    const t = Date.parse(str);
    return Number.isFinite(t) ? t : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(str);
  if (!m) {
    const t = Date.parse(str);
    return Number.isFinite(t) ? t : null;
  }
  return (
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0)
    ) - OFFSET_MS
  );
}

function nowIsoUtcPlus3() {
  return formatIsoUtcPlus3(Date.now());
}

module.exports = {
  OFFSET_MS,
  TZ_LABEL,
  formatDateTime,
  formatTime,
  formatTimeShort,
  formatChartAxis,
  formatIsoUtcPlus3,
  datetimeLocalValueToUtcMs,
  utcMsToDatetimeLocalValue,
  parseDisplayIso,
  nowIsoUtcPlus3,
};
