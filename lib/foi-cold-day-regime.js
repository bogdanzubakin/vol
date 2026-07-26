/**
 * FOI cold-day regime — scale/block new FOI opens from recent calendar-day book.
 * Uses only FOI closes with closedAt < asOf (causal).
 */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const FOI_COLD_DAY_DEFAULTS = {
  foiColdDayEnabled: false,
  /** Rolling complete UTC days to inspect. */
  foiColdDayLookbackDays: 3,
  /** Day counts as cold when WR < this (0–1). */
  foiColdDayMaxWinRate: 0.28,
  /** Or when day sum PnL < this. */
  foiColdDayMaxDayPnl: 0,
  /** Require this many FOI closes in the lookback window. */
  foiColdDayMinTrades: 8,
  /** cold: half | block | allow */
  foiColdDayPolicy: "half",
};

function normalizeFoiColdDayConfig(raw = {}) {
  const d = FOI_COLD_DAY_DEFAULTS;
  const policy = String(raw.foiColdDayPolicy ?? d.foiColdDayPolicy).toLowerCase();
  return {
    foiColdDayEnabled: Boolean(raw.foiColdDayEnabled ?? d.foiColdDayEnabled),
    foiColdDayLookbackDays: clamp(
      Math.round(num(raw.foiColdDayLookbackDays, d.foiColdDayLookbackDays)),
      1,
      14
    ),
    foiColdDayMaxWinRate: clamp(
      num(raw.foiColdDayMaxWinRate, d.foiColdDayMaxWinRate),
      0,
      1
    ),
    foiColdDayMaxDayPnl: num(raw.foiColdDayMaxDayPnl, d.foiColdDayMaxDayPnl),
    foiColdDayMinTrades: clamp(
      Math.round(num(raw.foiColdDayMinTrades, d.foiColdDayMinTrades)),
      1,
      500
    ),
    foiColdDayPolicy:
      policy === "block" || policy === "allow" ? policy : "half",
  };
}

function dayKeyUtc(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function isFoiSignalKind(signalKind) {
  return signalKind === "foi" || signalKind === "foi_bear";
}

function createFoiColdDayTracker(options = {}) {
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

  function completeDaysBefore(asOfMs, lookbackDays) {
    const asOfDay = dayKeyUtc(asOfMs);
    if (!asOfDay) return [];
    const byDay = new Map();
    for (const c of closes) {
      if (c.closedAt >= asOfMs) continue;
      if (c.day >= asOfDay) continue; // only completed prior UTC days
      if (!byDay.has(c.day)) byDay.set(c.day, []);
      byDay.get(c.day).push(c);
    }
    const days = [...byDay.keys()].sort();
    const recent = days.slice(-lookbackDays);
    return recent.map((day) => {
      const rows = byDay.get(day);
      const n = rows.length;
      const wins = rows.filter((r) => r.win).length;
      const sumPnl = rows.reduce((s, r) => s + r.pnl, 0);
      return {
        day,
        n,
        wr: n ? wins / n : 0,
        sumPnl,
        cold: false,
      };
    });
  }

  /**
   * @returns {{ pass: boolean, sizeScale: number, detail: string, cold: boolean, days: object[] }}
   */
  function check(cfgInput, asOfMs = Date.now()) {
    const cfg = normalizeFoiColdDayConfig(cfgInput ?? {});
    if (!cfg.foiColdDayEnabled) {
      return {
        pass: true,
        sizeScale: 1,
        detail: "disabled",
        cold: false,
        days: [],
      };
    }
    const days = completeDaysBefore(asOfMs, cfg.foiColdDayLookbackDays);
    const nTrades = days.reduce((s, d) => s + d.n, 0);
    if (nTrades < cfg.foiColdDayMinTrades || !days.length) {
      return {
        pass: true,
        sizeScale: 1,
        detail: `warmup allow (${nTrades}/${cfg.foiColdDayMinTrades})`,
        cold: false,
        days,
      };
    }
    for (const d of days) {
      d.cold =
        d.wr < cfg.foiColdDayMaxWinRate || d.sumPnl < cfg.foiColdDayMaxDayPnl;
    }
    const coldDays = days.filter((d) => d.cold).length;
    const cold = coldDays >= Math.ceil(days.length / 2); // majority cold
    if (!cold) {
      return {
        pass: true,
        sizeScale: 1,
        detail: `hot days ${days.length - coldDays}/${days.length}`,
        cold: false,
        days,
      };
    }
    if (cfg.foiColdDayPolicy === "allow") {
      return {
        pass: true,
        sizeScale: 1,
        detail: `cold allow (${coldDays}/${days.length})`,
        cold: true,
        days,
      };
    }
    if (cfg.foiColdDayPolicy === "block") {
      return {
        pass: false,
        sizeScale: 0,
        detail: `cold block (${coldDays}/${days.length})`,
        cold: true,
        days,
      };
    }
    return {
      pass: true,
      sizeScale: 0.5,
      detail: `cold half (${coldDays}/${days.length})`,
      cold: true,
      days,
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
  FOI_COLD_DAY_DEFAULTS,
  normalizeFoiColdDayConfig,
  createFoiColdDayTracker,
  dayKeyUtc,
};
