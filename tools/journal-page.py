#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["llm>=0.27", "llm-openrouter", "llm-gemini", "llm-anthropic", "pypdf>=4"]
# ///
"""Transcribe a handwritten journal page and file it in the life system.

    journal-page.py NOTEBOOK.pdf PAGE [--date YYYY-MM-DD] [--dry-run] ...

Made for pdfink's pen menu (command = journal-page.py "$PDF" "$PAGE"), but
works from a shell too. Steps:

1. Pull that page and the ones after it out of the PDF, a few at a time, and
   hand them to a vision model through Simon Willison's `llm` library, asking
   for the entry's writing as markdown under a `## YYYY-MM-DD` heading. The
   date is read off the page itself, so this works for any day, not just
   today; `--date` pins it when the page has no legible date (or several
   entries and you want one). Give it the entry's first page: it keeps
   reading onto following pages until a new dated entry starts, the topic
   plainly changes, the words "Journal ends" appear, or --max-pages is hit.
2. Save the markdown under ~/.cache/pdfink/journal (or --out DIR). Not under
   Desktop, Documents or Downloads: macOS gates those behind a consent
   dialog, and a process the pdfink server spawned has no screen to show it
   on, so its open() just hangs. (~/tmp pointing at Downloads cost a day.)
3. Run `claude -p` in the life directory to merge it into that day's journal
   entry. `--dry-run` stops after step 2 and prints the markdown.

Keys come from `llm keys set ...` as usual (the shared llm user directory).
Model: --model, else $PDFINK_JOURNAL_MODEL, else openrouter/google/gemini-3.7-flash.
Each model call is given $PDFINK_JOURNAL_LLM_TIMEOUT seconds (default 240) and
one retry; the whole run should stay inside the pen menu's timeout.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

DEFAULT_MODEL = "openrouter/google/gemini-3.7-flash"
DATE_RE = re.compile(r"^## (\d{4}-\d{2}-\d{2}|UNDATED)\s*$", re.M)
PAGES_RE = re.compile(r"<!--\s*pages?\s*:\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*-->")
STOP_RULES = """Stop at the end of this entry, which is the first of:
- a new entry beginning with its own date,
- the words "Journal ends", "End of journal" or similar (leave them out),
- the writing plainly turning into something else (a to-do list, meeting notes, a different topic with its own heading),
- the pages running out."""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def life_dir(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if os.environ.get("LIFE_DIR"):
        return Path(os.environ["LIFE_DIR"]).expanduser()
    life = shutil.which("life") or str(Path.home() / ".local/bin/life")
    try:
        out = subprocess.run([life, "path"], capture_output=True, text=True, timeout=20).stdout
        m = re.search(r"^Life directory:\s*(.+)$", out, re.M)
        if m:
            return Path(m.group(1).strip())
    except (OSError, subprocess.SubprocessError):
        pass
    return Path.home() / "Private/nextcloud/life"


def page_count(pdf: Path) -> int:
    from pypdf import PdfReader

    return len(PdfReader(str(pdf)).pages)


def pages_pdf(pdf: Path, first: int, last: int) -> bytes:
    """Bytes of a PDF holding pages first..last (1-based, inclusive)."""
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(pdf))
    writer = PdfWriter()
    for i in range(first - 1, last):
        writer.add_page(reader.pages[i])
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def year_hint(pdf: Path) -> int:
    m = re.search(r"(20\d{2})", pdf.stem)
    if m:
        return int(m.group(1))
    return dt.datetime.fromtimestamp(pdf.stat().st_mtime).year


LLM_TIMEOUT = int(os.environ.get("PDFINK_JOURNAL_LLM_TIMEOUT", "240"))


def ask(model, prompt: str, pdf_bytes: bytes, attempts: int = 2) -> str:
    """One model call with a hard timeout. The HTTP client underneath can sit
    on a half-closed connection for ten minutes per retry, so the call runs
    in a daemon thread we are free to abandon and try again."""
    import llm

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        tmp = f.name
    try:
        text = ""
        for attempt in range(1, attempts + 1):
            box: dict[str, object] = {}

            def call() -> None:
                try:
                    box["text"] = model.prompt(prompt, attachments=[llm.Attachment(path=tmp)], stream=False).text()
                except Exception as e:  # noqa: BLE001 - reported below
                    box["error"] = e

            t = threading.Thread(target=call, daemon=True)
            t.start()
            t.join(LLM_TIMEOUT)
            if "text" in box:
                text = str(box["text"])
                break
            why = f"{box['error']}" if "error" in box else f"no answer after {LLM_TIMEOUT}s"
            if attempt < attempts:
                log(f"model call failed ({why}); trying again…")
            else:
                raise SystemExit(f"model call failed: {why}")
    finally:
        os.unlink(tmp)
    text = text.strip()
    # Some models wrap the answer in a fence.
    m = re.match(r"^```(?:markdown|md)?\s*\n(.*)\n```$", text, re.S)
    if m:
        text = m.group(1).strip()
    return text


def pages_used(text: str, first: int) -> tuple[str, int]:
    """Strip the model's `<!-- pages: a-b -->` marker; return (text, last page used)."""
    m = PAGES_RE.search(text)
    if not m:
        return text, first  # no marker: assume it stayed on the first page
    last = int(m.group(2) or m.group(1))
    return PAGES_RE.sub("", text).rstrip(), max(first, last)


