"""Extract per-page text from the OmniPro 220 manual into data/pages/.

Output is the verification substrate: every number asserted in data/tables/*.json
must appear verbatim in the extracted text of its cited page.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

import fitz

from corpus import resolve_corpus

ROOT = Path(__file__).resolve().parents[2]
PDF, CORPUS = resolve_corpus(sys.argv[1:])
OUT = CORPUS / "pages"


def normalize(text: str) -> str:
    """Collapse whitespace and fold the unicode variants that break substring checks."""
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("−", "-").replace("–", "-").replace("—", "-")
    text = text.replace("’", "'").replace("“", '"').replace("”", '"')
    text = text.replace("�", "'")
    return re.sub(r"\s+", " ", text).strip()


def main() -> None:
    doc = fitz.open(PDF)
    OUT.mkdir(parents=True, exist_ok=True)

    index = []
    for i in range(doc.page_count):
        page = doc[i]
        page_no = i + 1
        raw = page.get_text()
        norm = normalize(raw)
        (OUT / f"p{page_no:02d}.txt").write_text(norm, encoding="utf-8")
        index.append(
            {
                "page": page_no,
                "chars": len(norm),
                "rasterImages": len(page.get_images(full=True)),
                "vectorDrawings": len(page.get_drawings()),
            }
        )

    (OUT / "index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")

    total_chars = sum(p["chars"] for p in index)
    total_raster = sum(p["rasterImages"] for p in index)
    total_vector = sum(p["vectorDrawings"] for p in index)
    print(f"pages={doc.page_count} chars={total_chars}")
    print(f"raster_images={total_raster} vector_drawings={total_vector}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
