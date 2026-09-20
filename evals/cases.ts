/**
 * Eval cases.
 *
 * Every assertion runs against the TOOL TRACE or a mechanical property of the
 * text -- never against an LLM judge's opinion of the prose. "Did it call
 * get_duty_cycle before answering" is a fact; "was the answer good" is not, and
 * grading on the second is how you end up with a suite that drifts.
 *
 * The headline metric is `mustRefuse`: cases where the manual has no answer and
 * inventing one is the failure mode that matters. A false answer here is worse
 * than any number of stylistic misses.
 */

import type { AgentResult } from "../packages/agent/src/session.js";
import { groundTruth } from "../packages/diagram/src/groundTruth.js";

export interface EvalCase {
  id: string;
  question: string;
  /** Path relative to repo root, attached as a user photo. */
  image?: string;
  /** This question has no answer in the manual; inventing one is the cardinal sin. */
  mustRefuse?: boolean;
  checks: Array<{ name: string; assert: (r: AgentResult) => boolean }>;
}

const called = (r: AgentResult, tool: string) =>
  r.toolCalls.some((c) => c.name === `mcp__omnipro__${tool}`);

const callArgs = (r: AgentResult, tool: string) =>
  r.toolCalls.filter((c) => c.name === `mcp__omnipro__${tool}`).map((c) => c.input as Record<string, unknown>);

const says = (r: AgentResult, re: RegExp) => re.test(r.text);
const lacks = (r: AgentResult, re: RegExp) => !re.test(r.text);

/**
 * The claim is traceable, in prose or on screen.
 *
 * Two bugs live here, both found the hard way.
 *
 * The regex matches "page 14" as well as "p.14". An earlier one required the
 * digits to follow "p" immediately, so it silently scored zero every time the
 * model spelled the word out -- which reads as the agent having stopped citing
 * when it had not.
 *
 * And a rendered matrix or diagram carries its own cited pages in the interface.
 * Asked for a stick duty cycle the agent drew the duty matrix and wrote a short
 * note about it; the prose had no page number because the picture had them all.
 * Failing that answer measures where the citation sits, not whether it exists.
 */
const CITES_PAGE = /\bp(?:age|g|\.)?\s*(\d{1,2})\b/gi;

const citesOneOf = (r: AgentResult, pages: number[]) =>
  [...r.text.matchAll(CITES_PAGE)].some((m) => pages.includes(Number(m[1])));

const showsProvenance = (r: AgentResult, pages: number[]) =>
  citesOneOf(r, pages) ||
  r.toolCalls.some(
    (c) => /render_diagram|duty_cycle_matrix|render_widget|get_figure/.test(c.name) && !c.isError,
  );

/**
 * Fabrication checks work from an ALLOWLIST built out of the verified tables,
 * not from a blocklist regex.
 *
 * A blocklist gets this wrong in both directions, and did: an early version
 * flagged "wire speed range is 50 - 500 IPM (p.7)" as an invented wire feed
 * speed, because 500 is a number next to IPM. That is a figure the manual
 * actually prints. Grading a refusal with a check that punishes correct
 * citations teaches exactly the wrong lesson, and it inflated the headline
 * false-answer metric with noise.
 *
 * So: pull every number the manual genuinely publishes for a unit, and fail only
 * on a number outside that set.
 */
function publishedNumbers(unit: "V" | "IPM"): Set<string> {
  const out = new Set<string>();
  if (unit === "IPM") {
    // The only IPM figures in the manual are the machine's wire-speed range.
    for (const n of ["50", "500"]) out.add(n);
    return out;
  }
  for (const row of groundTruth.duty) {
    out.add(String(row.outputRange.minVolts));
    out.add(String(row.outputRange.maxVolts));
    for (const p of row.points) out.add(String(p.arcVolts));
  }
  // OCV and the two mains voltages. 86, not 78: the Harbor Freight download is a
  // different revision of this manual (item 63621, UL 60974-1) and prints 78 V.
  // The graded copy in files/ prints 86 V, and allowlisting the wrong one would
  // have failed every correct citation of the spec page.
  for (const n of ["86", "120", "240"]) out.add(n);
  return out;
}

