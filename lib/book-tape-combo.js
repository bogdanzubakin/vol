/**
 * Combined Order Book + Tape Reading indicators for FOI / SFP / PB gates.
 *
 * Book (resting liquidity):
 *   bidAsk = BidVol/AskVol · askBid = AskVol/BidVol
 *
 * Tape (aggressive flow + absorption):
 *   buyShare / sellShare · seller_absorption (LONG) · buyer_absorption (SHORT)
 *
 * Combo views (side-aware):
 *   bookAligned / bookAgainst
 *   tapeAlignedShare / tapeAgainstShare
 *   absorptionWith / absorptionAgainst
 *   agreeScore ∈ [-1, +1]  — blended book+tape agreement with trade side
 *   conflict / support     — boolean gates
 */
const {
  computeObiSnapshot,
  normalizeObiConfig,
} = require("./order-book-imbalance-signal");
const {
  summarizeTape,
  evaluateTapeLong,
  evaluateTapeBear,
  normalizeTapeConfig,
} = require("./tape-reading-signal");

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const COMBO_DEFAULTS = {
  /** Enable FOI confirm gate (book + tape). */
  bookTapeFoiConfirm: false,
  /** Min book aligned ratio for FOI confirm. */
  bookTapeFoiMinBook: 1.5,
  /** Max opposing tape share for FOI confirm (0–1). */
  bookTapeFoiMaxTapeAgainst: 0.55,
  /** Require no opposing absorption on FOI. */
  bookTapeFoiBlockAbsorptionAgainst: true,

  /** Enable SFP/PB skip when book/tape fight the setup. */
  bookTapeSfpPbFilter: false,
  /** Skip SFP/PB when book against ≥ this. */
  bookTapeSfpPbMinAgainst: 1.5,
  /** Skip SFP/PB when opposing tape share ≥ this. */
  bookTapeSfpPbMaxTapeAgainst: 0.65,
  /** Skip when opposing absorption fires. */
  bookTapeSfpPbBlockAbsorptionAgainst: true,

  /** Size scale from combo strength (0.5 / 1.0). */
  bookTapeSizeScale: false,
  bookTapeSizeFullBook: 2.0,
  bookTapeSizeFullTape: 0.55,
  bookTapeSizeHalfBook: 1.2,

  /** Early abort when combo flips against open position. */
  bookTapeEarlyAbort: false,
  bookTapeAbortMinAgainst: 2.0,
  bookTapeAbortTapeAgainst: 0.7,
  bookTapeAbortOnAbsorptionAgainst: true,

  /** Weights for agreeScore (sum normalized). */
  bookTapeBookWeight: 0.5,
  bookTapeTapeWeight: 0.5,
};

