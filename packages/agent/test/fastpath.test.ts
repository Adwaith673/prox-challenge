/**
 * The voice fast path must be as disciplined as the slow one.
 *
 * A quick wrong answer spoken aloud in a workshop is worse than a slow right
 * one, so these assert the same refusals the full agent makes -- including that
 * it will not invent a duty cycle above the published ceiling, and will not pick
 * a MIG polarity when the variant is ambiguous.
 *
 * And it must be FAST. There is a latency assertion, because "sub-200ms" is the
 * entire reason this path exists.
 */

import { describe, expect, it } from "vitest";
import { fastAnswer } from "../src/fastpath.js";

describe("answers the questions a welder actually shouts", () => {
  it("flux-core polarity, with the sockets the right way round", () => {
    const a = fastAnswer("what polarity for flux core?")!;
    expect(a.intent).toBe("polarity");
    expect(a.text).toContain("DCEN");
    // Flux-core: wire feed NEGATIVE, ground POSITIVE.
    expect(a.text).toMatch(/wire feed power cable.*negative/i);
    expect(a.text).toMatch(/ground clamp.*positive/i);
    expect(a.citedPages).toContain(13);
  });

  it("solid-wire MIG is the inverse", () => {
    const a = fastAnswer("polarity for solid wire mig with gas")!;
    expect(a.text).toContain("DCEP");
    expect(a.text).toMatch(/wire feed power cable.*positive/i);
  });

  it("stick duty cycle at 175 on 240", () => {
    const a = fastAnswer("duty cycle at 175 amps on stick, 240v")!;
    expect(a.intent).toBe("duty_cycle");
    expect(a.text).toContain("25%");
    expect(a.text).not.toContain("30%");
  });

  it("TIG at the same current gives a different answer", () => {
    const a = fastAnswer("duty cycle at 175 amps tig 240v")!;
    expect(a.text).toContain("30%");
  });
});

describe("it refuses exactly where the slow path refuses", () => {
  it("will not name a duty cycle above the published ceiling", () => {
    const a = fastAnswer("duty cycle at 220 amps on mig, 240 volts")!;
    expect(a.intent).toBe("refusal");
    expect(a.text).toMatch(/no duty cycle is published/i);
    expect(a.text).toContain("200 A");
    // Must not state a percentage for 220 A.
    expect(a.text).not.toMatch(/220\s?A[^.]{0,30}\d{1,3}\s?%/);
  });

  it("will not pick a MIG polarity when the variant is ambiguous", () => {
    const a = fastAnswer("what polarity for mig?")!;
    expect(a.intent).toBe("refusal");
    expect(a.text).toContain("DCEP");
    expect(a.text).toContain("DCEN");
    expect(a.text).toMatch(/which/i);
  });

  it("asks for the missing key rather than guessing a duty cycle", () => {
    const a = fastAnswer("what's my duty cycle?")!;
    expect(a.intent).toBe("refusal");
    expect(a.text).toMatch(/process|voltage/i);
  });

  it("does not hand a stick welder a gas-flow fix", () => {
    const a = fastAnswer("porosity on stick with 7018")!;
    expect(a.intent).toBe("porosity");
    expect(a.text).toMatch(/no shielding gas/i);
    expect(a.text).not.toMatch(/increase.{0,20}gas/i);
  });
});

describe("it hands off rather than guessing", () => {
  it.each([
    "what voltage and wire speed for 1/8 inch steel",
    "can I weld titanium",
    "why is my machine making a noise",
    "write me a poem",
  ])("returns null for %s", (q) => {
    expect(fastAnswer(q)).toBeNull();
  });
});

describe("latency", () => {
  it("answers far inside the 200ms conversational budget", () => {
    const questions = [
      "what polarity for flux core?",
      "duty cycle at 175 amps on stick 240v",
      "porosity on stick",
      "duty cycle at 220 amps on mig 240 volts",
    ];
    const start = performance.now();
    for (let i = 0; i < 250; i++) for (const q of questions) fastAnswer(q);
    const perCall = (performance.now() - start) / (250 * questions.length);
    // Budget is 200ms for the WHOLE turn including speech synthesis; the lookup
    // itself should be invisible.
    expect(perCall).toBeLessThan(1);
  });
});

describe("speech output is speakable", () => {
  it("contains no markdown or page abbreviations", () => {
    for (const q of ["what polarity for flux core?", "duty cycle at 175 amps stick 240v"]) {
      const a = fastAnswer(q)!;
      expect(a.speech).not.toMatch(/[*_#|]/);
      expect(a.speech).not.toMatch(/\bp\.\d/);
    }
  });
});
