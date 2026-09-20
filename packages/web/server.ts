/**
 * The demo server.
 *
 * Deliberately not Next.js. This page needs one POST endpoint, static files, and
 * somewhere to put SVG strings the server already produced -- a framework buys
 * nothing here and costs a build step, a version surface, and one more thing to
 * go wrong on a reviewer's machine. `npm run web` starts instantly and has no
 * bundler.
 *
 * The diagrams are SVG generated server-side by the verified renderer, so the
 * front end never constructs one. It only ever displays what verifyDiagram
 * already blessed.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ask, type Attachment } from "../agent/src/session.js";
import { requireCredentials } from "../agent/src/preflight.js";
import { pages } from "../agent/src/retrieval.js";
import { groundTruth } from "../diagram/src/groundTruth.js";
import { buildPolarityCircuit } from "../diagram/src/builders/polarity.js";
import { verifyDiagram } from "../diagram/src/verify.js";
import { toSvg } from "../diagram/src/svg.js";
import figureIndexRaw from "../../data/figures/index.json" with { type: "json" };
import { citedPagesIn } from "./citations.js";
import { fastAnswer } from "../agent/src/fastpath.js";
import { buildWidget, WIDGET_KINDS, type WidgetKind } from "../diagram/src/builders/widgets.js";

const figureIndex = figureIndexRaw as Array<{ id: string; page: number; width: number; height: number }>;



/**
 * The manual's own artwork for the pages an answer cites.
 *
 * Showing the real illustration beside the derived schematic is the honest
 * version of "multimodal": here is what the manual draws, here is what we
 * derived from the verified table, judge for yourself.
 */
function figuresForPages(pagesCited: number[]): Array<{ id: string; page: number }> {
  return pagesCited
    .flatMap((p) =>
      figureIndex
        .filter((f) => f.page === p)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .slice(0, 1),
    )
    .slice(0, 3)
    .map((f) => ({ id: f.id, page: f.page }));
}

const creds = requireCredentials();

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const FIGURES = join(HERE, "..", "..", "data", "figures");
const PAGEIMG = join(HERE, "..", "..", "data", "pageimg");
const DOCS = join(HERE, "..", "..", "data", "docs");
const PORT = Number(process.env["PORT"] ?? 8788);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};