function normalizeBookTapeConfig(raw = {}) {
  const d = COMBO_DEFAULTS;
  const obi = normalizeObiConfig(raw);
  const tape = normalizeTapeConfig(raw);
  return {
    ...obi,
    ...tape,
    bookTapeFoiConfirm: Boolean(raw.bookTapeFoiConfirm ?? d.bookTapeFoiConfirm),
    bookTapeFoiMinBook: clamp(
      num(raw.bookTapeFoiMinBook, d.bookTapeFoiMinBook),
      1.0,
      10
    ),
    bookTapeFoiMaxTapeAgainst: clamp(
      num(raw.bookTapeFoiMaxTapeAgainst, d.bookTapeFoiMaxTapeAgainst),
      0.4,
      0.95
    ),
    bookTapeFoiBlockAbsorptionAgainst: Boolean(
      raw.bookTapeFoiBlockAbsorptionAgainst ?? d.bookTapeFoiBlockAbsorptionAgainst
    ),
    bookTapeSfpPbFilter: Boolean(
      raw.bookTapeSfpPbFilter ?? d.bookTapeSfpPbFilter
    ),
    bookTapeSfpPbMinAgainst: clamp(
      num(raw.bookTapeSfpPbMinAgainst, d.bookTapeSfpPbMinAgainst),
      1.0,
      20
    ),
    bookTapeSfpPbMaxTapeAgainst: clamp(
      num(raw.bookTapeSfpPbMaxTapeAgainst, d.bookTapeSfpPbMaxTapeAgainst),
      0.45,
      0.99
    ),
    bookTapeSfpPbBlockAbsorptionAgainst: Boolean(
      raw.bookTapeSfpPbBlockAbsorptionAgainst ??
        d.bookTapeSfpPbBlockAbsorptionAgainst
    ),
    bookTapeSizeScale: Boolean(raw.bookTapeSizeScale ?? d.bookTapeSizeScale),
    bookTapeSizeFullBook: clamp(
      num(raw.bookTapeSizeFullBook, d.bookTapeSizeFullBook),
      1.1,
      20
    ),
    bookTapeSizeFullTape: clamp(
      num(raw.bookTapeSizeFullTape, d.bookTapeSizeFullTape),
      0.5,
      0.95
    ),
    bookTapeSizeHalfBook: clamp(
      num(raw.bookTapeSizeHalfBook, d.bookTapeSizeHalfBook),
      1.0,
      10
    ),
    bookTapeEarlyAbort: Boolean(
      raw.bookTapeEarlyAbort ?? d.bookTapeEarlyAbort
    ),
    bookTapeAbortMinAgainst: clamp(
      num(raw.bookTapeAbortMinAgainst, d.bookTapeAbortMinAgainst),
      1.1,
      20
    ),
    bookTapeAbortTapeAgainst: clamp(
      num(raw.bookTapeAbortTapeAgainst, d.bookTapeAbortTapeAgainst),
      0.5,
      0.99
    ),
    bookTapeAbortOnAbsorptionAgainst: Boolean(
      raw.bookTapeAbortOnAbsorptionAgainst ?? d.bookTapeAbortOnAbsorptionAgainst
    ),
    bookTapeBookWeight: clamp(
      num(raw.bookTapeBookWeight, d.bookTapeBookWeight),
      0,
      1
    ),
    bookTapeTapeWeight: clamp(
      num(raw.bookTapeTapeWeight, d.bookTapeTapeWeight),
      0,
      1
    ),
  };
}

function isLongSide(side) {
  return side === "LONG" || side === "BUY";
}

/** Map book ratio to ≈[-1,+1] (1:1 → 0, 3:1 → ~0.5, extreme → ±1). */
function bookScoreFromRatio(aligned) {
  if (!(aligned > 0)) return 0;
  // tanh(log(ratio)) — symmetric around 1
  return Math.tanh(Math.log(aligned));
}

/** Map share ∈[0,1] to ≈[-1,+1] via (share − 0.5)*2. */
function tapeScoreFromShare(alignedShare) {
  if (alignedShare == null || !Number.isFinite(alignedShare)) return 0;
  return clamp((alignedShare - 0.5) * 2, -1, 1);
}

/**
 * @param {{ book?: object, trades?: object[], side: string, levels?: number, tapeCount?: number, cfg?: object }} input
 */
