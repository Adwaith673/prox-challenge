/**
 * Deterministic layout.
 *
 * No graph-layout library and no force simulation. The topology here is tiny and
 * highly stereotyped -- one machine, two or three leads, a workpiece -- so a
 * force-directed solver would be nondeterministic (which kills golden-file
 * tests), ugly at n=4, and impossible to reason about. Instead: fixed slots with
 * named port anchors, and slot assignment by device role rather than by the
 * order the model happened to list nodes in.
 *
 * Same spec in, byte-identical geometry out, every time.
 */

import type { CircuitSpec, MatrixSpec, PortId } from "./schema.js";

export const CANVAS = { w: 940, h: 470 } as const;

const MACHINE = { x: 70, y: 120, w: 215, h: 205 } as const;

/** Where each cable physically attaches on the machine. */
const PORT_ANCHOR: Record<PortId, { x: number; y: number }> = {
  "term.positive": { x: MACHINE.x + MACHINE.w, y: 232 },
  "term.negative": { x: MACHINE.x + MACHINE.w, y: 282 },
  "term.euro_gun": { x: MACHINE.x + MACHINE.w, y: 182 },
  "term.gas_in": { x: MACHINE.x, y: 160 },
  "dev.lead": { x: 0, y: 0 },
  "work.surface": { x: 0, y: 0 },
};

/** Device slots, assigned by role. Never by array order. */
const SLOT = {
  electrode: { x: 700, y: 118, w: 192, h: 72 },
  ground: { x: 700, y: 238, w: 192, h: 72 },
  work: { x: 372, y: 376, w: 330, h: 52 },
} as const;

export interface LaidNode {
  id: string;
  kind: "machine" | "device" | "workpiece";
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidEdge {
  id: string;
  label: string;
  medium: "weld_current" | "work_return" | "shielding_gas";
  polaritySign: "+" | "-" | "none";
  points: Array<{ x: number; y: number }>;
  labelAt: { x: number; y: number; anchor: "start" | "middle" | "end" };
  /** Length of the run the label sits on; the legibility check compares against it. */
  runWidth: number;
}

export interface LaidCircuit {
  kind: "circuit";
  title: string;
  subtitle?: string;
  convention: "DCEP" | "DCEN";
  nodes: LaidNode[];
  edges: LaidEdge[];
}

const centre = (n: { x: number; y: number; w: number; h: number }) => ({
  x: n.x + n.w / 2,
  y: n.y + n.h / 2,
});

export function layoutCircuit(spec: CircuitSpec): LaidCircuit {
  const nodes: LaidNode[] = [];
  const byId = new Map<string, LaidNode>();

  for (const n of spec.nodes) {
    let box: { x: number; y: number; w: number; h: number };
    if (n.kind === "machine") box = MACHINE;
    else if (n.kind === "workpiece") box = SLOT.work;
    else box = n.device === "ground_clamp" ? SLOT.ground : SLOT.electrode;

    const laid: LaidNode = { id: n.id, kind: n.kind, label: n.label, ...box };
    nodes.push(laid);
    byId.set(n.id, laid);
  }

  const edges: LaidEdge[] = [];
  // Lane index keyed on the machine port's vertical rank, so two cables leaving
  // the machine never share a vertical run.
  const laneFor = (y: number) => 320 + Math.round((y - 180) / 50) * 26;

  for (const e of spec.edges) {
    const a = byId.get(e.from.node);
    const b = byId.get(e.to.node);
    if (!a || !b) continue;

    let pts: Array<{ x: number; y: number }>;

    if (a.kind === "machine") {
      const start = PORT_ANCHOR[e.from.port];
      const end = centre(b);
      const lane = laneFor(start.y);
      pts = [
        { x: start.x, y: start.y },
        { x: lane, y: start.y },
        { x: lane, y: end.y },
        { x: b.x, y: end.y },
      ];
    } else if (b.kind === "machine") {
      const end = PORT_ANCHOR[e.to.port];
      const start = centre(a);
      const lane = laneFor(end.y);
      pts = [
        { x: a.x, y: start.y },
        { x: lane, y: start.y },
        { x: lane, y: end.y },
        { x: end.x, y: end.y },
      ];
    } else {
      // device -> workpiece
      const s = centre(a);
      const t = centre(b);
      pts = [
        { x: s.x, y: a.y + a.h },
        { x: s.x, y: (a.y + a.h + b.y) / 2 },
        { x: t.x, y: (a.y + a.h + b.y) / 2 },
        { x: t.x, y: b.y },
      ];
    }

    // Sit the label at the START of the longest horizontal run, reading into the
    // device. Centring it overruns the device box on long labels like
    // "Wire Feed Power Cable in Negative Socket"; left-anchoring cannot.
    let best = { len: -1, x: pts[0]!.x, y: pts[0]!.y, run: 0 };
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      if (p.y !== q.y) continue;
      const len = Math.abs(q.x - p.x);
      if (len > best.len) {
        best = { len, x: Math.min(p.x, q.x) + 7, y: p.y - 8, run: len };
      }
    }

    edges.push({
      id: e.id,
      label: e.label,
      medium: e.medium,
      polaritySign: e.polaritySign,
      points: pts,
      labelAt: { x: best.x, y: best.y, anchor: "start" },
      runWidth: best.run,
    });
  }

  return {
    kind: "circuit",
    title: spec.title,
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    convention: spec.convention,
    nodes,
    edges,
  };
}

export interface LaidMatrix {
  kind: "matrix";
  title: string;
  subtitle?: string;
  colWidth: number;
  rowHeight: number;
  headerWidth: number;
  spec: MatrixSpec;
  w: number;
  h: number;
}

export function layoutMatrix(spec: MatrixSpec): LaidMatrix {
  // Size to content. A fixed width clips long titles and long row headers, and
  // a clipped heading reads as a broken diagram even when the data is right.
  const longestHeader = Math.max(0, ...spec.rows.map((r) => r.header.length));
  const headerWidth = Math.min(340, Math.max(150, longestHeader * 7.2 + 26));

  const longestCell = Math.max(
    0,
    ...spec.columns.map((c) => c.length),
    ...spec.rows.flatMap((r) =>
      r.cells.map((c) => (c.state === "value" ? c.value.length : 14)),
    ),
  );
  const colWidth = Math.min(200, Math.max(118, longestCell * 7.4 + 22));

  const rowHeight = 46;
  const gridWidth = headerWidth + spec.columns.length * colWidth + 56;
  // Georgia at 21px averages ~10.1px per glyph; the subtitle ~6.6px at 13px.
  const titleWidth = spec.title.length * 10.1 + 56;
  const subtitleWidth = (spec.subtitle?.length ?? 0) * 6.6 + 56;

  return {
    kind: "matrix",
    title: spec.title,
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    colWidth,
    rowHeight,
    headerWidth,
    spec,
    w: Math.ceil(Math.max(gridWidth, titleWidth, subtitleWidth)),
    h: 108 + (spec.rows.length + 1) * rowHeight,
  };
}
