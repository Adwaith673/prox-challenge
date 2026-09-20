/**
 * Derive a wiring diagram from a verified polarity row.
 *
 * This is the only function in the system that decides which cable enters which
 * socket, and it does so from two INDEPENDENT fields of the table row
 * (`workLead` and `electrodeLead`) rather than from the convention name. The
 * verifier then recomputes the same mapping from the same row and demands exact
 * equality, and verify_tables.py separately asserts the two leads differ and
 * that the convention name agrees with the electrode lead.
 *
 * So a polarity error has to survive three independent checks that all read the
 * source differently. A typo fails CI, not the demo.
 */

import type { CircuitSpec, DeviceKind, Provenance } from "../schema.js";
import { portForLead, type PolarityRow } from "../groundTruth.js";

const DEVICE_LABEL: Record<DeviceKind, string> = {
  mig_gun: "MIG gun",
  tig_torch: "TIG torch",
  electrode_holder: "Electrode holder",
  ground_clamp: "Ground clamp",
  spool_gun: "Spool gun",
  gas_cylinder: "Gas cylinder",
};

/** The cable the manual names for each electrode-carrying device. */
const LEAD_LABEL: Record<string, string> = {
  mig_gun: "Wire Feed Power Cable",
  spool_gun: "Wire Feed Power Cable",
  tig_torch: "TIG Torch Cable",
  electrode_holder: "Electrode Holder Cable",
};

export function buildPolarityCircuit(row: PolarityRow): CircuitSpec {
  const src: Provenance = { kind: "table", table: "polarity", row: row.id };

  const electrodePort = portForLead(row.electrodeLead);
  const workPort = portForLead(row.workLead);

  const electrodeDevice = row.electrodeDevice;
  const electrodeCable = LEAD_LABEL[electrodeDevice] ?? "Electrode cable";
  const socketName = (p: string) => (p === "term.positive" ? "Positive" : "Negative");

  return {
    kind: "circuit",
    title: `${row.convention} - ${row.label}`,
    subtitle: `Polarity setup, page ${row.page}`,
    convention: row.convention,
    conventionSrc: src,
    annotations: [],
    nodes: [
      { kind: "machine", id: "welder", label: "OmniPro 220" },
      {
        kind: "device",
        id: "electrode",
        device: electrodeDevice,
        label: DEVICE_LABEL[electrodeDevice],
      },
      { kind: "device", id: "ground", device: "ground_clamp", label: "Ground clamp" },
      { kind: "workpiece", id: "work", label: "Workpiece" },
    ],
    edges: [
      {
        id: "electrode-lead",
        from: { node: "welder", port: electrodePort },
        to: { node: "electrode", port: "dev.lead" },
        medium: "weld_current",
        polaritySign: row.electrodeLead === "positive" ? "+" : "-",
        label: `${electrodeCable} in ${socketName(electrodePort)} Socket`,
        src,
      },
      {
        id: "work-return",
        from: { node: "welder", port: workPort },
        to: { node: "ground", port: "dev.lead" },
        medium: "work_return",
        polaritySign: row.workLead === "positive" ? "+" : "-",
        label: `Ground Clamp Cable in ${socketName(workPort)} Socket`,
        src,
      },
      {
        id: "clamp-to-work",
        from: { node: "ground", port: "dev.lead" },
        to: { node: "work", port: "work.surface" },
        medium: "work_return",
        polaritySign: "none",
        label: "Clamp to bare metal",
        src,
      },
    ],
  };
}
