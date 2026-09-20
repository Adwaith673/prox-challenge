"""Extract figures from the OmniPro 220 manual.

The manual's figures are VECTOR ART, not embedded rasters. Measured: 191 raster
images versus 257,862 vector drawing primitives across 48 pages, and pages 12-16
(the polarity setup pages, the ones that matter most) contain zero rasters.
page.get_images() therefore returns nothing on exactly the pages we need, silently.

Approach: paint every drawing primitive's bbox onto a coarse occupancy grid,
dilate to bridge intra-figure gaps, flood-fill into connected components, expand
each component to swallow the text labels sitting inside it, then re-render that
clip at high DPI.
"""

import json
import sys
from collections import deque
from pathlib import Path

import fitz

from corpus import resolve_corpus

ROOT = Path(__file__).resolve().parents[2]
PDF, CORPUS = resolve_corpus(sys.argv[1:])
OUT = CORPUS / "figures"

CELL = 4.0          # occupancy grid cell, points
DILATE = 2          # cells; 2 * 4pt = 8pt expansion, bridges 16pt gaps
MIN_AREA_FRAC = 0.015
HEADER_PT = 54.0    # "Page N / For technical questions... / Item 57812" band
FOOTER_PT = 40.0
SIDE_TAB_PT = 30.0  # black section tab bleeds off BOTH page edges
DPI = 300
TEXT_OVERLAP = 0.55  # fraction of a text block inside a region to absorb it
SPLIT_GAP_PT = 22.0  # horizontal whitespace band that separates stacked figures
MIN_FIG_PT = 40.0    # reject slivers: tab strips, rules, stray marks


