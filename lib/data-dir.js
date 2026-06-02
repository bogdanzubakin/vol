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
  const dir = path.resolve(
    explicit || railwayMount || path.join(process.cwd(), ".cache")
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

module.exports = {
  resolveDataDir,
  dataPath,
  readJsonFile,
  writeJsonFile,
  migrateLegacyCache,
};
