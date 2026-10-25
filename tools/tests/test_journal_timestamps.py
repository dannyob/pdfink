#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pypdf>=4"]
# ///
"""Tests for how journal-page.py reads the timestamps tools/timestamp.py leaves.

    uv run --script tools/tests/test_journal_timestamps.py
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter

TOOLS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("journal_page", TOOLS / "journal-page.py")
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)


def notebook(marks: list[tuple[str, int]], pages: int = 3) -> Path:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(612, 792)
    for title, page in marks:
        w.add_outline_item(title, page)
    f = Path(tempfile.mkdtemp()) / "n.pdf"
    with open(f, "wb") as out:
        w.write(out)
    return f


class TimestampDates(unittest.TestCase):
    def test_dates_of_the_timestamps_on_a_page_in_order(self):
        pdf = notebook([("2026-10-24 09:00", 0), ("2026-10-25 13:46", 1), ("2026-10-25 18:02", 1), ("2026-10-26 07:30", 1)])
        self.assertEqual(journal.timestamp_dates(pdf, 2), ["2026-10-25", "2026-10-26"])
        self.assertEqual(journal.timestamp_dates(pdf, 1), ["2026-10-24"])
        self.assertEqual(journal.timestamp_dates(pdf, 3), [])

    def test_other_bookmarks_are_not_timestamps(self):
        pdf = notebook([("2026-10-25", 0), ("Shopping", 0), ("2026-10-25 1346", 0)])
        self.assertEqual(journal.timestamp_dates(pdf, 1), [])

    def test_a_notebook_without_an_outline(self):
        self.assertEqual(journal.timestamp_dates(notebook([]), 1), [])


class FakePage:
    def __init__(self, marks):
        self.marks = marks
        self.added = []

    def bookmarks(self):
        return self.marks

    def add_bookmark(self, page, title, level=0):
        self.added.append((page, title))
        return 0


class BookmarkEntry(unittest.TestCase):
    def tearDown(self):
        journal.PAGE = None

    def test_a_timestamp_bookmark_on_the_page_counts_as_the_entry_bookmark(self):
        journal.PAGE = FakePage([{"title": "2026-10-25 13:46", "page": 1, "level": 0}])
        journal.bookmark_entry(1, "2026-10-25")
        self.assertEqual(journal.PAGE.added, [])

    def test_bookmarks_when_only_another_day_is_stamped_there(self):
        journal.PAGE = FakePage([{"title": "2026-10-24 13:46", "page": 1, "level": 0}])
        journal.bookmark_entry(1, "2026-10-25")
        self.assertEqual(journal.PAGE.added, [(1, "2026-10-25")])


class Prompt(unittest.TestCase):
    def test_the_model_is_told_what_a_timestamp_looks_like(self):
        self.assertIn("red chevron", journal.TIMESTAMP_RULES)
        self.assertIn("red chevron", journal.STOP_RULES)


if __name__ == "__main__":
    unittest.main()
