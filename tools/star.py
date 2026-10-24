#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf>=4"]
# ///
"""Draw a small star on a PDF page, as an /Ink annotation, at a point.

    star.py FILE.pdf PAGE X Y [RADIUS]

PAGE is 1-based; X and Y are PDF user-space points (origin bottom-left), which
is what pdfink hands a menu command in $PAGE, $X and $Y.

Run from pdfink's pen menu ($PDFINK_SOCKET set), the star is drawn in the
browser as one stroke, an ordinary undoable edit, and the file is not touched.
Otherwise -- or if the page goes away mid-run -- the file is rewritten in place;
because the star is an ordinary ink annotation, pdfink reads it back as a stroke
you can select or erase.
"""
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pdfink_page  # noqa: E402

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)


def star_points(cx: float, cy: float, r: float, n: int = 5) -> list[tuple[float, float]]:
    """A closed five-pointed star, drawn as one path through alternating radii."""
    pts = []
    for i in range(2 * n + 1):
        a = math.pi / 2 + i * math.pi / n
        rr = r if i % 2 == 0 else r * 0.4
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def draw_in_browser(page: pdfink_page.Page, page_no: int, pts: list[tuple[float, float]]) -> None:
    """Send the star to the page as one stroke, in PDF points."""
    stroke = {
        "points": [{"x": px, "y": py, "p": 0.6} for px, py in pts],
        "color": "#d91a1a",
        "width": 1.5,
        "opacity": 1,
    }
    page.add_strokes(page_no - 1, [stroke], space="pdf")


def stamp_file(path: str, page_no: int, pts: list[tuple[float, float]]) -> int:
    """Write the star into the PDF as an /Ink annotation; 0, or 1 on a bad page."""
    width, colour = 1.5, (0.85, 0.1, 0.1)
    writer = PdfWriter(clone_from=path)
    if not 1 <= page_no <= len(writer.pages):
        print(f"page {page_no} out of range (1..{len(writer.pages)})", file=sys.stderr)
        return 1
    m = width + 1
    x0, y0 = min(p[0] for p in pts) - m, min(p[1] for p in pts) - m
    x1, y1 = max(p[0] for p in pts) + m, max(p[1] for p in pts) + m

    # Appearance stream: what viewers draw.
    ops = [f"q {colour[0]:g} {colour[1]:g} {colour[2]:g} RG {width:g} w 1 J 1 j"]
    ops.append(f"{pts[0][0]:.2f} {pts[0][1]:.2f} m")
    ops += [f"{px:.2f} {py:.2f} l" for px, py in pts[1:]]
    ops.append("S Q")
    ap = StreamObject()
    ap.set_data("\n".join(ops).encode())
    ap.update({
        NameObject("/Type"): NameObject("/XObject"),
        NameObject("/Subtype"): NameObject("/Form"),
        NameObject("/BBox"): ArrayObject(FloatObject(v) for v in (x0, y0, x1, y1)),
    })
    ap_ref = writer._add_object(ap)

    annot = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"),
        NameObject("/Subtype"): NameObject("/Ink"),
        NameObject("/Rect"): ArrayObject(FloatObject(v) for v in (x0, y0, x1, y1)),
        NameObject("/InkList"): ArrayObject([ArrayObject(FloatObject(v) for p in pts for v in p)]),
        NameObject("/C"): ArrayObject(FloatObject(c) for c in colour),
        NameObject("/BS"): DictionaryObject({NameObject("/W"): FloatObject(width)}),
        NameObject("/F"): NumberObject(4),
        NameObject("/T"): TextStringObject("star.py"),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): ap_ref}),
    })
    writer.add_annotation(page_number=page_no - 1, annotation=annot)

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), suffix=".pdf")
    with os.fdopen(fd, "wb") as f:
        writer.write(f)
    os.replace(tmp, path)
    return 0


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__, file=sys.stderr)
        return 2
    path, page_no = sys.argv[1], int(sys.argv[2])
    x, y = float(sys.argv[3]), float(sys.argv[4])
    r = float(sys.argv[5]) if len(sys.argv) > 5 else 12.0
    pts = star_points(x, y, r)

    try:
        page = pdfink_page.connect(optional=True)
        if page is not None:
            with page:
                draw_in_browser(page, page_no, pts)
            print(f"star at ({x:.0f}, {y:.0f}) on page {page_no} (drawn in the browser)")
            return 0
    except pdfink_page.PageGone as e:  # write the file instead, so the star is not lost
        print(f"page gone ({e}); writing the file instead", file=sys.stderr)

    status = stamp_file(path, page_no, pts)
    if status == 0:
        print(f"star at ({x:.0f}, {y:.0f}) on page {page_no}")
    return status


if __name__ == "__main__":
    sys.exit(main())
