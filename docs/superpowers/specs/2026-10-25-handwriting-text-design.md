# Handwriting as text: design

Status: draft for Danny's approval, 2026-10-25.

## Intent

Make the words in Danny's handwriting into real PDF text, so a notebook can be
searched, copied from and read by other tools (Xodo, Preview, an LLM) without
losing the ink. Commands do the recognising; pdfink stores the result, keeps it
lined up with the ink, and hands any page's text to commands.

Already done in this round: pdf.js gets its CMaps, standard fonts, wasm
decoders and ICC profiles (served under `pdfjs/`), so text-bearing PDFs render
properly before we start reading their text.

## Goals

1. **Commands can read a page's text**: the PDF's own text (from pdf.js, with
   positions) and the handwriting text pdfink holds, plus the page's strokes.
2. **Commands can set the handwriting text** for a page: lines of text, each
   with the rectangle of ink it transcribes. One undoable edit, saved like ink.
3. **An OCR command** (`tools/ocr-page.py`) that transcribes a page's
   handwriting with a vision model and sets its text, run by hand from the
   pen menu or **automatically**: attached to the tab, it recognises a page
   after a quiet spell, re-reading only the lines whose ink changed.
4. **Where the text goes:**
   - *Every page* gets it as the `/Contents` of the page's ink annotation, so
     Xodo's annotation list shows it and it travels with the ink.
   - *Notebook pages* also get it as invisible text laid over the ink (the
     ocrmypdf technique), so every viewer can search and select it. Pages of
     a real document (a paper, a contract) do not, so it never mixes into the
     document's own text.
5. **Notebook or document** is decided per page: a page with no text of its
   own is a notebook page. A tag in the file overrides that for the whole
   file. pdfink's New sets it, and the pen menu can set or clear it.

## Non-goals

- Recognising text inside pdfink itself. The OCR is a command.
- A server-side watcher of the notebooks folder. Pages written in Xodo get
  their text when next viewed in pdfink.
- A text-selection or search UI in pdfink for now (see "Later").
- Non-Latin handwriting in the invisible layer (see Constraints).
- Keeping text in step with ink edited after the OCR ran. Moving or deleting
  a selection carries the text with it; erasing part of a line does not
  rewrite its text. Run the OCR again.

## Anti-goals

- Changing how the page looks. The invisible layer must never show.
- Disturbing a document's own text, or losing it, on any save.
- Text that drifts away from its ink after a save and reload.

## Approaches considered

**Recognition.** macOS Vision (local, free, two seconds for three pages) read
about a third of Danny's words wrongly and dropped a whole line; the vision
model through `llm` got nearly all of them. *Chosen: the vision model for the
words.* Line positions come from pdfink's own strokes, not from OCR: strokes
are grouped into lines by height, which is exact and cannot miss a line.

**Matching words to lines.** (a) Ask for lines in order and zip them with the
stroke lines: breaks whenever the model joins or splits a line. (b) Draw a
small number beside each stroke line on the image sent to the model and ask for
`{number: text}`: robust, the numbers are only on the copy the model sees.
*Chosen: (b).*

**Where the text lives.** (a) Invisible text in the page content: searchable
everywhere, but mixes with a document's own text. (b) The ink annotation's
`/Contents`: no interference, but not selectable and patchily searched.
*Chosen: (b) on every page, plus (a) on notebook pages*, as Danny agreed.
Cost: Acrobat, told to search comments too, finds notebook text twice, and may
show it on hover.

**Automatic OCR.** (a) The server watches the notebooks folder and OCRs pages
whose saved ink changed: covers Xodo with pdfink closed, but sees only saved
ink and must write into files that may be open. (b) An attached command
listens to the open tab's events and OCRs a page after a quiet spell: sees
unsaved ink and needs no new trigger machinery. *Chosen: (b).* Pages written
in Xodo get their text when next viewed in pdfink: the watcher checks a page
when you arrive on it, and lines with no text are new lines.

**Telling the cases apart.** A creation tag alone misses most notebooks (five
of seven in the notebooks folder came from ReportLab or iOS, and every save
already overwrites Producer). Every notebook page there has zero words of
printed text; the one real document has hundreds. *Chosen: per page by "has
text of its own", with a file tag overriding.*

## Design

### Model

`PageModel` gains `texts: TextItem[]`:

```ts
interface TextItem { id: string; x: number; y: number; w: number; h: number; text: string; sig?: string; note?: number }
```

Page space like links (top-left origin, display points). One item per line of
handwriting. `sig` is a fingerprint of the strokes the line was read from
(their points rounded to 0.1 pt, so it survives a save and reload), set by
the OCR so a later run can tell which lines changed. Selection, move, cut, copy, paste, delete and undo treat text
items like links: an item is selected when the selection rectangle contains
it, and moves with the strokes.

### In the file

- **Source of truth:** a page dictionary entry `/PdfinkText`, an array of
  `[x0 y0 x1 y1 (text) (sig) note]` in PDF user space. Import reads it into `texts`;
  export writes it from `texts`.
- **Notebook pages:** export appends one content stream to the page that
  begins `% pdfink handwriting text` and holds the lines as invisible text
  (render mode 3), Helvetica, each line's font size its box height and its
  horizontal scaling stretched to its box width. Import removes a stream
  starting with that marker from the base, as it removes ink.
