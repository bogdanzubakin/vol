#!/usr/bin/env node
/**
 * Persist FOI champion stack v1.5 = A+B + pathCosine≥0.95 + cold-day half + VWAP120 trail.
 *
 * Evidence: 3×10d CF trail Δ+$14.19 · WR 35.7%→75.1% · OOS+ 3/3
 *   (scripts/run-foi-vwap-trail-50d.js --portions 3)
 *
 *   node scripts/write-foi-v1.5-patch.js
 *   node scripts/apply-foi-v1.5.js --push
 */
const { writeJsonFile, dataPath } = require("../lib/data-dir");

const PATCH = {
  // A+B
  aiExitLevelsSlClampMin: 1.2,
  minSmartStopDistancePct: 1.2,
  minSmartStopDistancePctBear: 1.2,
  foiSkipExtremeCrowdingAnd: true,
  foiExtremeFundingAbs: 0.00025,
  foiExtremeOiDelta1hAbs: 0.8,
  moveStopEnabled: false,
  foiHotProtectLongHoldsEnabled: true,
  foiHotMinWinRate: 0.38,
  foiHotTpScale: 1.25,
  // pathCosine + cold half
  foiBtcLookalikeEnabled: true,
  foiBtcLookalikeHours: 4,
  foiBtcLookalikeBarMin: 5,
  foiBtcLookalikeMinPathCosine: 0.95,
  foiBtcLookalikeFailClosed: true,
  foiColdDayEnabled: true,
  foiColdDayLookbackDays: 3,
  foiColdDayMaxWinRate: 0.28,
  foiColdDayMaxDayPnl: 0,
  foiColdDayMinTrades: 8,
  foiColdDayPolicy: "half",
  // VWAP trail exit (immediate FOI entry)
  foiVwapTrailEnabled: true,
  foiVwapTrailOnlyFoi: true,
  foiVwapTrailArmPct: 0.3,
  foiVwapTrailBars: 120,
};

const doc = {
  ranAt: new Date().toISOString(),
  version: "1.5",
  name: "foi-v1.5",
  title: "FOI v1.5: A+B + pathCosine + coldHalf + VWAP120 trail",
  champion: "AB+pathCosine+coldHalf+vwapTrail",
  evidence: {
    method: "3×10d portions · live baseline + path CF trail",
    report: "foi-vwap-trail-50d-report.json",
    n: 770,
    baselineSum: 0.9755,
    trailSum: 15.1669,
    deltaSum: 14.1914,
    baselineWr: 35.7,
    trailWr: 75.1,
    oosPositive: "3/3",
    trailExits: 537,
  },
  patch: PATCH,
  apply: "node scripts/apply-foi-v1.5.js --push",
};

writeJsonFile(dataPath("foi-v1.5-patch.json"), doc);
writeJsonFile(dataPath("foi-ab-pathcosine-vwap-trail-patch.json"), doc);
console.log(JSON.stringify(doc, null, 2));
