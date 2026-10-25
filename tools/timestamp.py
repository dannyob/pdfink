#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf>=4"]
# ///
"""Stamp a diary timestamp in ink at a point, and bookmark the page with it.

    timestamp.py FILE.pdf PAGE X Y [--at "YYYY-MM-DD HH:MM"] [--size PT] [--page-width PT]

Draws a small red chevron and then today's date and the time, e.g.
`> 2026-10-25 13:46`, as ordinary pen strokes in a plain single-stroke hand,
vertically centred on the point and reading rightwards from it (pulled left
if it would run off the page). The page gets a bookmark titled with the same
date and time, which is how journal-page.py finds the entry's date without
having to read it.

PAGE is 1-based; X and Y are PDF points (origin bottom-left), as pdfink hands
a menu command in $PAGE, $X and $Y; pass $PAGE_WIDTH as --page-width so the
stamp stays on the page. --size is the height of the digits (default 14).

From pdfink's pen menu ($PDFINK_SOCKET set) the stamp is drawn in the browser
as one undoable edit and the file is not touched. Otherwise, or if the page goes
away mid-run, the ink and bookmark are written into the file.
"""
from __future__ import annotations

import argparse
import datetime as dt
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pdfink_page  # noqa: E402

RED = (0.85, 0.1, 0.1)
INK = (0.1, 0.1, 0.1)
MARGIN = 8.0
FORMAT = "%Y-%m-%d %H:%M"

Path = list[tuple[float, float]]


def arc(cx: float, cy: float, rx: float, ry: float, a0: float, a1: float, n: int = 16) -> Path:
    """Points along an elliptical arc from angle a0 to a1 (degrees; either way round)."""
    return [
        (cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n)))
        for i in range(n + 1)
    ]


def dot(cx: float, cy: float) -> Path:
    return arc(cx, cy, 0.04, 0.04, 0, 360, 8)


# A single-stroke hand: each glyph is a list of strokes in a box one unit tall
# (y up, baseline 0), with the advance to the next glyph.
GLYPHS: dict[str, tuple[float, list[Path]]] = {
    "0": (0.8, [arc(0.3, 0.5, 0.28, 0.5, 90, 450, 32)]),
    "1": (0.8, [[(0.1, 0.78), (0.32, 1.0), (0.32, 0.0)]]),
    "2": (0.8, [arc(0.3, 0.72, 0.27, 0.28, 165, -30, 14) + [(0.03, 0.0), (0.6, 0.0)]]),
    "3": (0.8, [arc(0.3, 0.76, 0.25, 0.24, 150, -90, 14) + arc(0.3, 0.27, 0.28, 0.27, 90, -150, 16)]),
    "4": (0.8, [[(0.46, 0.0), (0.46, 1.0), (0.02, 0.32), (0.6, 0.32)]]),
    "5": (0.8, [[(0.56, 1.0), (0.12, 1.0), (0.07, 0.56)] + arc(0.3, 0.33, 0.29, 0.33, 140, -145, 16)]),
    "6": (0.8, [[(0.52, 0.97), (0.32, 0.86), (0.14, 0.64), (0.05, 0.4)] + arc(0.31, 0.3, 0.27, 0.3, 170, 530, 24)]),
    "7": (0.8, [[(0.02, 1.0), (0.58, 1.0), (0.22, 0.0)]]),
    "8": (0.8, [arc(0.3, 0.76, 0.23, 0.24, -90, 270, 20) + arc(0.3, 0.27, 0.28, 0.27, 90, -270, 24)]),
    "9": (0.8, [arc(0.3, 0.7, 0.27, 0.3, 0, 360, 24) + [(0.54, 0.35), (0.42, 0.0)]]),
    "-": (0.6, [[(0.1, 0.48), (0.5, 0.48)]]),
    ":": (0.45, [dot(0.2, 0.72), dot(0.2, 0.22)]),
    " ": (0.55, []),
}
CHEVRON: tuple[float, list[Path]] = (1.0, [[(0.0, 0.9), (0.42, 0.5), (0.0, 0.1)]])


def layout(text: str, x: float, y: float, size: float, page_width: float | None) -> list[tuple[Path, tuple[float, float, float], float]]:
    """The stamp's strokes in PDF points: (points, colour, width), chevron first."""
    glyphs = [(CHEVRON, RED)] + [(GLYPHS[c], INK) for c in text]
    width = size * sum(adv for (adv, _), _ in glyphs)
    if page_width and x + width > page_width - MARGIN:
        x = max(MARGIN, page_width - MARGIN - width)
    base = y - size / 2
    out = []
    pen = x
    for (adv, strokes), colour in glyphs:
        w = size * (0.13 if colour == RED else 0.09)
        for s in strokes:
            out.append(([(pen + px * size, base + py * size) for px, py in s], colour, w))
        pen += adv * size
    return out


def hex_colour(c: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{round(v * 255):02x}" for v in c)


def draw_in_browser(page: pdfink_page.Page, page_no: int, strokes, title: str) -> None:
    page.add_strokes(
        page_no - 1,
        [{"points": [{"x": px, "y": py, "p": 0.6} for px, py in pts], "color": hex_colour(c), "width": w, "opacity": 1} for pts, c, w in strokes],
        space="pdf",
    )
    if not any(b.get("title") == title and b.get("page") == page_no - 1 for b in page.bookmarks()):
        page.add_bookmark(page_no - 1, title)


def stamp_file(path: str, page_no: int, x: float, y: float, size: float, title: str) -> int:
    from pypdf import PdfWriter

    from pdf_ink import InkStroke, add_ink, write_in_place

    writer = PdfWriter(clone_from=path)
    if not 1 <= page_no <= len(writer.pages):
        print(f"page {page_no} out of range (1..{len(writer.pages)})", file=sys.stderr)
        return 1
    box = writer.pages[page_no - 1].mediabox
    for pts, c, w in layout(title, x, y, size, float(box.right)):
        add_ink(writer, page_no - 1, InkStroke(pts, c, w), "timestamp.py")
    writer.add_outline_item(title, page_no - 1)
    write_in_place(writer, path)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("page", type=int, help="1-based page number")
    ap.add_argument("x", type=float)
    ap.add_argument("y", type=float)
    ap.add_argument("--at", help='the moment to stamp, "YYYY-MM-DD HH:MM" (default: now)')
    ap.add_argument("--size", type=float, default=14.0, help="digit height in points")
    ap.add_argument("--page-width", type=float, help="page width in points, to keep the stamp on the page")
    a = ap.parse_args()
    try:
        when = dt.datetime.strptime(a.at, FORMAT) if a.at else dt.datetime.now()
    except ValueError:
        ap.error('--at must be "YYYY-MM-DD HH:MM"')
    title = when.strftime(FORMAT)

    try:
        page = pdfink_page.connect(optional=True)
        if page is not None:
            with page:
                draw_in_browser(page, a.page, layout(title, a.x, a.y, a.size, a.page_width), title)
            print(f"{title} on page {a.page} (drawn in the browser)")
            return 0
    except pdfink_page.PageGone as e:  # write the file instead, so the stamp is not lost
        print(f"page gone ({e}); writing the file instead", file=sys.stderr)

    status = stamp_file(a.pdf, a.page, a.x, a.y, a.size, title)
    if status == 0:
        print(f"{title} on page {a.page}")
    return status


if __name__ == "__main__":
    sys.exit(main())
