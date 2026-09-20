/**
 * Eval runner.
 *
 *   npm run eval                    -- every case once
 *   npm run eval -- --n 3           -- three runs per case, reports pass RATE
 *   npm run eval -- --only polarity -- filter by id substring
 *
 * Reports per-check pass rates rather than a single pass/fail, because the
 * failure mode we care about is flakiness. "13/14 passing, one flakes per run"
 * tells you nothing actionable; "case 9, check 3: 2/5" tells you exactly what to
 * fix.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extname } from "node:path";
import { ask, type AgentResult, type Attachment } from "../packages/agent/src/session.js";
import { requireCredentials } from "../packages/agent/src/preflight.js";
import { cases, type EvalCase } from "./cases.js";
import { stressCases } from "./stress-cases.js";
import { diagramCases } from "./diagram-cases.js";
import { weldCases } from "./weld-cases.js";

requireCredentials();

const MEDIA: Record<string, Attachment["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const N = Number(flag("n", "1"));
const ONLY = flag("only", "");

// The must-refuse subset is the headline claim, so it is worth re-running on its
// own at a higher n without paying for the whole suite.
const REFUSE_ONLY = argv.includes("--refuse-only");
// --stress runs the adversarial set; --all runs both.
const pool = argv.includes("--stress")
  ? stressCases
  : argv.includes("--diagrams")
    ? diagramCases
    : argv.includes("--welds")
      ? weldCases
      : argv.includes("--all")
        ? [...cases, ...stressCases, ...diagramCases, ...weldCases]
        : cases;

let selected = ONLY ? pool.filter((c) => c.id.includes(ONLY)) : pool;
if (REFUSE_ONLY) selected = selected.filter((c) => c.mustRefuse === true);
if (selected.length === 0) {
  console.error(`no case matches "${ONLY}"`);
  process.exit(1);
}

interface CheckStat {
  name: string;
  passed: number;
  total: number;
  /** Text from a run where this check failed, for debugging the check itself. */
  sample?: string;
}

interface CaseStat {
  id: string;
  mustRefuse: boolean;
  checks: CheckStat[];
  /** Answers in which the post-hoc checker found an invented number. */
  fabricatedRuns: number;
  fabricatedSamples: string[];
  runs: number;
  errors: string[];
  costUsd: number;
  cacheRead: number;
  cacheTotal: number;
}

async function runCase(c: EvalCase): Promise<CaseStat> {
  const stat: CaseStat = {
    id: c.id,
    mustRefuse: c.mustRefuse === true,
    checks: c.checks.map((ch) => ({ name: ch.name, passed: 0, total: 0 })),
    fabricatedRuns: 0,
    fabricatedSamples: [],
    runs: 0,
    errors: [],
    costUsd: 0,
    cacheRead: 0,
    cacheTotal: 0,
  };

  const images: Attachment[] = c.image
    ? [{ data: readFileSync(c.image).toString("base64"), mediaType: MEDIA[extname(c.image)]! }]
    : [];

  for (let i = 0; i < N; i++) {
    let result: AgentResult;
    try {
      result = await ask({ text: c.question, ...(images.length ? { images } : {}) });
    } catch (e) {
      stat.errors.push(String(e).slice(0, 200));
      continue;
    }
    stat.runs++;
    stat.costUsd += result.costUsd ?? 0;
    if (result.usage) {
      stat.cacheRead += result.usage.cacheReadTokens;
      stat.cacheTotal +=
        result.usage.cacheReadTokens + result.usage.cacheCreationTokens + result.usage.inputTokens;
    }
    // A universal gate. Individual cases assert on behaviour; this asserts on
    // every number in every answer, including the ones no case thought to check.
    if (result.numbers.fabricated.length) {
      stat.fabricatedRuns++;
      if (stat.fabricatedSamples.length < 2) {
        // Keep the sentence, not just the number. "145 A was invented" tells you
        // nothing about whether the prompt or the checker needs the fix; the
        // sentence it sat in tells you immediately.
        stat.fabricatedSamples.push(
          result.numbers.fabricated
            .map((f) => {
              const at = result.text.indexOf(f.text);
              const ctx =
                at < 0
                  ? ""
                  : result.text.slice(Math.max(0, at - 120), at + f.text.length + 120).replace(/\s+/g, " ");
              return `"${f.text}" (${f.why})${ctx ? ` -- ...${ctx}...` : ""}`;
            })
            .join("; "),
        );
      }
    }

    c.checks.forEach((ch, idx) => {
      const s = stat.checks[idx]!;
      s.total++;
      let passed = false;
      try {
        passed = ch.assert(result);
      } catch {
        passed = false;
      }
      if (passed) s.passed++;
      // Keep the text a failing check actually graded. Without it you cannot
      // tell an over-strict regex from a genuine model failure, and you end up
      // "fixing" the prompt to satisfy a broken assertion.
      else if (!s.sample) s.sample = result.text;
    });
  }
  return stat;
}

