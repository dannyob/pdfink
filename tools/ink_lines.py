"""Group a page's ink strokes into lines of handwriting, and lines into notes.

Pure stdlib. Strokes are dicts as the page API returns them, in page space
(top-left origin, y down, PDF points):
    {"id": str, "points": [{"x", "y", "p"}, ...], "color", "width", "opacity"}

Rules (see docs/superpowers/specs/2026-10-25-handwriting-text-design.md):
- Connectors (dashes, arrows, long arcs to a note) are set aside first.
- A stroke joins a line when it overlaps the line vertically by at least half
  the smaller height and sits within a few line-heights of it horizontally,
  so notes level with each other on opposite sides of a figure stay apart.
- Dots (and commas) join the nearest line.
- Lines stacked closely with overlapping horizontal extents form one note.

The thresholds below are starting values; tune them here.
"""
from __future__ import annotations

import hashlib
import statistics
from dataclasses import dataclass

# Connector: wide and flat ...
CONNECTOR_MIN_WIDTH = 3.0  # x median stroke height
CONNECTOR_MAX_FLATNESS = 0.35  # height / width
# ... or simply very wide.
CONNECTOR_WIDE = 6.0  # x median stroke height
# Lines.
LINE_MIN_OVERLAP = 0.5  # of the smaller height
LINE_MAX_GAP = 2.5  # x the line's height
# Dots: both dimensions below this fraction of the median height.
DOT_MAX = 0.3
# Notes.
NOTE_MAX_GAP = 1.2  # x the taller line's height
# Notes whose tops are within this many median heights read left to right.
LEVEL_TOLERANCE = 1.0
# Used by is_connector when no median is given.
TYPICAL_STROKE_HEIGHT = 14.0


@dataclass
class Line:
    stroke_ids: list[str]
    x: float
    y: float
    w: float
    h: float
    sig: str
    note: int


Box = tuple[float, float, float, float]  # x0, y0, x1, y1


