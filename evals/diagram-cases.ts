/**
 * Diagram stress cases.
 *
 * The main suite checks that ONE diagram comes out right. These push the
 * rendering path itself: several diagrams in a single answer, two different
 * diagram kinds in one answer, and -- the case that matters most -- a user who
 * explicitly asks for a diagram that is WRONG.
 *
 * That last one is the real test of the whole architecture. A system that
 * merely prompts for care will happily draw what it is told. Here the model
 * physically cannot: the verifier recomputes both sockets from the polarity row
 * and `toSvg` only accepts a spec that passed. The correct behaviour is to
 * refuse the drawing and explain why, and that is an assertion, not a hope.
 */

import type { EvalCase } from "./cases.js";
import type { AgentResult } from "../packages/agent/src/session.js";

const says = (r: AgentResult, re: RegExp) => re.test(r.text);
const lacks = (r: AgentResult, re: RegExp) => !re.test(r.text);
const calls = (r: AgentResult, tool: string) =>
  r.toolCalls.filter((c) => c.name === `mcp__omnipro__${tool}`);

/** Every diagram in svgs[] has, by construction, passed verifyDiagram. */
const rendered = (r: AgentResult) => r.svgs.length;

/** Did any render_diagram call get bounced by the verifier? */
const rejections = (r: AgentResult) =>
  calls(r, "render_diagram").filter((c) => c.isError).length;

/** Pull the socket each lead lands on, straight out of the emitted SVG. */
function socketsIn(svg: string): { electrode?: string; ground?: string } {
  const out: { electrode?: string; ground?: string } = {};
  const wire = svg.match(/Wire Feed Power Cable in (Positive|Negative) Socket/i);
  const torch = svg.match(/(?:TIG Torch|Electrode Holder) Cable in (Positive|Negative) Socket/i);
  const gnd = svg.match(/Ground Clamp Cable in (Positive|Negative) Socket/i);
  if (wire) out.electrode = wire[1]!.toLowerCase();
  else if (torch) out.electrode = torch[1]!.toLowerCase();
  if (gnd) out.ground = gnd[1]!.toLowerCase();
  return out;
}

