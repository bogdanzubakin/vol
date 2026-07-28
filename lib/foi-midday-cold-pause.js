/**
 * FOI mid-day cold pause — block/half new FOI opens when recent closes are cold.
 * Causal: only FOI closes with closedAt < asOf.
 *
 * Research pick (offline + OOS soft PASS):
 *   2h rolling WR < 25% OR same-UTC-day PnL < −$1.5 → block
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const FOI_MIDDAY_COLD_PAUSE_DEFAULTS = {
  foiMiddayColdPauseEnabled: false,
  /** Rolling lookback hours for WR. */
  foiMiddayColdPauseWindowHours: 2,
  /** Min FOI closes in the rolling window to trust WR. */
  foiMiddayColdPauseMinSamples: 6,
  /** Cold when rolling WR < this (0–1). */
  foiMiddayColdPauseMaxWr: 0.25,
  /** Or when same-UTC-day closed PnL < this. */
  foiMiddayColdPauseMaxDayPnl: -1.5,
  /** When true, both roll WR and day PnL must be cold. */
  foiMiddayColdPauseRequireBoth: false,
  /** cold: half | block | allow */
  foiMiddayColdPausePolicy: "block",
};

function normalizeFoiMiddayColdPauseConfig(raw = {}) {
  const d = FOI_MIDDAY_COLD_PAUSE_DEFAULTS;
  const policy = String(
    raw.foiMiddayColdPausePolicy ?? d.foiMiddayColdPausePolicy
  ).toLowerCase();
  return {
    foiMiddayColdPauseEnabled: Boolean(
      raw.foiMiddayColdPauseEnabled ?? d.foiMiddayColdPauseEnabled
    ),
    foiMiddayColdPauseWindowHours: clamp(
      Math.round(
        num(raw.foiMiddayColdPauseWindowHours, d.foiMiddayColdPauseWindowHours)
      ),
      1,
      24
    ),
    foiMiddayColdPauseMinSamples: clamp(
      Math.round(
        num(raw.foiMiddayColdPauseMinSamples, d.foiMiddayColdPauseMinSamples)
      ),
      1,
      500
    ),
    foiMiddayColdPauseMaxWr: clamp(
      num(raw.foiMiddayColdPauseMaxWr, d.foiMiddayColdPauseMaxWr),
      0,
      1
    ),
    foiMiddayColdPauseMaxDayPnl: num(
      raw.foiMiddayColdPauseMaxDayPnl,
      d.foiMiddayColdPauseMaxDayPnl
    ),
    foiMiddayColdPauseRequireBoth: Boolean(
      raw.foiMiddayColdPauseRequireBoth ?? d.foiMiddayColdPauseRequireBoth
    ),
    foiMiddayColdPausePolicy:
      policy === "half" || policy === "allow" ? policy : "block",
  };
}

