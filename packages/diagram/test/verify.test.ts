/**
 * L1: pure, deterministic, no API key, no network.
 *
 * The headline claim of this submission is that a wrong wiring diagram cannot be
 * rendered. These tests are the evidence. They run in milliseconds, so the claim
 * is checked on every commit rather than demonstrated once in a README.
 */

import { describe, expect, it } from "vitest";
import { groundTruth, findDuty, findPolarity } from "../src/groundTruth.js";
import { buildPolarityCircuit } from "../src/builders/polarity.js";
import { buildDutyCycleMatrix } from "../src/builders/duty.js";
import { verifyDiagram } from "../src/verify.js";
import { toSvg, checkLegibility } from "../src/svg.js";
import type { CircuitSpec } from "../src/schema.js";

const rows = groundTruth.polarity;

describe("polarity: derived diagrams are correct and stable", () => {
  it.each(rows.map((r) => [r.id, r] as const))("%s verifies", (_id, row) => {
    const result = verifyDiagram(buildPolarityCircuit(row));
    expect(result.ok, result.ok ? "" : JSON.stringify(result.violations)).toBe(true);
  });

  it.each(rows.map((r) => [r.id, r] as const))(
    "%s puts each lead in the socket the table names",
    (_id, row) => {
      const spec = buildPolarityCircuit(row);
      const electrode = spec.edges.find((e) => e.id === "electrode-lead")!;
      const ret = spec.edges.find((e) => e.id === "work-return")!;
      const expectElectrode =
        row.electrodeLead === "positive" ? "term.positive" : "term.negative";
      const expectWork = row.workLead === "positive" ? "term.positive" : "term.negative";
      expect(electrode.from.port).toBe(expectElectrode);
      expect(ret.from.port).toBe(expectWork);
      expect(electrode.from.port).not.toBe(ret.from.port);
    },
  );

  it.each(rows.map((r) => [r.id, r] as const))("%s renders legibly", (_id, row) => {
    const result = verifyDiagram(buildPolarityCircuit(row));
    if (!result.ok) throw new Error("did not verify");
    const leg = checkLegibility(result.spec);
    expect(leg.problems).toEqual([]);
  });

  it.each(rows.map((r) => [r.id, r] as const))("%s renders byte-identically", (_id, row) => {
    const a = verifyDiagram(buildPolarityCircuit(row));
    const b = verifyDiagram(buildPolarityCircuit(row));
    if (!a.ok || !b.ok) throw new Error("did not verify");
    expect(toSvg(a.spec)).toBe(toSvg(b.spec));
  });

  it("MIG is ambiguous without a variant and is not guessed", () => {
    // Solid wire is DCEP, flux-core is DCEN. Picking one silently would be the
    // single most dangerous thing this system could do.
    expect(findPolarity("MIG")).toBeUndefined();
    expect(findPolarity("MIG", "flux_cored_self_shielded")?.convention).toBe("DCEN");
    expect(findPolarity("MIG", "solid_wire_gas_shielded")?.convention).toBe("DCEP");
  });

  it("flux-core and solid MIG are genuinely inverted", () => {
    const flux = findPolarity("MIG", "flux_cored_self_shielded")!;
    const solid = findPolarity("MIG", "solid_wire_gas_shielded")!;
    expect(flux.electrodeLead).not.toBe(solid.electrodeLead);
    expect(flux.workLead).not.toBe(solid.workLead);
  });
});

describe("the verifier refuses wrong diagrams", () => {
  const good = () => buildPolarityCircuit(findPolarity("MIG", "flux_cored_self_shielded")!);

  it("rejects a lead moved to the wrong socket", () => {
    const spec = good();
    const edge = spec.edges.find((e) => e.id === "electrode-lead")!;
    edge.from.port = "term.positive"; // flux-core is DCEN: this is the dangerous error
    edge.polaritySign = "+";
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("WRONG_SOCKET");
  });

  it("rejects a polarity sign that disagrees with its socket", () => {
    const spec = good();
    spec.edges.find((e) => e.id === "work-return")!.polaritySign = "-";
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("SIGN_MISMATCH");
  });

  it("rejects a current-carrying edge that cites a page instead of the table", () => {
    const spec = good();
    spec.edges.find((e) => e.id === "electrode-lead")!.src = {
      kind: "page",
      page: 13,
      quote: "Plug Wire Feed Power Cable into Negative (-) Socket.",
    };
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("EDGE_NOT_IN_TABLE");
  });

  it("rejects a citation to a polarity row that does not exist", () => {
    const spec = good();
    spec.edges.find((e) => e.id === "electrode-lead")!.src = {
      kind: "table",
      table: "polarity",
      row: "ac_tig_aluminum",
    };
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
  });

  it("rejects a DCEN circuit badged DCEP", () => {
    const spec = good() as CircuitSpec;
    spec.convention = "DCEP";
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("CONVENTION_MISMATCH");
  });

  it("rejects two cables landing on one socket", () => {
    const spec = good();
    spec.edges.find((e) => e.id === "work-return")!.from.port = "term.negative";
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("TOPOLOGY");
  });

  it("rejects a number that is not in the cited source", () => {
    const spec = good();
    spec.edges.find((e) => e.id === "electrode-lead")!.label = "Set to 220 A";
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.code)).toContain("UNCITED_NUMBER");
  });
});