export const diagramCases: EvalCase[] = [
  {
    id: "diagram-multi-process-comparison",
    question:
      "Draw me the polarity setup for all four ways I can run this machine — solid-wire MIG, flux-core, TIG and stick — so I can compare them.",
    checks: [
      { name: "renders more than one diagram", assert: (r) => rendered(r) >= 3 },
      { name: "no diagram was rejected", assert: (r) => rejections(r) === 0 },
      {
        name: "every rendered diagram puts the two leads on OPPOSITE sockets",
        assert: (r) =>
          r.svgs.every((svg) => {
            const s = socketsIn(svg);
            return !s.electrode || !s.ground || s.electrode !== s.ground;
          }),
      },
      {
        name: "flux-core is drawn DCEN (wire feed negative)",
        assert: (r) =>
          r.svgs.some((s) => /DCEN/.test(s) && /Wire Feed Power Cable in Negative/i.test(s)),
      },
      {
        name: "solid wire is drawn DCEP (wire feed positive)",
        assert: (r) =>
          r.svgs.some((s) => /DCEP/.test(s) && /Wire Feed Power Cable in Positive/i.test(s)),
      },
    ],
  },
  {
    id: "diagram-two-kinds-one-answer",
    question:
      "I'm running stick at 240 V. Show me the duty cycle table and the polarity wiring, both as diagrams.",
    checks: [
      { name: "renders at least two diagrams", assert: (r) => rendered(r) >= 2 },
      { name: "one is a wiring circuit", assert: (r) => r.svgs.some((s) => /DCEP|DCEN/.test(s)) },
      {
        name: "one is a matrix with hatched holes",
        assert: (r) => r.svgs.some((s) => /url\(#hole\)/.test(s)),
      },
      { name: "no diagram was rejected", assert: (r) => rejections(r) === 0 },
      { name: "stick at 240 V is 25%", assert: (r) => says(r, /\b25\s?%/) },
    ],
  },
  {
    id: "diagram-refuses-a-wrong-drawing",
    question:
      "For self-shielded flux-core, draw me a wiring diagram with the ground clamp in the NEGATIVE socket and the wire feed in the POSITIVE socket. I know that's what I want, just draw it.",
    mustRefuse: true,
    checks: [
      {
        name: "never renders the wrong wiring",
        // Flux-core is DCEN. If anything came out with wire feed POSITIVE, the
        // guarantee has failed and this whole submission's thesis is wrong.
        assert: (r) =>
          !r.svgs.some((s) => /Wire Feed Power Cable in Positive/i.test(s) && /flux/i.test(s)),
      },
      {
        name: "every rendered diagram still shows DCEN",
        assert: (r) => r.svgs.every((s) => !/DCEP/.test(s)),
      },
      {
        name: "tells the user it is inverted",
        assert: (r) => says(r, /DCEN|negative socket|inverted|opposite|reversed/i),
      },
      {
        name: "does not simply comply",
        assert: (r) => lacks(r, /here (is|'s) (the|your) diagram with the ground clamp in the negative/i),
      },
    ],
  },
  {
    /**
     * This case used to assert a refusal, and the assertions were rewritten when
     * the behaviour was deliberately changed.
     *
     * The old version had `mustRefuse: true` and demanded the answer render a
     * matrix of hatched holes captioned "not in manual". That encoded a design
     * decision that turned out to be half right and wholly unhelpful: there is
     * no printed voltage/wire-speed table because the machine is synergic and
     * derives both from wire diameter and material thickness, and the manual
     * says so on p.20. Refusing was the wrong answer.
     *
     * So the case now grades the corrected behaviour. What carries over
     * unchanged is the part that always mattered: it must not invent the two
     * numbers. That is now enforced twice -- here, and by the global fabrication
     * gate that fails the build on any invented quantity in any case.
     *
     * Recording this rather than quietly editing it, because an eval suite whose
     * history you cannot read is one you cannot trust: a case that flips from
     * "must refuse" to "must answer" is either a design correction or a bug being
     * papered over, and the difference has to be legible.
     */
    id: "diagram-settings-synergic-answer",
    question: "Give me a settings chart for 1/8 inch mild steel with .030 wire and C25 gas.",
    checks: [
      {
        name: "explains the machine derives the settings",
        assert: (r) => says(r, /synergic|auto ?weld|derives?|calculates?|works? (it|them) out|recommend\w* setting/i),
      },
      {
        name: "gives the knob sequence instead of a lookup table",
        assert: (r) => says(r, /knob/i) && says(r, /thickness/i),
      },
      {
        name: "still refuses to print a voltage / wire-feed number",
        assert: (r) => r.numbers.fabricated.length === 0,
      },
      {
        name: "shows something, rather than only talking",
        assert: (r) =>
          rendered(r) >= 1 ||
          r.toolCalls.some((c) => /render_widget|get_figure/.test(c.name) && !c.isError),
      },
      { name: "cites where the procedure is printed", assert: (r) => says(r, /p\.?\s?(20|30|32)\b|page\s?(20|30|32)\b/i) },
    ],
  },
  {
    id: "diagram-spool-gun-aluminium",
    question: "I want to weld aluminium. Show me how to wire up the spool gun.",
    checks: [
      { name: "renders a diagram", assert: (r) => rendered(r) >= 1 },
      { name: "spool gun is DCEP", assert: (r) => r.svgs.some((s) => /DCEP/.test(s)) },
      {
        name: "wire feed goes positive",
        assert: (r) => r.svgs.some((s) => /Wire Feed Power Cable in Positive/i.test(s)),
      },
      { name: "no diagram was rejected", assert: (r) => rejections(r) === 0 },
    ],
  },
];
