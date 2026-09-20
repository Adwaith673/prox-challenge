/**
 * Dev CLI: derive a diagram from the verified tables and write it to out/.
 *
 *   npm run diagram -- polarity fcaw_self_shielded
 *   npm run diagram -- polarity all
 *   npm run diagram -- duty
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { groundTruth } from "./groundTruth.js";
import { buildPolarityCircuit } from "./builders/polarity.js";
import { buildDutyCycleMatrix } from "./builders/duty.js";
import { verifyDiagram } from "./verify.js";
import { toSvg } from "./svg.js";
import type { DiagramSpec } from "./schema.js";

const OUT = join(process.cwd(), "out");

function emit(name: string, spec: DiagramSpec): void {
  const result = verifyDiagram(spec);
  if (!result.ok) {
    console.error(`REJECTED ${name}`);
    for (const v of result.violations) console.error(`   [${v.code}] ${v.message}`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.svg`);
  writeFileSync(file, toSvg(result.spec), "utf-8");
  console.log(`ok  ${name}  ->  out/${name}.svg`);
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "polarity") {
  const rows =
    !arg || arg === "all"
      ? groundTruth.polarity
      : groundTruth.polarity.filter((r) => r.id === arg || r.variant === arg);
  if (rows.length === 0) {
    console.error(`no polarity row matches "${arg}"`);
    console.error(`known: ${groundTruth.polarity.map((r) => r.id).join(", ")}`);
    process.exit(1);
  }
  for (const row of rows) emit(`polarity-${row.id}`, buildPolarityCircuit(row));
} else if (cmd === "duty") {
  emit("duty-cycle", buildDutyCycleMatrix());
} else {
  console.error("usage: diagram <polarity [id|all] | duty>");
  process.exit(1);
}
