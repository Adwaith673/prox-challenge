/**
 * Interactive widgets, built entirely from the verified tables.
 *
 * The brief asks for "interactive duty cycle calculators, troubleshooting
 * flowcharts, or settings configurators", and the obvious way to do that is to
 * let the model write HTML or JSX at runtime. That is the same mistake as
 * letting it free-draw an SVG, with more surface area: now it can author both
 * the numbers AND the logic that presents them.
 *
 * So the model chooses WHICH widget. It supplies no data at all. Every value,
 * every branch and every refusal in the payload below is read out of
 * `groundTruth` here on the server. There is nothing for the model to get wrong,
 * which makes this stronger than the diagram path rather than weaker: the
 * diagrams at least let it pick a table row.
 *
 * The interesting one is the settings configurator. It is fully interactive and
 * its honest output is "this manual does not contain that" -- an interactive
 * widget whose job is to show you exactly where the data stops.
 */

import { groundTruth, type DutyRow } from "../groundTruth.js";

export type WidgetKind =
  | "duty_cycle_calculator"
  | "troubleshooting_flowchart"
  | "settings_configurator";

export interface WidgetPayload {
  kind: WidgetKind;
  title: string;
  subtitle: string;
  data: unknown;
  citedPages: number[];
  /**
   * What the badge is allowed to claim.
   *
   * "text" means every value traces verbatim to a page the CI gate checks.
   * "mixed" means some of it came out of a picture -- the selection chart has no
   * text layer, so its numbers cannot be traced that way and must not wear the
   * same badge as the ones that can.
   */
  evidence: "text" | "mixed";
}

function dutyCalculator(): WidgetPayload {
  const rows = groundTruth.duty.map((r: DutyRow) => ({
    process: r.process,
    inputVoltage: r.inputVoltage,
    points: r.points,
    maxPublishedAmps: r.maxPublishedAmps,
    reach: r.outputRange.maxAmps,
    minAmps: r.outputRange.minAmps,
    page: r.page,
    // Carried so the widget can explain a refusal in the manual's own terms.
    unpublishedNote: r.unpublishedNote ?? null,
  }));
  return {
    kind: "duty_cycle_calculator",
    title: "Duty cycle calculator",
    subtitle: "Rated points only — nothing between them is interpolated.",
    data: { rows, periodMinutes: groundTruth.dutyPeriodMinutes },
    evidence: "text",
    citedPages: [...new Set(groundTruth.duty.map((r) => r.page))].sort((a, b) => a - b),
  };
}

function troubleshooting(): WidgetPayload {
  const symptoms = groundTruth.diagnosis.map((d) => ({
    id: d.id,
    symptom: d.symptom,
    appliesTo: d.appliesTo,
    variants: d.variants,
    definition: d.definition,
    page: d.page,
    causes: d.causes.map((c) => ({
      n: c.n,
      cause: c.cause,
      fix: c.fix,
      gasShieldedOnly: c.gasShieldedOnly,
    })),
  }));
  return {
    kind: "troubleshooting_flowchart",
    title: "Troubleshooting",
    subtitle: "Causes are gated by process — the manual prints different lists.",
    data: { symptoms },
    evidence: "text",
    citedPages: [...new Set(groundTruth.diagnosis.map((d) => d.page))].sort((a, b) => a - b),
  };
}

/**
 * The settings configurator.
 *
 * Prox asked for one "that takes process + material + thickness and outputs
 * recommended wire speed and voltage". An earlier version of this widget refused
 * outright, on the grounds that no such table is printed. That was half right and
 * wholly unhelpful: the table is missing because this is an Auto Weld (synergic)
 * machine that computes the pair itself from wire diameter and material
 * thickness, and the manual says so in as many words on page 20.
 *
 * So the configurator answers. For the job you pick it returns the knob sequence
 * from that process's own page, the gas flow, the polarity, and whether your
 * thickness is inside the published range -- then points at where the machine
 * displays the number it derived. The two figures it will not invent are the two
 * the welder is responsible for, and it says which they are instead of going
 * quiet.
 */
