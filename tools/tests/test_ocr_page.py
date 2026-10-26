#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow>=10.1"]
# ///
"""Tests for tools/ocr-page.py's pure helpers (no page, no model).

    uv run --script tools/tests/test_ocr_page.py
"""
from __future__ import annotations

import importlib.util
import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from PIL import Image

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("ocr_page", TOOLS / "ocr-page.py")
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)

from ink_lines import Line, group  # noqa: E402


def line(sig: str, x: float = 100, y: float = 100, w: float = 80, h: float = 14, note: int = 0) -> Line:
    return Line(stroke_ids=[f"s-{sig}"], x=x, y=y, w=w, h=h, sig=sig, note=note)


def text(sig: str | None, t: str, x: float = 100, y: float = 100, w: float = 80, h: float = 14, id: str = "t") -> dict:
    d = {"id": id, "text": t, "x": x, "y": y, "w": w, "h": h}
    if sig is not None:
        d["sig"] = sig
    return d


class ChangedLines(unittest.TestCase):
    def test_lines_whose_sig_has_text_are_skipped(self):
        a, b = line("a"), line("b", y=130)
        self.assertEqual(ocr.changed_lines([a, b], [text("a", "hello")], force=False, within=None), [b])

    def test_force_takes_every_line(self):
        a, b = line("a"), line("b", y=130)
        self.assertEqual(ocr.changed_lines([a, b], [text("a", "hello")], force=True, within=None), [a, b])

    def test_within_keeps_only_lines_centred_inside(self):
        a, b = line("a", x=10, y=10), line("b", x=300, y=300)
        rect = {"x": 0, "y": 0, "w": 120, "h": 50}
        self.assertEqual(ocr.changed_lines([a, b], [], force=True, within=rect), [a])
        self.assertEqual(ocr.changed_lines([a, b], [text("a", "x")], force=False, within=rect), [])


class ParseAnswer(unittest.TestCase):
    def test_plain_json(self):
        self.assertEqual(ocr.parse_answer('{"1": "hello", "2": ""}'), {1: "hello", 2: ""})

    def test_fenced_json(self):
        self.assertEqual(ocr.parse_answer('```json\n{"1": "hi there"}\n```'), {1: "hi there"})

    def test_bad_json_is_empty_and_logged(self):
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(ocr.parse_answer("I could not read it, sorry"), {})
        self.assertTrue(err.getvalue().strip())

    def test_non_numeric_keys_ignored(self):
        self.assertEqual(ocr.parse_answer('{"1": "a", "note": "b", "x2": "c"}'), {1: "a"})

    def test_not_an_object_is_empty(self):
        with redirect_stderr(io.StringIO()):
            self.assertEqual(ocr.parse_answer('["a", "b"]'), {})


class Merge(unittest.TestCase):
    def test_new_result_added_with_its_line_box(self):
        a = line("a", x=5, y=6, w=7, h=8, note=2)
        out = ocr.merge([a], [], {"a": "hello"})
        self.assertEqual(out, [{"text": "hello", "x": 5, "y": 6, "w": 7, "h": 8, "sig": "a", "note": 2}])

    def test_stale_result_dropped_when_its_line_changed(self):
        # "a" was sent, but was redrawn as "a2" while the model worked.
        self.assertEqual(ocr.merge([line("a2")], [], {"a": "hello"}), [])

    def test_existing_unsigned_item_kept(self):
        out = ocr.merge([line("a")], [text(None, "typed", id="t1")], {"a": "hello"})
        self.assertIn("typed", [o["text"] for o in out])
        self.assertIn("hello", [o["text"] for o in out])
        self.assertTrue(all("id" not in o for o in out))

    def test_existing_item_of_unchanged_line_kept(self):
        out = ocr.merge([line("a"), line("b", y=130)], [text("a", "old")], {"b": "new"})
        self.assertEqual(sorted(o["text"] for o in out), ["new", "old"])

    def test_vanished_lines_item_dropped(self):
        self.assertEqual(ocr.merge([line("b")], [text("a", "gone")], {}), [])

    def test_empty_results_dropped(self):
        self.assertEqual(ocr.merge([line("a")], [], {"a": ""}), [])

    def test_result_replaces_existing_text_for_the_same_line(self):
        out = ocr.merge([line("a")], [text("a", "old")], {"a": "new"})
        self.assertEqual([o["text"] for o in out], ["new"])


def png(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, "PNG")
    return buf.getvalue()


class LabelImage(unittest.TestCase):
    def test_same_size_png_with_red_marks(self):
        src = png(400, 600)
        out = ocr.label_image(src, [line("a", x=100, y=50), line("b", x=5, y=100)], [1, 2])
        im = Image.open(io.BytesIO(out))
        self.assertEqual(im.format, "PNG")
        self.assertEqual(im.size, (400, 600))
        rgb = im.convert("RGB")
        red = [(x, y) for x in range(400) for y in range(600) if rgb.getpixel((x, y))[0] > 150 and rgb.getpixel((x, y))[1] < 100]
        self.assertTrue(red, "no red label drawn")
        # Line a's label sits left of its box (x < 100 pt = 200 px at scale 2);
        # line b starts near the left edge, so its label sits right of it.
        a_band = [p for p in red if 90 <= p[1] <= 140]
        b_band = [p for p in red if 190 <= p[1] <= 240]
        self.assertTrue(a_band and max(x for x, _ in a_band) < 200)
        self.assertTrue(b_band and min(x for x, _ in b_band) > 170)