const started = Date.now();
const stats: CaseStat[] = [];

for (const c of selected) {
  process.stderr.write(`running ${c.id} (n=${N}) ... `);
  const s = await runCase(c);
  const failed = s.checks.filter((ch) => ch.passed < ch.total).length;
  process.stderr.write(failed === 0 ? "ok\n" : `${failed} check(s) flaked or failed\n`);
  stats.push(s);
}

console.log(`\n${"=".repeat(68)}`);
console.log(`EVAL REPORT   n=${N} per case   ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log("=".repeat(68));

let totalChecks = 0;
let totalPassed = 0;
let refuseChecks = 0;
let refusePassed = 0;

for (const s of stats) {
  const allPass = s.checks.every((c) => c.passed === c.total);
  console.log(`\n${allPass ? "PASS" : "FAIL"}  ${s.id}${s.mustRefuse ? "  [must-refuse]" : ""}`);
  for (const ch of s.checks) {
    totalChecks += ch.total;
    totalPassed += ch.passed;
    if (s.mustRefuse) {
      refuseChecks += ch.total;
      refusePassed += ch.passed;
    }
    const mark = ch.passed === ch.total ? "  ok  " : ch.passed === 0 ? " FAIL " : " FLAKY";
    console.log(`   ${mark} ${ch.passed}/${ch.total}  ${ch.name}`);
  }
  if (s.fabricatedRuns) {
    console.log(`   FAB   ${s.fabricatedRuns}/${s.runs} run(s) contained an invented number`);
    for (const f of s.fabricatedSamples) console.log(`         ${f}`);
  }
  for (const e of s.errors) console.log(`   ERROR ${e}`);
}

const cost = stats.reduce((a, s) => a + s.costUsd, 0);
const cacheRead = stats.reduce((a, s) => a + s.cacheRead, 0);
const cacheTotal = stats.reduce((a, s) => a + s.cacheTotal, 0);
const cacheHit = cacheTotal > 0 ? (cacheRead / cacheTotal) * 100 : 0;
const falseAnswerRate = refuseChecks > 0 ? ((refuseChecks - refusePassed) / refuseChecks) * 100 : 0;
const totalRuns = stats.reduce((a, s) => a + s.runs, 0);
const fabRuns = stats.reduce((a, s) => a + s.fabricatedRuns, 0);
const fabRate = totalRuns > 0 ? (fabRuns / totalRuns) * 100 : 0;

console.log(`\n${"=".repeat(68)}`);
console.log(`checks passed      ${totalPassed}/${totalChecks} (${((totalPassed / totalChecks) * 100).toFixed(1)}%)`);
console.log(`false-answer rate  ${falseAnswerRate.toFixed(1)}%   <- headline metric, must be 0`);
console.log(`fabricated numbers ${fabRate.toFixed(1)}%   (${fabRuns}/${totalRuns} answers)  <- must be 0`);
console.log(`cache hit rate     ${cacheHit.toFixed(1)}%   <- below 80% means the prompt lost stability`);
console.log(`cost               $${cost.toFixed(2)}`);
console.log("=".repeat(68));

mkdirSync("out", { recursive: true });
writeFileSync(
  "out/eval-report.json",
  JSON.stringify({ n: N, stats, cacheHit, falseAnswerRate, fabRate, cost }, null, 2),
);
console.log("\nwrote out/eval-report.json");

// A must-refuse failure fails the build. A stray cache regression does too --
// it means someone put a timestamp back in the system prompt.
// An invented number fails the build too, wherever it turns up. It is the one
// error class this system exists to prevent, and it is not any single case's job
// to notice it.
if (falseAnswerRate > 0 || fabRuns > 0 || (cacheTotal > 0 && cacheHit < 80)) process.exitCode = 1;
