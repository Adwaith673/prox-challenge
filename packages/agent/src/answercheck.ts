/**
 * Post-hoc numeric verification of the answer's PROSE.
 *
 * Everything else in this system is verified before it exists: a diagram cannot
 * be rendered unless `verifyDiagram` mints a `VerifiedSpec`, and a widget's
 * values are read out of the tables on the server where the model cannot reach
 * them. Prose is the one surface with no such gate -- the model writes free text,
 * and free text can carry a number.
 *
 * So the prose gets checked afterwards. This runs with no model in the loop and
 * no API call, in about a millisecond, and it classifies every quantity in the
 * answer:
 *
 *   grounded     - the number is in a verified table, or in the text of a page
 *   echoed       - the number came from the user's own question
 *   structural   - it is a page citation, a step number, a date; not a claim
 *   hypothetical - named in order to say the manual does NOT publish it
 *   miscited     - the number is real, but not on the page the sentence cites
 *   fabricated   - the number appears nowhere in the corpus
 *
 * The two failure classes are deliberately separate because they are not equally
 * serious. A fabricated number is the dangerous one: it is an invented figure on
 * a machine running mains voltage. A miscited number is harmless to act on but
 * still breaks the promise the whole system makes -- that you can walk to the
 * welder and check the page.
 */

import { pages } from "./retrieval.js";
import { groundTruth } from "../../diagram/src/groundTruth.js";

export type Verdict =
  | "grounded"
  | "echoed"
  | "structural"
  | "hypothetical"
  | "miscited"
  | "fabricated";

export interface NumberClaim {
  /** As written in the answer, e.g. "30%", "175 A". */
  text: string;
  value: string;
  unit: string | null;
  verdict: Verdict;
  /** Pages this number actually appears on. */
  foundOnPages: number[];
  /** The page the surrounding sentence cited, if any. */
  citedPage: number | null;
  /** Which table holds it, when one does. */
  table: string | null;
  why: string;
}

export interface AnswerCheck {
  ok: boolean;
  claims: NumberClaim[];
  fabricated: NumberClaim[];
  miscited: NumberClaim[];
  checkedMicros: number;
}

/**
 * A quantity, with its unit when it has one.
 *
 * Deliberately not `\d+`: bare integers in prose are mostly step numbers, list
 * markers and page references, and flagging those produces noise that trains you
 * to ignore the checker. A number is only a CLAIM here if it carries a unit, or
 * sits in a numeric context that makes it one (a gauge, a ratio, a fraction of
 * an inch).
 */
