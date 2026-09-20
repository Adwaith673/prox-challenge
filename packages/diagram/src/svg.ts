/**
 * Spec -> SVG.
 *
 * The signature is the point: `toSvg` takes a `VerifiedSpec`, and only
 * `verifyDiagram` can mint one. Calling this with a raw DiagramSpec is a type
 * error, so an unverified diagram cannot reach a screen.
 *
 * Colour is semantic, not decorative: positive is warm, negative is cool, and a
 * hole in the data is hatched rather than blank. A missing value has to be
 * visible -- that is how the manual's gaps become an answer instead of a silence.
 */

import type { CircuitSpec, MatrixSpec } from "./schema.js";
import type { VerifiedSpec } from "./verify.js";
import { CANVAS, layoutCircuit, layoutMatrix, type LaidCircuit } from "./layout.js";

const INK = "#16201c";
const MUTED = "#5d6b64";
const RULE = "#c2cac4";
const POS = "#b23b1e";
const NEG = "#1d5b7a";
const RETURN = "#3f7d4e";
const PAPER = "#ffffff";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/** Monospace at 10.5px advances ~6.3px per glyph. */
export const labelWidth = (s: string): number => s.length * 6.3;

/**
 * Rendered diagrams, keyed by handle.
 *
 * The agent never receives SVG source. It gets a handle, and the UI resolves it.
 * Two reasons, one of which we learned the hard way: a model handed 4kB of
 * markup will sometimes paste it into its prose, and every diagram would
 * otherwise cost several thousand tokens of context for bytes the model cannot
 * act on anyway.
 */
export interface StashedDiagram {
  handle: string;
  svg: string;
  /** The spec's own title, so the UI can show it once in the card header
      instead of repeating what is already drawn inside the SVG. */
  title: string;
  subtitle?: string;
}

const rendered = new Map<string, StashedDiagram>();
let seq = 0;

export function stash(svg: string, title: string, subtitle?: string): string {
  const handle = `diagram-${++seq}`;
  rendered.set(handle, { handle, svg, title, ...(subtitle ? { subtitle } : {}) });
  return handle;
}

export function resolve(handle: string): StashedDiagram | undefined {
  return rendered.get(handle);
}

/** Interactive widgets travel the same handle route as diagrams. */
const widgets: unknown[] = [];

export function stashWidget(payload: unknown): string {
  widgets.push(payload);
  return `widget-${widgets.length}`;
}

export function drainWidgets(): unknown[] {
  const all = [...widgets];
  widgets.length = 0;
  return all;
}

export function drainDiagrams(): StashedDiagram[] {
  const all = [...rendered.values()];
  rendered.clear();
  seq = 0;
  return all;
}

export interface Legibility {
  ok: boolean;
  problems: string[];
}

/**
 * Deterministic legibility check.
 *
 * The verifier guarantees the diagram is CORRECT; it cannot tell whether a label
 * overruns its run or leaves the canvas. That is the one class of defect code
 * can't fully settle, so it is the only thing worth spending a vision round-trip
 * on -- the agent is shown the rendered PNG only when this fails.
 */
