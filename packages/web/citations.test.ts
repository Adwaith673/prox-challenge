/**
 * The citation extractor decides what appears in the provenance rail, so a miss
 * silently makes a well-cited answer look uncited.
 */
import { describe, expect, it } from "vitest";
import { citedPagesIn } from "./citations.js";

describe("citedPagesIn", () => {
  it.each([
    ["**DCEN — electrode negative** (p.13).", [13]],
    ["See page 13 for the setup.", [13]],
    ["Rated on p 24 and page 7.", [7, 24]],
    ["p.7, p.14 and p.25 all agree.", [7, 14, 25]],
  ])("extracts from %s", (text, expected) => {
    expect(citedPagesIn(text)).toEqual(expected);
  });

  it.each([
    "the top 13 things to check",
    "set it to 200 A",
    "no citation here at all",
  ])("does not invent a citation from %s", (text) => {
    expect(citedPagesIn(text)).toEqual([]);
  });

  it("ignores page numbers outside the manual", () => {
    expect(citedPagesIn("see page 91")).toEqual([]);
  });
});