def transcribe(pdf: Path, page: int, model_id: str, date: str | None, batch: int, max_pages: int) -> tuple[str, int]:
    """Transcribe the entry starting on `page`, reading on as needed. Returns (markdown, last page)."""
    import llm

    model = llm.get_model(model_id)
    n = page_count(pdf)
    if not 1 <= page <= n:
        raise SystemExit(f"page {page} out of range: {pdf.name} has {n} page{'s' if n != 1 else ''}")
    hint = f'the handwritten notebook "{pdf.name}"'
    year = year_hint(pdf)
    rules = """Output markdown only, nothing before or after it. Transcribe the writing faithfully: keep lists, headings, emphasis, arrows and crossings-out as written; do not summarise, interpret, correct or add commentary. Sketches and diagrams may be rendered as a DOT or Mermaid code block. Mark words you cannot read as [illegible]. Finish with a line `<!-- pages: A-B -->` giving the first and last of the attached pages you transcribed (numbered as in the notebook)."""

    # First batch: find the entry and its date.
    last_attached = min(n, page + batch - 1)
    want = (
        f"The entry wanted is the one dated {date}; transcribe that entry only, under the heading `## {date}`."
        if date
        else "Transcribe the entry that begins on the first attached page, under a heading `## YYYY-MM-DD` with its date in ISO form. If the first page holds several dated entries, transcribe each under its own heading."
    )
    prompt = f"""Attached are pages {page} to {last_attached} of {hint}, which holds dated journal entries; the date is written on the page, usually at the top of an entry. Where only a day and month are written, the year is {year}.

{want} An entry may run on across pages. {STOP_RULES}

{rules}

If the first page has writing but no legible date, use the heading `## UNDATED`. If there is no journal writing on the first page at all, output exactly `NO ENTRY`."""
    log(f"reading pages {page}-{last_attached}…")
    first = pages_pdf(pdf, page, last_attached)
    text = ask(model, prompt, first)
    if text != "NO ENTRY" and not DATE_RE.search(text):
        # Vision models occasionally answer with noise; one more go before giving up.
        log("answer had no dated heading; asking again…")
        text = ask(model, prompt, first)
    if text == "NO ENTRY" or not text:
        return text, page
    text, last = pages_used(text, page)

    # Continue while the entry ran to the end of what we attached and pages remain.
    while last == last_attached and last < n and (last - page + 1) < max_pages:
        nxt_first = last + 1
        nxt_last = min(n, nxt_first + batch - 1, page + max_pages - 1)
        tail = "\n".join(text.splitlines()[-12:])
        prompt = f"""Attached are pages {nxt_first} to {nxt_last} of {hint}. A journal entry that began on page {page} has been transcribed up to the end of page {last}; its last lines were:

{tail}

Continue transcribing that same entry from the first attached page. {STOP_RULES}

{rules} Output only the continuation, with no heading. If the first attached page does not continue the entry, output exactly `ENTRY ENDED`."""
        log(f"entry continues; reading pages {nxt_first}-{nxt_last}…")
        more = ask(model, prompt, pages_pdf(pdf, nxt_first, nxt_last))
        if more.startswith("ENTRY ENDED") or not more:
            break
        more, more_last = pages_used(more, nxt_first)
        text = text.rstrip() + "\n\n" + more.strip()
        last_attached = nxt_last
        last = more_last
    return text, last