def zig(x: float, y: float, sid: str, step: float = 2.5) -> dict:
    pts = [{"x": x + step * i, "y": y + (14 if i % 2 else 0), "p": 0.5} for i in range(5)]
    return {"id": sid, "points": pts, "color": "#000000", "width": 1.5, "opacity": 1.0}


class MovedLine(unittest.TestCase):
    def test_a_line_moved_by_cut_and_paste_keeps_its_text(self):
        (before,) = group([zig(100, 100, "s1"), zig(112, 100, "s2")])
        (after,) = group([zig(300, 400, "s3"), zig(312, 400, "s4")])  # pasted: new ids, new place
        texts = [text(before.sig, "hello", x=before.x, y=before.y, w=before.w, h=before.h)]
        self.assertEqual(ocr.changed_lines([after], texts, force=False, within=None), [])
        out = ocr.merge([after], texts, {})
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "hello")
        self.assertEqual((out[0]["x"], out[0]["y"]), (after.x, after.y))

    def test_a_pasted_copy_does_not_take_the_originals_text(self):
        (orig,) = group([zig(100, 100, "s1")])
        (copy,) = group([zig(100, 300, "s2")])
        self.assertEqual(orig.sig, copy.sig)
        texts = [text(orig.sig, "hello", x=orig.x, y=orig.y, w=orig.w, h=orig.h)]
        self.assertEqual(ocr.changed_lines([orig, copy], texts, force=False, within=None), [copy])
        out = ocr.merge([copy, orig], texts, {})
        self.assertEqual([(o["text"], o["y"]) for o in out], [("hello", orig.y)])


class FakePage:
    def __init__(self, strokes, texts):
        self._strokes, self._texts = strokes, texts
        self.set_calls = []

    def strokes(self, page, space="page"):
        return self._strokes

    def ink_text(self, page):
        return self._texts

    def page_png(self, page, scale=1):
        return png(600, 800)

    def set_ink_text(self, page, lines, space="page", quiet=False, within=None):
        self.set_calls.append(lines)
        return [f"t{i}" for i in range(len(lines))]

    def selection(self):
        return None

    def progress(self, msg):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        pass


class Recognise(unittest.TestCase):
    def setUp(self):
        # Two lines of different shapes (so different sigs).
        self.page = FakePage([zig(100, 100, "s1"), zig(100, 200, "s2", step=3.5)], [text(None, "typed", id="t1")])
        self._ask = ocr.llm_call.ask

    def tearDown(self):
        ocr.llm_call.ask = self._ask

    def answer(self, reply):
        def fake(model, prompt, data, suffix, attempts=2, timeout=0):
            if isinstance(reply, Exception):
                raise reply
            return reply
        ocr.llm_call.ask = fake

    def run_it(self):
        with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()) as out:
            n = ocr.recognise(self.page, 0, quiet=True, model=object())
        return n, out.getvalue()

    def test_good_answer_sets_the_text(self):
        self.answer('{"1": "first", "2": "second"}')
        n, out = self.run_it()
        self.assertEqual(n, 2)
        self.assertEqual(sorted(i["text"] for i in self.page.set_calls[0]), ["first", "second", "typed"])

    def test_unparseable_answer_raises_and_leaves_texts_alone(self):
        self.answer("sorry, I cannot read this")
        with self.assertRaises(ocr.RecogniseError):
            self.run_it()
        self.assertEqual(self.page.set_calls, [])

    def test_answer_without_the_sent_numbers_raises(self):
        self.answer('{"7": "what"}')
        with self.assertRaises(ocr.RecogniseError):
            self.run_it()
        self.assertEqual(self.page.set_calls, [])

    def test_model_failure_is_a_plain_exception(self):
        self.answer(ocr.llm_call.LLMError("no answer after 1s"))
        with self.assertRaises(ocr.RecogniseError) as cm:
            self.run_it()
        self.assertNotIsInstance(cm.exception, SystemExit)
        self.assertEqual(self.page.set_calls, [])

    def test_main_says_why_and_exits_1(self):
        self.answer("garbage")
        connect, model, argv, env = ocr.pdfink_page.connect, ocr._model, sys.argv, os.environ.get("PDFINK_SOCKET")
        ocr.pdfink_page.connect = lambda *a, **k: self.page
        ocr._model = lambda m: object()  # no llm in the test environment
        sys.argv = ["ocr-page.py", "1"]
        os.environ["PDFINK_SOCKET"] = "/nonexistent"
        try:
            with redirect_stderr(io.StringIO()) as err, redirect_stdout(io.StringIO()):
                code = ocr.main()
        finally:
            ocr.pdfink_page.connect, ocr._model, sys.argv = connect, model, argv
            if env is None:
                os.environ.pop("PDFINK_SOCKET", None)
            else:
                os.environ["PDFINK_SOCKET"] = env
        self.assertEqual(code, 1)
        self.assertIn("ocr-page: ", err.getvalue())
        self.assertEqual(self.page.set_calls, [])


if __name__ == "__main__":
    unittest.main()
