/**
 * FOI BTC lookalike gate — skip alts whose recent path matches BTC.
 * Default research pick: 4h pathCosine ≥ 0.95 (5m bars).
 */
function num(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const FOI_BTC_LOOKALIKE_DEFAULTS = {
  foiBtcLookalikeEnabled: false,
  /** Lookback hours before entry. */
  foiBtcLookalikeHours: 4,
  /** Downsample 1m → N-minute closes for path shape. */
  foiBtcLookalikeBarMin: 5,
  /** Skip when path cosine ≥ this (0–1). */
  foiBtcLookalikeMinPathCosine: 0.95,
  /** Minimum aligned return samples. */
  foiBtcLookalikeMinSamples: 12,
};

function normalizeFoiBtcLookalikeConfig(raw = {}) {
  const d = FOI_BTC_LOOKALIKE_DEFAULTS;
  return {
    foiBtcLookalikeEnabled: Boolean(
      raw.foiBtcLookalikeEnabled ?? d.foiBtcLookalikeEnabled
    ),
    foiBtcLookalikeHours: clamp(
      Math.round(num(raw.foiBtcLookalikeHours, d.foiBtcLookalikeHours)),
      1,
      48
    ),
    foiBtcLookalikeBarMin: clamp(
      Math.round(num(raw.foiBtcLookalikeBarMin, d.foiBtcLookalikeBarMin)),
      1,
      60
    ),
    foiBtcLookalikeMinPathCosine: clamp(
      num(raw.foiBtcLookalikeMinPathCosine, d.foiBtcLookalikeMinPathCosine),
      0,
      1
    ),
    foiBtcLookalikeMinSamples: clamp(
      Math.round(num(raw.foiBtcLookalikeMinSamples, d.foiBtcLookalikeMinSamples)),
      4,
      500
    ),
  };
}

function endIndexAfterAsOf(bars, asOfMs) {
  if (!bars?.length) return 0;
  if (asOfMs == null || !Number.isFinite(asOfMs)) return bars.length;
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeTime <= asOfMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function windowBars(bars, asOfMs, hours) {
  if (!bars?.length || !Number.isFinite(asOfMs)) return [];
  const end = endIndexAfterAsOf(bars, asOfMs);
  const startMs = asOfMs - hours * 3_600_000;
  let start = end;
  while (start > 0 && bars[start - 1].closeTime > startMs) start--;
  return bars.slice(start, end);
}

function downsampleCloses(bars, barMin) {
  if (!bars?.length) return [];
  if (barMin <= 1) return bars.map((b) => ({ t: b.closeTime, c: b.close }));
  const ms = barMin * 60_000;
  const out = [];
  let bucket = null;
  let last = null;
  for (const b of bars) {
    const k = Math.floor(b.closeTime / ms);
    if (bucket == null) bucket = k;
    if (k !== bucket) {
      if (last) out.push(last);
      bucket = k;
    }
    last = { t: b.closeTime, c: b.close };
  }
  if (last) out.push(last);
  return out;
}

function logReturns(closes) {
  const r = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1].c;
    const b = closes[i].c;
    if (!(a > 0) || !(b > 0)) {
      r.push(0);
      continue;
    }
    r.push(Math.log(b / a));
  }
  return r;
}

function cumPath(rets) {
  const p = new Array(rets.length);
  let s = 0;
  for (let i = 0; i < rets.length; i++) {
    s += rets[i];
    p[i] = s;
  }
  return p;
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 4) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function pathCosineVsBtc(altBars, btcBars, asOfMs, hours, barMin) {
  const btcWin = windowBars(btcBars, asOfMs, hours);
  const altWin = windowBars(altBars, asOfMs, hours);
  const btcCl = downsampleCloses(btcWin, barMin);
  const altCl = downsampleCloses(altWin, barMin);
  const n = Math.min(btcCl.length, altCl.length);
  if (n < 2) return { pathCosine: null, nBars: n };
  const btcAligned = btcCl.slice(-n);
  const altAligned = altCl.slice(-n);
  const pathB = cumPath(logReturns(btcAligned));
  const pathA = cumPath(logReturns(altAligned));
  return { pathCosine: cosine(pathA, pathB), nBars: n };
}

/**
 * @returns {{ ok: boolean, reason?: string, pathCosine?: number|null, detail?: string }}
 */
function foiBtcLookalikeAllows(cfgInput, options = {}) {
  const cfg = normalizeFoiBtcLookalikeConfig(cfgInput);
  if (!cfg.foiBtcLookalikeEnabled) return { ok: true, detail: "disabled" };

  const {
    symbol,
    asOfMs = Date.now(),
    altBars = null,
    btcBars = null,
    getBarsForSymbol = null,
    getBtcBars = null,
  } = options;

  if (String(symbol || "").toUpperCase() === "BTCUSDT") {
    return { ok: true, detail: "btc_itself" };
  }

  const alt =
    altBars ??
    (typeof getBarsForSymbol === "function" ? getBarsForSymbol(symbol, asOfMs) : null);
  const btc =
    btcBars ?? (typeof getBtcBars === "function" ? getBtcBars(asOfMs) : null);
  if (!alt?.length || !btc?.length) {
    // Fail-open when bars missing (don't freeze book).
    return { ok: true, detail: "missing_bars_allow" };
  }

  const { pathCosine, nBars } = pathCosineVsBtc(
    alt,
    btc,
    asOfMs,
    cfg.foiBtcLookalikeHours,
    cfg.foiBtcLookalikeBarMin
  );
  if (pathCosine == null || nBars < cfg.foiBtcLookalikeMinSamples) {
    return { ok: true, pathCosine, detail: `warmup_allow n=${nBars}` };
  }
  if (pathCosine >= cfg.foiBtcLookalikeMinPathCosine) {
    return {
      ok: false,
      pathCosine,
      reason: "foi_btc_lookalike",
      detail: `pathCosine ${pathCosine.toFixed(3)} ≥ ${cfg.foiBtcLookalikeMinPathCosine} (${cfg.foiBtcLookalikeHours}h)`,
    };
  }
  return {
    ok: true,
    pathCosine,
    detail: `pathCosine ${pathCosine.toFixed(3)} < ${cfg.foiBtcLookalikeMinPathCosine}`,
  };
}

module.exports = {
  FOI_BTC_LOOKALIKE_DEFAULTS,
  normalizeFoiBtcLookalikeConfig,
  pathCosineVsBtc,
  foiBtcLookalikeAllows,
  windowBars,
  downsampleCloses,
};
