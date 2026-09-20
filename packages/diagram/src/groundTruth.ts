/**
 * Typed access to the verified tables in data/tables/.
 *
 * These JSON files are the root of trust. They are checked by
 * scripts/ingest/verify_tables.py, which proves every value traces verbatim to
 * its cited manual page and enforces the domain invariants (a lead cannot be in
 * both sockets; DCEP must mean electrode-positive). Nothing here re-derives a
 * fact -- it only reads what the gate has already blessed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TABLES = join(HERE, "..", "..", "..", "data", "tables");

export type Lead = "positive" | "negative";
export type Process = "MIG" | "TIG" | "Stick";

export interface PolarityRow {
  id: string;
  process: Process;
  variant: string;
  label: string;
  convention: "DCEP" | "DCEN";
  electrodeDevice: "mig_gun" | "tig_torch" | "electrode_holder" | "spool_gun";
  electrodeLead: Lead;
  workLead: Lead;
  page: number;
  quote: string;
}

export interface DutyPoint {
  dutyPct: number;
  amps: number;
  arcVolts: number;
}

export interface DutyRow {
  id: string;
  process: Process;
  inputVoltage: 120 | 240;
  outputRange: { minAmps: number; minVolts: number; maxAmps: number; maxVolts: number };
  points: DutyPoint[];
  maxPublishedAmps: number;
  unpublishedAbove: number | null;
  unpublishedNote?: string;
  page: number;
  quote: string;
}

export interface DiagnosisCause {
  n: number;
  cause: string;
  fix: string;
  gasShieldedOnly: boolean;
}

export interface DiagnosisRow {
  id: string;
  symptom: string;
  appliesTo: Process[];
  variants: string[];
  definition: string;
  page: number;
  quote: string;
  causes: DiagnosisCause[];
}

/**
 * One process's configuration procedure.
 *
 * `youSet` is geometry, `machineDerives` is electrics. That split is the whole
 * answer to "what voltage and wire speed should I use" on a synergic machine:
 * nobody looks those up, the welder computes them.
 */
export interface SettingsProcedure {
  id: string;
  process: Process;
  alsoCovers: string[];
  page: number;
  screenLabel: string;
  gasScfh: { min: number; max: number } | null;
  youSet: Array<{ knob: string; sets: string }>;
  machineDerives: string[];
  adjustStep: string;
  onScreenExample?: { reads: string; shownWith: string };
  /**
   * What the door decal's panel for this process shows on the LCD. Image-only:
   * "3/32" appears zero times in all 48 pages of the manual, so these values are
   * real, citable to the decal, and untraceable to any page of prose.
   */
  decalScreens: {
    source: "decal";
    textVerifiable: false;
    diameters: string[];
    thicknesses: string[];
    reads: { amps: number; volts: number };
    electrodeType?: string;
  };
  optionalSettings: string[];
  quote: string;
}

/** A column of the selection chart. Every field here came out of a JPEG. */
export interface SelectionRow {
  id: string;
  process: string;
  chartName: string;
  skillLevel: "LOW" | "MODERATE" | "HIGH";
  shieldingGas: string;
  gasNote?: string;
  materials: string[];
  materialsRequiringAcTig?: string[];
  thickness: { label: string; minIn: number; maxIn: number };
  cleanliness: string;
  applications: string[];
  strengths: string[];
  corroboration: { page: number; claim: string } | null;
}

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(join(TABLES, file), "utf-8")) as T;

const polarityDoc = read<{ rows: PolarityRow[]; corroboration: { page: number; quote: string } }>(
  "polarity.json",
);
const dutyDoc = read<{
  rows: DutyRow[];
  definition: { periodMinutes: number };
  /** Page 7's Specifications table -- the same figures, where a person looks. */
  specTableCorroboration: Array<{ process: Process; page: number; quote: string }>;
}>("duty-cycle.json");
const diagnosisDoc = read<{
  symptoms: DiagnosisRow[];
  exclusionRules: unknown[];
}>("diagnosis.json");
const unanswerableDoc = read<{
  gaps: Array<{
    id: string;
    triggers: string[];
    claim: string;
    correctBehavior: string;
    neverDo: string;
    evidence: Record<string, unknown>;
  }>;
  contradictions: Array<{
    id: string;
    page: number;
    quote: string;
    refutedBy: Array<{ page: number; quote: string; reason: string }>;
    resolution: string;
    attachToRetrievalOf: number[];
  }>;
}>("unanswerable.json");

const settingsDoc = read<{
  synergic: {
    page: number;
    claim: string;
    quote: string;
    approximateNote: { source: string; textVerifiable: false; quote: string };
  };
  processes: SettingsProcedure[];
}>("settings-procedure.json");

const selectionDoc = read<{
  source: { doc: string; page: number; image: string; textVerifiable: false };
  thicknessNote: string;
  rows: SelectionRow[];
  acTigResolution: {
    chartSaysDcRequiredFor: string[];
    chartSaysAcRequiredFor: string[];
    machineIsDcOnly: { page: number; quote: string };
    conclusion: string;
  };
  dutyCycleDefinition: {
    definition: string;
    genericExample: { amps: number; dutyPct: number; isRatingForThisMachine: false };
  };
}>("process-selection.json");

export const groundTruth = {
  polarity: polarityDoc.rows,
  polarityCorroboration: polarityDoc.corroboration,
  duty: dutyDoc.rows,
  dutyPeriodMinutes: dutyDoc.definition.periodMinutes,
  dutySpecTable: dutyDoc.specTableCorroboration,
  diagnosis: diagnosisDoc.symptoms,
  gaps: unanswerableDoc.gaps,
  contradictions: unanswerableDoc.contradictions,
  /** How the machine is actually configured: you set geometry, it derives the electrics. */
  settings: settingsDoc.processes,
  synergic: settingsDoc.synergic,
  /** The image-only selection chart. Not text-verifiable -- see process-selection.json. */
  selection: selectionDoc.rows,
  selectionSource: selectionDoc.source,
  thicknessNote: selectionDoc.thicknessNote,
  acTig: selectionDoc.acTigResolution,
  dutyDefinition: selectionDoc.dutyCycleDefinition,
} as const;

export type GroundTruth = typeof groundTruth;

export function findPolarity(process: Process, variant?: string): PolarityRow | undefined {
  const forProcess = groundTruth.polarity.filter((r) => r.process === process);
  if (variant) return forProcess.find((r) => r.variant === variant || r.id === variant);
  // MIG is ambiguous without a variant: solid wire is DCEP, flux-core is DCEN.
  // Refuse to guess rather than silently pick one.
  return forProcess.length === 1 ? forProcess[0] : undefined;
}

export function findDuty(process: Process, inputVoltage: 120 | 240): DutyRow | undefined {
  return groundTruth.duty.find(
    (r) => r.process === process && r.inputVoltage === inputVoltage,
  );
}

/** The socket a given lead occupies. The single mapping in the whole system. */
export function portForLead(lead: Lead): "term.positive" | "term.negative" {
  return lead === "positive" ? "term.positive" : "term.negative";
}
