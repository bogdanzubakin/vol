const fs = require("fs");
const path = require("path");

let dataDirMemo = null;

/**
 * Persistent app data root.
 * - Railway: attach a volume and set mount path (e.g. /app/data); uses RAILWAY_VOLUME_MOUNT_PATH.
 * - Override: DATA_DIR=/path/to/storage
 * - Local default: <project>/.cache
 */
function resolveDataDir() {
  if (dataDirMemo) return dataDirMemo;

  const explicit = process.env.DATA_DIR?.trim();
  const railwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  const railwayHints = [
    "/app/data",
    "/data",
    "/var/lib/railway/data",
  ];
  const hintedMount = railwayHints.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  const dir = path.resolve(
    explicit || railwayMount || hintedMount || path.join(process.cwd(), ".cache")
  );

  fs.mkdirSync(dir, { recursive: true });
  dataDirMemo = dir;
  return dir;
}

function dataPath(...segments) {
  return path.join(resolveDataDir(), ...segments);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const compact = options === true || options?.compact === true;
  const body = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, body);
}

/** Per-path write chain so concurrent async writes cannot finish out of order. */
const jsonWriteChains = new Map();

/** Non-blocking JSON write for runtime hot paths (keeps the disk syscall off the event loop). */
async function writeJsonFileAsync(filePath, data, options = {}) {
  const run = async () => {
    const compact = options === true || options?.compact === true;
    const body = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, body);
  };
  const prev = jsonWriteChains.get(filePath) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  jsonWriteChains.set(filePath, next);
  await next;
}

/** Copy legacy ./.cache into volume on first run (local / old deploys). */
function migrateLegacyCache() {
  const legacyRoot = path.join(process.cwd(), ".cache");
  const targetRoot = resolveDataDir();
  if (path.resolve(legacyRoot) === path.resolve(targetRoot)) return;

  const pairs = [
    [path.join(legacyRoot, "klines"), dataPath("klines")],
    [
      path.join(legacyRoot, "futures-exchangeInfo.json"),
      dataPath("futures-exchangeInfo.json"),
    ],
    [
      path.join(legacyRoot, "positions-history-comments.json"),
      dataPath("positions-history-comments.json"),
    ],
    [path.join(legacyRoot, "ui-settings.json"), dataPath("ui-settings.json")],
    [path.join(legacyRoot, "scanner-config.json"), dataPath("scanner-config.json")],
  ];

  for (const [from, to] of pairs) {
    try {
      if (!fs.existsSync(from)) continue;
      const stat = fs.statSync(from);
      if (stat.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) {
          const src = path.join(from, name);
          const dest = path.join(to, name);
          if (!fs.existsSync(dest)) {
            fs.cpSync(src, dest, { recursive: true });
          }
        }
      } else if (!fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    } catch {
      /* best effort */
    }
  }

  const legacyResults = path.join(process.cwd(), "public", "results.json");
  const targetResults = dataPath("results.json");
  try {
    if (fs.existsSync(legacyResults) && !fs.existsSync(targetResults)) {
      fs.copyFileSync(legacyResults, targetResults);
    }
  } catch {
    /* ignore */
  }
}

const RAILWAY_VOLUME_HINTS = ["/app/data", "/data", "/var/lib/railway/data"];

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fileEntry(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { path: filePath, exists: false, bytes: 0, files: 0 };
    }
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const dir = dirUsage(filePath);
      return { path: filePath, exists: true, ...dir };
    }
    return {
      path: filePath,
      exists: true,
      bytes: stat.size,
      files: 1,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { path: filePath, exists: false, bytes: 0, files: 0 };
  }
}

function dirUsage(dirPath) {
  let bytes = 0;
  let files = 0;
  let jsonFiles = 0;
  let liveFiles = 0;
  if (!fs.existsSync(dirPath)) {
    return { bytes: 0, files: 0, jsonFiles: 0, liveFiles: 0 };
  }
  for (const name of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const sub = dirUsage(full);
      bytes += sub.bytes;
      files += sub.files;
      jsonFiles += sub.jsonFiles;
      liveFiles += sub.liveFiles;
      continue;
    }
    if (!stat.isFile()) continue;
    bytes += stat.size;
    files++;
    if (name.endsWith(".meta.json") || name.endsWith(".live.meta.json")) continue;
    if (/\.live\.json(\.gz)?$/.test(name)) liveFiles++;
    else if (/\.json(\.gz)?$/.test(name)) jsonFiles++;
  }
  return { bytes, files, jsonFiles, liveFiles };
}