function settingsConfigurator(): WidgetPayload {
  const gap = groundTruth.gaps.find((g) => g.id === "settings_matrix_not_in_manual");
  const ev = (gap?.evidence ?? {}) as {
    pointers?: Array<{ page: number; quote: string }>;
    absence?: { probe: string; occurrencesInManual: number };
  };

  // Each selectable job binds three verified rows: how it is configured, what the
  // chart says it can weld, and which socket each lead goes in. Nothing here is
  // typed by hand -- the ids are lookups into tables the CI gate has blessed.
  const jobs = [
    { id: "mig_solid", label: "MIG (solid wire, gas)", settings: "mig_flux", selection: "mig", polarity: "gmaw_solid_gas" },
    { id: "mig_flux", label: "MIG (flux-core, gasless)", settings: "mig_flux", selection: "fcaw", polarity: "fcaw_self_shielded" },
    { id: "tig", label: "TIG", settings: "tig", selection: "tig", polarity: "gtaw_tig" },
    { id: "stick", label: "Stick", settings: "stick", selection: "stick", polarity: "smaw_stick" },
  ].map((j) => {
    const s = groundTruth.settings.find((x) => x.id === j.settings)!;
    const sel = groundTruth.selection.find((x) => x.id === j.selection)!;
    const pol = groundTruth.polarity.find((x) => x.id === j.polarity)!;
    return {
      id: j.id,
      label: j.label,
      // How the machine is driven, in its own words.
      page: s.page,
      youSet: s.youSet,
      machineDerives: s.machineDerives,
      adjustStep: s.adjustStep,
      gasScfh: s.gasScfh,
      optionalSettings: s.optionalSettings,
      onScreenExample: s.onScreenExample ?? null,
      // What the chart says this process is for.
      thickness: sel.thickness,
      materials: sel.materials,
      shieldingGas: sel.shieldingGas,
      skillLevel: sel.skillLevel,
      // And where the leads go, so the answer is actionable at the machine.
      polarity: {
        convention: pol.convention,
        workLead: pol.workLead,
        electrodeLead: pol.electrodeLead,
        page: pol.page,
      },
    };
  });

  return {
    kind: "settings_configurator",
    title: "Settings configurator",
    subtitle: "Your job, the way this machine is actually set up.",
    data: {
      jobs,
      // Real axes. Thicknesses carry decimal inches so the widget can range-check
      // them against the chart; the conversion is ours and is labelled as such.
      thicknesses: [
        { label: "24 ga", in: 0.0239 },
        { label: "22 ga", in: 0.0299 },
        { label: "18 ga", in: 0.0478 },
        { label: "1/16\"", in: 0.0625 },
        { label: "10 ga", in: 0.1345 },
        { label: "1/8\"", in: 0.125 },
        { label: "3/16\"", in: 0.1875 },
        { label: "1/4\"", in: 0.25 },
        { label: "3/8\"", in: 0.375 },
        { label: "1/2\"", in: 0.5 },
      ],
      diameters: ['.023"', '.025"', '.030"', '.035"', '.045"', '1/16"', '3/32"', '1/8"'],
      // The claim that makes the missing table make sense.
      synergic: groundTruth.synergic,
      thicknessNote: groundTruth.thicknessNote,
      selectionSource: groundTruth.selectionSource,
      // Retained: the two numbers we still will not print, and the proof we looked.
      missing: ["A printed voltage / wire-feed-speed lookup table"],
      claim: gap?.claim ?? "",
      pointers: ev.pointers ?? [],
      absence: ev.absence ?? null,
    },
    // Mixed: the procedure and polarity are text-verified, but the thickness
    // ranges came out of a JPEG with no text layer and cannot be.
    evidence: "mixed",
    citedPages: [7, 13, 14, 17, 20, 21, 24, 26, 27, 30, 32, 42],
  };
}

const BUILDERS: Record<WidgetKind, () => WidgetPayload> = {
  duty_cycle_calculator: dutyCalculator,
  troubleshooting_flowchart: troubleshooting,
  settings_configurator: settingsConfigurator,
};

export function buildWidget(kind: WidgetKind): WidgetPayload {
  return BUILDERS[kind]();
}

export const WIDGET_KINDS = Object.keys(BUILDERS) as WidgetKind[];