def main() -> int:
    if os.environ.get("PDFINK_JOURNAL_DEBUG"):
        # Where is it stuck? Dump all thread stacks to stderr every 30 s.
        import faulthandler

        faulthandler.dump_traceback_later(30, repeat=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", type=Path)
    ap.add_argument("page", type=int, help="1-based page number")
    ap.add_argument("--date", help="YYYY-MM-DD: the entry to pick, and the date to file it under")
    ap.add_argument("--model", default=os.environ.get("PDFINK_JOURNAL_MODEL", DEFAULT_MODEL))
    ap.add_argument("--life-dir", help="life system directory (default: `life path`)")
    ap.add_argument("--out", type=Path, help="where to keep the markdown (default ~/.cache/pdfink/journal)")
    ap.add_argument("--dry-run", action="store_true", help="transcribe and print; do not touch the journal")
    ap.add_argument("--claude", default=os.environ.get("PDFINK_JOURNAL_CLAUDE", shutil.which("claude") or "/opt/homebrew/bin/claude"))
    ap.add_argument("--timeout", type=int, default=900, help="seconds allowed for claude")
    ap.add_argument("--batch", type=int, default=4, help="pages attached per model call")
    ap.add_argument("--max-pages", type=int, default=12, help="longest entry to follow, in pages")
    a = ap.parse_args()

    if a.date:
        try:
            dt.date.fromisoformat(a.date)
        except ValueError:
            ap.error("--date must be YYYY-MM-DD")
    pdf = a.pdf.expanduser().resolve()
    if not pdf.is_file():
        raise SystemExit(f"no such file: {pdf}")

    log(f"transcribing from page {a.page} of {pdf.name} with {a.model}…")
    text, last_page = transcribe(pdf, a.page, a.model, a.date, max(1, a.batch), max(1, a.max_pages))
    span = f"page {a.page}" if last_page == a.page else f"pages {a.page}-{last_page}"
    if text == "NO ENTRY" or not text:
        print(f"no journal writing found on page {a.page} of {pdf.name}")
        return 1
    dates = DATE_RE.findall(text)
    if not dates:
        if a.date:
            text = f"## {a.date}\n\n{text}"
            dates = [a.date]
        else:
            print(f"page {a.page}: could not find a dated entry; pass --date YYYY-MM-DD")
            log(text)
            return 1
    if "UNDATED" in dates:
        if not a.date:
            print(f"page {a.page}: the writing has no legible date; pass --date YYYY-MM-DD")
            log(text)
            return 1
        text = text.replace("## UNDATED", f"## {a.date}")
        dates = [a.date if d == "UNDATED" else d for d in dates]
    for d in dates:
        try:
            dt.date.fromisoformat(d)
        except ValueError:
            print(f"page {a.page}: model produced an impossible date {d}")
            log(text)
            return 1
    dates = list(dict.fromkeys(dates))

    out_dir = a.out or Path.home() / ".cache" / "pdfink" / "journal"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"journal-{dates[0]}-{pdf.stem}-p{a.page}.md"
    out.write_text(text + "\n", encoding="utf8")
    log(f"transcript of {span} saved to {out}")

    if a.dry_run:
        print(text)
        return 0

    life = life_dir(a.life_dir)
    if not (life / "CLAUDE.md").is_file():
        print(f"life directory not found at {life} (use --life-dir)")
        return 1
    if not Path(a.claude).is_file() and not shutil.which(a.claude):
        print(f"claude not found at {a.claude}")
        return 1

    when = " and ".join(dates)
    prompt = f"""Below is a transcript of handwritten notes from {span} of {pdf} (my notebook, synced from the tablet). Integrate it into the journal entry for {when} in this life system:

- Open or create the entry with `life journal {dates[0]}` (one per date if there are several).
- Add the transcript's content to that entry under a heading saying it came from notebook "{pdf.name}", {span}. Keep whatever is already in the entry, and do not duplicate content that is already there from an earlier run.
- Keep the markdown as written; DOT and Mermaid code blocks are fine.
- Follow CLAUDE.md. Do not create other items unless the entry clearly calls for a todo; if so, say which.

When done, reply with one line naming the file(s) you changed.

---
{text}
"""
    env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE" and not k.startswith("CLAUDE_CODE_")}
    cmd = [a.claude, "-p", prompt, "--permission-mode", "acceptEdits", "--allowedTools", "Bash(life:*)"]
    log(f"filing into {life} with claude…")
    try:
        r = subprocess.run(cmd, cwd=str(life), env=env, capture_output=True, text=True, timeout=a.timeout)
    except subprocess.TimeoutExpired:
        print(f"claude timed out after {a.timeout}s; transcript kept at {out}")
        return 1
    reply = (r.stdout.strip().splitlines() or [""])[-1]
    if r.returncode != 0:
        print(f"claude failed ({r.returncode}): {(r.stderr.strip().splitlines() or [reply or 'no output'])[-1]}; transcript kept at {out}")
        return 1
    print(f"journal {when} ({span}): {reply}" if reply else f"journal {when} updated from {span}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
