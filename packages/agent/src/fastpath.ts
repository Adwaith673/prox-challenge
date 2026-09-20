/**
 * The voice fast path.
 *
 * Natural conversation needs a reply inside roughly 200 ms. This agent takes
 * 20-45 seconds, because it is doing real work: several tool calls and a frontier
 * model. Bolting speech onto that unchanged produces a demo where you ask a
 * question and listen to silence for half a minute, which is worse than no voice
 * at all.
 *
 * So: two paths, and the split falls out of the architecture rather than being
 * bolted on. The questions a welder actually shouts across a workshop --
 * "what's my polarity for flux-core", "duty cycle at 175 on stick" -- are
 * answered by the SAME verified tables the diagrams are derived from. Those are
 * dictionary lookups. No model, no network, sub-millisecond.
 *
 * Anything this cannot match with confidence falls through to the full agent,
 * and the UI says so out loud rather than stalling.
 *
 * Note what this is NOT: it is not a second source of truth. Every answer here
 * reads the same `groundTruth` tables, so the fast path cannot drift from the
 * slow one -- and it inherits the refusals, including "not published above
 * 200 A".
 */

import { findDuty, findPolarity, groundTruth, type Process } from "../../diagram/src/groundTruth.js";

export interface FastAnswer {
  /** Phrased for text-to-speech: no markdown, no page abbreviations. */
  speech: string;
  /** Same answer for the transcript, where "p.13" is fine. */
  text: string;
  intent: "polarity" | "duty_cycle" | "porosity" | "refusal";
  citedPages: number[];
  /** Diagram to show alongside, when one exists. */
  polarityRow?: string;
}

const has = (t: string, ...words: string[]): boolean => words.some((w) => t.includes(w));

function processIn(t: string): Process | null {
  if (has(t, "stick", "smaw", "7018", "6011", "6013", "electrode holder")) return "Stick";
  if (has(t, "tig", "gtaw", "tungsten")) return "TIG";
  if (has(t, "mig", "gmaw", "flux", "wire feed", "gasless", "solid wire", "spool")) return "MIG";
  return null;
}

function migVariantIn(t: string): string | null {
  if (has(t, "flux", "gasless", "self shielded", "self-shielded")) return "flux_cored_self_shielded";
  if (has(t, "spool")) return "spool_gun";
  if (has(t, "solid", "gas shielded", "c25", "argon", "with gas")) return "solid_wire_gas_shielded";
  return null;
}

function voltageIn(t: string): 120 | 240 | null {
  // A trailing unit kills the word boundary: \b240\b does NOT match "240v",
  // because 0 and v are both word characters. Spell the unit out instead.
  const unit = "(?:\\s*(?:v|volt|volts|vac))?\\b";
  if (new RegExp(`\\b(?:240|230)${unit}`).test(t)) return 240;
  if (new RegExp(`\\b(?:120|110|115)${unit}`).test(t)) return 120;
  // 220 is ambiguous on this machine -- it is a real MIG amperage as well as a
  // mains voltage -- so only read it as voltage when the unit is explicit.
  if (/\b220\s*(?:v|volt|volts|vac)\b/.test(t)) return 240;
  return null;
}

function ampsIn(t: string): number | null {
  const m = t.match(/\b(\d{2,3})\s*(?:a\b|amp|amps|ampere)/);
  return m ? Number(m[1]) : null;
}

/**
 * Try to answer from the tables alone.
 *
 * Returns null whenever the question is not squarely one of these -- being
 * unsure is a reason to hand off to the full agent, never a reason to guess
 * quickly.
 */
