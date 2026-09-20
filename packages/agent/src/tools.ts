/**
 * The tool surface: eleven tools, all pinned with alwaysLoad.
 *
 * Deliberately absent: anything that COMPUTES a duty cycle. There is nothing to
 * compute -- duty cycle is a tested thermal result read from a table -- and
 * offering arithmetic is an open invitation to extrapolate past 200 A, which is
 * the single most dangerous answer this system could give. Refusal is returned
 * as data (`published: false`) rather than left to the model's judgement.
 *
 * Tool descriptions are the highest-leverage prompt surface in the whole system,
 * so they carry the domain traps directly: MIG ambiguity, the process-conditional
 * porosity split, and the synergic settings model that explains why no
 * voltage/wire-speed table exists to look up.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

import { DiagramSpec } from "../../diagram/src/schema.js";
import { verifyDiagram } from "../../diagram/src/verify.js";
import { toSvg, checkLegibility, stash, stashWidget } from "../../diagram/src/svg.js";
import { buildPolarityCircuit } from "../../diagram/src/builders/polarity.js";
import { buildDutyCycleMatrix } from "../../diagram/src/builders/duty.js";
import { buildWidget, WIDGET_KINDS, type WidgetKind } from "../../diagram/src/builders/widgets.js";
import { groundTruth, findDuty, findPolarity } from "../../diagram/src/groundTruth.js";
import { search, pageText } from "./retrieval.js";
import { connect, graphStats, related } from "./graph.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIGURES = join(HERE, "..", "..", "..", "data", "figures");
const DOCS = join(HERE, "..", "..", "..", "data", "docs");

const figureIndex = JSON.parse(
  readFileSync(join(FIGURES, "index.json"), "utf-8"),
) as Array<{ id: string; page: number; file: string; width: number; height: number }>;

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const err = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  isError: true,
});

const PROCESS = z.enum(["MIG", "TIG", "Stick"]);

/** Every diagram the agent shows passes through here. Nothing else renders. */
export const renderDiagram = tool(
  "render_diagram",
  `Render a verified diagram. Pass a DiagramSpec (kind "circuit" for wiring, "matrix" for a table of values).

You do NOT author geometry: there are no coordinates, colours or SVG in the schema. You choose the nodes, the edges and -- critically -- the table row each current-carrying edge cites. Layout is derived.

Every weld_current and work_return edge MUST cite a polarity table row via src {kind:"table", table:"polarity", row:"<id>"}. The verifier recomputes both sockets from that row and rejects the diagram if they disagree, so a wrong-socket diagram cannot be rendered. If you get EDGE_NOT_IN_TABLE or WRONG_SOCKET back, call get_polarity and use the spec it hands you rather than guessing again.

For settings or duty tables use kind "matrix". Exact shape, and note that columns are PLAIN STRINGS, not objects:

{
  kind: "matrix",
  title: "...",               // <= 80 characters
  subtitle: "...",            // optional, <= 120 CHARACTERS -- longer is rejected by the schema
  annotations: [],
  columns: ["col A", "col B"],
  rows: [ { header: "row label", cells: [ <cell>, <cell> ] } ]   // one cell per column
}

A <cell> is exactly one of:
  { state: "value", value: "20-30 SCFH", src: { kind: "page", page: 20, quote: "<verbatim text from that page>" } }
  { state: "hole",  reason: "not_published" | "not_in_manual", note: "optional short reason" }

Use "not_in_manual" for facts that live elsewhere (the door decal); "not_published" for a value this manual rates for some cases but not this one. Render a gap as a hole -- never drop the column and never invent a number to fill it. Any digits inside a value must appear verbatim in the cited quote or the diagram is rejected.`,
  { spec: z.unknown().describe("A DiagramSpec object.") },
  async (args) => {
    const parsed = DiagramSpec.safeParse(args.spec);
    if (!parsed.success) {
      return err({
        rejected: "schema",
        issues: parsed.error.issues.slice(0, 8).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const result = verifyDiagram(parsed.data);
    if (!result.ok) {
      return err({
        rejected: "verification",
        violations: result.violations,
        hint: "Call get_polarity for the authoritative row and rebuild from it.",
      });
    }
    const legibility = checkLegibility(result.spec);
    const handle = stash(
      toSvg(result.spec, { heading: false }),
      parsed.data.title,
      parsed.data.subtitle,
    );
    // Deliberately no SVG in the response: the model cannot act on markup, and
    // given it will sometimes paste it straight into the answer.
    return ok({
      verified: true,
      diagram: handle,
      shownToUser: true,
      legibility: legibility.ok ? "ok" : legibility.problems,
      note: "The diagram is displayed to the user. Refer to it in prose; do not reproduce it.",
    });
  },
  { alwaysLoad: true },
);

export const getPolarity = tool(
  "get_polarity",
  `Authoritative polarity setup for a process, plus a ready-made verified diagram spec.

IMPORTANT: "MIG" alone is ambiguous on this machine and this tool will refuse it. Solid wire with shielding gas is DCEP (wire feed positive); self-shielded flux-core is DCEN (wire feed negative) -- the same gun, inverted. Ask the user which one they are running rather than picking one.

Returns the cited manual page and a prebuilt spec you can pass straight to render_diagram.`,
  {
    process: PROCESS,
    variant: z
      .enum(["solid_wire_gas_shielded", "flux_cored_self_shielded", "spool_gun", "dc_tig", "dc_stick"])
      .optional()
      .describe("Required when process is MIG."),
  },
  async (args) => {
    const row = findPolarity(args.process, args.variant);
    if (!row) {
      const options = groundTruth.polarity
        .filter((r) => r.process === args.process)
        .map((r) => ({ variant: r.variant, label: r.label, convention: r.convention }));
      return err({
        ambiguous: true,
        reason:
          `"${args.process}" does not identify one polarity configuration. ` +
          `Ask the user which variant they are running.`,
        options,
      });
    }
    return ok({
      row: {
        id: row.id,
        label: row.label,
        convention: row.convention,
        electrodeLead: row.electrodeLead,
        workLead: row.workLead,
        page: row.page,
        quote: row.quote,
      },
      spec: buildPolarityCircuit(row),
    });
  },
  { alwaysLoad: true },
);

export const getDutyCycle = tool(
  "get_duty_cycle",
  `Rated duty cycle, keyed on the TRIPLE (process, inputVoltage, amperage). Amperage alone is not a key: 175 A at 240 V is 30% in TIG but 25% in Stick, because arc voltage differs.

Never compute, interpolate or extrapolate a duty cycle yourself -- it is a tested thermal result, not a formula, and this tool deliberately offers no arithmetic. If the requested current sits above the highest published point, the response says published:false and names the ceiling; report that and render the matrix showing the gap.`,
  {
    process: PROCESS,
    inputVoltage: z.union([z.literal(120), z.literal(240)]),
    amperage: z.number().positive().optional(),
  },
  async (args) => {
    const row = findDuty(args.process, args.inputVoltage);
    const specRow = groundTruth.dutySpecTable.find((c) => c.process === args.process);
    if (!row) return err({ found: false, reason: "no such process/voltage combination" });

    const base = {
      process: row.process,
      inputVoltage: row.inputVoltage,
      outputRange: row.outputRange,
      points: row.points,
      maxPublishedAmps: row.maxPublishedAmps,
      /**
       * Both sources, with their roles named.
       *
       * The duty figures appear twice. Page 7's Specifications table is where a
       * person looks and prints the headline pair ("25% @ 200 A"); page 14 is the
       * rating plate, which is the only place the middle 60% tier appears at all.
       * Returning p.14 alone was truthful and answered "why page 14?" with
       * nothing, so both now come back labelled rather than the agent guessing
       * which to lead with.
       */
      source: {
        primary: specRow
          ? { page: specRow.page, section: "Specifications", quote: specRow.quote }
          : { page: row.page, section: "rating plate", quote: row.quote },
        corroborating: specRow
          ? [{ page: row.page, section: "rating plate", note: "carries the 60% tier, which the Specifications table omits" }]
          : [],
      },
      page: row.page,
      quote: row.quote,
    };

    if (args.amperage === undefined) return ok({ ...base, published: true });

    const exact = row.points.find((p) => p.amps === args.amperage);
    if (exact) return ok({ ...base, published: true, match: exact });

    if (args.amperage > row.maxPublishedAmps) {
      return ok({
        ...base,
        published: false,
        reason:
          `No duty cycle is published above ${row.maxPublishedAmps} A for ${row.process} ` +
          `at ${row.inputVoltage} V. The machine reaches ${row.outputRange.maxAmps} A, but ` +
          `the manual does not rate it there.`,
        doNot: "Do not interpolate or estimate. Report the ceiling and render the gap.",
      });
    }

    const bracket = [...row.points].sort((a, b) => a.amps - b.amps).find((p) => p.amps >= args.amperage!);
    return ok({
      ...base,
      published: false,
      reason: `${args.amperage} A is between published points; the manual rates discrete currents only.`,
      nearestPublishedAtOrAbove: bracket ?? null,
      doNot: "Do not interpolate between points. Cite the nearest published rating.",
    });
  },
  { alwaysLoad: true },
);

export const diagnose = tool(
  "diagnose",
  `Printed causes and fixes for a weld defect, gated by process.

The gating is real and the manual is explicit about it: porosity lists six causes for wire welding (p.37) but only two for stick (p.40). Telling a stick user to increase shielding gas flow is nonsense -- SMAW uses no gas. Within wire welding there is a second gate: two of the six causes are printed "(MIG only)", so they do not apply to self-shielded flux-core, which also runs gasless.

Returns the applicable causes and, separately, the ones excluded for this process with the reason.`,
  {
    symptom: z.string().describe('e.g. "porosity"'),
    process: PROCESS,
    variant: z.string().optional().describe('e.g. "flux_cored_self_shielded"'),
  },
  async (args) => {
    const key = args.symptom.trim().toLowerCase();
    const entry = groundTruth.diagnosis.find(
      (d) => d.symptom.toLowerCase() === key && d.appliesTo.includes(args.process),
    );
    if (!entry) {
      const known = [...new Set(groundTruth.diagnosis.map((d) => d.symptom))];
      return err({
        found: false,
        reason: `No printed section for "${args.symptom}" under ${args.process}.`,
        knownSymptoms: known,
      });
    }

    const gasless = args.variant === "flux_cored_self_shielded";
    const applicable = entry.causes.filter((c) => !(gasless && c.gasShieldedOnly));
    const excluded = entry.causes
      .filter((c) => gasless && c.gasShieldedOnly)
      .map((c) => ({
        cause: c.cause,
        reason: "self-shielded flux-core runs gasless, so this MIG-only cause cannot apply",
      }));

    return ok({
      symptom: entry.symptom,
      process: args.process,
      definition: entry.definition,
      page: entry.page,
      causes: applicable,
      excluded,
      note:
        args.process === "Stick"
          ? "This is the stick section (p.40). Do not import the six wire causes from p.37."
          : undefined,
    });
  },
  { alwaysLoad: true },
);

export const lookupManual = tool(
  "lookup_manual",
  `Search the 48-page manual. Returns scored page hits with excerpts.

Two things come back alongside the text and you must honour both:
- "contradictions": the manual contradicts itself on at least one point. If a hit carries this, surface it rather than quoting the page as fact.
- "knownGaps": some questions have NO answer in this manual -- most importantly the thickness/wire/gas/voltage settings matrix, which is a decal inside the welder door, not printed here. If a gap matches, say so and do not reconstruct the numbers from general welding knowledge.`,
  {
    query: z.string().min(2),
    onlyPages: z.array(z.number().int().min(1).max(48)).optional(),
    limit: z.number().int().min(1).max(8).optional(),
  },
  async (args) => {
    const hits = search(args.query, args.limit ?? 4, args.onlyPages);
    const pagesHit = new Set(hits.map((h) => h.page));

    const contradictions = groundTruth.contradictions
      .filter((c) => c.attachToRetrievalOf.some((p) => pagesHit.has(p)))
      .map((c) => ({
        page: c.page,
        claim: c.quote,
        refutedBy: c.refutedBy,
        resolution: c.resolution,
      }));

    const q = args.query.toLowerCase();
    const knownGaps = groundTruth.gaps
      .filter((g) => g.triggers.some((t) => q.includes(t.toLowerCase())))
      .map((g) => ({ id: g.id, claim: g.claim, correctBehavior: g.correctBehavior, neverDo: g.neverDo }));

    return ok({
      hits: hits.map((h) => ({
        page: h.page,
        score: h.score,
        excerpt: h.excerpt,
        figures: figureIndex.filter((f) => f.page === h.page).map((f) => f.id),
      })),
      contradictions,
      knownGaps,
    });
  },
  { alwaysLoad: true },
);

export const getFigure = tool(
  "get_figure",
  `Return a figure from the manual as an image you can actually look at.

Use this to compare a user's photo against the manual's own reference art -- for a weld-appearance question, pull the bead chart on p.35 and hold it beside their photo rather than describing either from memory. Also use it to check a polarity setup illustration before asserting which cable goes where.

Pass a figure id from lookup_manual, or a page number to get the largest figure on that page.

You can also pass \`doc\` to fetch one of the three non-manual sources, which have no figure ids because they are not the manual:
  - "selection-chart" : the process selection matrix. ZERO extractable text -- fetching it is the ONLY way to read it.
  - "quick-start"     : page 2 is the cable setup for all four processes, as a drawing. Pass page 1 or 2.
  - "decal"           : the Settings Chart photographed inside the welder door.

Show the selection chart whenever you explain which process to use or why this machine cannot TIG aluminium; it is a decision matrix and reads far better as a picture than as a list.`,
  {
    figureId: z.string().optional(),
    page: z.number().int().min(1).max(48).optional(),
    doc: z.enum(["manual", "selection-chart", "quick-start", "decal"]).optional(),
  },
  async (args) => {
    // The non-manual sources are whole pages, not extracted figures: a crop of a
    // decision matrix is worse than the matrix.
    if (args.doc && args.doc !== "manual") {
      const file =
        args.doc === "selection-chart"
          ? "sel-p1.png"
          : args.doc === "decal"
            ? "decal.png"
            : `qsg-p${args.page === 2 ? 2 : 1}.png`;
      try {
        const data = readFileSync(join(DOCS, file)).toString("base64");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${args.doc} (${file}). This is an image-only source: cite it by name ` +
                `("selection chart", "quick-start p.2", "door decal"), not with a page number ` +
                `from the owner's manual.`,
            },
            { type: "image" as const, data, mimeType: "image/png" },
          ],
        };
      } catch {
        return err({ found: false, reason: `No rendered image for doc "${args.doc}".` });
      }
    }

    let entry = args.figureId ? figureIndex.find((f) => f.id === args.figureId) : undefined;
    if (!entry && args.page !== undefined) {
      entry = figureIndex
        .filter((f) => f.page === args.page)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    }
    if (!entry) {
      const nearby = figureIndex
        .filter((f) => args.page !== undefined && Math.abs(f.page - args.page) <= 2)
        .map((f) => f.id);
      return err({
        found: false,
        reason: args.figureId
          ? `No figure "${args.figureId}".`
          : `No figures extracted from page ${args.page}.`,
        // Failing with a dead end makes the model guess again; failing with the
        // real neighbours makes it pick a figure that exists.
        ...(nearby.length ? { availableNearby: nearby } : {}),
        hint: "For the selection chart, quick-start guide or door decal, pass doc instead of page.",
      });
    }
    const data = readFileSync(join(FIGURES, `${entry.id}.png`)).toString("base64");
    return {
      content: [
        { type: "text" as const, text: `Figure ${entry.id} from page ${entry.page}.` },
        { type: "image" as const, data, mimeType: "image/png" },
      ],
    };
  },
  { alwaysLoad: true },
);

