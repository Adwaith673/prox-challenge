/**
 * Ask the agent one question from the terminal.
 *
 *   npm run ask -- "what is my duty cycle at 175 A on stick?"
 *   npm run ask -- --image weld.jpg "what is wrong with this bead?"
 *
 * Prints the answer, the tool trace, any SVGs written to out/, and the cache
 * statistics -- the trace and the cache numbers are what we actually grade.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { ask, type Attachment } from "./session.js";
import { requireCredentials } from "./preflight.js";

requireCredentials();

const MEDIA: Record<string, Attachment["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const argv = process.argv.slice(2);
const images: Attachment[] = [];
const words: string[] = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--image" && argv[i + 1]) {
    const path = argv[++i]!;
    const mediaType = MEDIA[extname(path).toLowerCase()];
    if (!mediaType) {
      console.error(`unsupported image type: ${path}`);
      process.exit(1);
    }
    images.push({ data: readFileSync(path).toString("base64"), mediaType });
  } else {
    words.push(argv[i]!);
  }
}

const question = words.join(" ").trim();
if (!question) {
  console.error('usage: ask [--image FILE] "question"');
  process.exit(1);
}

console.error(`> ${question}${images.length ? `  [${images.length} image(s)]` : ""}\n`);

const started = Date.now();
const result = await ask({ text: question, ...(images.length ? { images } : {}) });

console.log(result.text.trim());

console.error(`\n--- trace (${((Date.now() - started) / 1000).toFixed(1)}s) ---`);
for (const c of result.toolCalls) {
  const name = c.name.replace(/^mcp__omnipro__/, "");
  const arg = JSON.stringify(c.input).slice(0, 96);
  console.error(`  ${c.isError ? "REJECTED" : "ok      "} ${name} ${arg}`);
  if (c.error) {
    for (const line of c.error.split(/\r?\n/).slice(0, 12)) console.error(`      | ${line}`);
  }
}

if (result.svgs.length) {
  mkdirSync("out", { recursive: true });
  result.svgs.forEach((svg, i) => {
    const file = join("out", `answer-${i + 1}.svg`);
    writeFileSync(file, svg, "utf-8");
    console.error(`  rendered -> ${file}`);
  });
}

if (result.usage) {
  const u = result.usage;
  const total = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
  const hit = total > 0 ? Math.round((u.cacheReadTokens / total) * 100) : 0;
  console.error(
    `  tokens in=${u.inputTokens} out=${u.outputTokens} ` +
      `cacheRead=${u.cacheReadTokens} cacheWrite=${u.cacheCreationTokens} (${hit}% cached)`,
  );
}
if (result.costUsd !== undefined) console.error(`  cost $${result.costUsd.toFixed(4)}`);
