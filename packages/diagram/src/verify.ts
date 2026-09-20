/**
 * The guarantee.
 *
 * `toSvg` accepts only a `VerifiedSpec`, and the sole way to mint one is
 * `verifyDiagram`. The brand is a unique symbol, so it cannot be forged by a
 * cast from a plain object literal. There is therefore no compile-legal path
 * from an unverified spec to a rendered picture.
 *
 * Concretely: if the model claims the flux-core ground clamp goes in the
 * negative socket, verification recomputes both ports from the polarity table
 * row the model itself cited, finds they disagree, and refuses. The wrong
 * diagram is never drawn -- not "usually caught", never drawn.
 */

import type { CircuitSpec, DiagramSpec, MatrixSpec, Provenance } from "./schema.js";
import { groundTruth, portForLead, type GroundTruth } from "./groundTruth.js";

declare const verified: unique symbol;
export type VerifiedSpec = DiagramSpec & { readonly [verified]: true };

export interface Violation {
  code:
    | "EDGE_NOT_IN_TABLE"
    | "WRONG_SOCKET"
    | "SIGN_MISMATCH"
    | "CONVENTION_MISMATCH"
    | "TOPOLOGY"
    | "UNCITED_NUMBER"
    | "UNKNOWN_NODE";
  message: string;
  edgeId?: string;
  expected?: string;
  got?: string;
}

export type VerifyResult =
  | { ok: true; spec: VerifiedSpec }
  | { ok: false; violations: Violation[] };

const QUANTITY = /\b(\d+(?:\.\d+)?)\s?(A|V|%|in|mm|SCFH|IPM)\b/gi;

function resolveQuote(src: Provenance, g: GroundTruth): string | undefined {
  if (src.kind === "page") return src.quote;
  switch (src.table) {
    case "polarity":
      return g.polarity.find((r) => r.id === src.row)?.quote;
    case "duty_cycle":
      return g.duty.find((r) => r.id === src.row)?.quote;
    case "diagnosis":
      return g.diagnosis.find((r) => r.id === src.row)?.quote;
    case "unanswerable":
      return g.gaps.find((r) => r.id === src.row)?.claim;
  }
}

/**
 * Any quantity printed on a diagram must appear in the source it cites.
 *
 * The number and its unit are checked SEPARATELY rather than as an adjacent
 * pair. Requiring adjacency looks stricter but is simply wrong against real
 * documents: page 20 reads "Set SCFH between 20-30", unit first, so a correctly
 * cited "20-30 SCFH" cell would be rejected. That false positive is worse than
 * the laxity it buys -- it blocks true answers, and an agent that cannot render
 * a cited value learns to stop citing.
 *
 * The check still does its real job: a fabricated "250 A" fails, because 250
 * appears nowhere in the quote.
 */
function checkQuantities(
  label: string,
  src: Provenance,
  g: GroundTruth,
  where: string,
  out: Violation[],
): void {
  const quantities = [...label.matchAll(QUANTITY)];
  if (quantities.length === 0) return;
  const quote = (resolveQuote(src, g) ?? "").toLowerCase();
  const digitsOnly = quote.replace(/[^0-9.]/g, " ");

  for (const m of quantities) {
    const num = m[1]!;
    const unit = m[2]!.toLowerCase();
    const hasNumber = new RegExp(`(^|[^0-9.])${num.replace(".", "\\.")}([^0-9]|$)`).test(
      digitsOnly,
    ) || quote.includes(num);
    const hasUnit = quote.includes(unit);
    if (!hasNumber) {
      out.push({
        code: "UNCITED_NUMBER",
        message: `${where}: prints "${m[0]}" but ${num} does not appear in the cited source`,
        expected: m[0],
      });
    } else if (!hasUnit) {
      out.push({
        code: "UNCITED_NUMBER",
        message: `${where}: prints "${m[0]}" but the unit "${unit}" does not appear in the cited source`,
        expected: m[0],
      });
    }
  }
}