export const dutyCycleMatrix = tool(
  "duty_cycle_matrix",
  "Build the full duty-cycle matrix spec (all processes x both input voltages), with unpublished tiers marked as holes. Pass the returned spec to render_diagram. Use this whenever a duty-cycle answer depends on a value the manual does not publish -- the hatched cells show the user exactly where the data stops.",
  {},
  async () => ok({ spec: buildDutyCycleMatrix() }),
  { alwaysLoad: true },
);


export const crossReference = tool(
  "cross_reference",
  `Traverse the manual's cross-reference graph. Use this when a question spans concepts that are unlikely to share a page, or when you need to know what a part is related to before searching for it.

Two modes:
  - one term  -> the pages and figures that name it, plus the parts it co-occurs with
  - two terms -> the shortest chain between them, with the pages each hop was made through

This exists because lexical search answers "which page says X", not "how is X connected to Y". A user asking about "gasless" welding never types the word that appears on the polarity page; the graph folds gasless onto flux-cored and hops to DCEN. Every hop names its pages, so the chain stays checkable -- do not report a connection without citing those pages.`,
  {
    term: z.string().min(2),
    connectedTo: z.string().min(2).optional().describe("Supply to get a path between two concepts."),
  },
  async (args) => {
    if (args.connectedTo) {
      const path = connect(args.term, args.connectedTo);
      if (!path) {
        return ok({
          connected: false,
          reason:
            `No path between "${args.term}" and "${args.connectedTo}" in this manual. ` +
            `Treat that as evidence the manual does not relate them, not as a retrieval miss.`,
        });
      }
      return ok({ connected: true, hops: path });
    }
    const hits = related(args.term);
    if (hits.length === 0) {
      return ok({ found: false, reason: `"${args.term}" is not named anywhere in this manual.` });
    }
    return ok({ found: true, matches: hits, graph: graphStats });
  },
  { alwaysLoad: true },
);