const QUANTITY =
  /(?<![\d./])(\d+(?:\.\d+)?)\s*(%|A\b|amps?\b|V(?:AC|DC)?\b|volts?\b|SCFH\b|IPM\b|in\/min\b|minutes?\b|min\b|ga(?:uge)?\b|mm\b|inch(?:es)?\b|")/gi;

/**
 * Fractional inches -- "1/8 inch", "5/16\"", "3/32".
 *
 * Matched whole. The lookbehind on QUANTITY is what makes that safe: without it
 * the scanner reads the denominator of 5/16" as a standalone "16 inches", which
 * is a dimension the manual never prints, and reports the answer as fabricating
 * it. Caught against real agent output, not in the unit tests.
 *
 * The denominator is restricted to a binary fraction and the numerator must be
 * smaller than it, because not every `a/b` in a welding answer is a length:
 * "75/25" is a shielding gas blend (argon/CO2) and "50/60Hz" is a mains
 * frequency. An earlier version reported the gas mix as an invented dimension,
 * which is the checker calling a correct answer a liar -- the failure mode that
 * makes people switch the checker off.
 */
const FRACTION = /(?<![\d/])(\d{1,2})\/(2|4|8|16|32|64)(?![\d/])\s*(?:"|inch(?:es)?\b|in\b)?/g;

/** "p.14", "page 14", "(p. 7)" -- the number is a pointer, not a measurement. */
const CITATION = /\bp(?:age|g|\.)?\s*(\d{1,2})\b/gi;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Units, collapsed to classes.
 *
 * Checking the bare number is not enough, and the failure is not hypothetical:
 * "22" appears in the corpus as "22 Gauge", so an invented "22% duty cycle"
 * grounds itself against a thickness rating. A quantity is only grounded when
 * the number AND its kind both appear -- 22 as a percentage, not 22 as anything.
 */
type UnitClass = "pct" | "amp" | "volt" | "scfh" | "ipm" | "minute" | "gauge" | "inch" | null;

function unitClass(u: string | null): UnitClass {
  if (!u) return null;
  const s = u.toLowerCase().replace(/\.$/, "");
  if (s === "%") return "pct";
  if (/^(a|amp|amps)$/.test(s)) return "amp";
  if (/^(v|volt|volts|vdc)$/.test(s)) return "volt";
  if (s === "scfh") return "scfh";
  if (s === "ipm" || s === "in/min") return "ipm";
  if (/^(min|minute|minutes)$/.test(s)) return "minute";
  if (/^ga(uge)?$/.test(s)) return "gauge";
  if (/^(mm|in|inch|inches|")$/.test(s)) return "inch";
  return null;
}

/** The words that mark each class in running text. */
const UNIT_WORDS: Record<Exclude<UnitClass, null>, RegExp> = {
  pct: /%|percent/i,
  amp: /\bamp(s|erage)?\b|\d\s*A\b|\bI2\b/,
  // VAC matters: page 7 prints "120 VAC 60Hz / 240 VAC 60Hz", and `V\b` never
  // fires before the "AC". Without it the spec page did not count as carrying a
  // voltage at all, so every correct citation of 240 V to p.7 came back miscited.
  volt: /\bvolt(s|age)?\b|\d\s*V(AC|DC)?\b|\bU0\b|\bU2\b/,
  scfh: /SCFH/i,
  ipm: /\bIPM\b|in\/min/i,
  minute: /\bminute/i,
  gauge: /\bga(uge)?\b/i,
  inch: /"|\binch|\bin\b|\bmm\b/i,
};

/**
 * Index the corpus as (number, unit class) -> pages.
 *
 * Proximity, not adjacency. Page 20 prints "Set SCFH between 20-30" with the
 * unit BEFORE the numbers, and page 14 prints "U0 = 86V I2 200A" where the unit
 * binds tightly. An adjacency rule handles the second and silently rejects the
 * first -- which is how a correct citation gets flagged as invented. A window
 * either side covers both orders.
 */
const WINDOW = 26;

function buildIndex(): Map<string, Set<number>> {
  const idx = new Map<string, Set<number>>();
  const put = (value: string, cls: UnitClass, page: number) => {
    const key = `${value}|${cls ?? "*"}`;
    let set = idx.get(key);
    if (!set) idx.set(key, (set = new Set()));
    set.add(page);
  };

  for (const p of pages) {
    for (const m of p.text.matchAll(/\d+(?:\.\d+)?/g)) {
      const at = m.index ?? 0;
      const near = p.text.slice(Math.max(0, at - WINDOW), at + m[0].length + WINDOW);
      put(m[0], null, p.page); // bare presence, used as a fallback
      for (const [cls, re] of Object.entries(UNIT_WORDS)) {
        if (re.test(near)) put(m[0], cls as UnitClass, p.page);
      }
    }
    for (const m of p.text.matchAll(/\d{1,2}\/\d{1,2}/g)) put(m[0], "inch", p.page);
  }
  return idx;
}

const INDEX = buildIndex();

/**
 * The same index for the verified tables, but built from KNOWN semantics rather
 * than guessed from nearby words -- a duty point's `dutyPct` is a percentage
 * because the schema says so, not because a '%' happened to sit beside it.
 *
 * Page 0 stands for "in a table, not on a page": the selection chart's ranges
 * exist only in a JPEG and so appear on no page at all, yet must still ground.
 */
function buildTableIndex(): Map<string, string> {
  const out = new Map<string, string>();
  const put = (v: number | string | null | undefined, cls: UnitClass, table: string) => {
    if (v === null || v === undefined) return;
    const key = `${typeof v === "number" ? String(v) : v}|${cls ?? "*"}`;
    if (!out.has(key)) out.set(key, table);
  };

  for (const r of groundTruth.duty) {
    for (const pt of r.points) {
      put(pt.dutyPct, "pct", "duty-cycle");
      put(pt.amps, "amp", "duty-cycle");
      put(pt.arcVolts, "volt", "duty-cycle");
      // The manual's own arithmetic: 30% of a 10-minute window is 3 minutes.
      put(pt.dutyPct / 10, "minute", "duty-cycle");
      put(10 - pt.dutyPct / 10, "minute", "duty-cycle");
    }
    put(r.outputRange.minAmps, "amp", "duty-cycle");
    put(r.outputRange.maxAmps, "amp", "duty-cycle");
    put(r.outputRange.minVolts, "volt", "duty-cycle");
    put(r.outputRange.maxVolts, "volt", "duty-cycle");
    put(r.inputVoltage, "volt", "duty-cycle");
  }
  put(groundTruth.dutyPeriodMinutes, "minute", "duty-cycle");

  for (const s of groundTruth.settings) {
    if (s.gasScfh) {
      put(s.gasScfh.min, "scfh", "settings-procedure");
      put(s.gasScfh.max, "scfh", "settings-procedure");
    }
    // The decal's own screens. Several of these exist on no page -- "3/32"
    // occurs zero times in the manual text -- so an answer that correctly
    // repeats a Stick electrode diameter off the door sticker was being
    // reported as an invention until these were indexed.
    const dec = s.decalScreens;
    for (const dia of dec.diameters) {
      for (const m of dia.matchAll(/\d{1,2}\/\d{1,2}/g)) put(m[0], "inch", "decal");
      for (const m of dia.matchAll(/\.\d+/g)) put(m[0], "inch", "decal");
    }
    for (const t of dec.thicknesses) {
      for (const m of t.matchAll(/\d+/g)) put(m[0], "gauge", "decal");
    }
    put(dec.reads.amps, "amp", "decal");
    put(dec.reads.volts, "volt", "decal");
  }

  for (const r of groundTruth.selection) {
    // "18 Gauge to 5/16\"" -- both halves, each with the right class.
    for (const m of r.thickness.label.matchAll(/(\d+)\s*Gauge/gi)) {
      put(m[1]!, "gauge", "process-selection");
    }
    for (const m of r.thickness.label.matchAll(/\d{1,2}\/\d{1,2}/g)) {
      put(m[0], "inch", "process-selection");
    }
  }
  return out;
}

const TABLE_INDEX = buildTableIndex();

/** Pages carrying this number as this kind of quantity. */
function pagesFor(value: string, cls: UnitClass): number[] {
  return [...(INDEX.get(`${value}|${cls ?? "*"}`) ?? [])].sort((a, b) => a - b);
}

/**
 * The pages cited in the same sentence as a number.
 *
 * Scope matters more than it looks. An earlier version searched BACKWARDS from
 * the number, which gets the common case exactly wrong: people cite after the
 * claim, not before it. "Maximum OCV is 86 VDC (p.7)" was being judged against
 * whatever page the previous sentence had mentioned, so a correct citation came
 * back miscited.
 *
 * Sentence scope also decides what we are willing to accuse. A citation in the
 * same sentence is a deliberate attribution and can be checked. A citation two
 * sentences up is context, not a claim about this number -- "that's 3 minutes of
 * arc time" derived from a 30% rating is not miscited just because the paragraph
 * began by citing page 14.
 */
function sentenceAround(text: string, at: number): [number, number] {
  // Sentence enders, but not the dot in "p.14", "1/8" or "13.8".
  const END = /[.!?](?=\s|$)/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(END)) {
    const i = m.index ?? 0;
    // "p." and "pg." are abbreviations, not sentence ends.
    if (/\bp(?:g|age)?$/i.test(text.slice(Math.max(0, i - 5), i))) continue;
    if (i < at) start = i + 1;
    else {
      end = i + 1;
      break;
    }
  }
  return [start, end];
}

function citedPagesInSentence(text: string, at: number): number[] {
  const [a, b] = sentenceAround(text, at);
  return [
    ...new Set(
      [...text.slice(a, b).matchAll(CITATION)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 1 && n <= 48),
    ),
  ];
}

/** Character offsets covered by page citations, so "p.14" is never read as 14 volts. */
function citationSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(CITATION)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

/**
 * The sentence denies that this number has a published value.
 *
 * Naming a figure in order to say it does not exist is the opposite of
 * inventing one, and the agent does it constantly because it is the right
 * answer: "there's no valid number at, say, 145 A; pick a published point
 * instead." The checker originally read that 145 A as an invention and failed
 * the build over the single most correct sentence in the run.
 *
 * The guard is deliberately narrow. It needs a negation AND a publication word
 * in the same sentence, so "the manual doesn't say much, but it's 22%" -- a
 * negation attached to a real assertion -- still counts as fabrication, because
 * the disclaimer must be about *publication*, not about vagueness.
 */
const DISCLAIMED =
  /\b(?:no|not|never|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|nothing)\b[^.!?]{0,70}?\b(?:publish\w*|rated?|rating|specif\w*|listed|valid number|figure|data)\b|\b(?:publish\w*|rated?|rating|specif\w*|listed)\b[^.!?]{0,30}?\b(?:no|not|never|nowhere)\b/i;

export function checkAnswer(answer: string, question = ""): AnswerCheck {
  const started = process.hrtime.bigint();
  const claims: NumberClaim[] = [];

  // The user's own numbers are not the agent's claims. Asked "what's my duty
  // cycle at 150 amps", an answer that repeats 150 A is quoting the question --
  // flagging it as fabricated is the right rule applied at the wrong scope.
  const asked = new Set(
    [...norm(question).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]),
  );

  const spans = citationSpans(answer);
  const inCitation = (i: number) => spans.some(([a, b]) => i >= a && i < b);

  const seen = new Set<string>();
  const consider = (raw: string, value: string, unit: string | null, at: number) => {
    const key = `${value}|${unit ?? ""}|${at}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (inCitation(at)) {
      claims.push({
        text: raw, value, unit, verdict: "structural", foundOnPages: [],
        citedPage: null, table: null, why: "page citation, not a measurement",
      });
      return;
    }

    if (asked.has(value)) {
      claims.push({
        text: raw, value, unit, verdict: "echoed", foundOnPages: [],
        citedPage: null, table: null, why: "the user supplied this number",
      });
      return;
    }

    const cls = unitClass(unit);
    const onPages = pagesFor(value, cls);
    const table = TABLE_INDEX.get(`${value}|${cls ?? "*"}`) ?? null;
    const cites = citedPagesInSentence(answer, at);
    const cited = cites[0] ?? null;

    if (!onPages.length && !table) {
      // Named in order to be ruled out, not asserted.
      const [sa, sb] = sentenceAround(answer, at);
      if (DISCLAIMED.test(answer.slice(sa, sb))) {
        claims.push({
          text: raw, value, unit, verdict: "hypothetical", foundOnPages: [],
          citedPage: cited, table: null,
          why: "named as an example of a value the manual does NOT publish",
        });
        return;
      }
      const asAnything = pagesFor(value, null);
      claims.push({
        text: raw, value, unit, verdict: "fabricated", foundOnPages: [], citedPage: cited,
        table: null,
        why: asAnything.length
          ? `${value} appears in the manual, but never as ${cls ?? "this quantity"} ` +
            `(seen on p.${asAnything.slice(0, 3).join(", p.")} as something else)`
          : "appears in no verified table and on no page of the manual",
      });
      return;
    }

    // Miscitation is only alleged where the answer attributed IN THE SAME
    // SENTENCE and the value is traceable to pages at all. A table-only value
    // (the selection chart's ranges) is on no page by construction, so there is
    // nothing for a citation to disagree with.
    if (cites.length > 0 && onPages.length > 0 && !cites.some((c) => onPages.includes(c))) {
      claims.push({
        text: raw, value, unit, verdict: "miscited", foundOnPages: onPages, citedPage: cited,
        table,
        why: `cited p.${cites.join(", p.")}, but this value appears on ${
          onPages.length > 3 ? `${onPages.length} other pages` : `p.${onPages.join(", p.")}`
        }`,
      });
      return;
    }

    claims.push({
      text: raw, value, unit, verdict: "grounded", foundOnPages: onPages, citedPage: cited,
      table,
      why: table ? `in the ${table} table` : `on p.${onPages.slice(0, 4).join(", p.")}`,
    });
  };

  for (const m of answer.matchAll(QUANTITY)) {
    consider(m[0], m[1]!, m[2]!.toLowerCase(), m.index ?? 0);
  }
  for (const m of answer.matchAll(FRACTION)) {
    const at = m.index ?? 0;
    if (inCitation(at)) continue;
    const frac = `${m[1]}/${m[2]}`;
    // A binary fraction is only a length if it is a proper one. 3/2" is not a
    // thickness anyone states, and letting it through re-opens the gas-mix hole.
    if (Number(m[1]) >= Number(m[2])) continue;
    if (asked.has(frac)) continue;
    const onPages = pagesFor(frac, "inch");
    const table = TABLE_INDEX.get(`${frac}|inch`) ?? null;
    if (!onPages.length && !table) {
      claims.push({
        text: m[0], value: frac, unit: "in", verdict: "fabricated", foundOnPages: [],
        citedPage: citedPagesInSentence(answer, at)[0] ?? null, table: null,
        why: "fractional dimension appears nowhere in the corpus",
      });
    } else {
      claims.push({
        text: m[0], value: frac, unit: "in", verdict: "grounded", foundOnPages: onPages,
        citedPage: citedPagesInSentence(answer, at)[0] ?? null, table,
        why: table ? `in the ${table} table` : `on p.${onPages.slice(0, 4).join(", p.")}`,
      });
    }
  }

  const fabricated = claims.filter((c) => c.verdict === "fabricated");
  const miscited = claims.filter((c) => c.verdict === "miscited");
  return {
    ok: fabricated.length === 0 && miscited.length === 0,
    claims,
    fabricated,
    miscited,
    checkedMicros: Math.round(Number(process.hrtime.bigint() - started) / 1000),
  };
}

/** One line per problem, for the CLI and the eval suite. */
export function formatCheck(c: AnswerCheck): string {
  if (c.ok) {
    const n = c.claims.filter((x) => x.verdict === "grounded").length;
    return `numbers: ${n} grounded, 0 fabricated, 0 miscited (${c.checkedMicros}µs)`;
  }
  const lines = [...c.fabricated, ...c.miscited].map(
    (x) => `  ${x.verdict.toUpperCase()}: "${x.text}" — ${x.why}`,
  );
  return [`numbers: ${c.fabricated.length} fabricated, ${c.miscited.length} miscited`, ...lines].join(
    "\n",
  );
}
