#!/usr/bin/env node
/**
 * Detect AI-model "scope blocking" bugs: a bot calling a scope-sensitive model
 * evaluation without the correct `modelScope`, so live silently uses paper
 * weights (or vice versa).
 *
 * How it works
 *   Each bot file declares its own scope (live-bot → "live", paper-bot → "paper").
 *   Every direct call to a scope-sensitive function must pass `modelScope` that
 *   resolves to that bot's scope. Regime gates routed through pre-scoped monitor
 *   objects (monitor.checkSymbol(...)) are fine and are not flagged.
 *
 * Usage
 *   node scripts/audit-model-scope.js          # report, exit 1 on issues
 *   node scripts/audit-model-scope.js --json
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Functions whose behaviour depends on which model scope is loaded. */
const SCOPE_SENSITIVE_CALLS = [
  "resolveExitLevels",
  "resolveAiExitLevels",
  "predictExitLevelPcts",
  "evaluatePullbackSignalGate",
  "evaluateSfpRegimeGate",
  "evaluatePullbackRegimeGate",
  "evaluatePullbackPatternBreakGate",
  "evaluateAiEarlyExit",
];

/** Files that run a specific scope and must pass it to every call above. */
const TARGETS = [
  { file: "lib/live-bot.js", expected: "live" },
  { file: "lib/paper-bot.js", expected: "paper" },
  { file: "lib/paper-bot-simulator.js", expected: "paper" },
];

/** Read the balanced (...) argument block starting at the '(' index. */
function readArgBlock(src, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  return src.slice(openParenIdx);
}

function lineAt(src, idx) {
  return src.slice(0, idx).split("\n").length;
}

/** Resolve the scope literal a `modelScope:` value refers to (constant or string). */
function resolvedScope(argBlock, expected) {
  const m = argBlock.match(/modelScope\s*:\s*([A-Za-z0-9_."']+)/);
  if (!m) return { present: false };
  const raw = m[1];
  if (raw === "MODEL_SCOPE") return { present: true, scope: expected, viaConst: true };
  const lit = raw.replace(/["']/g, "");
  return { present: true, scope: lit, viaConst: false };
}

function auditFile(file, expected) {
  const abs = path.join(ROOT, file);
  const src = fs.readFileSync(abs, "utf8");
  const issues = [];

  for (const fn of SCOPE_SENSITIVE_CALLS) {
    const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
    let match;
    while ((match = re.exec(src)) !== null) {
      const openIdx = src.indexOf("(", match.index);
      if (openIdx < 0) continue;
      const argBlock = readArgBlock(src, openIdx);
      const line = lineAt(src, match.index);
      const res = resolvedScope(argBlock, expected);
      if (!res.present) {
        issues.push({ file, line, fn, kind: "missing", expected });
      } else if (res.scope !== expected) {
        issues.push({
          file,
          line,
          fn,
          kind: "wrong-scope",
          expected,
          got: res.scope,
        });
      }
    }
  }
  return issues;
}

function main() {
  const json = process.argv.includes("--json");
  const all = [];
  for (const { file, expected } of TARGETS) {
    all.push(...auditFile(file, expected));
  }

  if (json) {
    console.log(JSON.stringify({ ok: all.length === 0, issues: all }, null, 2));
    process.exit(all.length ? 1 : 0);
  }

  if (!all.length) {
    console.log("✓ model scope audit: no scope-blocking calls found");
    console.log(
      `  checked ${SCOPE_SENSITIVE_CALLS.length} functions across ${TARGETS.length} bot files`
    );
    process.exit(0);
  }

  console.error(`✗ model scope audit: ${all.length} issue(s)\n`);
  for (const i of all) {
    if (i.kind === "missing") {
      console.error(
        `  ${i.file}:${i.line}  ${i.fn}(…) missing modelScope (expected "${i.expected}") — falls back to "paper"`
      );
    } else {
      console.error(
        `  ${i.file}:${i.line}  ${i.fn}(…) uses modelScope "${i.got}" but this bot is "${i.expected}"`
      );
    }
  }
  console.error(
    '\nFix: pass `modelScope: MODEL_SCOPE` in the call, or route through a pre-scoped monitor.'
  );
  process.exit(1);
}

main();