/**
 * The answer to "what voltage and wire speed should I run?".
 *
 * This used to be a refusal. It should not have been: the pair is missing from
 * the documents because the machine computes it, and the procedure for making it
 * do that is printed on one page per process. Returning that procedure is both
 * more honest and more useful than declining -- and it still refuses the one
 * thing it should, which is inventing a lookup table.
 */
export const getSettings = tool(
  "get_settings",
  `How to set this machine up for a job: process + material thickness + wire/rod/electrode diameter.

Use this for ANY "what voltage / what wire speed / what settings for X" question.

This welder is synergic ("Auto Weld"). The operator sets DIAMETER and THICKNESS; the machine derives amperage and voltage and shows the recommendation as a white mark on the adjustment line (p.20). There is no printed voltage/wire-speed table anywhere in the three documents, and "in/min" appears zero times in 48 pages -- so do not look for one and do not construct one.

Returns, for the process you name: the exact knob sequence from that process's own page, the gas flow range, the polarity and sockets, the published thickness range from the selection chart, and whether the thickness you gave falls inside it.`,
  {
    process: z.enum(["MIG", "Flux-Cored", "TIG", "Stick"]),
    thicknessInches: z
      .number()
      .min(0.001)
      .max(2)
      .optional()
      .describe("Material thickness in decimal inches, if the user gave one. 1/8in = 0.125."),
  },
  async (args) => {
    // Flux-core shares MIG's settings page but has its own chart column and its
    // own (inverted) polarity, so the two cannot be collapsed.
    const isFlux = args.process === "Flux-Cored";
    const settingsId = args.process === "TIG" ? "tig" : args.process === "Stick" ? "stick" : "mig_flux";
    const selectionId = isFlux ? "fcaw" : args.process === "TIG" ? "tig" : args.process === "Stick" ? "stick" : "mig";
    const polarityId = isFlux
      ? "fcaw_self_shielded"
      : args.process === "TIG"
        ? "gtaw_tig"
        : args.process === "Stick"
          ? "smaw_stick"
          : "gmaw_solid_gas";

    const s = groundTruth.settings.find((x) => x.id === settingsId)!;
    const sel = groundTruth.selection.find((x) => x.id === selectionId)!;
    const pol = groundTruth.polarity.find((x) => x.id === polarityId)!;

    const t = args.thicknessInches;
    const inRange = t === undefined ? null : t >= sel.thickness.minIn && t <= sel.thickness.maxIn;
    const alternatives =
      t !== undefined && inRange === false
        ? groundTruth.selection
            .filter((r) => t >= r.thickness.minIn && t <= r.thickness.maxIn)
            .map((r) => ({ process: r.process, range: r.thickness.label }))
        : [];

    return ok({
      process: args.process,
      youSet: s.youSet,
      machineDerives: s.machineDerives,
      adjustStep: s.adjustStep,
      gasScfh: s.gasScfh,
      optionalSettings: s.optionalSettings,
      page: s.page,
      quote: s.quote,
      synergic: { page: groundTruth.synergic.page, quote: groundTruth.synergic.quote },
      approximate: groundTruth.synergic.approximateNote.quote,
      approximateSource: "door decal (this caveat is not in the manual text)",
      polarity: {
        convention: pol.convention,
        groundClamp: pol.workLead,
        electrode: pol.electrodeLead,
        page: pol.page,
      },
      publishedThickness: {
        range: sel.thickness.label,
        source: "selection chart (image only, no text layer)",
        yourThickness: t ?? null,
        inRange,
        alternatives,
      },
      noLookupTable:
        "No voltage/wire-feed-speed table exists in any of the three documents. The machine " +
        "derives both. Give the knob sequence and tell the user to read the value off the display.",
    });
  },
  { alwaysLoad: true },
);

