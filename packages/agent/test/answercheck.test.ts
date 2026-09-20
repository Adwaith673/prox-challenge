/**
 * Tests for the prose number checker.
 *
 * Written defensively, because the last two verification bugs in this project
 * were both the CHECK being wrong rather than the thing checked -- once flagging
 * the manual's own printed spec, once flagging a correct refusal. A checker that
 * cries wolf gets ignored, which is worse than not having one. So most of what
 * follows asserts that correct answers come back clean.
 */

import { describe, expect, it } from "vitest";
import { checkAnswer } from "../src/answercheck.js";

describe("grounded numbers pass", () => {
  it("accepts the headline duty-cycle answer", () => {
    const c = checkAnswer(
      "At 175 A on 240 V in TIG the rated duty cycle is 30% (p.14). That's 3 minutes of arc " +
        "time in every 10-minute window.",
    );
    expect(c.fabricated).toEqual([]);
    expect(c.ok).toBe(true);
  });

  it("accepts a polarity answer", () => {
    const c = checkAnswer(
      "For self-shielded flux-core the ground clamp goes in the Positive socket and the wire " +
        "feed lead in the Negative socket (p.13). Maximum OCV is 86 VDC (p.7).",
    );
    expect(c.ok).toBe(true);
  });

  it("accepts gas flow ranges from their own pages", () => {
    const c = checkAnswer("Set SCFH between 20-30 for MIG (p.20), and 10-25 for TIG (p.30).");
    expect(c.fabricated).toEqual([]);
  });
});

describe("fabrication is caught", () => {
  it("flags an interpolated duty cycle", () => {
    // 22% is the classic dangerous answer: plausible, between two rated points,
    // and published nowhere.
    const c = checkAnswer("At 210 A on 240 V MIG you'll get roughly 22% duty cycle.");
    expect(c.fabricated.map((f) => f.value)).toContain("22");
    expect(c.ok).toBe(false);
  });

  it("flags an invented wire feed speed", () => {
    const c = checkAnswer("For 1/8\" steel run about 310 IPM at 19.5 V.");
    const vals = c.fabricated.map((f) => f.value);
    expect(vals).toContain("310");
  });

  it("names the failure in the formatted output", () => {
    const c = checkAnswer("Run it at 640 SCFH.");
    expect(c.fabricated).toHaveLength(1);
    expect(c.fabricated[0]!.why).toMatch(/no page/i);
  });
});

describe("the checker does not cry wolf", () => {
  /**
   * The bug this prevents: asked "what's my duty cycle at 150 amps", the answer
   * repeats 150 A while explaining that 150 is not a published point. 150
   * appears nowhere in the manual -- correctly -- so a naive check calls the
   * agent a liar for quoting the question back.
   */
  it("exempts numbers the user supplied", () => {
    const c = checkAnswer(
      "150 A is not one of the published points for this machine, so I won't give you a " +
        "duty cycle for it.",
      "what's my duty cycle at 150 amps?",
    );
    expect(c.fabricated).toEqual([]);
    expect(c.claims.find((x) => x.value === "150")?.verdict).toBe("echoed");
  });

  /** "p.14" must never be read as a measurement of 14. */
  it("treats page citations as structural, not as claims", () => {
    const c = checkAnswer("The spec table is on p.7 and the ratings on page 14.");
    const verdicts = c.claims.map((x) => x.verdict);
    expect(verdicts.every((v) => v === "structural" || v === "grounded")).toBe(true);
    expect(c.fabricated).toEqual([]);
  });

  /**
   * "40" is a substring of "240". An earlier version of this check used plain
   * substring matching and would ground a fabricated 40% against any page that
   * happened to mention 240 V.
   */
  it("does not ground a number by substring", () => {
    const c = checkAnswer("You'll see about 9999 A here.");
    expect(c.fabricated.map((f) => f.value)).toContain("9999");
  });

  it("accepts a clean refusal with no numbers at all", () => {
    const c = checkAnswer(
      "The manual doesn't publish that. It's on the Settings Chart decal inside the welder door.",
    );
    expect(c.ok).toBe(true);
    expect(c.claims.filter((x) => x.verdict === "fabricated")).toEqual([]);
  });

  it("accepts image-sourced thickness ranges from the selection chart", () => {
    // These exist only in a zero-text JPEG, so they are in the tables but on no
    // page. They must still come back grounded.
    const c = checkAnswer("Stick covers 10 Gauge to 1/2\", and MIG covers 22 Gauge to 3/8\".");
    expect(c.fabricated).toEqual([]);
  });
});

