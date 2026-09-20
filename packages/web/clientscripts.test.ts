/**
 * The browser code has to parse.
 *
 * This looks like a test for nothing until you have shipped the bug. A single
 * mismatched quote in widgets.js is a SyntaxError, a SyntaxError aborts the
 * whole IIFE, and `window.widgetCard` is then simply undefined -- so every
 * interactive widget silently fails to appear. Nothing throws on the server,
 * every server-side test still passes, `npm run typecheck` is clean (these files
 * are not TypeScript), and the only symptom is a blank space where the duty
 * cycle calculator should be.
 *
 * That exact bug shipped into a working tree here, introduced by a scripted
 * string replacement that closed a single-quoted string with a double quote.
 * Parsing both client files costs a millisecond and closes the hole.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");

const parses = (source: string, name: string) => {
  // `new Script` compiles without executing -- exactly the check we want, since
  // this code needs a DOM it will never have here.
  expect(() => new Script(source, { filename: name })).not.toThrow();
};

describe("client scripts parse", () => {
  it("widgets.js", () => {
    parses(readFileSync(join(PUBLIC, "widgets.js"), "utf-8"), "widgets.js");
  });

  it("the inline script in index.html", () => {
    const html = readFileSync(join(PUBLIC, "index.html"), "utf-8");
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((m, i) => parses(m[1]!, `index.html#inline-${i}`));
  });

  it("widgets.js actually defines the entry point the page calls", () => {
    // Parsing is necessary but not sufficient: the file could parse and still
    // never assign window.widgetCard, which fails the same way.
    const src = readFileSync(join(PUBLIC, "widgets.js"), "utf-8");
    expect(src).toMatch(/window\.widgetCard\s*=/);
  });

  it("every widget kind the server can send has a client builder", () => {
    // A kind added on the server with no renderer here produces an empty card,
    // which is the same silent failure wearing a different hat.
    const src = readFileSync(join(PUBLIC, "widgets.js"), "utf-8");
    for (const kind of [
      "duty_cycle_calculator",
      "troubleshooting_flowchart",
      "settings_configurator",
    ]) {
      expect(src).toContain(kind);
    }
  });
});
