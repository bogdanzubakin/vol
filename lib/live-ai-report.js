const { formatIsoUtcPlus3 } = require("./time-format");
const { isAiEarlyExitReason } = require("./early-exit-model");
const { collectAiTrainingTrades } = require("./ai-training-trades");

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pct(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return +(n * 100).toFixed(1);
}

function summarizeTrades(trades = []) {
  const list = trades ?? [];
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of list) {
    const p = num(t.pnl, 0);
    pnl += p;
    if (p > 0) wins++;
    else if (p < 0) losses++;
  }
  return {
    count: list.length,
    pnl: +pnl.toFixed(4),
    wins,
    losses,
    breakeven: list.length - wins - losses,
    avgPnl: list.length ? +(pnl / list.length).toFixed(4) : null,
    winRate: list.length ? +((wins / list.length) * 100).toFixed(1) : null,
  };
}

function groupExitReasons(trades = []) {
  const out = {};
  for (const t of trades ?? []) {
    const key = String(t.exitReason || "unknown");
    const row = out[key] ?? { exitReason: key, count: 0, pnl: 0 };
    row.count++;
    row.pnl += num(t.pnl, 0);
    out[key] = row;
  }
  return Object.values(out)
    .map((r) => ({ ...r, pnl: +r.pnl.toFixed(4) }))
    .sort((a, b) => b.count - a.count);
}

function isSfpTrade(t) {
  const k = t?.signalKind;
  return k === "sfp" || k === "sfp_bear";
}

function isLevelBreakTrade(t) {
  const k = t?.signalKind;
  return k === "level_break" || k === "level_break_bear";
}

function modelCard(status = {}, monitor = {}, enabledKey, cfg = {}) {
  const enabled = Boolean(cfg[enabledKey]);
  const hard = status.hardMetrics ?? status.metrics ?? {};
  const soft = status.softMetrics ?? {};
  const bull = status.bullMetrics ?? status.metrics ?? {};
  const bear = status.bearMetrics ?? {};
  return {
    enabled,
    source: status.source ?? null,
    trainedAt: status.trainedAt ?? null,
    version: status.version ?? null,
    path: status.path ?? null,
    training: status.training?.running
      ? {
          running: true,
          phase: status.training.progress?.phase ?? null,
          message: status.training.progress?.message ?? null,
        }
      : status.training?.error
        ? { running: false, error: status.training.error }
        : null,
    metrics:
      status.signal === "sfp"
        ? {
            hardSamples: hard.samples ?? null,
            hardAccuracy: hard.accuracy ?? null,
            softSamples: soft.samples ?? null,
            softAccuracy: soft.accuracy ?? null,
            hardThreshold: status.hardThreshold ?? status.threshold ?? null,
            softThreshold: status.softThreshold ?? null,
          }
        : {
            bullSamples: bull.samples ?? null,
            bullAccuracy: bull.accuracy ?? null,
            bearSamples: bear.samples ?? null,
            bearAccuracy: bear.accuracy ?? null,
            bullThreshold:
              status.bullThreshold ?? monitor.bullThreshold ?? null,
            bearThreshold:
              status.bearThreshold ?? monitor.bearThreshold ?? null,
          },
    monitor: {
      enabled: Boolean(monitor.enabled),
      tracked: monitor.tracked ?? 0,
      badCount: monitor.badCount ?? 0,
      worst: (monitor.worst ?? []).slice(0, 12),
      updatedAt: monitor.updatedAt ?? null,
    },
  };
}

function countLogMatches(log = [], predicate) {
  let n = 0;
  for (const row of log ?? []) {
    if (predicate(row)) n++;
  }
  return n;
}

function recentLogMatches(log = [], predicate, limit = 20) {
  return (log ?? []).filter(predicate).slice(0, limit).map((row) => ({
    at: row.atIso ?? (row.at ? formatIsoUtcPlus3(row.at) : null),
    type: row.type,
    symbol: row.symbol,
    detail: row.detail,
  }));
}

