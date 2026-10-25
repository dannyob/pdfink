#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Tests for tools/ink_lines.py, on synthetic strokes.

    uv run --script tools/tests/test_ink_lines.py

Each "word" is a few zig-zag strokes about 14 pt tall, like handwriting at
margin-note size; the layouts mimic notes on an annotated paper.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ink_lines  # noqa: E402
from ink_lines import Line, group, is_connector, signature  # noqa: E402

H = 14.0  # word stroke height

_ids = iter(range(1, 1_000_000))


def stroke(points: list[tuple[float, float]], sid: str | None = None) -> dict:
    return {
        "id": sid or f"s{next(_ids)}",
        "points": [{"x": x, "y": y, "p": 0.5} for x, y in points],
        "color": "#000000",
        "width": 1.5,
        "opacity": 1.0,
    }


def zigzag(x: float, y: float, w: float = 10.0, h: float = H, n: int = 4) -> dict:
    """A zig-zag stroke filling the box (x, y, w, h)."""
    pts = [(x + w * i / n, y + (h if i % 2 else 0.0)) for i in range(n + 1)]
    return stroke(pts)


def word(x: float, y: float, letters: int = 3) -> list[dict]:
    """A word of `letters` zig-zag strokes, 10 pt wide with 2 pt gaps."""
    return [zigzag(x + i * 12.0, y) for i in range(letters)]


def bbox(strokes: list[dict]) -> tuple[float, float, float, float]:
    xs = [p["x"] for s in strokes for p in s["points"]]
    ys = [p["y"] for s in strokes for p in s["points"]]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def ids(strokes: list[dict]) -> set[str]:
    return {s["id"] for s in strokes}


class TwoColumns(unittest.TestCase):
    def test_level_notes_on_opposite_sides_stay_apart(self) -> None:
        left = word(50, 200, 4)  # "encoder"
        right = word(450, 201, 4)  # "decoder", level with it
        lines = group(right + left)
        self.assertEqual(len(lines), 2)
        self.assertEqual(set(lines[0].stroke_ids), ids(left))
        self.assertEqual(set(lines[1].stroke_ids), ids(right))
        self.assertEqual([l.note for l in lines], [0, 1])
        self.assertAlmostEqual(lines[0].x, 50)
        self.assertAlmostEqual(lines[1].x, 450)


class NarrowMarginNote(unittest.TestCase):
    def test_five_lines_one_note(self) -> None:
        rows = []
        for i, words in enumerate([2, 1, 3, 2, 1]):
            row = []
            for j in range(words):
                row += word(500 + j * 40, 100 + i * 20, 3)
            rows.append(row)
        lines = group([s for row in reversed(rows) for s in row])
        self.assertEqual(len(lines), 5)
        self.assertEqual({l.note for l in lines}, {0})
        for line, row in zip(lines, rows):
            self.assertEqual(set(line.stroke_ids), ids(row))
            self.assertEqual((line.x, line.y, line.w, line.h), bbox(row))

    def test_far_apart_stacks_are_separate_notes(self) -> None:
        a = word(500, 100) + word(500, 120)
        b = word(500, 400) + word(500, 420)
        lines = group(a + b)
        self.assertEqual([l.note for l in lines], [0, 0, 1, 1])


class Connectors(unittest.TestCase):
    def test_dash_and_arc_are_excluded_and_do_not_widen_lines(self) -> None:
        note1 = word(490, 100) + word(530, 100)
        note2 = word(490, 300, 4)
        dash = stroke([(440, 106), (462, 107), (485, 106)])  # 45 x 1
        arc = stroke([(150, 330), (300, 270), (450, 300)])  # 300 x 60
        body = word(120, 320, 3)  # a word in the text the arc starts at
        median = ink_lines.median_height(note1 + note2 + body + [dash, arc])
        self.assertTrue(is_connector(dash, median))
        self.assertTrue(is_connector(arc, median))
        for s in note1:
            self.assertFalse(is_connector(s, median))

        lines = group(note1 + note2 + body + [dash, arc])
        all_ids = {i for l in lines for i in l.stroke_ids}
        self.assertNotIn(dash["id"], all_ids)
        self.assertNotIn(arc["id"], all_ids)
        self.assertEqual(len(lines), 3)
        l1 = next(l for l in lines if set(l.stroke_ids) == ids(note1))
        l2 = next(l for l in lines if set(l.stroke_ids) == ids(note2))
        self.assertEqual((l1.x, l1.y, l1.w, l1.h), bbox(note1))
        self.assertEqual((l2.x, l2.y, l2.w, l2.h), bbox(note2))

    def test_very_wide_stroke_is_connector_even_if_tall(self) -> None:
        loop = stroke([(0, 0), (50, 60), (100, 0)])  # 100 x 60, >= 6 x 14 wide
        self.assertTrue(is_connector(loop, H))
        self.assertFalse(is_connector(zigzag(0, 0, 40, H), H))


class Dots(unittest.TestCase):
    def test_dot_over_an_i_joins_its_line(self) -> None:
        w = word(100, 200, 3)
        dot = stroke([(113, 194), (114, 194.5)])  # above the line, 1 x 0.5
        other = word(100, 260, 3)
        lines = group(w + [dot] + other)
        self.assertEqual(len(lines), 2)
        self.assertIn(dot["id"], lines[0].stroke_ids)
        self.assertNotIn(dot["id"], lines[1].stroke_ids)
        self.assertAlmostEqual(lines[0].y, 194)


class Signature(unittest.TestCase):
    def test_stable_under_tiny_moves_changed_by_real_ones(self) -> None:
        base = [stroke([(100.0, 200.0), (110.0, 214.0)]), stroke([(120.0, 200.0), (130.0, 214.0)])]
        sig = signature(base)
        self.assertEqual(len(sig), 16)
        int(sig, 16)

        nudged = [stroke([(p["x"] + 0.03, p["y"] - 0.04) for p in s["points"]], s["id"]) for s in base]
        self.assertEqual(signature(nudged), sig)
        self.assertEqual(signature(list(reversed(base))), sig)

        moved = [stroke([(p["x"] + 1.0, p["y"]) for p in base[0]["points"]])] + base[1:]
        self.assertNotEqual(signature(moved), sig)

    def test_lines_carry_their_signature(self) -> None:
        w = word(100, 100)
        (line,) = group(w)
        self.assertEqual(line.sig, signature(w))


class Empty(unittest.TestCase):
    def test_empty_input(self) -> None:
        self.assertEqual(group([]), [])

    def test_strokes_without_points_are_ignored(self) -> None:
        self.assertEqual(group([stroke([])]), [])


class Shape(unittest.TestCase):
    def test_line_fields(self) -> None:
        (line,) = group(word(10, 20))
        self.assertIsInstance(line, Line)
        self.assertEqual(line.note, 0)
        self.assertIsInstance(line.stroke_ids, list)


if __name__ == "__main__":
    unittest.main()