def _bbox(stroke: dict) -> Box | None:
    pts = stroke.get("points") or []
    if not pts:
        return None
    xs = [p["x"] for p in pts]
    ys = [p["y"] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _union(a: Box, b: Box) -> Box:
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


def median_height(strokes: list[dict]) -> float:
    """Median bbox height of the strokes that have points (0 if none)."""
    hs = [b[3] - b[1] for b in map(_bbox, strokes) if b is not None]
    return statistics.median(hs) if hs else 0.0


def is_connector(stroke: dict, median_h: float | None = None) -> bool:
    """True for a dash, arrow or arc: much wider than a line is tall and thin
    for its length, or simply very wide. `median_h` is the page's median
    stroke height (TYPICAL_STROKE_HEIGHT when not given)."""
    b = _bbox(stroke)
    if b is None:
        return False
    m = TYPICAL_STROKE_HEIGHT if median_h is None else median_h
    if m <= 0:
        return False
    w, h = b[2] - b[0], b[3] - b[1]
    if w >= CONNECTOR_WIDE * m:
        return True
    return w >= CONNECTOR_MIN_WIDTH * m and h <= CONNECTOR_MAX_FLATNESS * w


def signature(strokes: list[dict]) -> str:
    """Fingerprint of the strokes' geometry: sha1 (first 16 hex chars) of the
    sorted strokes' points rounded to 0.1 pt. Independent of stroke order and
    ids; pressure and style are ignored."""
    keyed = sorted(
        ";".join(f"{round(p['x'] * 10)},{round(p['y'] * 10)}" for p in s.get("points") or [])
        for s in strokes
    )
    return hashlib.sha1("|".join(keyed).encode()).hexdigest()[:16]


def _v_overlap(a: Box, b: Box) -> float:
    """Vertical overlap as a fraction of the smaller height."""
    ov = min(a[3], b[3]) - max(a[1], b[1])
    smaller = min(a[3] - a[1], b[3] - b[1])
    if smaller <= 0:
        return 1.0 if ov >= 0 else 0.0
    return ov / smaller


def _h_gap(a: Box, b: Box) -> float:
    return max(0.0, max(a[0], b[0]) - min(a[2], b[2]))


def _joins(stroke: Box, line: Box) -> bool:
    return (
        _v_overlap(stroke, line) >= LINE_MIN_OVERLAP
        and _h_gap(stroke, line) <= LINE_MAX_GAP * (line[3] - line[1])
    )


def _dist(a: Box, b: Box) -> float:
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return (dx * dx + dy * dy) ** 0.5


class _Group:
    def __init__(self, sid: str, box: Box) -> None:
        self.ids = [sid]
        self.box = box

    def add(self, sid: str, box: Box) -> None:
        self.ids.append(sid)
        self.box = _union(self.box, box)


def _lines(items: list[tuple[str, Box]]) -> list[_Group]:
    groups: list[_Group] = []
    for sid, b in sorted(items, key=lambda it: (it[1][0], it[1][1])):
        best = None
        for g in groups:
            if _joins(b, g.box):
                key = (-_v_overlap(b, g.box), _h_gap(b, g.box))
                if best is None or key < best[0]:
                    best = (key, g)
        if best is None:
            groups.append(_Group(sid, b))
        else:
            best[1].add(sid, b)
    # Growing lines can come to meet; merge until stable.
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, c = groups[i], groups[j]
                if _joins(c.box, a.box) or _joins(a.box, c.box):
                    a.ids += c.ids
                    a.box = _union(a.box, c.box)
                    del groups[j]
                    merged = True
                    break
            if merged:
                break
    return groups


def _notes(lines: list[_Group], median_h: float) -> list[list[_Group]]:
    notes: list[list[_Group]] = []
    for ln in sorted(lines, key=lambda g: (g.box[1], g.box[0])):
        best = None
        for note in notes:
            last = note[-1]
            gap = ln.box[1] - last.box[3]
            taller = max(ln.box[3] - ln.box[1], last.box[3] - last.box[1])
            overlaps = min(ln.box[2], last.box[2]) - max(ln.box[0], last.box[0]) > 0
            if overlaps and gap <= NOTE_MAX_GAP * taller:
                if best is None or gap < best[0]:
                    best = (gap, note)
        if best is None:
            notes.append([ln])
        else:
            best[1].append(ln)
    # Reading order: top to bottom, left to right among notes level with each other.
    notes.sort(key=lambda n: n[0].box[1])
    ordered: list[list[_Group]] = []
    tol = LEVEL_TOLERANCE * median_h
    i = 0
    while i < len(notes):
        top = notes[i][0].box[1]
        band = [n for n in notes[i:] if n[0].box[1] - top <= tol]
        ordered += sorted(band, key=lambda n: n[0].box[0])
        i += len(band)
    return ordered


def group(strokes: list[dict]) -> list[Line]:
    """Group strokes into lines in reading order, with notes numbered from 0
    in reading order. Connectors belong to no line."""
    boxed = [(s, b) for s in strokes if (b := _bbox(s)) is not None]
    if not boxed:
        return []
    m = median_height([s for s, _ in boxed])
    by_id = {s["id"]: s for s, _ in boxed}

    words: list[tuple[str, Box]] = []
    dots: list[tuple[str, Box]] = []
    for s, b in boxed:
        if is_connector(s, m):
            continue
        w, h = b[2] - b[0], b[3] - b[1]
        if m > 0 and w < DOT_MAX * m and h < DOT_MAX * m:
            dots.append((s["id"], b))
        else:
            words.append((s["id"], b))

    if not words:  # nothing but dots: group them like words
        words, dots = dots, []
    lines = _lines(words)
    for sid, b in dots:
        min(lines, key=lambda g: _dist(b, g.box)).add(sid, b)

    out: list[Line] = []
    for n, note in enumerate(_notes(lines, m)):
        for g in note:
            x0, y0, x1, y1 = g.box
            out.append(Line(
                stroke_ids=g.ids, x=x0, y=y0, w=x1 - x0, h=y1 - y0,
                sig=signature([by_id[i] for i in g.ids]), note=n,
            ))
    return out
