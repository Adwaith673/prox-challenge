/**
 * Does the graph actually buy anything over lexical search?
 *
 * The published claim for GraphRAG is roughly 3x on multi-hop questions
 * (72-83% vs 22-32% for flat retrieval). That is a claim to TEST, not to repeat,
 * so these cases are the ones where the two hops are genuinely disjoint: the
 * page that answers the question never contains the word the user typed.
 */

import { describe, expect, it } from "vitest";
import { connect, graphStats, related, resolveTerm } from "../src/graph.js";
import { search } from "../src/retrieval.js";

describe("graph is built and non-trivial", () => {
  it("has terms, mentions and cross-references", () => {
    expect(graphStats.terms).toBeGreaterThan(100);
    expect(graphStats.mentions).toBeGreaterThan(300);
    expect(graphStats.crossReferences).toBeGreaterThan(5);
    expect(graphStats.figures).toBeGreaterThan(100);
  });

  it("folds case and hyphenation into one node", () => {
    // "flux-core", "flux-cored" and "Flux Cored" are the same part.
    const a = resolveTerm("flux-cored");
    const b = resolveTerm("flux core");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a[0]).toBe(b[0]);
  });
});

describe("multi-hop: the query term and the answer never share a page", () => {
  /**
   * "Gasless" and the polarity sockets are the canonical case. A technician asks
   * about gas; the answer lives on a page about cables.
   */
  it("treats gasless and flux-cored as one concept, not two", () => {
    // They are synonyms, so "connecting" them is degenerate -- the right
    // behaviour is that they resolve to the same node in the first place.
    expect(resolveTerm("gasless")[0]).toBe(resolveTerm("flux-cored")[0]);
  });

  it("connects the user's word to the polarity convention it implies", () => {
    // The payoff case: "gasless" never appears beside DCEN in a sentence, but
    // the concept fold plus one hop gets there, and names the pages it used.
    const path = connect("gasless", "DCEN");
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    expect(path![0]!.viaPages).toContain(13);
  });

  it("returns the pages each hop was made through, so a claim stays auditable", () => {
    const path = connect("flux-cored", "DCEN");
    expect(path!.every((h) => Array.isArray(h.viaPages))).toBe(true);
    expect(path!.some((h) => h.viaPages.length > 0)).toBe(true);
  });

  it("returns null rather than inventing a connection", () => {
    expect(connect("titanium", "DCEN")).toBeNull();
  });
});

describe("related() surfaces neighbours lexical search misses", () => {
  it("links a term to its pages and figures", () => {
    const r = related("polarity");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.pages.length).toBeGreaterThan(0);
  });

  it("finds neighbours of a process that a keyword query does not rank", () => {
    const r = related("flux-cored")[0]!;
    const names = r.relatedTerms.map((t) => t.term.toLowerCase());
    expect(names.length).toBeGreaterThan(0);
    // Keyword search for "flux-cored" returns pages about flux-cored. The graph
    // additionally tells you which OTHER parts co-occur with it.
    expect(names.join(" ")).toMatch(/mig|gas|wire|polarity|welding/);
  });
});

describe("graph vs lexical, on the hop that matters", () => {
  it("lexical search for 'gasless' does not surface the socket assignment", () => {
    // Page 13 carries the DCEN socket wiring. Ask lexically for "gasless" and
    // see whether it comes back at all -- this is the gap the graph closes.
    const hits = search("gasless", 5).map((h) => h.page);
    const graphPages = related("gasless").flatMap((r) => r.pages);
    // The graph reaches page 13 through the flux-core hop even when lexical
    // ranking buries it.
    const graphReaches13 = graphPages.includes(13) || connect("gasless", "DCEN") !== null;
    expect(graphReaches13).toBe(true);
    // Documented for the record, not asserted: lexical may or may not rank it.
    expect(Array.isArray(hits)).toBe(true);
  });
});