def components(grid, cols, rows):
    """4-connected flood fill over the occupancy grid."""
    seen = [[False] * cols for _ in range(rows)]
    out = []
    for sy in range(rows):
        for sx in range(cols):
            if not grid[sy][sx] or seen[sy][sx]:
                continue
            q = deque([(sx, sy)])
            seen[sy][sx] = True
            x0 = x1 = sx
            y0 = y1 = sy
            n = 0
            while q:
                x, y = q.popleft()
                n += 1
                x0, x1 = min(x0, x), max(x1, x)
                y0, y1 = min(y0, y), max(y1, y)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < cols and 0 <= ny < rows and grid[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            out.append((x0, y0, x1, y1, n))
    return out


def split_on_gaps(rect, raw, live):
    """Stacked figures share a component. Cut them apart on horizontal gutters.

    Binary occupancy fails here: a single 1pt callout leader line crossing the
    gutter makes every row "occupied" and the whole page stays one strip. So cut
    on row DENSITY instead -- a leader line scores 1-2 cells, real figure content
    scores dozens. Uses the UNDILATED grid so dilation can't paper over a gutter.
    """
    gy0, gy1 = int(rect.y0 / CELL), int(rect.y1 / CELL)
    gx0, gx1 = int(rect.x0 / CELL), int(rect.x1 / CELL)
    ncols = len(raw[0])
    density = [
        sum(1 for x in range(gx0, gx1 + 1) if 0 <= x < ncols and raw[y][x])
        for y in range(gy0, gy1 + 1)
        if 0 <= y < len(raw)
    ]
    if not density:
        return [rect]

    peak = max(density)
    floor = max(2, int(peak * 0.04))
    min_gap = int(SPLIT_GAP_PT / CELL)

    bands, start, gap = [], None, 0
    for i, d in enumerate(density):
        if d > floor:
            if start is None:
                start = i
            gap = 0
        else:
            if start is not None:
                gap += 1
                if gap >= min_gap:
                    bands.append((start, i - gap))
                    start = None
    if start is not None:
        bands.append((start, len(density) - 1))

    if len(bands) <= 1:
        return [rect]
    out = []
    for a, b in bands:
        r = fitz.Rect(
            rect.x0, (gy0 + a) * CELL, rect.x1, (gy0 + b + 1) * CELL
        ) & live
        if not r.is_empty:
            out.append(r)
    return out


def extract_page(page, page_no):
    pr = page.rect
    cols = int(pr.width / CELL) + 1
    rows = int(pr.height / CELL) + 1
    grid = [[False] * cols for _ in range(rows)]
    raw = [[False] * cols for _ in range(rows)]

    live = fitz.Rect(
        SIDE_TAB_PT,
        HEADER_PT,
        pr.width - SIDE_TAB_PT,
        pr.height - FOOTER_PT,
    )

    def paint(rect):
        r = rect & live
        if r.is_empty or r.width <= 0 or r.height <= 0:
            return
        for gy in range(max(0, int(r.y0 / CELL)), min(rows, int(r.y1 / CELL) + 1)):
            for gx in range(max(0, int(r.x0 / CELL)), min(cols, int(r.x1 / CELL) + 1)):
                grid[gy][gx] = True
                raw[gy][gx] = True

    for d in page.get_drawings():
        paint(fitz.Rect(d["rect"]))
    for img in page.get_images(full=True):
        for r in page.get_image_rects(img[0]):
            paint(fitz.Rect(r))

    # dilate to bridge gaps between strokes of the same figure
    for _ in range(DILATE):
        add = []
        for y in range(rows):
            for x in range(cols):
                if grid[y][x]:
                    continue
                if any(
                    0 <= x + dx < cols and 0 <= y + dy < rows and grid[y + dy][x + dx]
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                ):
                    add.append((x, y))
        for x, y in add:
            grid[y][x] = True

    page_area = live.width * live.height
    text_blocks = [fitz.Rect(b[:4]) for b in page.get_text("blocks")]
    figures = []

    for x0, y0, x1, y1, _n in components(grid, cols, rows):
        rect = fitz.Rect(x0 * CELL, y0 * CELL, (x1 + 1) * CELL, (y1 + 1) * CELL) & live
        if rect.is_empty:
            continue
        # undo dilation
        rect = fitz.Rect(
            rect.x0 + DILATE * CELL, rect.y0 + DILATE * CELL,
            rect.x1 - DILATE * CELL, rect.y1 - DILATE * CELL,
        ) & live
        if rect.is_empty:
            continue

        for piece in split_on_gaps(rect, raw, live):
            r = piece
            if r.width < MIN_FIG_PT or r.height < MIN_FIG_PT:
                continue
            if (r.width * r.height) / page_area < MIN_AREA_FRAC:
                continue
            # absorb labels inside the figure, but never a block that juts
            # outside it horizontally (that's body text in an adjacent column)
            for tb in text_blocks:
                inter = tb & r
                if inter.is_empty or tb.get_area() <= 0:
                    continue
                if inter.get_area() / tb.get_area() < TEXT_OVERLAP:
                    continue
                if tb.x0 < r.x0 - 6 or tb.x1 > r.x1 + 6:
                    continue
                r = (r | tb) & live
            figures.append(r)

    # drop regions fully contained in a larger sibling
    figures.sort(key=lambda r: -r.get_area())
    kept = []
    for r in figures:
        if not any((r & k).get_area() / max(r.get_area(), 1) > 0.9 for k in kept):
            kept.append(r)
    kept.sort(key=lambda r: (round(r.y0, 1), round(r.x0, 1)))
    return kept


def main() -> None:
    doc = fitz.open(PDF)
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()

    index = []
    for i in range(doc.page_count):
        page = doc[i]
        page_no = i + 1
        for j, rect in enumerate(extract_page(page, page_no), start=1):
            fid = f"p{page_no:02d}-f{j}"
            pix = page.get_pixmap(clip=rect, dpi=DPI)
            pix.save(OUT / f"{fid}.png")
            index.append(
                {
                    "id": fid,
                    "page": page_no,
                    "bbox": [round(v, 1) for v in (rect.x0, rect.y0, rect.x1, rect.y1)],
                    "width": pix.width,
                    "height": pix.height,
                    "file": f"figures/{fid}.png",
                }
            )
        print(f"p{page_no:02d}: {sum(1 for f in index if f['page'] == page_no)} figures")

    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"\ntotal figures: {len(index)}")


if __name__ == "__main__":
    main()
