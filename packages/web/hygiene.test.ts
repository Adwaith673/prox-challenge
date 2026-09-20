/**
 * Source files must not contain control characters.
 *
 * This guards a bug that has bitten this repo four separate times, always the
 * same way: a regex is edited through a shell heredoc, the shell interprets
 * `\b` as an escape, and a literal backspace byte (0x08) lands in the source
 * where a word-boundary assertion was meant to be.
 *
 * Nothing catches it. The file still parses -- 0x08 is a valid regex literal
 * character -- TypeScript is happy, and the pattern simply stops matching what
 * it was written to match. The last instance turned `/\bp(?:age)?\s*(\d{1,2})\b/`
 * into a pattern requiring a literal backspace either side of the page number,
 * so an eval check for "does the answer cite a page" scored zero against answers
 * that cited pages perfectly well.
 *
 * Tabs and newlines are fine; everything else in the C0 range is not.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", ".git", "out", "data", "files", ".playwright-mcp"]);
const EXT = /\.(ts|tsx|js|mjs|cjs|py|json|css|html|md)$/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (EXT.test(name)) acc.push(full);
  }
  return acc;
}

// 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F. Tab (09), LF (0A) and CR (0D) are allowed.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

describe("no control characters in source", () => {
  it("every source file is clean", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const text = readFileSync(file, "utf-8");
      const m = CONTROL.exec(text);
      if (!m) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const code = `0x${m[0].charCodeAt(0).toString(16).padStart(2, "0")}`;
      offenders.push(
        `${relative(ROOT, file)}:${line} contains ${code}` +
          (m[0] === "\u0008" ? ' — almost certainly a "\\b" eaten by a shell heredoc' : ""),
      );
    }
    expect(offenders).toEqual([]);
  });
});