/**
 * Both of these were found by running the checker over real agent answers, not
 * by writing tests. Neither would have shown up in a hand-written example,
 * which is the argument for validating a verifier against live output.
 */
describe("false positives found against real answers", () => {
  it("does not read the denominator of a fraction as a measurement", () => {
    // "5/16\"" was being scanned as a separate "16 inches" -- a dimension the
    // manual never prints -- so a correct thickness table reported two
    // fabrications.
    const c = checkAnswer('Flux-Cored covers 18 Gauge to 5/16", and TIG 24 Gauge to 3/16".');
    expect(c.fabricated).toEqual([]);
  });

  it("does not read a shielding-gas blend as a dimension", () => {
    // "75/25" is argon/CO2, not 75 twenty-fifths of an inch. The checker reported
    // it as an invented fractional dimension in a correct answer about what the
    // machine's display was showing.
    const c = checkAnswer("That's solid wire under 75/25 argon-CO2 shielding gas.");
    expect(c.fabricated).toEqual([]);
  });

  it("grounds values that exist only on the door decal", () => {
    // "3/32" appears ZERO times across all 48 pages -- the Stick electrode
    // diameter lives on the sticker inside the door and nowhere else. Before the
    // decal screens were indexed, quoting it correctly counted as fabrication.
    const c = checkAnswer('Set a 3/32" electrode and the machine will suggest around 60 A.');
    expect(c.fabricated).toEqual([]);
  });

  it("recognises the spec page's VAC as a voltage", () => {
    // p.7 prints "120 VAC 60Hz / 240 VAC 60Hz". An earlier unit pattern required
    // a word boundary after the V, which never fires before "AC", so p.7 did not
    // count as carrying any voltage and every correct citation to it was
    // reported as a miscitation.
    const c = checkAnswer("Run it on 240 V; on 120 V the machine tops out at 140 A (p.7).");
    expect(c.miscited).toEqual([]);
    expect(c.fabricated).toEqual([]);
  });
});

describe("naming a number to rule it out is not inventing it", () => {
  /**
   * Found live, and the most interesting false positive of the set: the checker
   * failed the build over the single most correct sentence in the run.
   */
  it("accepts a current named as an example of what is NOT rated", () => {
    const c = checkAnswer(
      "Duty cycle is a tested thermal result, so there's no valid number at, say, 145 A; " +
        "pick a published point instead.",
    );
    expect(c.fabricated).toEqual([]);
    expect(c.claims.find((x) => x.value === "145")?.verdict).toBe("hypothetical");
  });

  it("accepts a plain non-publication statement", () => {
    expect(checkAnswer("Nothing is rated at 210 A for Stick.").fabricated).toEqual([]);
  });

  it("still catches a fabrication wearing a disclaimer", () => {
    // A negation about vagueness is not a negation about publication. If this
    // ever passes, the exemption has become a loophole.
    const c = checkAnswer("The manual doesn't say much, but at 210 A it's about 22%.");
    expect(c.fabricated.map((f) => f.value)).toContain("22");
  });
});

describe("miscitation is separated from fabrication", () => {
  it("flags a real number attached to the wrong page", () => {
    // 20-30 SCFH is real and printed on p.20. Citing it to p.35 is checkable and
    // wrong, but harmless to act on -- so it must not be called fabrication.
    const c = checkAnswer("Set the flow to 30 SCFH (p.35).");
    const claim = c.claims.find((x) => x.value === "30" && x.verdict !== "structural");
    expect(claim?.verdict).toBe("miscited");
    expect(c.fabricated).toEqual([]);
  });
});

describe("it is fast enough to run on every answer", () => {
  it("checks a long answer in under 50ms", () => {
    const long = "At 175 A on 240 V TIG the duty cycle is 30% (p.14). ".repeat(40);
    const c = checkAnswer(long);
    expect(c.checkedMicros).toBeLessThan(50_000);
  });
});