function verifyCircuit(spec: CircuitSpec, g: GroundTruth, out: Violation[]): void {
  const nodeIds = new Set(spec.nodes.map((n) => n.id));
  for (const e of spec.edges) {
    for (const end of [e.from, e.to]) {
      if (!nodeIds.has(end.node)) {
        out.push({
          code: "UNKNOWN_NODE",
          message: `edge ${e.id} references node "${end.node}", which is not in the spec`,
          edgeId: e.id,
        });
      }
    }
  }

  const machineEdges = spec.edges.filter(
    (e) => e.from.node === "welder" || e.to.node === "welder",
  );

  // TOPOLOGY: one socket cannot carry two leads.
  const usedPorts = new Map<string, string>();
  for (const e of machineEdges) {
    const port = e.from.node === "welder" ? e.from.port : e.to.port;
    if (port !== "term.positive" && port !== "term.negative") continue;
    const prior = usedPorts.get(port);
    if (prior) {
      out.push({
        code: "TOPOLOGY",
        message: `both "${prior}" and "${e.id}" land on ${port}; a socket takes one cable`,
        edgeId: e.id,
      });
    }
    usedPorts.set(port, e.id);
  }

  // TOPOLOGY: exactly one return path from the machine.
  const returns = machineEdges.filter((e) => e.medium === "work_return");
  if (returns.length !== 1) {
    out.push({
      code: "TOPOLOGY",
      message: `expected exactly 1 work_return edge at the welder, found ${returns.length}`,
    });
  }

  for (const e of spec.edges) {
    const machineSide = e.from.node === "welder" ? e.from : e.to.node === "welder" ? e.to : null;

    // SIGN: the redundant polaritySign must agree with the socket it names.
    if (machineSide && e.polaritySign !== "none") {
      const expectSign = machineSide.port === "term.positive" ? "+" : "-";
      if (e.polaritySign !== expectSign) {
        out.push({
          code: "SIGN_MISMATCH",
          message: `edge ${e.id} is on ${machineSide.port} but is signed "${e.polaritySign}"`,
          edgeId: e.id,
          expected: expectSign,
          got: e.polaritySign,
        });
      }
    }

    checkQuantities(e.label, e.src, g, `edge ${e.id}`, out);

    // The load-bearing rule. Current-carrying edges at the machine must come
    // from the polarity table, and the sockets are recomputed from that row.
    if (!machineSide) continue;
    if (e.medium !== "weld_current" && e.medium !== "work_return") continue;

    if (e.src.kind !== "table" || e.src.table !== "polarity") {
      out.push({
        code: "EDGE_NOT_IN_TABLE",
        message: `edge ${e.id} carries current but cites ${
          e.src.kind === "page" ? `page ${e.src.page}` : e.src.table
        }; it must cite a polarity table row`,
        edgeId: e.id,
      });
      continue;
    }

    const citedRowId = e.src.row;
    const cited = g.polarity.find((r) => r.id === citedRowId);
    if (!cited) {
      out.push({
        code: "EDGE_NOT_IN_TABLE",
        message: `edge ${e.id} cites polarity row "${citedRowId}", which does not exist`,
        edgeId: e.id,
      });
      continue;
    }

    const expectedPort =
      e.medium === "work_return"
        ? portForLead(cited.workLead)
        : portForLead(cited.electrodeLead);

    if (machineSide.port !== expectedPort) {
      out.push({
        code: "WRONG_SOCKET",
        message:
          `edge ${e.id} (${e.medium}) lands on ${machineSide.port}, but polarity row ` +
          `"${cited.id}" puts it on ${expectedPort}`,
        edgeId: e.id,
        expected: expectedPort,
        got: machineSide.port,
      });
    }

    if (spec.convention !== cited.convention) {
      out.push({
        code: "CONVENTION_MISMATCH",
        message: `spec is badged ${spec.convention} but row "${cited.id}" is ${cited.convention}`,
        expected: cited.convention,
        got: spec.convention,
      });
    }
  }
}

function verifyMatrix(spec: MatrixSpec, g: GroundTruth, out: Violation[]): void {
  for (const row of spec.rows) {
    if (row.cells.length !== spec.columns.length) {
      out.push({
        code: "TOPOLOGY",
        message: `row "${row.header}" has ${row.cells.length} cells but there are ${spec.columns.length} columns`,
      });
    }
    for (const [i, cell] of row.cells.entries()) {
      if (cell.state !== "value") continue;
      checkQuantities(cell.value, cell.src, g, `cell ${row.header}/${spec.columns[i]}`, out);
    }
  }
}

export function verifyDiagram(spec: DiagramSpec, g: GroundTruth = groundTruth): VerifyResult {
  const violations: Violation[] = [];
  if (spec.kind === "circuit") verifyCircuit(spec, g, violations);
  else verifyMatrix(spec, g, violations);

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, spec: spec as VerifiedSpec };
}