function getStorageInfo() {
  const dataDir = resolveDataDir();
  const resolved = path.resolve(dataDir);
  const explicit = process.env.DATA_DIR?.trim() || null;
  const railwayMount = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || null;
  const defaultLocal = path.resolve(path.join(process.cwd(), ".cache"));

  let source = "local_default";
  if (explicit) {
    source = "DATA_DIR";
  } else if (railwayMount && resolved === path.resolve(railwayMount)) {
    source = "RAILWAY_VOLUME_MOUNT_PATH";
  } else if (RAILWAY_VOLUME_HINTS.some((h) => resolved === path.resolve(h))) {
    source = "volume_hint";
  }

  const persistent =
    source === "DATA_DIR" ||
    source === "RAILWAY_VOLUME_MOUNT_PATH" ||
    source === "volume_hint";

  const activeKlineDir = dataPath("klines");
  const entries = {
    klines: fileEntry(activeKlineDir),
    results: fileEntry(dataPath("results.json")),
    uiSettings: fileEntry(dataPath("ui-settings.json")),
    scannerConfig: fileEntry(dataPath("scanner-config.json")),
    historyComments: fileEntry(dataPath("positions-history-comments.json")),
    exchangeInfo: fileEntry(dataPath("futures-exchangeInfo.json")),
    paperBot: fileEntry(dataPath("paper-bot-state.json")),
    liveBot: fileEntry(dataPath("live-bot-state.json")),
    paperBotReport: fileEntry(dataPath("paper-bot-report.json")),
    paperBotBacktest: fileEntry(dataPath("paper-bot-backtest-last.json")),
    paperBotBacktestKlines: fileEntry(dataPath("backtest-klines")),
    paperBotSnapshots: fileEntry(dataPath("paper-bot-snapshots")),
    paperBotBacktestSnapshots: fileEntry(dataPath("paper-bot-backtest-snapshots")),
    sqlite: fileEntry(dataPath("vol.db")),
  };

  const totalBytes = Object.values(entries).reduce((sum, e) => sum + (e.bytes || 0), 0);
  const usage = Object.fromEntries(
    Object.entries(entries).map(([key, e]) => [
      key,
      {
        ...e,
        bytesFormatted: formatBytes(e.bytes),
      },
    ])
  );

  return {
    dataDir: resolved,
    persistent,
    source,
    cwd: process.cwd(),
    defaultLocalCache: defaultLocal,
    isDefaultLocalPath: resolved === defaultLocal,
    env: {
      DATA_DIR: explicit,
      RAILWAY_VOLUME_MOUNT_PATH: railwayMount,
      PORT: process.env.PORT || null,
    },
    usage: {
      totalBytes,
      totalBytesFormatted: formatBytes(totalBytes),
      entries: usage,
    },
    files: {
      uiSettings: Boolean(entries.uiSettings?.exists),
      scannerConfig: Boolean(entries.scannerConfig?.exists),
      results: Boolean(entries.results?.exists),
      historyComments: Boolean(entries.historyComments?.exists),
      exchangeInfo: Boolean(entries.exchangeInfo?.exists),
      klineCacheFiles: entries.klines?.files ?? 0,
      klineJsonFiles: entries.klines?.jsonFiles ?? 0,
      klineLiveFiles: entries.klines?.liveFiles ?? 0,
    },
    paths: {
      activeKlineDir,
      uiSettings: dataPath("ui-settings.json"),
      scannerConfig: dataPath("scanner-config.json"),
      results: dataPath("results.json"),
      historyComments: dataPath("positions-history-comments.json"),
      exchangeInfo: dataPath("futures-exchangeInfo.json"),
    },
  };
}

/** Files/dirs kept when cleaning storage (settings, descriptions, bot transactions). */
const STORAGE_KEEP_FILES = new Set([
  "ui-settings.json",
  "scanner-config.json",
  "positions-history-comments.json",
  "paper-bot-state.json",
  "live-bot-state.json",
  "vol.db",
  "vol.db-wal",
  "vol.db-shm",
]);

/** Explicit cache / snapshots / derived data to remove. */
const STORAGE_DELETE_REL_PATHS = [
  "klines",
  "paper-bot-snapshots",
  "paper-bot-backtest-snapshots",
  "results.json",
  "futures-exchangeInfo.json",
  "futures-exchangeInfo-full.json",
  "paper-bot-backtest-last.json",
  "paper-bot-report.json",
  "backtest-klines",
];

function safePathUnderDataDir(dataDir, relPath) {
  const base = path.resolve(dataDir);
  const full = path.resolve(base, relPath);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Unsafe storage path: ${relPath}`);
  }
  return full;
}

function removePathRecursive(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return { path: targetPath, bytes: 0, removed: false };
  }
  const stat = fs.statSync(targetPath);
  const bytes = stat.isDirectory() ? dirUsage(targetPath).bytes : stat.size;
  fs.rmSync(targetPath, { recursive: true, force: true });
  return { path: targetPath, bytes, removed: true };
}

function cleanStorage() {
  const dataDir = resolveDataDir();
  const removed = [];
  let freedBytes = 0;

  for (const rel of STORAGE_DELETE_REL_PATHS) {
    const full = safePathUnderDataDir(dataDir, rel);
    const result = removePathRecursive(full);
    if (result.removed) {
      removed.push({
        name: rel,
        bytes: result.bytes,
        bytesFormatted: formatBytes(result.bytes),
      });
      freedBytes += result.bytes;
    }
  }

  return {
    ok: true,
    freedBytes,
    freedBytesFormatted: formatBytes(freedBytes),
    removed,
    kept: [...STORAGE_KEEP_FILES],
    storage: getStorageInfo(),
  };
}

module.exports = {
  resolveDataDir,
  dataPath,
  readJsonFile,
  writeJsonFile,
  writeJsonFileAsync,
  migrateLegacyCache,
  getStorageInfo,
  cleanStorage,
  formatBytes,
  STORAGE_KEEP_FILES,
  STORAGE_DELETE_REL_PATHS,
};
