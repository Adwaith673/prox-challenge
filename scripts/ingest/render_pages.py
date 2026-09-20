"""Render each manual page to an image for the in-app viewer.

The extracted TEXT is the verification substrate -- it is what proves a quoted
number really appears on the page it cites. It is not what a person should be
asked to read: normalised, unwrapped page text is a wall of run-on sentences
with the figure captions spliced into the middle of procedures.

So the viewer shows the page as it was printed, and the text stays behind the
scenes doing its job.
"""

import json
import sys
from pathlib import Path

import fitz

from corpus import resolve_corpus

ROOT = Path(__file__).resolve().parents[2]
PDF, CORPUS = resolve_corpus(sys.argv[1:])
OUT = CORPUS / "pageimg"

# 150 DPI is the sweet spot here: small callout text on the wiring pages stays
# legible when zoomed, and a page still lands around 250 KB.
DPI = 150


def main() -> None:
    doc = fitz.open(PDF)
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()

    index = []
    total = 0
    for i in range(doc.page_count):
        page_no = i + 1
        pix = doc[i].get_pixmap(dpi=DPI)
        path = OUT / f"p{page_no:02d}.png"
        pix.save(path)
        size = path.stat().st_size
        total += size
        index.append({"page": page_no, "width": pix.width, "height": pix.height, "bytes": size})

    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"rendered {len(index)} pages at {DPI} dpi -> {OUT}")
    print(f"total {total / 1_000_000:.1f} MB, {index[0]['width']}x{index[0]['height']} px each")


if __name__ == "__main__":
    main()
