"""Ingest the two documents that are not the owner's manual.

The challenge ships three PDFs. Only one of them behaves like a document:

    owner-manual.pdf      48 pages, ~92k characters of clean text
    quick-start-guide.pdf  2 pages, 555 characters -- and NONE of the cable
                           setup text is in that 555. Page 2 carries all four
                           processes' polarity wiring and extracts as the single
                           line "BASIC WELDING INSTRUCTIONS ... ARE IN MANUAL."
    selection-chart.pdf    1 page, ZERO characters. One 1200x1200 JPEG.

A text pipeline reads the first, returns almost nothing for the second, and
returns literally nothing for the third -- without erroring. The brief warns
about exactly this ("some critical information exists only in images"), so the
silent-empty case is the one to design against: this script asserts a floor on
what each document must yield and fails loudly if a document comes back blank.

Page images are the deliverable here, not text. What these two documents know is
carried in their pixels, so they are rendered at 200 dpi and handed to the model
as images; their *facts* are hand-transcribed into data/tables/ where every other
load-bearing number in this system lives.
"""

import json
import sys
from pathlib import Path

import fitz
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_pages import normalize  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
FILES = ROOT / "files"
OUT = ROOT / "data" / "docs"

# (stem, doc id, human title, min pages, whether text is expected at all)
DOCS = [
    ("quick-start-guide", "qsg", "Quick Start Guide", 2, True),
    ("selection-chart", "sel", "How To Choose A Welder (process selection chart)", 1, False),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index = []

    for stem, doc_id, title, min_pages, expect_text in DOCS:
        pdf = FILES / f"{stem}.pdf"
        if not pdf.exists():
            sys.exit(f"missing {pdf} -- run: git submodule / re-download files/ from upstream")

        doc = fitz.open(pdf)
        if doc.page_count < min_pages:
            sys.exit(f"{stem}: expected >= {min_pages} pages, got {doc.page_count}")

        pages = []
        for i in range(doc.page_count):
            page = doc[i]
            text = normalize(page.get_text())
            # 200 dpi: the selection chart's smallest cells are ~7pt and have to
            # stay legible both to the vision model and to a human clicking it.
            pix = page.get_pixmap(dpi=200)
            name = f"{doc_id}-p{i + 1}.png"
            pix.save(OUT / name)
            pages.append(
                {
                    "page": i + 1,
                    "chars": len(text),
                    "image": f"/docs/{name}",
                    "width": pix.width,
                    "height": pix.height,
                    "textOnly": expect_text,
                }
            )
            (OUT / f"{doc_id}-p{i + 1}.txt").write_text(text, encoding="utf-8")

        index.append({"id": doc_id, "title": title, "file": f"files/{stem}.pdf", "pages": pages})
        total = sum(p["chars"] for p in pages)
        print(f"{stem}: {doc.page_count} page(s), {total} chars, rendered at 200dpi")
        if expect_text and total == 0:
            sys.exit(f"{stem}: expected text, extracted none -- ingest is broken, not the PDF")
        doc.close()

    # The door decal is a photograph in the repo root, not a PDF, and the manual
    # points readers at it five times ("the Settings Chart on the inside of the
    # Welder door"). Without it the single most-referenced surface on the machine
    # is missing from the corpus.
    decal = FILES / "product-inside.webp"
    if decal.exists():
        index.append(
            {
                "id": "decal",
                "title": "Settings Chart (decal inside the welder door)",
                "file": "files/product-inside.webp",
                "pages": [{"page": 1, "chars": 0, "image": "/docs/decal.png", "textOnly": False}],
            }
        )
        # PIL, not fitz: MuPDF has no webp decoder and raises "unknown image
        # file format" here.
        Image.open(decal).convert("RGB").save(OUT / "decal.png")
        print("product-inside.webp: door Settings Chart -> docs/decal.png")

    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"wrote {OUT / 'index.json'}")


if __name__ == "__main__":
    main()