const json = (res: import("node:http").ServerResponse, code: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
};

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/api/ask") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        question?: string;
        images?: Array<{ data: string; mediaType: Attachment["mediaType"] }>;
      };
      const question = (body.question ?? "").trim();
      if (!question) return json(res, 400, { error: "empty question" });

      const started = Date.now();
      const result = await ask({
        text: question,
        ...(body.images?.length ? { images: body.images } : {}),
      });

      // Pages the answer actually cites, so the rail shows provenance rather
      // than a generic source list.
      const cited = [...new Set([...result.text.matchAll(/p\.?\s?(\d{1,2})\b/gi)]
        .map((m) => Number(m[1]))
        .filter((n) => n >= 1 && n <= 48))].sort((a, b) => a - b);

      return json(res, 200, {
        text: result.text,
        svgs: result.svgs,
        citedPages: cited,
        figures: figuresForPages(cited),
        tools: result.toolCalls.map((t) => ({
          name: t.name.replace(/^mcp__omnipro__/, ""),
          rejected: t.isError === true,
        })),
        elapsedMs: Date.now() - started,
        costUsd: result.costUsd ?? null,
      });
    } catch (e) {
      return json(res, 500, { error: String(e).slice(0, 400) });
    }
  }


  /**
   * Voice fast path.
   *
   * Conversation needs a reply inside ~200 ms; the full agent takes 20-45 s.
   * The questions people ask out loud are table lookups, so answer those here
   * with no model in the loop and let everything else fall through.
   */
  if (req.method === "POST" && url.pathname === "/api/fast") {
    const started = process.hrtime.bigint();
    try {
      const { question } = JSON.parse(await readBody(req)) as { question?: string };
      const hit = fastAnswer((question ?? "").trim());
      const micros = Number(process.hrtime.bigint() - started) / 1000;
      if (!hit) return json(res, 200, { matched: false, micros: Math.round(micros) });

      let svg: string | null = null;
      if (hit.polarityRow) {
        const row = groundTruth.polarity.find((r) => r.id === hit.polarityRow);
        if (row) {
          const v = verifyDiagram(buildPolarityCircuit(row));
          if (v.ok) svg = toSvg(v.spec, { heading: false });
        }
      }
      return json(res, 200, {
        matched: true,
        ...hit,
        svg,
        micros: Math.round(Number(process.hrtime.bigint() - started) / 1000),
      });
    } catch (e) {
      return json(res, 500, { error: String(e).slice(0, 300) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ask/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const body = JSON.parse(await readBody(req)) as {
        question?: string;
        images?: Array<{ data: string; mediaType: Attachment["mediaType"] }>;
      };
      const question = (body.question ?? "").trim();
      if (!question) {
        send("error", { error: "empty question" });
        return res.end();
      }
      const started = Date.now();
      const result = await ask(
        { text: question, ...(body.images?.length ? { images: body.images } : {}) },
        {},
        (e) => {
          if (e.type === "done") return;
          send(e.type, e);
        },
      );
      send("done", {
        citedPages: citedPagesIn(result.text),
        figures: figuresForPages(citedPagesIn(result.text)),
        elapsedMs: Date.now() - started,
        costUsd: result.costUsd ?? null,
        tools: result.toolCalls.map((t) => ({
          name: t.name.replace(/^mcp__omnipro__/, ""),
          rejected: t.isError === true,
        })),
      });
    } catch (e) {
      send("error", { error: String(e).slice(0, 400) });
    }
    return res.end();
  }

  /**
   * The rejection demo.
   *
   * The strongest property of this system -- that a wrong wiring diagram cannot
   * be rendered -- is otherwise invisible: you would have to read verify.ts to
   * know it exists. This endpoint takes the real flux-core diagram, moves the
   * electrode lead to the wrong socket, and shows what happens.
   */
  if (req.method === "GET" && url.pathname === "/api/demo/rejection") {
    const row = groundTruth.polarity.find((r) => r.id === "fcaw_self_shielded")!;
    const good = buildPolarityCircuit(row);

    const tampered = structuredClone(good);
    const edge = tampered.edges.find((e) => e.id === "electrode-lead")!;
    edge.from.port = "term.positive"; // flux-core is DCEN; this is the dangerous error
    edge.polaritySign = "+";

    const rejected = verifyDiagram(tampered);
    const accepted = verifyDiagram(good);

    return json(res, 200, {
      tamperedWith:
        "Moved the flux-core wire feed lead from the Negative socket to the Positive socket, " +
        "exactly the mistake that would burn up a weld and mislead someone standing at the machine.",
      rejected: rejected.ok ? null : rejected.violations,
      correctSvg: accepted.ok ? toSvg(accepted.spec, { heading: false }) : null,
      correctTitle: accepted.ok ? accepted.spec.title : null,
      citedRow: { id: row.id, page: row.page, quote: row.quote, convention: row.convention },
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/page/")) {
    const n = Number(url.pathname.split("/").pop());
    const page = pages.find((p) => p.page === n);
    if (!page) return json(res, 404, { error: "no such page" });
    return json(res, 200, { page: n, text: page.text });
  }

  if (req.method === "GET" && url.pathname === "/api/facts") {
    return json(res, 200, {
      polarity: groundTruth.polarity.map((r) => ({
        id: r.id,
        label: r.label,
        convention: r.convention,
        page: r.page,
      })),
      contradictions: groundTruth.contradictions.map((c) => ({ page: c.page, quote: c.quote })),
    });
  }

  /**
   * Rendered manual pages.
   *
   * The viewer shows the page as printed. The extracted TEXT exists to prove a
   * citation, not to be read: normalised page text runs figure captions into
   * the middle of procedures and is unpleasant to look at.
   */
  if (req.method === "GET" && url.pathname.startsWith("/pageimg/")) {
    const name = normalize(url.pathname.replace("/pageimg/", "")).replace(/^(\.\.[/\\])+/, "");
    try {
      const buf = await readFile(join(PAGEIMG, name));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
      return res.end(buf);
    } catch {
      res.writeHead(404);
      return res.end("not found");
    }
  }

  /**
   * A widget payload on its own.
   *
   * Same builder the agent's tool uses, so this is not a mock -- it lets the UI
   * preview a widget, and lets tests exercise the interaction without paying for
   * an agent round trip.
   */
  if (req.method === "GET" && url.pathname.startsWith("/api/widget/")) {
    const kind = url.pathname.split("/").pop() as WidgetKind;
    if (!WIDGET_KINDS.includes(kind)) {
      return json(res, 404, { error: "unknown widget", known: WIDGET_KINDS });
    }
    return json(res, 200, buildWidget(kind));
  }

  /**
   * The two documents that are not the owner's manual, plus the door decal.
   *
   * These are served as images because that is what they are: the selection
   * chart has no text layer at all, and the quick-start guide's cable setups
   * extract as nothing. Showing the page is the only honest citation for them.
   */
  if (req.method === "GET" && url.pathname.startsWith("/docs/")) {
    const name = normalize(url.pathname.replace("/docs/", "")).replace(/^(\.\.[/\\])+/, "");
    try {
      const buf = await readFile(join(DOCS, name));
      res.writeHead(200, {
        "content-type": name.endsWith(".txt") ? "text/plain; charset=utf-8" : "image/png",
        "cache-control": "public, max-age=3600",
      });
      return res.end(buf);
    } catch {
      res.writeHead(404);
      return res.end("not found");
    }
  }

  if (req.method === "GET" && url.pathname === "/api/manuals") {
    return json(res, 200, {
      manuals: [
        {
          id: "omnipro-220",
          title: "OmniPro 220 Multiprocess Welding System",
          subtitle: "Owner's manual",
          maker: "Vulcan / Harbor Freight",
          item: "57812",
          pages: pages.length,
          cover: "/pageimg/p01.png",
          thumb: "/assets/omnipro-220.jpg",
          figures: figureIndex.length,
          note: "48 pages of clean text. Everything cited as (p.N) resolves here.",
        },
        {
          id: "quick-start",
          title: "Quick Start Guide",
          subtitle: "Cable setup for all four processes",
          maker: "Vulcan / Harbor Freight",
          item: "57812",
          pages: 2,
          cover: "/docs/qsg-p1.png",
          figures: 0,
          note: "558 characters of text, and none of it is the wiring. Page 2 is the only place all four processes' cable setups appear together -- as a drawing.",
        },
        {
          id: "selection-chart",
          title: "How To Choose A Welder",
          subtitle: "Process selection chart",
          maker: "Vulcan / Harbor Freight",
          item: "57812",
          pages: 1,
          cover: "/docs/sel-p1.png",
          figures: 0,
          note: "ZERO extractable characters. One JPEG. A text-only pipeline cannot see this document at all.",
        },
        {
          id: "door-decal",
          title: "Settings Chart",
          subtitle: "Decal inside the welder door",
          maker: "Vulcan / Harbor Freight",
          item: "57812",
          pages: 1,
          cover: "/docs/decal.png",
          figures: 0,
          note: "A photograph, not a document. The manual points readers at it five times.",
        },
      ],
    });
  }

  if (req.method === "GET" && url.pathname.startsWith("/figures/")) {
    const name = normalize(url.pathname.replace("/figures/", "")).replace(/^(\.\.[/\\])+/, "");
    try {
      const buf = await readFile(join(FIGURES, name));
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(buf);
    } catch {
      res.writeHead(404);
      return res.end("not found");
    }
  }

  // Static, path-traversal guarded.
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  try {
    const buf = await readFile(join(PUBLIC, safe));
    res.writeHead(200, { "content-type": MIME[extname(safe)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`OmniPro 220 specialist  ->  http://127.0.0.1:${PORT}`);
  console.log(`auth: ${creds.source}`);
});