export function checkLegibility(spec: VerifiedSpec): Legibility {
  const problems: string[] = [];
  if (spec.kind !== "circuit") return { ok: true, problems };
  const laid = layoutCircuit(spec as CircuitSpec);
  for (const e of laid.edges) {
    const w = labelWidth(e.label);
    if (w > e.runWidth - 10) {
      problems.push(
        `label on "${e.id}" needs ${Math.round(w)}px but its run is ${Math.round(e.runWidth)}px`,
      );
    }
    if (e.labelAt.x + w > CANVAS.w - 8) {
      problems.push(`label on "${e.id}" extends past the right edge of the canvas`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function defs(): string {
  return `<defs>
<pattern id="hole" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
<rect width="7" height="7" fill="#f2f0ec"/><line x1="0" y1="0" x2="0" y2="7" stroke="#b9b3a9" stroke-width="2.2"/>
</pattern>
<marker id="arrow-pos" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="${POS}"/></marker>
<marker id="arrow-neg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="${NEG}"/></marker>
<marker id="arrow-ret" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
<path d="M0,0 L10,5 L0,10 z" fill="${RETURN}"/></marker>
</defs>`;
}

function edgeColour(sign: "+" | "-" | "none", medium: string): string {
  if (sign === "+") return POS;
  if (sign === "-") return NEG;
  return medium === "work_return" ? RETURN : MUTED;
}

function markerFor(sign: "+" | "-" | "none"): string {
  return sign === "+" ? "arrow-pos" : sign === "-" ? "arrow-neg" : "arrow-ret";
}

function renderCircuit(laid: LaidCircuit, showHeading: boolean): string {
  const parts: string[] = [];

  if (showHeading) parts.push(
    `<text x="32" y="44" font-family="Georgia,serif" font-size="21" font-weight="700" fill="${INK}">${esc(
      laid.title,
    )}</text>`,
  );
  if (showHeading && laid.subtitle) {
    parts.push(
      `<text x="32" y="66" font-family="Georgia,serif" font-size="13" fill="${MUTED}">${esc(
        laid.subtitle,
      )}</text>`,
    );
  }

  const badgeFill = laid.convention === "DCEP" ? POS : NEG;
  parts.push(
    `<rect x="${CANVAS.w - 122}" y="26" width="90" height="28" rx="4" fill="${badgeFill}"/>` +
      `<text x="${CANVAS.w - 77}" y="45" text-anchor="middle" font-family="ui-monospace,monospace" ` +
      `font-size="14" font-weight="700" fill="#fff">${esc(laid.convention)}</text>`,
  );

  for (const e of laid.edges) {
    const colour = edgeColour(e.polaritySign, e.medium);
    const d = e.points.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)},${f(p.y)}`).join(" ");
    const dash = e.medium === "shielding_gas" ? ` stroke-dasharray="6 4"` : "";
    parts.push(
      `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2.6" stroke-linejoin="round"` +
        `${dash} marker-end="url(#${markerFor(e.polaritySign)})"/>`,
    );
    const w = labelWidth(e.label);
    parts.push(
      `<rect x="${f(e.labelAt.x - 4)}" y="${f(e.labelAt.y - 12)}" width="${f(w + 8)}" height="17" ` +
        `rx="3" fill="${PAPER}" fill-opacity="0.95"/>` +
        `<text x="${f(e.labelAt.x)}" y="${f(e.labelAt.y)}" text-anchor="start" ` +
        `font-family="ui-monospace,monospace" font-size="10.5" fill="${colour}">${esc(e.label)}</text>`,
    );
  }

  for (const n of laid.nodes) {
    const isMachine = n.kind === "machine";
    parts.push(
      `<rect x="${f(n.x)}" y="${f(n.y)}" width="${f(n.w)}" height="${f(n.h)}" rx="7" ` +
        `fill="${isMachine ? "#eef1ee" : PAPER}" stroke="${INK}" stroke-width="${isMachine ? 2 : 1.5}"/>`,
    );
    parts.push(
      `<text x="${f(n.x + n.w / 2)}" y="${f(n.y + (isMachine ? 26 : n.h / 2 + 5))}" ` +
        `text-anchor="middle" font-family="Georgia,serif" font-size="${isMachine ? 15 : 13}" ` +
        `font-weight="${isMachine ? 700 : 400}" fill="${INK}">${esc(n.label)}</text>`,
    );

    if (isMachine) {
      for (const [port, sign, colour] of [
        ["term.positive", "+", POS],
        ["term.negative", "-", NEG],
      ] as const) {
        const y = port === "term.positive" ? 232 : 282;
        parts.push(
          `<circle cx="${f(n.x + n.w)}" cy="${y}" r="9" fill="${PAPER}" stroke="${colour}" stroke-width="2.4"/>` +
            `<text x="${f(n.x + n.w)}" y="${y + 5}" text-anchor="middle" ` +
            `font-family="ui-monospace,monospace" font-size="13" font-weight="700" fill="${colour}">${sign}</text>`,
        );
      }
    }
  }

  return parts.join("\n");
}

function renderMatrix(spec: MatrixSpec, showHeading: boolean): { body: string; w: number; h: number } {
  const laid = layoutMatrix(spec);
  const { headerWidth: hw, colWidth: cw, rowHeight: rh } = laid;
  const x0 = 28;
  const y0 = 92;
  const parts: string[] = [];

  if (showHeading) {
    parts.push(
      `<text x="${x0}" y="42" font-family="Georgia,serif" font-size="21" font-weight="700" fill="${INK}">${esc(
        spec.title,
      )}</text>`,
    );
  }
  if (showHeading && spec.subtitle) {
    parts.push(
      `<text x="${x0}" y="64" font-family="Georgia,serif" font-size="13" fill="${MUTED}">${esc(
        spec.subtitle,
      )}</text>`,
    );
  }

  spec.columns.forEach((c, i) => {
    parts.push(
      `<text x="${f(x0 + hw + i * cw + cw / 2)}" y="${y0 - 10}" text-anchor="middle" ` +
        `font-family="ui-monospace,monospace" font-size="11" font-weight="700" fill="${MUTED}">${esc(c)}</text>`,
    );
  });

  spec.rows.forEach((row, r) => {
    const y = y0 + r * rh;
    parts.push(
      `<text x="${x0}" y="${f(y + rh / 2 + 4)}" font-family="Georgia,serif" font-size="13" fill="${INK}">${esc(
        row.header,
      )}</text>`,
    );
    row.cells.forEach((cell, c) => {
      const x = x0 + hw + c * cw;
      if (cell.state === "hole") {
        parts.push(
          `<rect x="${f(x + 3)}" y="${f(y + 4)}" width="${cw - 8}" height="${rh - 9}" rx="4" ` +
            `fill="url(#hole)" stroke="${RULE}" stroke-width="1"/>`,
        );
        const tag = cell.reason === "not_published" ? "not published" : "not in manual";
        parts.push(
          `<text x="${f(x + cw / 2)}" y="${f(y + rh / 2 + 4)}" text-anchor="middle" ` +
            `font-family="ui-monospace,monospace" font-size="9" fill="#7c736a">${esc(tag)}</text>`,
        );
      } else {
        parts.push(
          `<rect x="${f(x + 3)}" y="${f(y + 4)}" width="${cw - 8}" height="${rh - 9}" rx="4" ` +
            `fill="${PAPER}" stroke="${RULE}" stroke-width="1"/>`,
        );
        // Shrink to fit rather than clip. A long but correct value should look
        // slightly smaller, never be cut in half or rejected upstream.
        const avail = cw - 14;
        const size = Math.max(7.5, Math.min(11.5, (avail / (cell.value.length * 0.62)) * 1.0));
        parts.push(
          `<text x="${f(x + cw / 2)}" y="${f(y + rh / 2 + size / 3)}" text-anchor="middle" ` +
            `font-family="ui-monospace,monospace" font-size="${f(size)}" font-weight="700" fill="${INK}">${esc(
              cell.value,
            )}</text>`,
        );
      }
    });
  });

  return { body: parts.join("\n"), w: laid.w, h: laid.h };
}

export interface RenderOptions {
  /**
   * Draw the title block inside the SVG.
   *
   * Off when the surrounding UI already shows the title in a card header --
   * otherwise the same heading appears twice, once in chrome and once in the
   * picture. On by default so a standalone export is still self-describing.
   */
  heading?: boolean;
}

export function toSvg(spec: VerifiedSpec, opts: RenderOptions = {}): string {
  const showHeading = opts.heading !== false;

  if (spec.kind === "circuit") {
    const body = renderCircuit(layoutCircuit(spec as CircuitSpec), showHeading);
    // With the heading suppressed, crop the band it occupied rather than
    // shipping an SVG with a blank strip along the top.
    const y0 = showHeading ? 0 : 16;
    const h = CANVAS.h - y0;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${y0} ${CANVAS.w} ${h}" ` +
      `width="${CANVAS.w}" height="${h}" role="img" aria-label="${esc(spec.title)}">\n` +
      `${defs()}\n<rect x="0" y="${y0}" width="${CANVAS.w}" height="${h}" fill="${PAPER}"/>\n${body}\n</svg>\n`
    );
  }

  const { body, w, h } = renderMatrix(spec as MatrixSpec, showHeading);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
    `role="img" aria-label="${esc(spec.title)}">\n` +
    `${defs()}\n<rect width="${w}" height="${h}" fill="${PAPER}"/>\n${body}\n</svg>\n`
  );
}
