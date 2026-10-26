#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["llm>=0.27", "llm-openrouter", "llm-gemini", "llm-anthropic", "pillow>=10.1"]
# ///
"""Recognise a page's handwriting into text the PDF carries.

    ocr-page.py PAGE [--model M] [--all] [--dry-run]
    ocr-page.py --watch [--quiet SECONDS] [--model M]

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
lines that changed while the model was working. When the model fails, or
its answer covers none of the numbered lines, it leaves the text alone and
exits 1. It prints "N lines" (the
lines newly given text), or "up to date" when there was nothing to send.
--dry-run prints the numbered lines it would send and stops there.

--watch is automatic mode, for a `detach = true` menu entry: it stays with
the tab and recognises a page once its ink has been quiet for --quiet seconds
(default 20) after its lines change, or once you have stayed on a page (the
visible one at the start too) for 3 s and it has lines without text, so
scrolling past pages reads none of them. Opening or reloading a document
reads nothing by itself: an `ink` event whose fingerprint (`sig`) is the one
last seen for its page fetches nothing, and existing ink is read a page at a
time, as you stop on it. One page at a time, as quiet updates (no undo step), showing
"Reading page N…" while busy and printing nothing per page. A page that
fails, for whatever reason, is logged and tried again only after new ink.
It exits 0 when the page goes away or the run is stopped.

Keys come from `llm keys set ...` as usual (the shared llm user directory).
Model: --model, else $PDFINK_OCR_MODEL, else openrouter/google/gemini-3.7-flash.
Each model call is given $PDFINK_OCR_LLM_TIMEOUT seconds (default 120) and one
retry, inside the pen menu's 300 s.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
import time
from typing import Any, Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_call  # noqa: E402
import pdfink_page  # noqa: E402
from ink_lines import Line, group  # noqa: E402

DEFAULT_MODEL = "openrouter/google/gemini-3.7-flash"
DEFAULT_QUIET = 20.0  # s of no ink on a page before --watch reads it
ARRIVAL_DWELL = 3.0  # s you must stay on a page before --watch reads its existing ink
LLM_TIMEOUT = int(os.environ.get("PDFINK_OCR_LLM_TIMEOUT", "120"))
SCALE = 2  # page render scale, pixels per point
LEFT_EDGE = 20  # pt: a line starting this close to the left edge is labelled on its right
PROMPT = """The attached page has handwriting on it. Some handwritten lines have a small red number beside them. For each numbered line, transcribe the handwriting on that line exactly as written: keep spelling, capitals and punctuation; mark unreadable words [illegible]. Ignore printed text, the red numbers themselves, underlines, circles, arrows and other marks that are not words. Answer with JSON only: an object mapping each number (as a string) to its line's text, with "" for a numbered line that has no words."""

Rect = dict[str, float]


class RecogniseError(Exception):
    """The model failed or gave no usable answer; the page's text is untouched."""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _centre_inside(x: float, y: float, w: float, h: float, r: Rect) -> bool:
    cx, cy = x + w / 2, y + h / 2
    return r["x"] <= cx <= r["x"] + r["w"] and r["y"] <= cy <= r["y"] + r["h"]


def line_inside(ln: Line, r: Rect) -> bool:
    return _centre_inside(ln.x, ln.y, ln.w, ln.h, r)


def text_inside(t: dict, r: Rect) -> bool:
    return _centre_inside(t["x"], t["y"], t["w"], t["h"], r)


def match_texts(lines: list[Line], texts: list[dict]) -> list[tuple[dict, Line]]:
    """Pair signed texts with lines of the same sig, one to one, nearest first.
    A sig fixes a line's shape, not its place, so a moved line still matches,
    and a pasted copy of a line (same sig) does not take the original's text."""
    pairs = []
    for t in texts:
        for ln in lines:
            if t.get("sig") and t.get("sig") == ln.sig:
                pairs.append((math.hypot(t["x"] - ln.x, t["y"] - ln.y), id(t), id(ln), t, ln))
    pairs.sort(key=lambda p: p[0])
    used_t: set[int] = set()
    used_l: set[int] = set()
    out = []
    for _, it, il, t, ln in pairs:
        if it not in used_t and il not in used_l:
            used_t.add(it)
            used_l.add(il)
            out.append((t, ln))
    return out


