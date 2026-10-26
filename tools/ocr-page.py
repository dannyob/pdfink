#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["llm>=0.27", "llm-openrouter", "llm-gemini", "llm-anthropic", "pillow>=10.1"]
# ///
"""Recognise a page's handwriting into text the PDF carries.

    ocr-page.py PAGE [--model M] [--all] [--dry-run]

Run from pdfink's pen menu (command = ocr-page.py "$PAGE", PAGE 1-based): it
needs the page bridge ($PDFINK_SOCKET). It groups the page's strokes into
lines (tools/ink_lines.py), renders the page with a small red number beside
each line that has no text yet, asks a vision model what each numbered line
says, and sets the answers as the page's handwriting text, one item per line
(setInkText). Lines whose strokes have not changed since they were last
recognised keep their text and are not sent again; --all sends every line.

With a selection on the page, only the lines inside it are recognised (all of
them, changed or not) and only the texts inside it are replaced.

Before setting the text it reads the strokes again and drops answers for
lines that changed while the model was working. It prints "N lines" (the
lines newly given text), or "up to date" when there was nothing to send.
--dry-run prints the numbered lines it would send and stops there.

Keys come from `llm keys set ...` as usual (the shared llm user directory).
Model: --model, else $PDFINK_OCR_MODEL, else openrouter/google/gemini-3.7-flash.
Each model call is given $PDFINK_OCR_LLM_TIMEOUT seconds (default 120) and one
retry, inside the pen menu's 300 s.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pdfink_page  # noqa: E402
from ink_lines import Line, group  # noqa: E402

DEFAULT_MODEL = "openrouter/google/gemini-3.7-flash"
LLM_TIMEOUT = int(os.environ.get("PDFINK_OCR_LLM_TIMEOUT", "120"))
SCALE = 2  # page render scale, pixels per point
LEFT_EDGE = 20  # pt: a line starting this close to the left edge is labelled on its right
PROMPT = """The attached page has handwriting on it. Some handwritten lines have a small red number beside them. For each numbered line, transcribe the handwriting on that line exactly as written: keep spelling, capitals and punctuation; mark unreadable words [illegible]. Ignore printed text, the red numbers themselves, underlines, circles, arrows and other marks that are not words. Answer with JSON only: an object mapping each number (as a string) to its line's text, with "" for a numbered line that has no words."""

Rect = dict[str, float]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _centre_inside(x: float, y: float, w: float, h: float, r: Rect) -> bool:
    cx, cy = x + w / 2, y + h / 2
    return r["x"] <= cx <= r["x"] + r["w"] and r["y"] <= cy <= r["y"] + r["h"]


def line_inside(ln: Line, r: Rect) -> bool:
    return _centre_inside(ln.x, ln.y, ln.w, ln.h, r)


def text_inside(t: dict, r: Rect) -> bool:
    return _centre_inside(t["x"], t["y"], t["w"], t["h"], r)


def changed_lines(lines: list[Line], texts: list[dict], force: bool, within: Rect | None) -> list[Line]:
    """The lines to send to the model: those (inside `within`, when given)
    whose sig matches no existing text item, or all of them when `force`."""
    if within is not None:
        lines = [ln for ln in lines if line_inside(ln, within)]
    if force:
        return list(lines)
    known = {t.get("sig") for t in texts if t.get("sig")}
    return [ln for ln in lines if ln.sig not in known]


def label_image(png: bytes, lines: list[Line], numbers: list[int], scale: float = SCALE) -> bytes:
    """A copy of the page render `png` (at `scale` px per pt) with a small red
    number beside each line: left of its box, or right of it when the box
    starts within LEFT_EDGE pt of the page's left edge."""
    from PIL import Image, ImageDraw, ImageFont

    im = Image.open(io.BytesIO(png)).convert("RGB")
    draw = ImageDraw.Draw(im)
    for ln, n in zip(lines, numbers):
        size = max(12, min(28, round(ln.h * scale * 0.8)))
        font = ImageFont.load_default(size=size)
        label = str(n)
        l, t, r, b = draw.textbbox((0, 0), label, font=font)
        tw, th = r - l, b - t
        gap = 3 * scale
        if ln.x < LEFT_EDGE:
            x = (ln.x + ln.w) * scale + gap
        else:
            x = ln.x * scale - gap - tw
        y = (ln.y + ln.h / 2) * scale - th / 2
        draw.text((x - l, y - t), label, fill=(220, 0, 0), font=font)
    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue()


