"""Build a cross-reference graph over the ingested manual.

WHY THIS EXISTS, honestly: at 48 pages, prompt-stuffing the whole manual beats
any retrieval structure, and pretending otherwise would be dishonest. The graph
is not here to win on this document. It is here because Prox onboards NEW
manufacturers, and a 500-page hydraulic excavator manual does not fit in a
prompt. This is the structure that takes over when the corpus stops fitting, and
it is built generically so it runs on whatever PDF you point the pipeline at.

What it captures:
  page   --mentions-->  term        a part or concept named on that page
  figure --on-->        page        artwork recovered from that page
  page   --see-also-->  page        an explicit "refer to page N" cross-reference
  term   --co-occurs--> term        two parts named in the same procedure step

Term extraction leans on a real convention rather than an LLM: equipment manuals
Capitalise Part Names. "Wire Feed Power Cable" is a part; "the cable" is prose.
That gives precise, auditable vocabulary with no model in the loop and nothing to
hallucinate.
"""

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Capitalised multi-word part names, e.g. "Wire Feed Power Cable".
PART = re.compile(r"\b(?:[A-Z][a-z]{2,}\s){1,4}[A-Z][a-z]{2,}\b")

# Domain vocabulary that is not Capitalised but matters.
VOCAB = [
    "DCEN", "DCEP", "MIG", "TIG", "Stick", "SMAW", "GMAW", "FCAW",
    "flux-cored", "flux-core", "gasless", "self-shielded", "solid core",
    "duty cycle", "polarity", "porosity", "spatter", "undercut", "penetration",
    "CTWD", "stickout", "spool gun", "shielding gas", "wire feed speed",
    "argon", "tri-mix", "arc voltage", "amperage", "synergic",
]

CROSS_REF = re.compile(r"\b(?:see|refer to|per|on)\s+page\s+(\d{1,2})\b", re.I)

# Synonym groups. These are not co-occurring terms, they are ONE concept the
# manual spells several ways, and collapsing them is the difference between a
# connected graph and a pile of singletons. Curated deliberately, like the
# verified tables: a human decided, and the decision is auditable in one place.
ALIASES = {
    "flux-cored": ["flux-core", "flux cored", "gasless", "self-shielded", "self shielded"],
    "solid wire": ["solid core", "solid-core"],
    "CTWD": ["stickout", "contact tip to work distance"],
    "duty cycle": ["rated duty", "duty rating"],
    "shielding gas": ["gas coverage", "gas flow"],
}
CANON = {a.lower(): k for k, vs in ALIASES.items() for a in vs}
CANON.update({k.lower(): k for k in ALIASES})


def canonical(term: str) -> str:
    """Fold a surface form onto its concept."""
    t = re.sub(r"[-\s]+", " ", term.strip().lower())
    return CANON.get(t, term.strip())


# Boilerplate that appears on nearly every page and carries no signal.
STOP_PHRASES = {
    "For Technical Questions", "Item", "Page", "Safety Welding Tips",
    "Save This Manual", "Owner Manual", "Harbor Freight Tools",
    "Technical Questions Please", "Welding Tips Maintenance",
}


def load_pages(corpus: Path) -> dict[int, str]:
    out: dict[int, str] = {}
    for f in sorted((corpus / "pages").glob("p*.txt")):
        out[int(f.stem[1:])] = f.read_text(encoding="utf-8")
    return out


def terms_on(text: str) -> set[str]:
    found: set[str] = set()
    for m in PART.finditer(text):
        phrase = m.group(0).strip()
        if len(phrase) < 6:
            continue
        if any(sp.lower() in phrase.lower() for sp in STOP_PHRASES):
            continue
        found.add(phrase)
    low = text.lower()
    for word in VOCAB:
        if word.lower() in low:
            found.add(word)
    return found


def main() -> None:
    corpus = ROOT / "data" / (sys.argv[1] if len(sys.argv) > 1 else "")
    if not (corpus / "pages").exists():
        corpus = ROOT / "data"
    pages = load_pages(corpus)
    if not pages:
        print(f"no extracted pages under {corpus}; run extract_pages.py first")
        sys.exit(1)

    figures = []
    fig_index = corpus / "figures" / "index.json"
    if fig_index.exists():
        figures = json.loads(fig_index.read_text(encoding="utf-8"))

    page_terms: dict[int, set[str]] = {
        p: {canonical(t) for t in terms_on(t_)} for p, t_ in pages.items()
    }

    # A term on 60% of pages is boilerplate, not a part.
    df = Counter(t for ts in page_terms.values() for t in ts)
    ubiquitous = {t for t, n in df.items() if n > len(pages) * 0.6}
    for p in page_terms:
        page_terms[p] -= ubiquitous

    mentions = [
        {"page": p, "term": t}
        for p, ts in sorted(page_terms.items())
        for t in sorted(ts)
    ]

    see_also = []
    for p, text in pages.items():
        for m in CROSS_REF.finditer(text):
            target = int(m.group(1))
            if target != p and target in pages:
                see_also.append({"from": p, "to": target})

    co: Counter[tuple[str, str]] = Counter()
    for ts in page_terms.values():
        ordered = sorted(ts)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1 :]:
                co[(a, b)] += 1

    # Weight by RARITY, not raw count. A flat "3 shared pages" threshold is wrong
    # on a 48-page manual: it keeps common-word pairs and drops the pair that
    # actually matters, because a term like "gasless" appears on exactly one page.
    # Normalising by document frequency (a PMI-style score) makes two rare terms
    # sharing one page outrank two common terms sharing three.
    scored = []
    for (a, b), n in co.items():
        score = n / ((df[a] * df[b]) ** 0.5)
        if score >= 0.30:
            scored.append({"a": a, "b": b, "pages": n, "score": round(score, 3)})
    scored.sort(key=lambda e: -e["score"])

    # Cap PER NODE, not globally. A global top-N by PMI keeps only singleton
    # pairs -- two terms that each appear once, on the same page, score a perfect
    # 1.0 -- and silently strips every edge from the well-connected terms people
    # actually ask about. Keeping each node's strongest neighbours guarantees the
    # graph stays traversable.
    per_node: Counter[str] = Counter()
    edges = []
    for e in scored:
        if per_node[e["a"]] >= 14 and per_node[e["b"]] >= 14:
            continue
        per_node[e["a"]] += 1
        per_node[e["b"]] += 1
        edges.append(e)

    graph = {
        "corpus": corpus.name,
        "pageCount": len(pages),
        "terms": sorted(df.keys() - ubiquitous),
        "mentions": mentions,
        "figures": [{"id": f["id"], "page": f["page"]} for f in figures],
        "seeAlso": see_also,
        "coOccurs": edges,
        "droppedAsBoilerplate": sorted(ubiquitous),
        # Shipped so the query layer resolves a user's wording ("gasless")
        # onto the concept node the corpus was folded into ("flux-cored").
        "aliases": {k: sorted(v) for k, v in ALIASES.items()},
    }

    out = corpus / "graph.json"
    out.write_text(json.dumps(graph, indent=2), encoding="utf-8")
    print(f"terms={len(graph['terms'])} mentions={len(mentions)} "
          f"see-also={len(see_also)} co-occurs={len(edges)} figures={len(figures)}")
    print(f"dropped as boilerplate: {len(ubiquitous)}")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
