#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["llm>=0.27", "llm-openrouter", "llm-gemini", "llm-anthropic"]
# ///
"""Describe the selected ink (or the whole page) with a vision model.

    describe-selection.py [--model M] [--dry-run]

Run from pdfink's pen menu: it needs the page bridge ($PDFINK_SOCKET). It takes
a PNG of the selection -- or of page $PAGE (1-based) when nothing is selected --
asks the model for a short description, then offers the answer in a dialog:
"Show in status" puts it in a toast, "Print" writes it to stdout (the command's
output), "Cancel" drops it.

Keys come from `llm keys set ...` as usual (the shared llm user directory).
Model: --model, else $PDFINK_DESCRIBE_MODEL, else openrouter/google/gemini-3.7-flash.
The model call is given $PDFINK_DESCRIBE_LLM_TIMEOUT seconds (default 120).
--dry-run skips the model and answers "(dry run) 1 image".
"""
from __future__ import annotations

import argparse
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pdfink_page  # noqa: E402

DEFAULT_MODEL = "openrouter/google/gemini-3.7-flash"
PROMPT = "Describe what this handwritten or drawn selection shows, in one short paragraph; transcribe any words."
LLM_TIMEOUT = int(os.environ.get("PDFINK_DESCRIBE_LLM_TIMEOUT", "120"))


def snapshot(page: pdfink_page.Page) -> bytes:
    """PNG bytes of the selection, or of page $PAGE when nothing is selected."""
    if page.selection() is not None:
        return page.selection_png()
    return page.page_png(int(os.environ.get("PAGE", "1")) - 1, scale=2)


def describe(model_id: str, png: bytes) -> str:
    """One model call with a hard timeout, in a daemon thread we can abandon
    (the HTTP client can sit on a half-closed connection for minutes)."""
    import llm

    model = llm.get_model(model_id)
    box: dict[str, object] = {}

    def call() -> None:
        try:
            att = llm.Attachment(content=png, type="image/png")
            box["text"] = model.prompt(PROMPT, attachments=[att], stream=False).text()
        except Exception as e:  # noqa: BLE001 - reported below
            box["error"] = e

    t = threading.Thread(target=call, daemon=True)
    t.start()
    t.join(LLM_TIMEOUT)
    if "text" in box:
        return str(box["text"]).strip()
    why = box["error"] if "error" in box else f"no answer after {LLM_TIMEOUT}s"
    raise RuntimeError(f"model call failed: {why}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=os.environ.get("PDFINK_DESCRIBE_MODEL", DEFAULT_MODEL))
    ap.add_argument("--dry-run", action="store_true", help="skip the model; answer with a fixed text")
    a = ap.parse_args()

    try:
        page = pdfink_page.connect()
    except pdfink_page.PageGone as e:
        print(f"describe-selection: {e}", file=sys.stderr)
        return 1
    assert page is not None
    with page:
        try:
            png = snapshot(page)
            page.progress("Looking…")
            try:
                answer = "(dry run) 1 image" if a.dry_run else describe(a.model, png)
            finally:
                page.progress(None)
            choice = page.choose(answer, ["Show in status", "Print", "Cancel"])
        except (pdfink_page.PageGone, pdfink_page.PageError, TimeoutError, RuntimeError) as e:
            print(f"describe-selection: {e}", file=sys.stderr)
            return 1
        if choice == "Show in status":
            page.toast(answer)
        elif choice == "Print":
            print(answer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