def parse_answer(text: str) -> dict[int, str]:
    """The model's {"1": "text", ...} as {1: "text"}; {} (logged) when it is
    not a JSON object. Keys that are not numbers are ignored."""
    s = text.strip()
    m = re.match(r"^```[A-Za-z]*\s*\n(.*?)\n?```$", s, re.S)
    if m:
        s = m.group(1).strip()
    try:
        obj = json.loads(s)
    except ValueError:
        # Prose around the object: try the outermost braces.
        a, b = s.find("{"), s.rfind("}")
        try:
            obj = json.loads(s[a : b + 1]) if 0 <= a < b else None
        except ValueError:
            obj = None
    if not isinstance(obj, dict):
        log(f"the model's answer was not a JSON object: {text[:200]!r}")
        return {}
    out: dict[int, str] = {}
    for k, v in obj.items():
        if isinstance(k, str) and k.strip().isdigit() and isinstance(v, str):
            out[int(k)] = v.strip()
    return out


def _item(ln: Line, text: str) -> dict[str, Any]:
    return {"text": text, "x": ln.x, "y": ln.y, "w": ln.w, "h": ln.h, "sig": ln.sig, "note": ln.note}


def merge(lines_now: list[Line], texts: list[dict], results: dict[str, str]) -> list[dict]:
    """The page's new handwriting text. `results` maps a line's sig to what the
    model read. Keeps existing items with no sig, or whose sig is still a line
    (and has no new result); adds a result only while its line is unchanged;
    drops empty results and items of lines that are gone."""
    now = {ln.sig: ln for ln in lines_now}
    out: list[dict] = []
    for t in texts:
        sig = t.get("sig")
        if not sig:
            out.append({k: v for k, v in t.items() if k != "id"})
        elif sig in now and sig not in results:
            out.append({**{k: v for k, v in t.items() if k != "id"}, "note": now[sig].note})
    for ln in lines_now:
        text = results.get(ln.sig, "")
        if text:
            out.append(_item(ln, text))
    return out


def _model(model):
    import llm

    if model is None:
        model = os.environ.get("PDFINK_OCR_MODEL") or DEFAULT_MODEL
    return llm.get_model(model) if isinstance(model, str) else model


def recognise(
    page_api: pdfink_page.Page,
    page_index: int,
    quiet: bool,
    force: bool = False,
    within: Rect | None = None,
    model=None,
    dry_run: bool = False,
) -> int:
    """Recognise the handwriting on page `page_index` (0-based) and set it as
    the page's text. With `within`, only lines inside it (all forced) and only
    texts inside it. `model` is an llm model or its id (None: the default).
    Returns the number of lines newly set."""
    from llm_call import ask

    lines = group(page_api.strokes(page_index))
    todo = changed_lines(lines, page_api.ink_text(page_index), force or within is not None, within)
    if not todo:
        print("up to date")
        return 0
    numbers = list(range(1, len(todo) + 1))
    if dry_run:
        for n, ln in zip(numbers, todo):
            print(f"{n}: x={ln.x:.1f} y={ln.y:.1f} w={ln.w:.1f} h={ln.h:.1f} note={ln.note} sig={ln.sig}")
        return 0

    png = label_image(page_api.page_png(page_index, SCALE), todo, numbers)
    answer = parse_answer(ask(_model(model), PROMPT, png, ".png", attempts=2, timeout=LLM_TIMEOUT))
    results = {todo[n - 1].sig: text for n, text in answer.items() if 1 <= n <= len(todo)}

    # The ink may have changed while the model worked: regroup, and keep only
    # results whose line is still there as it was.
    lines_now = group(page_api.strokes(page_index))
    texts = page_api.ink_text(page_index)
    if within is not None:
        lines_now = [ln for ln in lines_now if line_inside(ln, within)]
        texts = [t for t in texts if text_inside(t, within)]
    items = merge(lines_now, texts, results)
    page_api.set_ink_text(page_index, items, quiet=quiet, within=within)
    n = sum(1 for ln in lines_now if results.get(ln.sig))
    print(f"{n} line{'' if n == 1 else 's'}")
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page", type=int, help="1-based page number ($PAGE)")
    ap.add_argument("--model", default=os.environ.get("PDFINK_OCR_MODEL", DEFAULT_MODEL))
    ap.add_argument("--all", action="store_true", help="recognise every line, not only changed ones")
    ap.add_argument("--dry-run", action="store_true", help="print the numbered lines it would send; no model, no text set")
    a = ap.parse_args()

    if not os.environ.get("PDFINK_SOCKET"):
        print("ocr-page: needs the pdfink page (run it from the pen menu)", file=sys.stderr)
        return 1
    try:
        page = pdfink_page.connect()
    except pdfink_page.PageGone as e:
        print(f"ocr-page: {e}", file=sys.stderr)
        return 1
    assert page is not None
    index = a.page - 1
    with page:
        try:
            sel = page.selection()
            within = sel["rect"] if sel and sel.get("page") == index else None
            page.progress("Recognising handwriting…")
            recognise(page, index, quiet=False, force=a.all, within=within, model=a.model, dry_run=a.dry_run)
        except (pdfink_page.PageGone, pdfink_page.PageError, TimeoutError) as e:
            print(f"ocr-page: {e}", file=sys.stderr)
            return 1
        finally:
            page.progress(None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
