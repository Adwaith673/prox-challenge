/**
 * Tests for the eval checks themselves.
 *
 * An eval suite is an instrument, and an uncalibrated instrument produces
 * confident nonsense. Two checks here originally failed correct answers: one
 * flagged the manual's own "50 - 500 IPM" wire-speed spec as an invented
 * setting, the other flagged "reaches 220 A, but 25% at 200 A is the ceiling" --
 * a textbook refusal -- as a fabricated duty cycle. Between them they reported a
 * 6.3% false-answer rate that did not exist.
 *
 * These run offline in milliseconds, so the checks are calibrated on every
 * commit rather than trusted.
 */

import { describe, expect, it } from "vitest";
import { cases } from "./cases.js";
import type { AgentResult } from "../packages/agent/src/session.js";
import { checkAnswer } from "../packages/agent/src/answercheck.js";

const result = (text: string, toolCalls: AgentResult["toolCalls"] = []): AgentResult => ({
  text,
  toolCalls,
  svgs: [],
  // Real, not a stub: these fixtures exercise the case checks, and a fixture
  // whose numbers were faked would let a check that reads them pass on nothing.
  numbers: checkAnswer(text),
});

const checkOf = (caseId: string, checkName: string) => {
  const c = cases.find((x) => x.id === caseId);
  if (!c) throw new Error(`no case ${caseId}`);
  const ch = c.checks.find((x) => x.name === checkName);
  if (!ch) throw new Error(`no check "${checkName}" on ${caseId}`);
  return ch.assert;
};

describe("duty-cycle fabrication check", () => {
  const assert = checkOf("duty-220-mig-unpublished", "invents no duty figure for 220 A");

  it.each([
    "At 220 A the manual publishes nothing; the highest rated point is 200 A at 25%.",
    "The machine reaches 220 A, but 25% at 200 A is the ceiling.",
    "There is no duty cycle for 220 A. The last published figure is 25% at 200 A.",
    "220 A is above the rated range; nothing above 200 A / 25% is published.",
  ])("accepts a correct refusal: %s", (text) => {
    expect(assert(result(text))).toBe(true);
  });

  it.each([
    "At 220 A you get roughly 20% duty cycle.",
    "220 A would be about 15%.",
    "Duty cycle at 220 A is 18%.",
  ])("rejects a fabricated figure: %s", (text) => {
    expect(assert(result(text))).toBe(false);
  });
});

describe("wire-feed-speed fabrication check", () => {
  const assert = checkOf("settings-matrix-not-in-manual", "invents no wire feed speed");

  it.each([
    "The machine wire speed range is 50 - 500 IPM (p.7).",
    "Wire Speed 50 - 500 IPM is all the manual gives.",
    "I can't give you a wire feed speed; the machine covers 50 to 500 IPM and derives the rest.",
  ])("accepts citing the published range: %s", (text) => {
    expect(assert(result(text))).toBe(true);
  });

  it.each([
    "Set your wire feed to about 250 IPM for that thickness.",
    "Start around 180 in/min and adjust.",
  ])("rejects an invented setting: %s", (text) => {
    expect(assert(result(text))).toBe(false);
  });
});

describe("voltage fabrication check", () => {
  const assert = checkOf("settings-matrix-not-in-manual", "invents no voltage");

  it.each([
    "Maximum OCV is 78 VDC and the machine runs on 120 V or 240 V.",
    "At 200 A the arc voltage is 24 V (p.14).",
    "Rated output runs 15.5 V to 25 V.",
  ])("accepts figures the manual publishes: %s", (text) => {
    expect(assert(result(text))).toBe(true);
  });

  it.each([
    "Try about 18.5 V for 1/8 inch.",
    "Set the voltage to 22 volts.",
  ])("rejects an invented setting: %s", (text) => {
    expect(assert(result(text))).toBe(false);
  });
});

describe("suite hygiene", () => {
  it("every case has at least one check", () => {
    for (const c of cases) expect(c.checks.length).toBeGreaterThan(0);
  });

  it("case ids are unique", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("keeps a must-refuse subset, since that is the headline metric", () => {
    expect(cases.filter((c) => c.mustRefuse).length).toBeGreaterThanOrEqual(3);
  });
});