export function fastAnswer(question: string): FastAnswer | null {
  const t = question.toLowerCase().replace(/[^a-z0-9\s.+-]/g, " ").replace(/\s+/g, " ");

  // ---- polarity -------------------------------------------------------
  if (has(t, "polarity", "dcen", "dcep", "which socket", "what socket", "positive socket", "negative socket")) {
    const proc = processIn(t);
    if (!proc) {
      return {
        intent: "refusal",
        speech:
          "Which process are you running? Polarity is different for solid wire M I G, " +
          "flux core, tig and stick on this machine.",
        text: "Which process? Polarity differs across solid-wire MIG, flux-core, TIG and stick.",
        citedPages: [],
      };
    }
    const variant = proc === "MIG" ? migVariantIn(t) : undefined;
    if (proc === "MIG" && !variant) {
      return {
        intent: "refusal",
        speech:
          "M I G is ambiguous on this machine. Solid wire with gas is D C E P, " +
          "wire feed positive. Self shielded flux core is D C E N, wire feed negative. " +
          "Which one are you running?",
        text: "MIG is ambiguous: solid wire with gas is DCEP; self-shielded flux-core is DCEN. Which are you running?",
        citedPages: [13, 14],
      };
    }
    const row = findPolarity(proc, variant ?? undefined);
    if (!row) return null;

    const electrodeSocket = row.electrodeLead === "positive" ? "positive" : "negative";
    const workSocket = row.workLead === "positive" ? "positive" : "negative";
    const lead =
      row.electrodeDevice === "tig_torch"
        ? "torch cable"
        : row.electrodeDevice === "electrode_holder"
          ? "electrode holder cable"
          : "wire feed power cable";

    return {
      intent: "polarity",
      polarityRow: row.id,
      speech:
        `${row.convention.split("").join(" ")}. ${row.label}. ` +
        `Put the ${lead} in the ${electrodeSocket} socket, and the ground clamp in the ` +
        `${workSocket} socket. That is on page ${row.page}.`,
      text:
        `**${row.convention}** — ${row.label}. ${lead[0]!.toUpperCase()}${lead.slice(1)} → ` +
        `**${electrodeSocket}** socket; ground clamp → **${workSocket}** socket (p.${row.page}).`,
      citedPages: [row.page],
    };
  }

  // ---- duty cycle -----------------------------------------------------
  if (has(t, "duty cycle", "duty", "how long can i weld", "how long can i run")) {
    const proc = processIn(t);
    const volts = voltageIn(t);
    const amps = ampsIn(t);
    if (!proc || !volts) {
      const missing = !proc && !volts ? "which process and which input voltage" : !proc ? "which process" : "which input voltage";
      return {
        intent: "refusal",
        speech:
          `I need ${missing}. Duty cycle is not the same across processes. ` +
          `At 175 amps on 240 volts it is thirty percent in tig but twenty five percent in stick.`,
        text: `Need ${missing} — 175 A at 240 V is 30% in TIG but 25% in Stick.`,
        citedPages: [7, 14],
      };
    }
    const row = findDuty(proc, volts);
    if (!row) return null;

    if (amps !== null && amps > row.maxPublishedAmps) {
      return {
        intent: "refusal",
        speech:
          `Nothing is published above ${row.maxPublishedAmps} amps for ${proc} at ${volts} volts. ` +
          `The machine reaches ${row.outputRange.maxAmps}, but the manual does not rate it there, ` +
          `and I will not estimate a duty cycle. Page ${row.page}.`,
        text:
          `No duty cycle is published above **${row.maxPublishedAmps} A** for ${proc} at ${volts} V. ` +
          `The machine reaches ${row.outputRange.maxAmps} A but the manual does not rate it (p.${row.page}).`,
        citedPages: [row.page],
      };
    }

    const point = amps !== null ? row.points.find((p) => p.amps === amps) : undefined;
    if (point) {
      const minutes = (point.dutyPct / 10).toFixed(1).replace(/\.0$/, "");
      return {
        intent: "duty_cycle",
        speech:
          `${point.dutyPct} percent at ${point.amps} amps, ${proc} on ${volts} volts. ` +
          `That is ${minutes} minutes of arc time in any ten minute window. Page ${row.page}.`,
        text:
          `**${point.dutyPct}%** at ${point.amps} A (${proc}, ${volts} V) — ${minutes} min of arc ` +
          `time per 10-minute window (p.${row.page}).`,
        citedPages: [row.page],
      };
    }

    const spoken = row.points.map((p) => `${p.dutyPct} percent at ${p.amps} amps`).join(", ");
    return {
      intent: "duty_cycle",
      speech: `For ${proc} on ${volts} volts the published points are ${spoken}. Page ${row.page}.`,
      text:
        `${proc} at ${volts} V: ` +
        row.points.map((p) => `**${p.dutyPct}%** at ${p.amps} A`).join(" · ") +
        ` (p.${row.page}).`,
      citedPages: [row.page],
    };
  }

  // ---- porosity -------------------------------------------------------
  if (has(t, "porosity", "porous", "holes in", "pin holes", "pinholes")) {
    const proc = processIn(t);
    if (!proc) return null;
    const entry = groundTruth.diagnosis.find(
      (d) => d.symptom === "porosity" && d.appliesTo.includes(proc),
    );
    if (!entry) return null;

    const gasless = migVariantIn(t) === "flux_cored_self_shielded";
    const causes = entry.causes.filter((c) => !(gasless && c.gasShieldedOnly));
    const spoken = causes.map((c, i) => `${i + 1}. ${c.cause}`).join(". ");

    return {
      intent: "porosity",
      speech:
        `For ${proc}, the manual lists ${causes.length} cause${causes.length === 1 ? "" : "s"} ` +
        `of porosity on page ${entry.page}. ${spoken}.` +
        (proc === "Stick" ? " Stick uses no shielding gas, so gas flow is not one of them." : ""),
      text:
        `${proc} porosity — ${causes.length} printed cause${causes.length === 1 ? "" : "s"} (p.${entry.page}): ` +
        causes.map((c) => c.cause).join("; ") +
        (proc === "Stick" ? ". Stick runs no shielding gas, so gas flow is not among them." : "."),
      citedPages: [entry.page],
    };
  }

  return null;
}