const ALLOWED_V = publishedNumbers("V");
const ALLOWED_IPM = publishedNumbers("IPM");

/** Numbers attached to a unit that the manual never publishes. */
function fabricated(text: string, unit: "V" | "IPM"): string[] {
  const allowed = unit === "V" ? ALLOWED_V : ALLOWED_IPM;
  const re =
    unit === "V"
      ? /(\d+(?:\.\d+)?)\s?(?:V\b|volts\b)/gi
      : /(\d+(?:\.\d+)?)\s?(?:IPM\b|in\/min\b)/gi;
  return [...text.matchAll(re)].map((m) => m[1]!).filter((n) => !allowed.has(n));
}

/**
 * A duty percentage ATTRIBUTED to an out-of-range current.
 *
 * Requires an attribution ("220 A is 20%", "at 220 A you get 20%"), so a correct
 * sentence that merely mentions both numbers -- "reaches 220 A, but 25% at 200 A
 * is the ceiling" -- does not trip it.
 */
const ATTRIBUTES_DUTY_TO_220 =
  /220\s?A\b[^.]{0,40}?\b(?:is|gives|would be|about|approx\w*|around|roughly|estimate\w*|=)\s*~?\s*\d{1,3}\s?%/i;

export const cases: EvalCase[] = [
  {
    id: "duty-175-stick",
    question: "What is my duty cycle at 175 A on stick, 240 V input?",
    checks: [
      { name: "consults the duty table", assert: (r) => called(r, "get_duty_cycle") },
      {
        name: "keyed on the process, not just amps",
        assert: (r) => callArgs(r, "get_duty_cycle").some((a) => a["process"] === "Stick"),
      },
      { name: "answers 25%", assert: (r) => says(r, /\b25\s?%/) },
      {
        /**
         * Must not ASSIGN 30% to stick -- which is not the same as never saying
         * "30%".
         *
         * The best answer this case has produced wrote: "175 A is 25% on Stick
         * but 30% on TIG at the same 240 V input, because arc voltage differs
         * (27 V vs 17 V)." That contrast IS the trap this whole system was built
         * to surface, and a check that forbade "30%" anywhere near the word
         * "stick" failed the answer for making the point.
         *
         * So the patterns below look for attribution -- "stick is 30%", "30% for
         * stick" -- and let the comparison through.
         */
        name: "never attributes 30% to stick",
        assert: (r) =>
          lacks(r, /stick[^.]{0,48}(?:is|=|:|→|->)\s*30\s?%/i) &&
          lacks(r, /\b30\s?%\s*(?:for|on|in|at)\s+stick/i),
      },
      { name: "the answer is traceable", assert: (r) => showsProvenance(r, [7, 14, 25]) },
    ],
  },
  {
    id: "duty-175-tig",
    question: "What is my duty cycle at 175 A on TIG, 240 V input?",
    checks: [
      { name: "consults the duty table", assert: (r) => called(r, "get_duty_cycle") },
      { name: "answers 30%", assert: (r) => says(r, /\b30\s?%/) },
      { name: "does not say 25%", assert: (r) => lacks(r, /\b25\s?%[^.]{0,40}tig/i) },
    ],
  },
  {
    id: "duty-220-mig-unpublished",
    question: "What is the duty cycle at 220 A on MIG with 240 V input?",
    mustRefuse: true,
    checks: [
      { name: "consults the duty table", assert: (r) => called(r, "get_duty_cycle") },
      {
        name: "says it is not published",
        assert: (r) => says(r, /not\s+(published|rated)|no\s+(published|rated)|does not (publish|rate)/i),
      },
      { name: "names the 200 A ceiling", assert: (r) => says(r, /200\s?A/i) },
      {
        name: "invents no duty figure for 220 A",
        assert: (r) => lacks(r, ATTRIBUTES_DUTY_TO_220),
      },
    ],
  },
  {
    id: "polarity-fluxcore",
    question: "How do I set up polarity for flux-cored gasless welding?",
    checks: [
      { name: "consults the polarity table", assert: (r) => called(r, "get_polarity") },
      { name: "renders a diagram", assert: (r) => called(r, "render_diagram") },
      { name: "a diagram actually verified", assert: (r) => r.svgs.length > 0 },
      { name: "says DCEN", assert: (r) => says(r, /DCEN/) },
      {
        name: "wire feed to negative",
        assert: (r) => says(r, /wire\s*feed[^.]{0,60}negative/i),
      },
      { name: "ground to positive", assert: (r) => says(r, /ground[^.]{0,60}positive/i) },
      { name: "emits no raw SVG into the prose", assert: (r) => lacks(r, /<svg/i) },
    ],
  },
  {
    id: "polarity-mig-ambiguous",
    question: "What polarity should I use for MIG?",
    checks: [
      {
        name: "surfaces both variants rather than guessing",
        assert: (r) => says(r, /flux[- ]?core/i) && says(r, /solid/i),
      },
      { name: "names both conventions", assert: (r) => says(r, /DCEP/) && says(r, /DCEN/) },
    ],
  },
  {
    id: "settings-matrix-not-in-manual",
    question: "What voltage and wire feed speed for 1/8 inch mild steel, .030 wire, C25 gas?",
    mustRefuse: true,
    checks: [
      {
        // No longer "points at the door decal". The decal does not carry a
        // thickness -> voltage/WFS table either -- that was an inference we had
        // written down as a finding. Sending someone to hunt for a table that
        // does not exist is a wrong answer even though no number was invented.
        name: "explains the machine derives the settings",
        assert: (r) =>
          says(r, /synergic|auto ?weld|derives?|calculates?|works? (it|them) out|recommend\w* setting/i),
      },
      {
        name: "gives the knob sequence rather than hunting for a table",
        assert: (r) => says(r, /knob/i) && says(r, /thickness/i),
      },
      { name: "invents no voltage", assert: (r) => fabricated(r.text, "V").length === 0 },
      { name: "invents no wire feed speed", assert: (r) => fabricated(r.text, "IPM").length === 0 },
    ],
  },
  {
    id: "ac-tig-contradiction",
    question: "Can I TIG weld aluminium with AC on this machine?",
    mustRefuse: true,
    checks: [
      { name: "does not affirm AC TIG", assert: (r) => lacks(r, /yes[^.]{0,40}AC\s?TIG/i) },
      { name: "says the machine is DC only", assert: (r) => says(r, /DC\s?only|no AC|DC\b[^.]{0,30}output/i) },
      { name: "cites the DC evidence", assert: (r) => says(r, /78\s?V|VDC/i) },
      { name: "routes to the spool gun", assert: (r) => says(r, /spool\s?gun/i) },
    ],
  },
  {
    id: "porosity-stick-gated",
    question: "I'm stick welding with 7018 and I have porosity in my bead. What's wrong?",
    checks: [
      { name: "consults the diagnosis table", assert: (r) => called(r, "diagnose") },
      {
        name: "gated to the stick process",
        assert: (r) => callArgs(r, "diagnose").some((a) => a["process"] === "Stick"),
      },
      {
        name: "does NOT prescribe gas flow to a stick welder",
        assert: (r) => lacks(r, /increase[^.]{0,30}(gas|flow)|gas flow[^.]{0,20}(up|increase)/i),
      },
      {
        name: "gives the two printed stick causes",
        assert: (r) => says(r, /dirty|clean/i) && says(r, /speed/i),
      },
    ],
  },
  {
    id: "porosity-mig-gas",
    question: "I'm running solid wire MIG with C25 and getting porosity. What should I check?",
    checks: [
      { name: "consults the diagnosis table", assert: (r) => called(r, "diagnose") },
      { name: "does mention shielding gas here", assert: (r) => says(r, /gas/i) },
      { name: "mentions CTWD or stickout", assert: (r) => says(r, /CTWD|stick\s?out/i) },
    ],
  },
];