def changed_lines(lines: list[Line], texts: list[dict], force: bool, within: Rect | None) -> list[Line]:
    """The lines to send to the model: those (inside `within`, when given)
    that no existing text item matches by sig, or all of them when `force`."""
    if within is not None:
        lines = [ln for ln in lines if line_inside(ln, within)]
    if force:
        return list(lines)
    matched = {id(ln) for _, ln in match_texts(lines, texts)}
    return [ln for ln in lines if id(ln) not in matched]


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


def _assign(lines_now: list[Line], results: list[tuple[Line, str]]) -> dict[int, str]:
    """Which current line each sent line's result belongs to: by index into
    `lines_now`, one to one, same sig, nearest first. A sent line whose shape
    changed while the model worked has no current line, so its result is
    dropped. Keyed by line, not sig, so two sent lines with the same sig (a
    pasted copy) each get their own answer."""
    pairs = sorted(
        (math.hypot(s.x - ln.x, s.y - ln.y), k, j)
        for k, (s, _) in enumerate(results)
        for j, ln in enumerate(lines_now)
        if s.sig == ln.sig
    )
    used_k: set[int] = set()
    out: dict[int, str] = {}
    for _, k, j in pairs:
        if k not in used_k and j not in out:
            used_k.add(k)
            out[j] = results[k][1]
    return out


def _overlaps(t: dict, ln: Line) -> bool:
    """An unsigned text item sits on line `ln`: either one's centre is inside the other."""
    return _centre_inside(t["x"], t["y"], t["w"], t["h"], {"x": ln.x, "y": ln.y, "w": ln.w, "h": ln.h}) or _centre_inside(
        ln.x, ln.y, ln.w, ln.h, {"x": t["x"], "y": t["y"], "w": t["w"], "h": t["h"]}
    )


def merge(lines_now: list[Line], texts: list[dict], results: list[tuple[Line, str]]) -> list[dict]:
    """The page's new handwriting text. `results` pairs each sent line with
    what the model read for it. Keeps existing items with no sig, unless a new
    result lands on the line they sit on, and items matched to a current line
    (match_texts) that got no result, moved to that line's box; gives every
    current line with a result its text; drops empty results, results whose
    line changed meanwhile, and items whose line is gone."""
    got = _assign(lines_now, results)
    landed = [lines_now[j] for j, text in got.items() if text]
    out: list[dict] = [
        {k: v for k, v in t.items() if k != "id"}
        for t in texts
        if not t.get("sig") and not any(_overlaps(t, ln) for ln in landed)
    ]
    index = {id(ln): j for j, ln in enumerate(lines_now)}
    for t, ln in match_texts(lines_now, texts):
        if index[id(ln)] not in got:
            out.append({**{k: v for k, v in t.items() if k != "id"}, "x": ln.x, "y": ln.y, "w": ln.w, "h": ln.h, "note": ln.note})
    for j, ln in enumerate(lines_now):
        text = got.get(j, "")
        if text:
            out.append(_item(ln, text))
    return out


def _model(model):
    if model is None:
        model = os.environ.get("PDFINK_OCR_MODEL") or DEFAULT_MODEL
    if not isinstance(model, str):
        return model
    import llm

    try:
        return llm.get_model(model)
    except llm.UnknownModelError as e:
        raise RecogniseError(f"unknown model {model!r} (see `llm models`)") from e


def recognise(
    page_api: pdfink_page.Page,
    page_index: int,
    quiet: bool,
    force: bool = False,
    within: Rect | None = None,
    model=None,
    dry_run: bool = False,
    report: bool = True,
) -> int:
    """Recognise the handwriting on page `page_index` (0-based) and set it as
    the page's text. With `within`, only lines inside it (all forced) and only
    texts inside it. `model` is an llm model or its id (None: the default).
    Returns the number of lines newly set, and prints it unless not `report`.
    RecogniseError, with the page's text untouched, when the model fails or
    answers for none of the lines."""
    lines = group(page_api.strokes(page_index))
    todo = changed_lines(lines, page_api.ink_text(page_index), force or within is not None, within)
    if not todo:
        if report:
            print("up to date")
        return 0
    numbers = list(range(1, len(todo) + 1))
    if dry_run:
        for n, ln in zip(numbers, todo):
            print(f"{n}: x={ln.x:.1f} y={ln.y:.1f} w={ln.w:.1f} h={ln.h:.1f} note={ln.note} sig={ln.sig}")
        return 0

    png = label_image(page_api.page_png(page_index, SCALE), todo, numbers)
    try:
        reply = llm_call.ask(_model(model), PROMPT, png, ".png", attempts=2, timeout=LLM_TIMEOUT)
    except llm_call.LLMError as e:
        raise RecogniseError(str(e)) from e
    answer = parse_answer(reply)
    results = [(todo[n - 1], text) for n, text in sorted(answer.items()) if 1 <= n <= len(todo)]
    if not results:
        raise RecogniseError("the model's answer had none of the numbered lines; page text left as it was")

    # The ink may have changed while the model worked: regroup, and keep only
    # results whose line is still there as it was.
    lines_now = group(page_api.strokes(page_index))
    texts = page_api.ink_text(page_index)
    if within is not None:
        lines_now = [ln for ln in lines_now if line_inside(ln, within)]
        texts = [t for t in texts if text_inside(t, within)]
    items = merge(lines_now, texts, results)
    page_api.set_ink_text(page_index, items, quiet=quiet, within=within)
    n = sum(1 for text in _assign(lines_now, results).values() if text)
    if report:
        print(f"{n} line{'' if n == 1 else 's'}")
    return n


