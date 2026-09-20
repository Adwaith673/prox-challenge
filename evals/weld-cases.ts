/**
 * Weld photo cases.
 *
 * The brief asks for multimodal responses -- agent to user. This runs the other
 * way: somebody in a garage does not know the word "porosity", which is exactly
 * why they could not find it in the manual, so they photograph the bead instead.
 *
 * Three things this set is built to catch, none of which the old single case
 * could:
 *
 * 1. TESTING ON YOUR OWN SOURCE MATERIAL IS CIRCULAR. The one weld case we had
 *    fed the agent a figure cropped out of the manual it is answering from. The
 *    model can recognise the artwork -- it is line art, not a photograph -- and
 *    "diagnosed" it partly by recall. Half the set below is real photographs
 *    from Wikimedia Commons, credited in CREDITS.json, which the manual has
 *    never seen.
 *
 * 2. "YOUR WELD IS FINE" IS A REAL ANSWER. A tool that finds a fault in every
 *    photo is not diagnosing, it is agreeing with you. So the questions here are
 *    neutral -- "how does this look", "is this any good" -- never "what's wrong
 *    with it", which presupposes a fault and grades the model on going along
 *    with the premise.
 *
 * 3. IT HAS TO BE ABLE TO SAY "THAT ISN'T A WELD". Shown the machine itself, the
 *    only correct answer is to decline. A system that hunts for undercut in a
 *    product photo will hunt for it anywhere.
 */

import type { EvalCase } from "./cases.js";
import type { AgentResult } from "../packages/agent/src/session.js";

const called = (r: AgentResult, tool: string) =>
  r.toolCalls.some((c) => c.name === `mcp__omnipro__${tool}`);
const says = (r: AgentResult, re: RegExp) => re.test(r.text);
const lacks = (r: AgentResult, re: RegExp) => !re.test(r.text);

/** Cites a manual page, a named image-only source, or both. */
const cites = (r: AgentResult) =>
  /\bp(?:age|\.)\s?\d{1,2}\b|selection chart|quick.start|door decal/i.test(r.text);

/**
 * An AFFIRMATIVE defect attribution, as opposed to merely naming a fault.
 *
 * The distinction is the whole difference between diagnosing and pattern
 * matching. Shown the manual's good-weld panel, the agent wrote "Porosity: none
 * — no pinholes in the bead or the surrounding plate", which is the correct
 * method: rule the six faults out one at a time and let *good* be what is left.
 * A check that merely forbids the word "porosity" fails that answer for doing
 * the right thing, and would pass a vaguer one that never looked.
 */
const ATTRIBUTES_FAULT = (r: AgentResult) =>
  new RegExp(
    String.raw`(?:you(?:'ve| have)|there(?:'s| is| are)|showing|suffers?|caused by|problem is|issue is|that(?:'s| is))` +
      String.raw`[^.!?]{0,60}(porosity|undercut|lack of fusion|inadequate penetration)`,
    "i",
  ).test(r.text);

/**
 * Provenance reached the user, in prose or on screen.
 *
 * A rendered widget or diagram carries its own cited pages in the interface, so
 * an answer that shows one has not dropped the promise that you can check this
 * at the machine -- it has moved the citation out of the paragraph and into the
 * thing you are looking at.
 */
const showsProvenance = (r: AgentResult) =>
  cites(r) ||
  r.toolCalls.some((c) => /render_widget|render_diagram|get_figure/.test(c.name) && !c.isError);