function buildLiveAiReport(deps = {}) {
  const cfg = deps.config ?? {};
  const closedTrades = deps.closedTrades ?? [];
  const log = deps.log ?? [];
  const backtest = deps.backtest ?? null;

  const aiExits = closedTrades.filter((t) => isAiEarlyExitReason(t.exitReason));
  const aiHardExits = closedTrades.filter((t) => t.exitReason === "ai_early_exit_hard");
  const aiSoftExits = closedTrades.filter((t) => t.exitReason === "ai_early_exit_soft");
  const sfpTrades = closedTrades.filter(isSfpTrade);
  const levelBreakTrades = closedTrades.filter(isLevelBreakTrade);

  const sfpRegimeSkip = (row) =>
    row.type === "SKIP" &&
    String(row.detail || "").includes("SFP regime AI");
  const levelBreakRegimeSkip = (row) =>
    row.type === "SKIP" &&
    String(row.detail || "").includes("Level-break regime AI");
  const aiClose = (row) =>
    row.type === "CLOSE" &&
    String(row.detail || "").startsWith("ai_early_exit");

  const trainingDeps = {
    backtestTrades: backtest?.closedTrades,
    paperTrades: [],
    liveTrades: closedTrades,
  };
  const trainSfpLive = collectAiTrainingTrades("auto", "live", trainingDeps, (list) =>
    (list ?? []).filter(isSfpTrade)
  );
  const trainLbLive = collectAiTrainingTrades("auto", "live", trainingDeps, (list) =>
    (list ?? []).filter(isLevelBreakTrade)
  );
  const trainSfpBacktest = collectAiTrainingTrades("backtest", "live", trainingDeps, (list) =>
    (list ?? []).filter(isSfpTrade)
  );

  return {
    ok: true,
    generatedAt: formatIsoUtcPlus3(Date.now()),
    config: {
      aiEarlyExitEnabled: Boolean(cfg.aiEarlyExitEnabled),
      aiSfpRegimeEnabled: Boolean(cfg.aiSfpRegimeEnabled),
      aiLevelBreakRegimeEnabled: Boolean(cfg.aiLevelBreakRegimeEnabled),
      armed: Boolean(cfg.armed),
    },
    trainingData: {
      backtestAvailable: Boolean(backtest?.closedTrades?.length),
      backtestFinishedAt: backtest?.finishedAt ?? null,
      backtestClosedTrades: backtest?.closedTrades?.length ?? 0,
      backtestSfpTrades: trainSfpBacktest.length,
      liveClosedTrades: closedTrades.length,
      liveSfpTrades: sfpTrades.length,
      liveLevelBreakTrades: levelBreakTrades.length,
      mergedForLiveTraining: {
        sfp: trainSfpLive.length,
        levelBreak: trainLbLive.length,
      },
    },
    models: {
      earlyExit: modelCard(
        deps.earlyExitStatus ?? {},
        {},
        "aiEarlyExitEnabled",
        cfg
      ),
      sfpRegime: modelCard(
        deps.sfpRegimeStatus ?? {},
        deps.sfpRegimeMonitor ?? {},
        "aiSfpRegimeEnabled",
        cfg
      ),
      levelBreakRegime: modelCard(
        deps.levelBreakRegimeStatus ?? {},
        deps.levelBreakRegimeMonitor ?? {},
        "aiLevelBreakRegimeEnabled",
        cfg
      ),
    },
    impact: {
      allClosed: summarizeTrades(closedTrades),
      sfpClosed: summarizeTrades(sfpTrades),
      levelBreakClosed: summarizeTrades(levelBreakTrades),
      aiEarlyExit: {
        all: summarizeTrades(aiExits),
        hard: summarizeTrades(aiHardExits),
        soft: summarizeTrades(aiSoftExits),
      },
      regimeSkips: {
        sfp: countLogMatches(log, sfpRegimeSkip),
        levelBreak: countLogMatches(log, levelBreakRegimeSkip),
      },
      exitReasons: groupExitReasons(closedTrades),
    },
    recentEvents: {
      sfpRegimeSkips: recentLogMatches(log, sfpRegimeSkip, 15),
      levelBreakRegimeSkips: recentLogMatches(log, levelBreakRegimeSkip, 15),
      aiEarlyExits: recentLogMatches(log, aiClose, 15),
    },
  };
}

module.exports = {
  buildLiveAiReport,
  summarizeTrades,
};
