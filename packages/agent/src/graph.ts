/**
 * Query layer over the cross-reference graph.
 *
 * The honest case for this, restated: at 48 pages, stuffing the manual into a
 * cached prompt beats it. The graph earns its place on the documents Prox
 * actually onboards -- a 500-page machine manual does not fit in a prompt, and
 * "which pages discuss this part" stops being free.
 *
 * What it buys even here is MULTI-HOP. "What polarity for the process that runs
 * without gas?" is two joins: gasless -> flux-core -> its polarity row. Lexical
 * search answers neither hop on its own, because the page naming the polarity
 * never uses the word "gasless".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH = join(HERE, "..", "..", "..", "data", "graph.json");

interface RawGraph {
  corpus: string;
  pageCount: number;
  terms: string[];
  mentions: Array<{ page: number; term: string }>;
  figures: Array<{ id: string; page: number }>;
  seeAlso: Array<{ from: number; to: number }>;
  coOccurs: Array<{ a: string; b: string; pages: number; score?: number }>;
  aliases?: Record<string, string[]>;
}

const raw = JSON.parse(readFileSync(GRAPH, "utf-8")) as RawGraph;

/** Fold case and hyphenation so "flux-core" and "Flux Cored" are one node. */
const fold = (t: string): string => t.toLowerCase().replace(/[-\s]+/g, " ").trim();

/**
 * Surface form -> concept.
 *
 * The corpus was folded onto concept nodes at build time, so a user typing
 * "gasless" must be folded the same way or they query a node that no longer
 * exists. Shipping the alias map with the graph keeps the two ends in step
 * instead of duplicating the vocabulary in two languages.
 */
const ALIAS = new Map<string, string>();
for (const [concept, forms] of Object.entries(raw.aliases ?? {})) {
  ALIAS.set(fold(concept), fold(concept));
  for (const f of forms) ALIAS.set(fold(f), fold(concept));
}

const key = (t: string): string => ALIAS.get(fold(t)) ?? fold(t);

const pagesByTerm = new Map<string, Set<number>>();
const termsByPage = new Map<number, Set<string>>();
const displayName = new Map<string, string>();

for (const m of raw.mentions) {
  const k = key(m.term);
  if (!displayName.has(k) || m.term.length < displayName.get(k)!.length) {
    displayName.set(k, m.term);
  }
  if (!pagesByTerm.has(k)) pagesByTerm.set(k, new Set());
  pagesByTerm.get(k)!.add(m.page);
  if (!termsByPage.has(m.page)) termsByPage.set(m.page, new Set());
  termsByPage.get(m.page)!.add(k);
}

const neighbours = new Map<string, Array<{ term: string; weight: number }>>();
for (const e of raw.coOccurs) {
  const a = key(e.a);
  const b = key(e.b);
  if (a === b) continue;
  if (!neighbours.has(a)) neighbours.set(a, []);
  if (!neighbours.has(b)) neighbours.set(b, []);
  neighbours.get(a)!.push({ term: b, weight: e.pages });
  neighbours.get(b)!.push({ term: a, weight: e.pages });
}

const figuresByPage = new Map<number, string[]>();
for (const f of raw.figures) {
  if (!figuresByPage.has(f.page)) figuresByPage.set(f.page, []);
  figuresByPage.get(f.page)!.push(f.id);
}

const seeAlso = new Map<number, number[]>();
for (const e of raw.seeAlso) {
  if (!seeAlso.has(e.from)) seeAlso.set(e.from, []);
  seeAlso.get(e.from)!.push(e.to);
}

export const graphStats = {
  corpus: raw.corpus,
  pages: raw.pageCount,
  terms: pagesByTerm.size,
  mentions: raw.mentions.length,
  crossReferences: raw.seeAlso.length,
  coOccurrences: raw.coOccurs.length,
  figures: raw.figures.length,
};

/** Loose match so a user's phrasing finds the manual's vocabulary. */
export function resolveTerm(q: string): string[] {
  const k = key(q);
  const exact = pagesByTerm.has(k) ? [k] : [];
  if (exact.length) return exact;
  const parts = k.split(" ").filter((w) => w.length > 2);
  return [...pagesByTerm.keys()]
    .filter((t) => t.includes(k) || parts.every((w) => t.includes(w)))
    .sort((a, b) => a.length - b.length)
    .slice(0, 6);
}

export interface Related {
  term: string;
  pages: number[];
  figures: string[];
  relatedTerms: Array<{ term: string; sharedPages: number }>;
  alsoSeePages: number[];
}

export function related(q: string, limit = 8): Related[] {
  return resolveTerm(q).slice(0, 3).map((k) => {
    const pages = [...(pagesByTerm.get(k) ?? [])].sort((a, b) => a - b);
    const figures = pages.flatMap((p) => figuresByPage.get(p) ?? []).slice(0, 6);
    const alsoSee = [...new Set(pages.flatMap((p) => seeAlso.get(p) ?? []))].sort((a, b) => a - b);
    const rel = (neighbours.get(k) ?? [])
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((n) => ({ term: displayName.get(n.term) ?? n.term, sharedPages: n.weight }));
    return {
      term: displayName.get(k) ?? k,
      pages,
      figures,
      relatedTerms: rel,
      alsoSeePages: alsoSee,
    };
  });
}

export interface Hop {
  from: string;
  to: string;
  viaPages: number[];
}

/**
 * Shortest path between two concepts, over pages that mention both.
 *
 * This is the thing lexical search cannot do. "Gasless" and "Negative Socket"
 * never appear in the same sentence, but they are two hops apart through
 * "flux-cored", and that chain is exactly the reasoning a technician makes.
 */
export function connect(fromQ: string, toQ: string, maxHops = 4): Hop[] | null {
  const starts = resolveTerm(fromQ);
  const goals = new Set(resolveTerm(toQ));
  if (starts.length === 0 || goals.size === 0) return null;

  const prev = new Map<string, string>();
  const seen = new Set<string>(starts);
  let frontier = [...starts];

  for (let depth = 0; depth < maxHops && frontier.length; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      if (goals.has(node) && !starts.includes(node)) return rebuild(node);
      for (const n of neighbours.get(node) ?? []) {
        if (seen.has(n.term)) continue;
        seen.add(n.term);
        prev.set(n.term, node);
        if (goals.has(n.term)) return rebuild(n.term);
        next.push(n.term);
      }
    }
    frontier = next;
  }
  return null;

  function rebuild(end: string): Hop[] {
    const chain: string[] = [end];
    let cur = end;
    while (prev.has(cur)) {
      cur = prev.get(cur)!;
      chain.unshift(cur);
    }
    const hops: Hop[] = [];
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i]!;
      const b = chain[i + 1]!;
      const shared = [...(pagesByTerm.get(a) ?? [])].filter((p) =>
        pagesByTerm.get(b)?.has(p),
      );
      hops.push({
        from: displayName.get(a) ?? a,
        to: displayName.get(b) ?? b,
        viaPages: shared.sort((x, y) => x - y),
      });
    }
    return hops;
  }
}
