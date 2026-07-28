#!/usr/bin/env node
/** Persist A+B feature patch for Railway / local apply. */
const { writeJsonFile, dataPath } = require("../lib/data-dir");

const PATCH = {
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
};

const doc = {
  ranAt: new Date().toISOString(),
  name: "foi-ab",
  title: "A+B: less qSL + hot TP protect",
  fromLadder: "railway-live-30d-feature-ladder A+B",
  ladderPnl: 7.69,
  ladderDeltaVsBase: 2.43,
  patch: PATCH,
  apply:
    "node scripts/run-railway-live-30d-daily.js --features ab --skip-pull --foi-symbols-only",
};

writeJsonFile(dataPath("foi-ab-patch.json"), doc);
console.log(JSON.stringify(doc, null, 2));