function computeBookTapeCombo(input = {}) {
  const side = String(input.side || "LONG").toUpperCase();
  const long = isLongSide(side);
  const cfg = normalizeBookTapeConfig(input.cfg ?? {});
  const levels = input.levels ?? cfg.obiLevels ?? 20;
  const tapeCount = input.tapeCount ?? cfg.tapeTradeCount ?? 100;

  const obi = computeObiSnapshot(input.book, levels);
  const tape = summarizeTape(input.trades, tapeCount);
  const tapeLong = evaluateTapeLong(input.trades, cfg);
  const tapeBear = evaluateTapeBear(input.trades, cfg);

  const bidAsk = obi.imbalance;
  const askBid =
    obi.bidVol > 0 && obi.askVol > 0 ? +(obi.askVol / obi.bidVol).toFixed(4) : null;

  const bookAligned = long ? bidAsk : askBid;
  const bookAgainst = long ? askBid : bidAsk;
  const tapeAlignedShare = long ? tape.buyShare : tape.sellShare;
  const tapeAgainstShare = long ? tape.sellShare : tape.buyShare;

  // Absorption WITH trade: fade into our direction
  // LONG ← seller absorption; SHORT ← buyer absorption
  const absorptionWith = long ? Boolean(tapeLong.passes) : Boolean(tapeBear.passes);
  const absorptionAgainst = long
    ? Boolean(tapeBear.passes)
    : Boolean(tapeLong.passes);

  const bw = cfg.bookTapeBookWeight;
  const tw = cfg.bookTapeTapeWeight;
  const wSum = bw + tw || 1;
  let agreeScore =
    (bw * bookScoreFromRatio(bookAligned || 1) +
      tw * tapeScoreFromShare(tapeAlignedShare)) /
    wSum;
  // Penalize opposing absorption hard
  if (absorptionAgainst) agreeScore = Math.min(agreeScore, -0.35);
  if (absorptionWith) agreeScore = Math.max(agreeScore, Math.min(1, agreeScore + 0.2));
  agreeScore = +clamp(agreeScore, -1, 1).toFixed(4);

  const conflict =
    (bookAgainst != null && bookAgainst >= 2 && (bookAligned || 0) < 1.2) ||
    (tapeAgainstShare != null && tapeAgainstShare >= 0.65) ||
    absorptionAgainst;

  const support =
    (bookAligned != null && bookAligned >= 1.5) &&
    (tapeAlignedShare == null || tapeAlignedShare >= 0.5) &&
    !absorptionAgainst;

  return {
    side: long ? "LONG" : "SHORT",
    asOfMs: Date.now(),
    // book
    bidVol: obi.bidVol,
    askVol: obi.askVol,
    bidAsk,
    askBid,
    bookAligned: bookAligned != null ? +Number(bookAligned).toFixed(4) : null,
    bookAgainst: bookAgainst != null ? +Number(bookAgainst).toFixed(4) : null,
    mid: obi.mid ?? tape.mid,
    // tape
    buyShare: tape.buyShare,
    sellShare: tape.sellShare,
    tapeAlignedShare:
      tapeAlignedShare != null ? +Number(tapeAlignedShare).toFixed(4) : null,
    tapeAgainstShare:
      tapeAgainstShare != null ? +Number(tapeAgainstShare).toFixed(4) : null,
    priceChangePct: tape.priceChangePct,
    tapeN: tape.n,
    absorptionWith,
    absorptionAgainst,
    absorptionKind: absorptionWith
      ? long
        ? "seller_absorption"
        : "buyer_absorption"
      : absorptionAgainst
        ? long
          ? "buyer_absorption"
          : "seller_absorption"
        : null,
    // combo
    agreeScore,
    conflict,
    support,
    bookScore: +bookScoreFromRatio(bookAligned || 1).toFixed(4),
    tapeScore: +tapeScoreFromShare(tapeAlignedShare).toFixed(4),
  };
}

/**
 * FOI entry confirm: book + tape must not fight the FOI side.
 * @returns {{ pass: boolean, reason: string, scale?: number }}
 */
function evaluateFoiBookTapeGate(combo, cfgInput = {}) {
  const cfg = normalizeBookTapeConfig(cfgInput);
  if (!cfg.bookTapeFoiConfirm) return { pass: true, reason: "disabled" };
  if (!combo) return { pass: false, reason: "no_combo" };
  if (
    combo.bookAligned == null ||
    combo.bookAligned < cfg.bookTapeFoiMinBook
  ) {
    return {
      pass: false,
      reason: `book_aligned_${combo.bookAligned ?? "null"}<${cfg.bookTapeFoiMinBook}`,
    };
  }
  if (
    combo.tapeAgainstShare != null &&
    combo.tapeAgainstShare >= cfg.bookTapeFoiMaxTapeAgainst
  ) {
    return {
      pass: false,
      reason: `tape_against_${combo.tapeAgainstShare}≥${cfg.bookTapeFoiMaxTapeAgainst}`,
    };
  }
  if (cfg.bookTapeFoiBlockAbsorptionAgainst && combo.absorptionAgainst) {
    return { pass: false, reason: "absorption_against" };
  }
  return { pass: true, reason: "foi_combo_ok" };
}

/**
 * SFP/PB filter: skip when book or tape strongly fights the setup.
 */
function evaluateSfpPbBookTapeGate(combo, cfgInput = {}) {
  const cfg = normalizeBookTapeConfig(cfgInput);
  if (!cfg.bookTapeSfpPbFilter) return { pass: true, reason: "disabled" };
  if (!combo) return { pass: true, reason: "no_combo" }; // fail-open if no live book/tape
  if (
    combo.bookAgainst != null &&
    combo.bookAgainst >= cfg.bookTapeSfpPbMinAgainst
  ) {
    return {
      pass: false,
      reason: `book_against_${combo.bookAgainst}≥${cfg.bookTapeSfpPbMinAgainst}`,
    };
  }
  if (
    combo.tapeAgainstShare != null &&
    combo.tapeAgainstShare >= cfg.bookTapeSfpPbMaxTapeAgainst
  ) {
    return {
      pass: false,
      reason: `tape_against_${combo.tapeAgainstShare}≥${cfg.bookTapeSfpPbMaxTapeAgainst}`,
    };
  }
  if (cfg.bookTapeSfpPbBlockAbsorptionAgainst && combo.absorptionAgainst) {
    return { pass: false, reason: "absorption_against" };
  }
  return { pass: true, reason: "sfp_pb_combo_ok" };
}

