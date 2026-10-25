"""Write strokes into a PDF file as /Ink annotations, the way pdfink saves them.

For tools that stamp ink when no pdfink page is there to draw it (shell use, or
the page went away mid-run). Needs pypdf, which each calling script declares.
Points are PDF user space: origin bottom-left, y up.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass

from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    StreamObject,
    TextStringObject,
)


@dataclass
class InkStroke:
    points: list[tuple[float, float]]
    colour: tuple[float, float, float]
    width: float


def hex_colour(c: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{round(v * 255):02x}" for v in c)


def add_ink(writer: PdfWriter, page_index: int, stroke: InkStroke, author: str) -> None:
    """Add one stroke to a page as an /Ink annotation with an appearance stream."""
    pts, (r, g, b), width = stroke.points, stroke.colour, stroke.width
    m = width + 1
    x0, y0 = min(p[0] for p in pts) - m, min(p[1] for p in pts) - m
    x1, y1 = max(p[0] for p in pts) + m, max(p[1] for p in pts) + m

    # Appearance stream: what viewers draw.
    ops = [f"q {r:g} {g:g} {b:g} RG {width:g} w 1 J 1 j"]
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
        NameObject("/C"): ArrayObject(FloatObject(c) for c in (r, g, b)),
        NameObject("/BS"): DictionaryObject({NameObject("/W"): FloatObject(width)}),
        NameObject("/F"): NumberObject(4),
        NameObject("/T"): TextStringObject(author),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): ap_ref}),
    })
    writer.add_annotation(page_number=page_index, annotation=annot)


def write_in_place(writer: PdfWriter, path: str) -> None:
    """Replace the file atomically, keeping its mode."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), suffix=".pdf")
    with os.fdopen(fd, "wb") as f:
        writer.write(f)
    shutil.copymode(path, tmp)  # mkstemp makes it 0600; keep the notebook's own mode
    os.replace(tmp, path)