describe("duty cycle: the key is the triple, not the amperage", () => {
  it("175 A at 240 V differs between TIG and Stick", () => {
    const tig = findDuty("TIG", 240)!.points.find((p) => p.amps === 175)!;
    const stick = findDuty("Stick", 240)!.points.find((p) => p.amps === 175)!;
    expect(tig.dutyPct).toBe(30);
    expect(stick.dutyPct).toBe(25);
    expect(tig.arcVolts).not.toBe(stick.arcVolts);
  });

  it.each([
    ["MIG", 240, 220, 200],
    ["MIG", 120, 140, 100],
  ] as const)(
    "%s at %i V reaches %i A but publishes nothing above %i A",
    (process, volts, reach, published) => {
      const row = findDuty(process, volts)!;
      expect(row.outputRange.maxAmps).toBe(reach);
      expect(row.maxPublishedAmps).toBe(published);
      expect(row.unpublishedAbove).toBe(published);
    },
  );

  it("renders unpublished tiers as holes, not blanks", () => {
    const spec = buildDutyCycleMatrix();
    if (spec.kind !== "matrix") throw new Error("expected a matrix");
    const holes = spec.rows.flatMap((r) => r.cells).filter((c) => c.state === "hole");
    expect(holes.length).toBeGreaterThan(0);
    // Every cell is either a cited value or an explicit hole. Never empty.
    for (const row of spec.rows) {
      for (const cell of row.cells) {
        expect(["value", "hole"]).toContain(cell.state);
      }
    }
  });

  it("verifies and every printed number traces to the table", () => {
    const result = verifyDiagram(buildDutyCycleMatrix());
    expect(result.ok, result.ok ? "" : JSON.stringify(result.violations)).toBe(true);
  });
});

describe("quantity checking accepts real citations and rejects invented ones", () => {
  const matrixWith = (value: string, quote: string) =>
    ({
      kind: "matrix" as const,
      title: "Gas flow",
      annotations: [],
      columns: ["setting"],
      rows: [
        {
          header: "MIG",
          cells: [
            { state: "value" as const, value, src: { kind: "page" as const, page: 20, quote } },
          ],
        },
      ],
    });

  it("accepts a value whose unit precedes the number in the source", () => {
    // Page 20 really reads "Set SCFH between 20-30" -- unit first. Requiring the
    // number and unit to be adjacent would reject this correct citation.
    const spec = matrixWith("20-30 SCFH", "Connect gas according to screen. Set SCFH between 20-30.");
    expect(verifyDiagram(spec).ok).toBe(true);
  });

  it("accepts a value written exactly as the source writes it", () => {
    const spec = matrixWith("200 A", "X 25% 60% 100% U0 = 78V I2 200A 130A 115A U2 24V");
    expect(verifyDiagram(spec).ok).toBe(true);
  });

  it("still rejects a number that appears nowhere in the source", () => {
    const spec = matrixWith("250 A", "Connect gas according to screen. Set SCFH between 20-30.");
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations[0]!.code).toBe("UNCITED_NUMBER");
  });

  it("rejects a plausible number carrying a unit the source never mentions", () => {
    const spec = matrixWith("20 IPM", "Connect gas according to screen. Set SCFH between 20-30.");
    const result = verifyDiagram(spec);
    expect(result.ok).toBe(false);
  });
});

describe("the machine is DC only", () => {
  it("no polarity row uses an AC convention", () => {
    for (const row of groundTruth.polarity) {
      expect(["DCEP", "DCEN"]).toContain(row.convention);
    }
  });

  it("the AC TIG contradiction is recorded with its refutation", () => {
    const c = groundTruth.contradictions.find((x) => x.id === "ac_tig_aluminum");
    expect(c).toBeDefined();
    expect(c!.page).toBe(28);
    expect(c!.refutedBy.length).toBeGreaterThan(0);
    expect(c!.refutedBy.some((r) => r.quote.includes("86 VDC"))).toBe(true);
  });
});
