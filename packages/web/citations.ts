/**
 * Which manual pages an answer cites.
 *
 * Its own module rather than living in server.ts: importing the server to test a
 * pure function also boots an HTTP listener and runs the credential preflight,
 * which is exactly the kind of import side effect that makes a test suite
 * flaky and slow.
 */

/**
 * Matches both forms the model actually uses -- "p.13" and "page 13". An earlier
 * version handled only the abbreviated form and silently returned no citations
 * whenever the answer spelled the word out, which looked like the model had
 * stopped citing when it had not.
 */
const CITATION = /\bp(?:age|g|\.)?\s*(\d{1,2})\b/gi;

export function citedPagesIn(text: string): number[] {
  return [
    ...new Set(
      [...text.matchAll(CITATION)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 1 && n <= 48),
    ),
  ].sort((a, b) => a - b);
}