function dayKeyUtc(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function isFoiSignalKind(signalKind) {
  return signalKind === "foi" || signalKind === "foi_bear";
}

function wrOf(rows) {
  if (!rows.length) return null;
  return rows.filter((r) => r.win).length / rows.length;
}

function createFoiMiddayColdPauseTracker(options = {}) {
  const maxKeep = clamp(Math.round(num(options.maxKeep, 2000)), 100, 20000);
  /** @type {{ closedAt: number, day: string, pnl: number, win: boolean }[]} */
  const closes = [];

  function recordClosedTrade(trade) {
    if (!trade || !isFoiSignalKind(trade.signalKind)) return;
    const closedAt = Number(trade.closedAt);
    const pnl = Number(trade.pnl);
    const day = dayKeyUtc(closedAt);
    if (!day || !Number.isFinite(closedAt)) return;
    closes.push({
      closedAt,
      day,
      pnl: Number.isFinite(pnl) ? pnl : 0,
      win: Number.isFinite(pnl) && pnl > 0,
    });
    if (closes.length > maxKeep) closes.splice(0, closes.length - maxKeep);
  }

  /**
   * @returns {{ pass: boolean, sizeScale: number, detail: string, cold: boolean, rollWr: number|null, dayPnl: number, rollN: number, dayN: number }}
   */
  function check(cfgInput, asOfMs = Date.now()) {
    const cfg = normalizeFoiMiddayColdPauseConfig(cfgInput ?? {});
    if (!cfg.foiMiddayColdPauseEnabled) {
      return {
        pass: true,
        sizeScale: 1,
        detail: "disabled",
        cold: false,
        rollWr: null,
        dayPnl: 0,
        rollN: 0,
        dayN: 0,
      };
    }
    if (!Number.isFinite(asOfMs)) {
      return {
        pass: true,
        sizeScale: 1,
        detail: "bad asOf",
        cold: false,
        rollWr: null,
        dayPnl: 0,
        rollN: 0,
        dayN: 0,
      };
    }

    const openDay = dayKeyUtc(asOfMs);
    const cut = asOfMs - cfg.foiMiddayColdPauseWindowHours * 3_600_000;
    const prior = [];
    for (const c of closes) {
      if (c.closedAt >= asOfMs) continue;
      prior.push(c);
    }

    const roll = prior.filter((c) => c.closedAt >= cut);
    const dayCloses = prior.filter((c) => c.day === openDay);
    const rollWr = wrOf(roll);
    const dayPnl = dayCloses.reduce((s, c) => s + c.pnl, 0);
    const dayMin = Math.min(4, cfg.foiMiddayColdPauseMinSamples);
    const coldRoll =
      roll.length >= cfg.foiMiddayColdPauseMinSamples &&
      rollWr != null &&
      rollWr < cfg.foiMiddayColdPauseMaxWr;
    const coldDay =
      dayCloses.length >= dayMin && dayPnl < cfg.foiMiddayColdPauseMaxDayPnl;
    const cold = cfg.foiMiddayColdPauseRequireBoth
      ? coldRoll && coldDay
      : coldRoll || coldDay;

    if (!cold) {
      return {
        pass: true,
        sizeScale: 1,
        detail: `ok rollWR=${rollWr == null ? "n/a" : (rollWr * 100).toFixed(0)}% dayPnL=${dayPnl.toFixed(2)}`,
        cold: false,
        rollWr,
        dayPnl,
        rollN: roll.length,
        dayN: dayCloses.length,
      };
    }

    const why = [
      coldRoll
        ? `roll ${cfg.foiMiddayColdPauseWindowHours}h WR ${(rollWr * 100).toFixed(0)}%<${(cfg.foiMiddayColdPauseMaxWr * 100).toFixed(0)}% n=${roll.length}`
        : null,
      coldDay
        ? `dayPnL ${dayPnl.toFixed(2)}<${cfg.foiMiddayColdPauseMaxDayPnl} n=${dayCloses.length}`
        : null,
    ]
      .filter(Boolean)
      .join(" OR ");

    if (cfg.foiMiddayColdPausePolicy === "allow") {
      return {
        pass: true,
        sizeScale: 1,
        detail: `cold allow (${why})`,
        cold: true,
        rollWr,
        dayPnl,
        rollN: roll.length,
        dayN: dayCloses.length,
      };
    }
    if (cfg.foiMiddayColdPausePolicy === "half") {
      return {
        pass: true,
        sizeScale: 0.5,
        detail: `cold half (${why})`,
        cold: true,
        rollWr,
        dayPnl,
        rollN: roll.length,
        dayN: dayCloses.length,
      };
    }
    return {
      pass: false,
      sizeScale: 0,
      detail: `cold block (${why})`,
      cold: true,
      rollWr,
      dayPnl,
      rollN: roll.length,
      dayN: dayCloses.length,
    };
  }

  return {
    recordClosedTrade,
    check,
    get size() {
      return closes.length;
    },
  };
}

module.exports = {
  FOI_MIDDAY_COLD_PAUSE_DEFAULTS,
  normalizeFoiMiddayColdPauseConfig,
  createFoiMiddayColdPauseTracker,
  dayKeyUtc,
};
