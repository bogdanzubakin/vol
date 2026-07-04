/**
 * Ensure Node.js heap >= 8 GB for heavy backtests / training.
 * Child scripts inherit NODE_OPTIONS via nodeChildEnv() / execNode().
 */
const { execSync, spawnSync } = require("child_process");
const path = require("path");

const DEFAULT_MIN_HEAP_MB = 8192;

function minHeapMb() {
  const raw = process.env.VOL_NODE_HEAP_MB ?? process.env.NODE_HEAP_MB ?? DEFAULT_MIN_HEAP_MB;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MIN_HEAP_MB;
}

function currentHeapLimitMb() {
  try {
    const v8 = require("v8");
    return Math.floor(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
  } catch {
    return 0;
  }
}

function heapFlag(mb = minHeapMb()) {
  return `--max-old-space-size=${mb}`;
}

function mergeNodeOptions(existing, mb = minHeapMb()) {
  const flag = heapFlag(mb);
  const opts = String(existing || "").trim();
  if (/max-old-space-size=\d+/i.test(opts)) return opts;
  return [opts, flag].filter(Boolean).join(" ").trim();
}

/** Env for child `node` processes (execSync, spawn). */
function nodeChildEnv(extraEnv = {}) {
  const base = { ...process.env, ...extraEnv };
  base.NODE_OPTIONS = mergeNodeOptions(base.NODE_OPTIONS);
  return base;
}

function shellQuote(arg) {
  const s = String(arg);
  if (!/[\s"'$`\\]/.test(s)) return s;
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Run `node <script> [...args]` with extended heap. */
function execNode(scriptPath, args = [], options = {}) {
  const script = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.join(options.cwd || process.cwd(), scriptPath);
  const cmd = [process.execPath, heapFlag(), script, ...args].map(shellQuote).join(" ");
  return execSync(cmd, {
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
    env: nodeChildEnv(options.env),
  });
}

/**
 * Re-exec current script with --max-old-space-size if default heap is too small.
 * Call at the top of heavy CLI scripts (no-op when already sufficient).
 */
function ensureMinHeapMb(mb = minHeapMb()) {
  if (process.env.VOL_NODE_HEAP_ENSURED === "1") return;
  const limit = currentHeapLimitMb();
  if (limit >= mb - 64) return;

  const childArgs = [heapFlag(mb), ...process.execArgv, ...process.argv.slice(1)];
  const res = spawnSync(process.execPath, childArgs, {
    stdio: "inherit",
    env: { ...process.env, VOL_NODE_HEAP_ENSURED: "1" },
  });
  if (res.error) throw res.error;
  process.exit(res.status ?? 1);
}

module.exports = {
  DEFAULT_MIN_HEAP_MB,
  minHeapMb,
  currentHeapLimitMb,
  heapFlag,
  nodeChildEnv,
  execNode,
  ensureMinHeapMb,
};