export const weldCases: EvalCase[] = [
  /* ── negatives: these are not welds, and must not be diagnosed ───────── */
  {
    id: "weld-negative-machine",
    question: "How does this look?",
    image: "evals/welds/real/not-a-weld-machine.webp",
    checks: [
      {
        name: "recognises the welder itself rather than finding a defect",
        assert: (r) => says(r, /welder|machine|OmniPro|not a weld|isn't a weld|no weld/i),
      },
      {
        // Not a bare keyword scan: shown the product shot the agent correctly said
        // "that's the stock product shot ... nothing to critique in it", then
        // read the LCD and explained that reversed polarity causes "a nasty,
        // spattery flux-core bead". That is teaching, not diagnosing, and a
        // keyword check marked the best answer in the set as a failure.
        name: "does NOT attribute a weld fault to a product photo",
        assert: (r) => !ATTRIBUTES_FAULT(r),
      },
    ],
  },
  {
    id: "weld-negative-decal",
    question: "Is this any good?",
    image: "data/docs/decal.png",
    checks: [
      {
        name: "identifies the settings chart / machine, not a bead",
        assert: (r) => says(r, /settings chart|decal|door|welder|machine|not a weld/i),
      },
      { name: "does NOT attribute a weld fault", assert: (r) => !ATTRIBUTES_FAULT(r) },
    ],
  },

  /* ── a good weld, with exact ground truth ────────────────────────────── */
  {
    id: "weld-good-reference",
    // Panel 1 of the p.35 chart, cropped away from its caption and neighbours so
    // the verdict has to come from the picture. Ground truth: this is the GOOD
    // bead -- even ripples, correct profile, no voids.
    question: "Is this weld any good?",
    image: "evals/welds/good-bead-p35.png",
    checks: [
      {
        name: "calls it good rather than inventing a fault",
        assert: (r) =>
          says(r, /good|correct|fine|proper|nothing wrong|looks right|acceptable|textbook/i),
      },
      {
        // Not `lacks(/porosity/)`: the agent ruled porosity out by name
        // ("Porosity: none - no pinholes"), which is the method working.
        name: "does not ATTRIBUTE a defect to this bead",
        assert: (r) => !ATTRIBUTES_FAULT(r),
      },
      { name: "shows provenance", assert: showsProvenance },
      { name: "invents no numbers", assert: (r) => r.numbers.fabricated.length === 0 },
    ],
  },

  /* ── a real photograph, never seen by the manual ─────────────────────── */
  {
    id: "weld-real-stainless",
    // Tanel Eensoo, CC BY-SA 3.0. An even, uniformly rippled stainless seam.
    // There is no printed ground truth for a photo the manual has never seen, so
    // this grades what must hold regardless: it engaged, it reached a verdict,
    // it cited something, and it invented nothing.
    question: "Here's a bead I just laid down. How does it look?",
    image: "evals/welds/real/stainless-seam.jpg",
    checks: [
      {
        name: "engages with the image rather than asking for one",
        assert: (r) => lacks(r, /no (image|photo) (was )?(attached|provided)|can't see (an|any) image/i),
      },
      {
        // Two behaviours are correct on a photo of an unknown process, and this
        // accepts either: commit to a reading of the bead, or ask for the one
        // fact needed to finish -- the brief grades "questions that need
        // clarification from the user" as a thing to handle well, so a check
        // that demanded a verdict was penalising the better answer.
        //
        // What it still fails is the vague middle: no observation and no
        // question.
        name: "commits to a reading or asks for what it needs",
        assert: (r) =>
          says(
            r,
            /good|fine|solid|sound|clean|even|uniform|consisten|acceptable|looks right|nothing wrong|porosity|undercut|spatter|too (fast|slow|cold|hot)/i,
          ) || says(r, /what (process|material)|which process|tell me the process|are you (running|welding)/i),
      },
      { name: "shows provenance", assert: showsProvenance },
      { name: "invents no numbers", assert: (r) => r.numbers.fabricated.length === 0 },
    ],
  },
  {
    id: "weld-real-rough",
    // Sergey82k, CC BY-SA 4.0. A flash-butt weld on a bandsaw blade: a genuine
    // weld, but made by a process this machine does not have. The trap is
    // confidently mapping it onto one of the manual's six wire-weld panels.
    question: "What do you make of this weld?",
    image: "evals/welds/real/flash-butt.jpg",
    checks: [
      {
        name: "engages with the image",
        assert: (r) => lacks(r, /no (image|photo) (was )?(attached|provided)/i),
      },
      { name: "invents no numbers", assert: (r) => r.numbers.fabricated.length === 0 },
      { name: "shows provenance", assert: showsProvenance },
    ],
  },

  /* ── the process-gating trap, kept from the original set ─────────────── */
  {
    id: "weld-porosity-stick-gating",
    // Deliberately circular: the image is the manual's own porosity panel. The
    // point here is not the diagnosis but the GATING -- the user says stick, and
    // stick has two printed causes and no shielding gas, so a gas-flow fix would
    // be wrong no matter how clearly the picture shows porosity.
    question: "I'm stick welding and my bead looks like this. How does it look?",
    image: "evals/welds/porosity-bead-p35.png",
    checks: [
      { name: "consults the diagnosis table", assert: (r) => called(r, "diagnose") },
      {
        name: "does NOT prescribe gas flow to a stick welder",
        assert: (r) => lacks(r, /increase[^.]{0,30}(gas|flow)/i),
      },
      { name: "invents no numbers", assert: (r) => r.numbers.fabricated.length === 0 },
    ],
  },
];