- **Every page with text:** export writes the page's text as `/Contents` of
  the page's first ink annotation: one paragraph per note (its lines joined
  by spaces), notes in reading order separated by blank lines, e.g. "(this
  is a pdfink note)\n\nI wonder what these folks ended up doing?". `TextItem`
  carries a `note` number for this; items without one are a note each.
- **The tag:** `/PdfinkNotebook` in the document information dictionary,
  `true` or `false`; absent means decide per page. A page "has text of its
  own" when pdf.js finds any non-blank text item in the base (the base no
  longer holds our layer).

### Page API (window.pdfink, and pdfink_page.py in snake_case)

- `pageText(page)` → `{ own: [{text, x, y, w, h}], ink: TextItem[], notebook: boolean }`.
  `own` is the PDF's text from pdf.js; `notebook` is how this page will be
  saved.
- `inkText(page)` → `TextItem[]`; `setInkText(page, lines, {space, quiet})`
  replaces the page's handwriting text with `lines` (`{text, x, y, w, h,
  sig}`) and returns their ids. One undoable edit; with `quiet: true` (the
  automatic mode) it is not put on the undo stack and only marks the
  notebook for autosave. `removeItems` also removes text ids.
- `strokes(page, {space})` → the page's strokes, for grouping into lines.
- `notebookTag()` / `setNotebookTag(true | false | null)`.

Commands therefore read the PDF's own text through the page; from a shell,
pypdf or `pdftotext` on the file already do.

### The OCR command, `tools/ocr-page.py`

`ocr-page.py PAGE` from the pen menu (needs the page bridge; without it,
it says so and exits 1):

1. Get the page's strokes and group them into lines, then lines into notes.
   Annotating a paper (Danny's sample, "Attention Is All You Need") showed
   what this has to cope with: margin notes in narrow columns of one to three
   words a line, notes level with each other on opposite sides of a figure,
   and connectors (a dash or arrow before most notes, a long arc from a word
   in the text to its note).
   - *Connectors* are set aside first: strokes much wider than a line is
     tall and thin for their length. They are not words and must not stretch
     a line's box.
   - *Lines*: strokes join a line when they overlap vertically by at least
     half the smaller height **and** sit within a few line-heights of it
     horizontally, so notes level with each other stay apart. Small strokes
     (dots, commas) join the nearest line.
   - *Notes*: lines stacked closely with overlapping horizontal extents form
     one note.
2. Render the page (`pagePng`) and draw a small red number in the margin
   beside each line, on that copy only.
3. Ask the vision model (same default and `llm` keys as journal-page.py) for
   JSON `{"1": "text", ...}`, transcribing faithfully, `""` for a numbered
   line with no words (a doodle).
4. `setInkText` with one item per non-empty line: the line's text and the
   union rectangle of its strokes. Progress lines while it works; prints
   "N lines" at the end.

pen-menu entry: `[Recognise handwriting]`, timeout 300. Selection-aware: with
a selection, only strokes inside it are recognised and only text items inside
it are replaced.

Each run fingerprints every line and sends the model only lines whose `sig`
matches no existing text item (the page image still shows the whole page, so
the model has context; only the changed lines are numbered). Unchanged lines
keep their text. Before setting the text it re-reads the strokes and drops
results for lines that changed while the model was working.

### Automatic mode

`ocr-page.py --watch` as a detached pen-menu entry, `[Recognise handwriting
automatically]`: started once per tab, it shows a chip; dismissing the chip
stops it. It subscribes to the page's events and recognises a page when:

- the page's ink has been quiet for `--quiet` seconds (default 20) after an
  `ink` event on it, or
- you arrive on a page (`page` event) that has lines without text.

It works on one page at a time, queues the rest, uses `quiet: true`, and
reports only through a short progress line while busy. Other commands keep
working alongside it: each run has its own socket.

### New page event: `ink`

`{"event": "ink", "data": {"page": N}}` whenever a page's strokes change:
drawn, erased, moved, pasted, cut, deleted, undone, redone, added by a
command, or replaced by a reload. The existing `stroke` event stays.

### Pen menu

A checkbox row "Notebook" (checked when this file is treated as a notebook)
that sets the tag; New sets it to `true`.

## Constraints

- Helvetica with WinAnsi encoding in the invisible layer: characters outside
  it (beyond Western European) become `?` there. The `/PdfinkText` copy keeps
  the full text, so commands and the document-page `/Contents` lose nothing.
- No new npm dependencies. The OCR script uses uv inline metadata (`llm`,
  Pillow).
- Existing notebooks must open and save unchanged when they have no text.

## Left to the builder

Check the grouping and the OCR against Danny's annotated paper
(`NIPS-2017-attention-is-all-you-need-Paper.pdf` in the notebooks folder,
pages 1 to 4) as well as the notebook pages; never commit it, fixtures are
generated. Whether a local vision model on the server machine is good enough for the automatic mode
(`--model` takes any `llm` model; test it against the same three pages as
macOS Vision). Line-grouping thresholds; the exact JSON prompt; how the number labels are
drawn; test fixtures.

## Later

- Copy puts the selection's handwriting text on the clipboard as plain text.
- A find bar searching both kinds of text.
- journal-page.py reusing the page's handwriting text instead of OCRing again.
- Anchoring a margin note to the printed text its connector points at (the
  word under the arrow's end), so a command can say what a note is about.
