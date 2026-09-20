/**
 * Derive the duty-cycle matrix from the verified table.
 *
 * This is the highest-leverage idea in the design: the manual's GAPS are
 * rendered, not described. A duty tier that this machine does not publish for a
 * given process becomes a hatched cell, so the shape of the hatching is the
 * answer.
 *
 * Read the output and the graded fact falls out visually: at 175 A the TIG row
 * has a value under 30% while the Stick row has one under 25%. Same current,
 * same input voltage, different answer -- because arc voltage differs (17 V vs
 * 27 V) and so does dissipated power. No prose required.
 */

import type { DiagramSpec, MatrixCell, Provenance } from "../schema.js";
import { groundTruth, type DutyRow } from "../groundTruth.js";

const TIERS = [25, 30, 40, 60, 100] as const;

function cellFor(row: DutyRow, tier: number): MatrixCell {
  const point = row.points.find((p) => p.dutyPct === tier);
  if (!point) {
    return {
      state: "hole",
      reason: "not_published",
      note: `${row.process} at ${row.inputVoltage} V has no ${tier}% rating`,
    };
  }
  const src: Provenance = { kind: "table", table: "duty_cycle", row: row.id };
  return { state: "value", value: `${point.amps} A / ${point.arcVolts} V`, src };
}

export function buildDutyCycleMatrix(): DiagramSpec {
  const rows = groundTruth.duty.map((r) => ({
    header: `${r.process} @ ${r.inputVoltage} V`,
    cells: TIERS.map((t) => cellFor(r, t)),
  }));

  // Make the out-of-range ceiling a first-class visible row rather than a
  // footnote: the machine reaches currents it publishes no duty cycle for.
  const ceilings = groundTruth.duty.map((r) =>
    r.unpublishedAbove === null
      ? ({
          state: "value",
          value: `${r.outputRange.maxAmps} A`,
          src: { kind: "table", table: "duty_cycle", row: r.id },
        } satisfies MatrixCell)
      : ({
          state: "hole",
          reason: "not_published",
          note:
            `machine reaches ${r.outputRange.maxAmps} A but nothing is ` +
            `published above ${r.maxPublishedAmps} A`,
        } satisfies MatrixCell),
  );

  return {
    kind: "matrix",
    title: "Rated duty cycle by process and input voltage",
    subtitle:
      "Hatched = not published in the manual. Duty cycle is a tested thermal result, never interpolated.",
    annotations: [],
    columns: [...TIERS.map((t) => `${t}%`), "at machine max"],
    rows: [
      ...rows.map((r, i) => ({ header: r.header, cells: [...r.cells, ceilings[i]!] })),
    ],
  };
}