/**
 * The selection chart, which is a JPEG with no text layer.
 *
 * "Which process should I use" is the first question a new owner has, and the
 * only document that answers it is the one a text pipeline cannot read at all.
 */
export const chooseProcess = tool(
  "choose_process",
  `Which of the four welding processes suits a job. Source: selection-chart.pdf -- a single page with ZERO extractable text, so this is the only way to reach it.

Covers, per process: skill level, whether shielding gas is required, weldable materials, published thickness range, spatter/cleanliness, and typical applications.

Also settles the AC TIG question: the chart marks steel/stainless/chrome-moly as "DC TIG REQUIRED" and aluminium/magnesium as "AC TIG REQUIRED". This machine is DC only, so it cannot TIG aluminium.

Pass a thickness to filter to the processes rated for it. Consider calling get_figure afterwards to show the chart itself -- it is a decision matrix and reads far better as a picture.`,
  {
    thicknessInches: z.number().min(0.001).max(2).optional(),
    material: z.string().max(60).optional().describe("e.g. 'aluminium', 'stainless', 'cast iron'"),
  },
  async (args) => {
    const t = args.thicknessInches;
    const rows = groundTruth.selection.map((r) => ({
      process: r.process,
      skillLevel: r.skillLevel,
      shieldingGas: r.shieldingGas,
      materials: r.materials,
      thickness: r.thickness.label,
      cleanliness: r.cleanliness,
      applications: r.applications,
      strengths: r.strengths,
      fitsThickness: t === undefined ? null : t >= r.thickness.minIn && t <= r.thickness.maxIn,
    }));

    const m = (args.material ?? "").toLowerCase();
    const wantsAluminium = /alumin|magnesium/.test(m);

    return ok({
      source: groundTruth.selectionSource,
      thicknessNote: groundTruth.thicknessNote,
      rows,
      ...(t !== undefined
        ? { ratedForYourThickness: rows.filter((r) => r.fitsThickness).map((r) => r.process) }
        : {}),
      ...(wantsAluminium
        ? {
            aluminium: {
              tig: "NOT possible on this machine. The chart marks aluminium 'AC TIG REQUIRED' and this welder is DC only (86 VDC max OCV, p.7).",
              instead: "MIG with the optional spool gun (p.17), DCEP.",
              ...groundTruth.acTig,
            },
          }
        : {}),
      acTigResolution: groundTruth.acTig,
    });
  },
  { alwaysLoad: true },
);