/**
 * Size multiplier from combo strength (1 = full, 0.5 = half, 0 = skip).
 */
function sizeScaleFromBookTape(combo, cfgInput = {}) {
  const cfg = normalizeBookTapeConfig(cfgInput);
  if (!cfg.bookTapeSizeScale) return { scale: 1, reason: "disabled" };
  if (!combo) return { scale: 1, reason: "no_combo" };
  if (combo.absorptionAgainst || combo.conflict) {
    return { scale: 0.5, reason: "conflict_half" };
  }
  const bookOk =
    combo.bookAligned != null && combo.bookAligned >= cfg.bookTapeSizeFullBook;
  const tapeOk =
    combo.tapeAlignedShare == null ||
    combo.tapeAlignedShare >= cfg.bookTapeSizeFullTape;
  if (bookOk && tapeOk) return { scale: 1, reason: "full_support" };
  if (
    combo.bookAligned != null &&
    combo.bookAligned >= cfg.bookTapeSizeHalfBook
  ) {
    return { scale: 0.5, reason: "partial_book" };
  }
  if ((combo.agreeScore ?? 0) >= 0.15) return { scale: 0.5, reason: "mild_agree" };
  return { scale: 0.5, reason: "weak_default_half" };
}

/**
 * Early-abort when open position faces book+tape pressure.
 */
function shouldEarlyAbortBookTape(combo, cfgInput = {}) {
  const cfg = normalizeBookTapeConfig(cfgInput);
  if (!cfg.bookTapeEarlyAbort) return { abort: false, reason: "disabled" };
  if (!combo) return { abort: false, reason: "no_combo" };
  if (
    combo.bookAgainst != null &&
    combo.bookAgainst >= cfg.bookTapeAbortMinAgainst
  ) {
    return {
      abort: true,
      reason: `book_against_${combo.bookAgainst}≥${cfg.bookTapeAbortMinAgainst}`,
    };
  }
  if (
    combo.tapeAgainstShare != null &&
    combo.tapeAgainstShare >= cfg.bookTapeAbortTapeAgainst
  ) {
    return {
      abort: true,
      reason: `tape_against_${combo.tapeAgainstShare}≥${cfg.bookTapeAbortTapeAgainst}`,
    };
  }
  if (cfg.bookTapeAbortOnAbsorptionAgainst && combo.absorptionAgainst) {
    return { abort: true, reason: "absorption_against" };
  }
  return { abort: false, reason: "ok" };
}

/**
 * Unified entry gate for a signal family.
 * @param {'foi'|'sfp_pb'|'other'} family
 */
function evaluateBookTapeEntryGate(family, combo, cfgInput = {}) {
  const cfg = normalizeBookTapeConfig(cfgInput);
  if (family === "foi") {
    const g = evaluateFoiBookTapeGate(combo, cfg);
    if (!g.pass) return { ...g, scale: 0 };
    const sz = sizeScaleFromBookTape(combo, cfg);
    return { pass: true, reason: g.reason, scale: sz.scale, sizeReason: sz.reason };
  }
  if (family === "sfp_pb") {
    const g = evaluateSfpPbBookTapeGate(combo, cfg);
    if (!g.pass) return { ...g, scale: 0 };
    const sz = sizeScaleFromBookTape(combo, cfg);
    return { pass: true, reason: g.reason, scale: sz.scale, sizeReason: sz.reason };
  }
  const sz = sizeScaleFromBookTape(combo, cfg);
  return { pass: true, reason: "other", scale: sz.scale, sizeReason: sz.reason };
}

module.exports = {
  COMBO_DEFAULTS,
  normalizeBookTapeConfig,
  computeBookTapeCombo,
  evaluateFoiBookTapeGate,
  evaluateSfpPbBookTapeGate,
  sizeScaleFromBookTape,
  shouldEarlyAbortBookTape,
  evaluateBookTapeEntryGate,
  bookScoreFromRatio,
  tapeScoreFromShare,
};
