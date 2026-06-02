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

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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

  const files = {
    uiSettings: fs.existsSync(dataPath("ui-settings.json")),
    results: fs.existsSync(dataPath("results.json")),
    historyComments: fs.existsSync(dataPath("positions-history-comments.json")),
    exchangeInfo: fs.existsSync(dataPath("futures-exchangeInfo.json")),
  };

  let klineCacheFiles = 0;
  try {
    const kdir = dataPath("klines");
    if (fs.existsSync(kdir)) {
      klineCacheFiles = fs.readdirSync(kdir).filter((n) => n.endsWith(".json")).length;
    }
  } catch {
    /* ignore */
  }

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
    files: { ...files, klineCacheFiles },
  };
}

module.exports = {
  resolveDataDir,
  dataPath,
  readJsonFile,
  writeJsonFile,
  migrateLegacyCache,
  getStorageInfo,
};