class Scheduler:
    """Which pages --watch should read, and when. Pure: callers pass `now`.

    A page is due `quiet_s` seconds after its last ink, wherever you are by
    then. A page you arrive on that has lines without text is due once you
    have stayed on it for `dwell` seconds: arriving on another page cancels
    it, so scrolling past pages reads none of them. due() hands each page out
    once, oldest first; after that, only new ink makes it due again (so a
    page whose recognition failed is not retried in a loop)."""

    def __init__(self, quiet_s: float, dwell: float = ARRIVAL_DWELL) -> None:
        self.quiet_s = quiet_s
        self.dwell = dwell
        self._ink: dict[int, float] = {}  # page -> time of its last ink
        self._arrived: dict[int, float] = {}  # the current page -> when you arrived, if it is to be read
        self._done: set[int] = set()  # handed out, no ink since

    def ink(self, page: int, now: float) -> None:
        self._ink[page] = now
        self._arrived.pop(page, None)  # wait for the ink to settle instead
        self._done.discard(page)

    def arrived(self, page: int, now: float, has_untexted: bool) -> None:
        """`page` is now the current page; any page you left is no longer
        waiting on its dwell."""
        since = self._arrived.get(page)
        self._arrived.clear()
        if has_untexted and page not in self._done and page not in self._ink:
            self._arrived[page] = now if since is None else since

    def due(self, now: float) -> list[int]:
        ready = [(t + self.quiet_s, p) for p, t in self._ink.items() if now - t >= self.quiet_s]
        ready += [(t + self.dwell, p) for p, t in self._arrived.items() if now - t >= self.dwell]
        ready.sort()
        out = [p for _, p in ready]
        for p in out:
            self._ink.pop(p, None)
            self._arrived.pop(p, None)
            self._done.add(p)
        return out


class InkBaseline:
    """The line sigs --watch last saw on each page, so that an `ink` event
    counts only when a page's lines really changed. A document load or
    reload fires `ink` for every page; those pages are either new to it
    (first sight: recorded, not a change) or unchanged. Sigs are kept as a
    multiset, so a pasted copy of a line (same sig) is a change."""

    def __init__(self) -> None:
        self._sigs: dict[int, tuple[str, ...]] = {}

    def see(self, page: int, sigs) -> None:
        self._sigs[page] = tuple(sorted(sigs))

    def known(self, page: int) -> bool:
        return page in self._sigs

    def changed(self, page: int, sigs) -> bool:
        new = tuple(sorted(sigs))
        old = self._sigs.get(page)
        self._sigs[page] = new
        return old is not None and old != new


