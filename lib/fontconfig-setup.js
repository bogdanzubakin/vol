const fs = require("fs");
const os = require("os");
const path = require("path");

let configured = false;

function resolveBundledFontDir() {
  try {
    const pkgRoot = path.dirname(
      require.resolve("dejavu-fonts-ttf/package.json")
    );
    return path.join(pkgRoot, "ttf");
  } catch {
    return path.join(__dirname, "..", "assets", "fonts");
  }
}

function resolveFontPaths() {
  const dir = resolveBundledFontDir();
  return {
    sans: path.join(dir, "DejaVuSans.ttf"),
    sansBold: path.join(dir, "DejaVuSans-Bold.ttf"),
    mono: path.join(dir, "DejaVuSansMono.ttf"),
  };
}

function systemFontconfigFile() {
  for (const candidate of [
    "/opt/homebrew/etc/fonts/fonts.conf",
    "/usr/local/etc/fonts/fonts.conf",
    "/etc/fonts/fonts.conf",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function writeBundledFontconfig() {
  const fontDir = resolveBundledFontDir();
  if (!fs.existsSync(fontDir)) return null;

  const confRoot = path.join(os.tmpdir(), "vol-fontconfig");
  const cacheDir = path.join(confRoot, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const confFile = path.join(confRoot, "fonts.conf");
  const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;
  fs.writeFileSync(confFile, conf);
  return confFile;
}

/** Must run before the native \`canvas\` module is first loaded. */
function ensureFontconfig() {
  if (configured) return;
  configured = true;

  if (process.env.FONTCONFIG_FILE) return;

  const systemConf = systemFontconfigFile();
  if (systemConf) {
    process.env.FONTCONFIG_FILE = systemConf;
    return;
  }

  const bundledConf = writeBundledFontconfig();
  if (bundledConf) {
    process.env.FONTCONFIG_FILE = bundledConf;
  }
}

module.exports = {
  ensureFontconfig,
  resolveFontPaths,
  resolveBundledFontDir,
};