export const renderWidget = tool(
  "render_widget",
  `Show an INTERACTIVE tool the user can operate, rather than a static picture.

  - duty_cycle_calculator  : pick process, input voltage and amperage; shows the rated point, or refuses where nothing is published
  - troubleshooting_flowchart: pick a symptom and process; walks the printed causes and fixes, gated by process
  - settings_configurator  : pick material, thickness, wire and gas; shows what the manual publishes and, honestly, where it stops

Use one of these when the answer is something the user will want to TRY several values against -- "how long can I weld at various currents", "walk me through this fault", "what do I set for my job". Use render_diagram instead when the answer is one specific picture.

You choose which widget. You do not supply its contents: every number, branch and refusal is read from the verified tables on the server, so the widget cannot show a value the manual does not support.`,
  { widget: z.enum(["duty_cycle_calculator", "troubleshooting_flowchart", "settings_configurator"]) },
  async (args) => {
    const payload = buildWidget(args.widget as WidgetKind);
    const handle = stashWidget(payload);
    return ok({
      shown: true,
      widget: handle,
      kind: payload.kind,
      citedPages: payload.citedPages,
      note:
        "The interactive tool is displayed to the user, populated from the verified tables. " +
        "Introduce it in a sentence; do not restate its contents.",
    });
  },
  { alwaysLoad: true },
);

export const omniproServer = createSdkMcpServer({
  name: "omnipro",
  version: "0.1.0",
  tools: [
    renderDiagram,
    getPolarity,
    getDutyCycle,
    diagnose,
    lookupManual,
    getFigure,
    dutyCycleMatrix,
    crossReference,
    renderWidget,
    getSettings,
    chooseProcess,
  ],
});

export const ALLOWED_TOOLS = [
  "mcp__omnipro__render_diagram",
  "mcp__omnipro__get_polarity",
  "mcp__omnipro__get_duty_cycle",
  "mcp__omnipro__diagnose",
  "mcp__omnipro__lookup_manual",
  "mcp__omnipro__get_figure",
  "mcp__omnipro__duty_cycle_matrix",
  "mcp__omnipro__cross_reference",
  "mcp__omnipro__render_widget",
  "mcp__omnipro__get_settings",
  "mcp__omnipro__choose_process",
];

export { pageText };