def watch(
    page_api: pdfink_page.Page,
    quiet_s: float = DEFAULT_QUIET,
    model=None,
    clock: Callable[[], float] = time.monotonic,
    recognise_fn: Callable[..., int] = recognise,
) -> int:
    """Automatic mode (see the module doc). Returns 0 when the page goes
    away or the run gets its exit/gone event."""
    sched = Scheduler(quiet_s)
    baseline = InkBaseline()

    def page_of(data: Any) -> int | None:
        p = data.get("page") if isinstance(data, dict) else None
        return p if isinstance(p, int) and p >= 0 else None

    def arrive(p: int) -> None:
        """You are on page p: read it now if it has lines without text. Also
        its baseline, so the first stroke drawn after this counts as new ink."""
        try:
            lines = group(page_api.strokes(p))
            baseline.see(p, (ln.sig for ln in lines))
            untexted = bool(changed_lines(lines, page_api.ink_text(p), False, None))
            sched.arrived(p, clock(), untexted)
        except (pdfink_page.PageError, TimeoutError) as e:
            log(f"ocr-page: page {p + 1}: {e}")

    fingerprints: dict[int, str] = {}  # page -> the ink event's sig last seen

    def inked(p: int, fp: Any) -> None:
        """An ink event on page p: debounce it only if its lines changed.
        With the event's fingerprint (`sig`), an unchanged one fetches
        nothing, and a page first seen that way is only recorded: its
        strokes are fetched when the fingerprint next changes, which is then
        new ink."""
        fp = fp if isinstance(fp, str) else None
        if fp is not None:
            old = fingerprints.get(p)
            if old == fp:
                return
            if old is None and not baseline.known(p):
                fingerprints[p] = fp
                return
        try:
            sigs = [ln.sig for ln in group(page_api.strokes(p))]
        except (pdfink_page.PageError, TimeoutError) as e:
            log(f"ocr-page: page {p + 1}: {e}")
            return
        if fp is not None:
            fingerprints[p] = fp
            if not baseline.known(p):
                baseline.see(p, sigs)
                sched.ink(p, clock())
                return
        if baseline.changed(p, sigs):
            sched.ink(p, clock())

    try:
        page_api.subscribe("ink", "page")
        try:
            current = page_of({"page": page_api.state().get("currentPage")})
        except (pdfink_page.PageError, TimeoutError) as e:
            log(f"ocr-page: {e}")
            current = None
        if current is not None:
            arrive(current)
        last_tick = None
        while True:
            for name, data in page_api.events(timeout=1.0):
                if name in ("exit", "gone"):
                    return 0
                p = page_of(data)
                if p is None:
                    pass
                elif name == "ink":
                    inked(p, data.get("sig"))
                elif name == "page":
                    arrive(p)
                if last_tick is not None and clock() - last_tick < 1.0:
                    continue
                break  # a second has passed: see what is due
            last_tick = clock()
            for p in sched.due(last_tick):
                page_api.progress(f"Reading page {p + 1}…")
                try:
                    recognise_fn(page_api, p, quiet=True, model=model, report=False)
                except pdfink_page.PageGone:
                    raise
                except Exception as e:  # anything else: this page waits for new ink, the watch goes on
                    log(f"ocr-page: page {p + 1}: {e}")
                finally:
                    page_api.progress(None)
    except pdfink_page.PageGone:
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page", type=int, nargs="?", help="1-based page number ($PAGE); not with --watch")
    ap.add_argument("--model", default=os.environ.get("PDFINK_OCR_MODEL", DEFAULT_MODEL))
    ap.add_argument("--all", action="store_true", help="recognise every line, not only changed ones")
    ap.add_argument("--dry-run", action="store_true", help="print the numbered lines it would send; no model, no text set")
    ap.add_argument("--watch", action="store_true", help="automatic mode: keep recognising pages as you write")
    ap.add_argument("--quiet", type=float, default=DEFAULT_QUIET, metavar="SECONDS", help="--watch: seconds of no ink before a page is read (default 20)")
    a = ap.parse_args()
    if (a.page is None) != a.watch:
        ap.error("give a PAGE, or --watch")

    if not os.environ.get("PDFINK_SOCKET"):
        print("ocr-page: needs the pdfink page (run it from the pen menu)", file=sys.stderr)
        return 1
    try:
        page = pdfink_page.connect()
    except pdfink_page.PageGone as e:
        print(f"ocr-page: {e}", file=sys.stderr)
        return 1
    assert page is not None
    if a.watch:
        with page:
            return watch(page, a.quiet, model=a.model)
    index = a.page - 1
    with page:
        try:
            sel = page.selection()
            within = sel["rect"] if sel and sel.get("page") == index else None
            page.progress("Recognising handwriting…")
            recognise(page, index, quiet=False, force=a.all, within=within, model=a.model, dry_run=a.dry_run)
        except (pdfink_page.PageGone, pdfink_page.PageError, TimeoutError, RecogniseError) as e:
            print(f"ocr-page: {e}", file=sys.stderr)
            return 1
        finally:
            page.progress(None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
