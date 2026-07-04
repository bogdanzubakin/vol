const { formatIsoUtcPlus3 } = require("./time-format");

const SOURCE_LABELS = {
  bootstrap: "Default bootstrap",
  "train:backtest": "Backtest trades",
  "train:cached-backtest": "30-day cache backtest",
  "train:cached-backtest:live": "30-day cache (copied to live)",
  "train-best-eval": "Best-settings pipeline",
  "train-best-eval:paper": "Best-settings pipeline (paper)",
  "train-best-eval:live": "Best-settings pipeline (live)",
  "sync:paper-train-best-eval": "Copied from paper (latest train)",
  "import:local:paper": "Imported from local paper",
  "import:local:live": "Imported from local live",
};

function humanizeSource(source) {
  if (!source) return SOURCE_LABELS.bootstrap;
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (source.startsWith("best-training:")) {
    return `SFP compare winner (${source.slice("best-training:".length)})`;
  }
  if (source.startsWith("train-best-eval:")) {
    const scope = source.slice("train-best-eval:".length);
    return scope ? `Best-settings train (${scope})` : SOURCE_LABELS["train-best-eval"];
  }
  if (source.startsWith("compare:")) return "SFP BTC compare sweep";
  if (source.startsWith("optimize:")) {
    const tail = source.slice("optimize:".length).replace(/-/g, " ");
    return `Optimize · ${tail}`;
  }
  if (source.startsWith("import:")) return "Imported snapshot";
  if (source.startsWith("train:")) {
    return source
      .slice("train:".length)
      .replace(/:/g, " · ")
      .replace(/-/g, " ");
  }
  return source.replace(/:/g, " · ");
}

function formatTrainedAt(ms) {
  if (ms == null || ms === "") return null;
  if (typeof ms === "string" && /^\d{4}-\d{2}-\d{2}/.test(ms)) return ms;
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  return formatIsoUtcPlus3(n);
}

/** In-sample MAE in % — hide diverged / missing fits. */
function sanitizeMaePct(mae, { max = 50 } = {}) {
  const n = Number(mae);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return +n.toFixed(2);
}

function formatMaePctLabel(mae, { max = 50 } = {}) {
  const v = sanitizeMaePct(mae, { max });
  return v != null ? `±${v}%` : "—";
}

function scopeLabel(scope) {
  return scope === "live" ? "Live" : "Paper";
}

function formatFitBucket(label, slMae, tpMae, samples) {
  const n = samples != null ? Number(samples) : null;
  const nPart = Number.isFinite(n) && n > 0 ? ` · n=${n}` : "";
  if (slMae == null && tpMae == null) return `${label}: no fit${nPart}`;
  return `${label}: SL ${formatMaePctLabel(slMae)} · TP ${formatMaePctLabel(tpMae)}${nPart}`;
}

function bucketsMirror(bull = {}, bear = {}) {
  const bSl = sanitizeMaePct(bull.slMae);
  const bTp = sanitizeMaePct(bull.tpMae);
  const rSl = sanitizeMaePct(bear.slMae);
  const rTp = sanitizeMaePct(bear.tpMae);
  if (bSl != null && bSl === rSl && bTp === rTp) return true;
  if (!Number.isFinite(Number(bear.slMae)) || Number(bear.slMae) > 50) return true;
  return (bull.samples ?? 0) > 0 && bull.samples === bear.samples && rSl == null;
}

function formatExitLevelsStatus({ scope, source, trainedAt, bull = {}, bear = {} }) {
  const parts = [
    `${scopeLabel(scope)} SL/TP model`,
    humanizeSource(source),
  ];
  const trained = formatTrainedAt(trainedAt);
  if (trained) parts.push(`trained ${trained}`);

  const mirror = bucketsMirror(bull, bear);
  if (mirror) {
    parts.push(formatFitBucket("long & short", bull.slMae, bull.tpMae, bull.samples));
    if ((bear.samples ?? 0) > 0 && (bull.samples ?? 0) !== bear.samples) {
      parts.push("(short uses long fit — few short samples)");
    }
  } else {
    parts.push(formatFitBucket("long", bull.slMae, bull.tpMae, bull.samples));
    parts.push(formatFitBucket("short", bear.slMae, bear.tpMae, bear.samples));
  }
  return parts.join(" · ");
}

function formatRegimeStatus({
  scope,
  source,
  trainedAt,
  bullMetrics,
  bearMetrics,
  version,
  modelLabel = "regime",
  bullThreshold,
  bearThreshold,
  bullHeadActive,
  bearHeadActive,
}) {
  const parts = [
    `${scopeLabel(scope)} ${modelLabel} v${version ?? 2}`,
    humanizeSource(source),
  ];
  const trained = formatTrainedAt(trainedAt);
  if (trained) parts.push(`trained ${trained}`);
  if (bullThreshold != null && bullHeadActive !== false) {
    parts.push(`long th ≥${bullThreshold}`);
  }
  if (bearThreshold != null && bearHeadActive !== false) {
    parts.push(`short th ≥${bearThreshold}`);
  }
  const bAcc = bullMetrics?.accuracy;
  const rAcc = bearMetrics?.accuracy;
  const bullActive =
    bullHeadActive != null
      ? bullHeadActive
      : (bullMetrics?.samples ?? 0) >= 30;
  const bearActive =
    bearHeadActive != null
      ? bearHeadActive
      : (bearMetrics?.samples ?? 0) >= 30;
  if (!bullActive) {
    parts.push("long filter off");
  } else if (bAcc != null) {
    parts.push(
      `long acc ${(bAcc * 100).toFixed(1)}% (n=${bullMetrics?.samples ?? "—"})`
    );
  }
  if (!bearActive) {
    parts.push("short filter off");
  } else if (rAcc != null) {
    parts.push(
      `short acc ${(rAcc * 100).toFixed(1)}% (n=${bearMetrics?.samples ?? "—"})`
    );
  }
  return parts.join(" · ");
}

function formatEarlyExitStatus({
  scope,
  source,
  trainedAt,
  hardThreshold,
  softThreshold,
  hardMetrics,
  softMetrics,
  version,
}) {
  const parts = [
    `${scopeLabel(scope)} early-exit v${version ?? 2}`,
    humanizeSource(source),
  ];
  const trained = formatTrainedAt(trainedAt);
  if (trained) parts.push(`trained ${trained}`);
  if (hardThreshold != null) parts.push(`hard ≥${hardThreshold}`);
  if (softThreshold != null) parts.push(`soft ≥${softThreshold}`);
  if (hardMetrics?.accuracy != null) {
    parts.push(
      `hard acc ${(hardMetrics.accuracy * 100).toFixed(1)}% (n=${hardMetrics.samples ?? "—"})`
    );
  }
  if (softMetrics?.accuracy != null) {
    parts.push(
      `soft acc ${(softMetrics.accuracy * 100).toFixed(1)}% (n=${softMetrics.samples ?? "—"})`
    );
  }
  return parts.join(" · ");
}

module.exports = {
  humanizeSource,
  formatTrainedAt,
  sanitizeMaePct,
  formatMaePctLabel,
  formatExitLevelsStatus,
  formatRegimeStatus,
  formatEarlyExitStatus,
  scopeLabel,
};
