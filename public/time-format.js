/** Browser copy — keep in sync with lib/time-format.js */
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;
const TZ_LABEL = "UTC+3";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function tzShifted(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n + TZ_OFFSET_MS);
}

function formatDateTime(ms) {
  const d = tzShifted(ms);
  if (!d) return "—";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

function formatTime(ms) {
  const d = tzShifted(ms);
  if (!d) return "—";
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function formatTimeShort(ms) {
  const d = tzShifted(ms);
  if (!d) return "—";
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

function formatBarTime(ms) {
  return formatDateTime(ms);
}

function datetimeLocalValueToUtcMs(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value));
  if (!m) return null;
  return (
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) -
    TZ_OFFSET_MS
  );
}

function utcMsToDatetimeLocalValue(ms) {
  const d = tzShifted(ms);
  if (!d) return "";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

function parseDisplayIso(s) {
  if (s == null || s === "") return null;
  if (typeof s === "number") return s;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : null;
}
