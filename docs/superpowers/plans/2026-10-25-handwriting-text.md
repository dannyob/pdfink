# Handwriting as Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store recognised handwriting as text in the PDF (annotation `/Contents` on every page, an invisible text layer on notebook pages), expose page text to commands, and ship an OCR command that runs by hand or automatically.

**Architecture:** `PageModel` gains `texts: TextItem[]`, round-tripped through a private `/PdfinkText` page entry and rendered on export as `/Contents` of the first ink annotation plus, on notebook pages, a marked invisible-text content stream that import strips again. The browser decides per page whether a page is a notebook page (a file tag, else "no text of its own" via pdf.js) and tells export. Commands read and write texts through new page-API calls; `tools/ocr-page.py` groups strokes into lines and notes (`tools/ink_lines.py`), asks a vision model for numbered lines, and sets the text; `--watch` does it automatically from an attached run listening to a new `ink` event.

**Tech Stack:** TypeScript, pdf-lib, pdf.js (pdfjs-dist 6.4), Vite, vitest, Playwright; Python 3.10+ scripts run by uv with inline metadata (`llm` + plugins, Pillow).

**Spec:** `docs/superpowers/specs/2026-10-25-handwriting-text-design.md`

## Global Constraints

- No new npm dependencies.
- Python tools declare dependencies inline (PEP 723) and run with `uv run --script`; shared modules sit in `tools/` and are imported after `sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))`.
- Text items are page space like links: top-left origin, display points.
- File format names, verbatim: page entry `/PdfinkText` = array of `[x0 y0 x1 y1 (text) (sig) note]` in PDF user space (`sig` empty string and `note` `-1` when absent); Info entry `/PdfinkNotebook` = `true` or `false`; layer stream begins with the line `% pdfink handwriting text`; layer font resource name `/PdfinkF1` (Helvetica, WinAnsi).
- Characters Helvetica/WinAnsi cannot encode become `?` in the layer only; `/PdfinkText` and `/Contents` keep the full text.
- `/Contents` format: one paragraph per note (its lines in top-to-bottom order joined by single spaces), notes in reading order (by top edge, then left edge) separated by a blank line (`\n\n`). Items without `note` are a note each.
- Default OCR model: `$PDFINK_OCR_MODEL`, else `openrouter/google/gemini-3.7-flash` (the journal default).
- Danny's annotated paper (`NIPS-2017-attention-is-all-you-need-Paper.pdf` in the notebooks folder) and his notebooks are never committed; all fixtures are generated.
- The repo is public: no machine names, home paths or personal details in code, tests or docs.
- All existing unit and e2e tests stay green (`npx vitest run`, `npx playwright test`, `npm run typecheck`).

## Review Focus

1. A notebook page with text saved, reloaded and saved again many times: exactly one layer stream and one copy of each line in `pdftotext` output, never accumulating.
2. Rotated pages (`/Rotate` 90/180/270): layer text runs along the displayed line, inside the line's box.
3. Undo/redo after a quiet (automatic) OCR update does not wipe or resurrect texts.
4. A file another app re-saved: `/PdfinkText` present but the layer stream gone, or the first ink annotation replaced; pdfink must still open it and rewrite both cleanly.
5. A page whose "own text" is only whitespace or empty strings counts as a notebook page.

Each has a test in the owning task below.

---

### Task 1: Text items in the model and the PDF

**Files:**
- Modify: `src/model.ts` (TextItem, PageModel.texts, ClipContent.texts)
- Create: `src/pdf/text.ts` (read/write `/PdfinkText`, the layer, `/Contents`, the tag)
- Modify: `src/pdf/import.ts`, `src/pdf/export.ts`
- Modify every `PageModel` literal to include `texts: []` (`src/app.ts`, `server/index.ts`, `src/api.ts`, tests): `grep -rn "links: \[\]" src server tests`
- Test: `tests/unit/handwriting-text.test.ts`

**Interfaces:**
- Produces:
  - `interface TextItem { id: string; x: number; y: number; w: number; h: number; text: string; sig?: string; note?: number }` in `src/model.ts`; `PageModel.texts: TextItem[]`; `ClipContent.texts: TextItem[]`.
  - `ImportedDocument.notebook: boolean | null` (the `/PdfinkNotebook` tag).
  - `exportPdf(baseBytes, pages, bookmarks?, opts?: { notebook?: boolean | null; textLayers?: boolean[] })`: `notebook` undefined leaves the tag, `null` removes it, a boolean sets it; `textLayers[i]` true writes the invisible layer on page i (ignored when page i has no texts).
  - `createBlankPdf(pageCount = 1, opts?: { notebook?: boolean })` writes the tag when given.
  - `notesText(texts: TextItem[]): string` in `src/pdf/text.ts` (the `/Contents` format).

- [ ] **Step 1: Write the failing tests** in `tests/unit/handwriting-text.test.ts`. Use pdf.js in node (`import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"`) to read page text. Tests:
  - `texts round-trip through /PdfinkText`: export a blank 1-page PDF with two items (`{x:72,y:100,w:120,h:20,text:"hello there",sig:"a1",note:0}`, `{x:72,y:124,w:80,h:20,text:"Grüße — ok",note:0}`), import: `pages[0].texts` equal by x/y/w/h (to 0.01), text, sig, note; ids fresh strings.
  - `notebook pages get one invisible layer, never two`: export with `textLayers:[true]`, import, export again with `textLayers:[true]`, three times; pdf.js `getTextContent()` of the final file joins to contain `hello there` exactly once; the base bytes from `importPdf` contain no text items (pdf.js finds none).
  - `the layer sits inside each line's box`: pdf.js text item for `hello there` has transform origin within 1 pt of PDF (72, 792-120) and width within 2 pt of 120. Repeat on a page with `/Rotate 90` set via pdf-lib (`page.setRotation(degrees(90))`), checking via pdf.js viewport-converted coordinates that the item lies within the display box.
  - `document pages get no layer`: `textLayers:[false]`, pdf.js finds no text; the first `/Ink` annotation's `/Contents` (page also has one stroke) equals `hello there Grüße — ok`.
  - `contents groups notes into paragraphs`: `notesText` of four items given out of order (note 0: "a" at y 100 and "b" at y 120; note 1: "c" at y 300; no note: "d" at y 500) returns exactly `"a b\n\nc\n\nd"`.
  - `non-WinAnsi text becomes ? in the layer only`: item text `"漢字 ok"`; pdf.js layer text is `?? ok`; `/PdfinkText` round-trip keeps `漢字 ok`.
  - `the notebook tag round-trips`: `createBlankPdf(1,{notebook:true})` imports with `notebook: true`; export with `{notebook:false}` → `false`; `{notebook:null}` → `null`; omitted → unchanged.
  - `a file with /PdfinkText but no layer and no ink still opens and exports both`: hand-build with pdf-lib.
  - `pages without texts are unchanged`: exporting a page with `texts: []` and `textLayers:[true]` adds no content stream (content array length unchanged).

- [ ] **Step 2: Run** `npx vitest run tests/unit/handwriting-text.test.ts` — Expected: FAIL (no `texts`, `notesText` missing).

- [ ] **Step 3: Implement.**
  - `src/pdf/text.ts`: `readTexts(doc, page, geom): TextItem[]` (convert PDF rect corners with the existing geom helpers; decode strings with pdf-lib `decodeText()`), `writeTexts(doc, page, geom, texts)` (strings as `PDFHexString.fromText`), `stripLayer(doc, page): void` (remove from `/Contents` the stream whose decoded data starts with the marker; decode with `decodePDFRawStream(stream).decode()`; leave a non-array `/Contents` alone unless it is the marker stream itself), `addLayer(doc, page, geom, texts)` and `notesText`.
  - Layer content per line: `BT 3 Tr /PdfinkF1 <h> Tf <Tz> Tz <a b c d e f> Tm <hex> Tj ET`, wrapped in `q … Q`, first line the marker comment. `a b` = unit vector of the display x-axis in PDF space, `c d` = unit vector of display "up" (−y) in PDF space, `e f` = PDF point of the line's display bottom-left `(x, y+h)` plus `0.2*h` upward along `c d` for the descender. `Tz = 100 * w / font.widthOfTextAtSize(text, h)` (100 when the width is 0). Font: `doc.embedFont(StandardFonts.Helvetica)` once per export, registered on each layered page as `/PdfinkF1`. Replace characters not in `font.getCharacterSet()` with `?`.
  - Append the layer stream to the page's `/Contents` (turn a single stream into an array).
  - `/Contents` text: on export, after writing ink annotations, set `/Contents` (as `PDFHexString.fromText`) on the page's first `/Ink` annotation when the page has texts.
  - Import: read `/PdfinkText` into `texts`, strip the layer, delete `/PdfinkText` from the base page dict; read the Info dict entry `/PdfinkNotebook` (`PDFBool`) into `notebook`. Export writes `/PdfinkText` (only when texts non-empty) and the tag per `opts.notebook`.

- [ ] **Step 4: Run** `npx vitest run tests/unit/handwriting-text.test.ts` then `npx vitest run` and `npm run typecheck` — Expected: all PASS.

- [ ] **Step 5: Commit** `git commit -m "Handwriting text in the PDF: /PdfinkText, an invisible layer, annotation contents"`

### Task 2: Wire format and server save

**Files:**
- Modify: `server/index.ts` (WirePage.texts, envelopes, `checkWireShapes`, save → `exportPdf` opts), `src/api.ts` (encode/decode the same)
- Test: `tests/unit/server.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 `TextItem`, `exportPdf` opts, `ImportedDocument.notebook`.
- Produces: open envelope JSON `{ pages, bookmarks, notebook }`; save envelope JSON adds optional `textLayers?: boolean[]` and `notebook?: boolean | null` (absent = leave the tag); `WirePage.texts?: TextItem[]`. `decodeOpened` returns `notebook: boolean | null`; `encodeSaveEnvelope(pages, baseBytes, bookmarks, opts?: { textLayers?: boolean[]; notebook?: boolean | null })`; `saveNotebookParsed(name, pages, ifMtime, baseBytes, bookmarks, opts?)` passes `opts` through.

- [ ] **Step 1: Failing tests** in `tests/unit/server.test.ts`: a save envelope with texts and `textLayers:[true]`, `notebook:true` writes a file that `importPdf` reads back with the texts and `notebook: true`; an open of that file returns texts and `notebook: true`; `checkWireShapes` rejects a text with non-finite `x`, non-string `text`, non-string `sig`, non-integer `note` (`pages[0].texts[0].x must be a finite number` style messages, matching the link ones).
- [ ] **Step 2: Run** `npx vitest run tests/unit/server.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; older envelopes without the fields behave as before.
- [ ] **Step 4: Run** `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Texts and the notebook tag over the wire"`

### Task 3: Texts in the app: edits, undo, saves, the Notebook row, the ink event

**Files:**
- Modify: `src/app.ts`, `src/menu.ts` only if a checked text row needs styling (it already supports `checked`)
- Test: `tests/e2e/handwriting-text.spec.ts` (new)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `App.setInkText(page: number, lines: Array<Omit<TextItem, "id">>, opts?: { quiet?: boolean; within?: Rect }): string[]` — replaces the page's texts (only those inside `within`, when given) with `lines`; one undo step, or with `quiet` no undo entry (redo stack untouched) but `markDirty()`.
  - `App.inkText(page): TextItem[]`; `App.ownText(page): Promise<Array<{ text: string; x: number; y: number; w: number; h: number }>>` (pdf.js `getTextContent` of the base, converted to page space, non-blank items only, cached per document); `App.isNotebookPage(page): Promise<boolean>` = tag ?? no own text.
  - `App.notebookTag: boolean | null`; `App.setNotebookTag(v: boolean | null)` marks dirty.
  - `AppEvent` gains `"ink"`, emitted as `{ page }` whenever a page's `strokes` array changes (in `apply`, so commits, undo, redo and quiet updates all count) and for every page after a document load or reload.
- Behaviour:
  - Selection, move, copy, cut, paste, delete and `removeItems` treat texts like links (`textIds` beside `linkIds`; contained-in-rect test). `getState()` lists texts like links.
  - Snapshots include `texts`. Undo/redo of an entry whose `before.texts === after.texts` keeps the page's current texts (so quiet OCR results survive undoing a stroke).
  - Saves (server and `exportBytes`) pass `textLayers` (for each page with texts, `await isNotebookPage(i)`) and `notebook` (the tag, only when changed since load).
  - Both New paths call `createBlankPdf(1, { notebook: true })`.
  - Pen menu: a text row `Notebook` after `Bookmark this page…`, `checked` when the current page counts as a notebook page; choosing it sets the tag to the opposite of its checked state.

- [ ] **Step 1: Failing e2e tests** in `tests/e2e/handwriting-text.spec.ts` (server storage, via `window.pdfink` and `window.__pdfink`):
  - `setInkText then save: the file has the layer and contents` (read the saved file with pdf-lib + `importPdf`).
  - `moving a selection moves its text; cut/paste and delete carry it; undo restores it`.
  - `a quiet update is not undoable and survives undoing an earlier stroke`.
  - `New makes a notebook: the Notebook row is ticked; untick it and save → tag false`.
  - `a page with printed text is not a notebook page; a whitespace-only text page is` (fixtures built with pdf-lib `drawText`, one with `"   "`).
  - `ink events fire for draw, erase, undo, redo, delete and reload` (subscribe with `pdfink`-side listener via `__pdfink.on`).
- [ ] **Step 2: Run** `npx playwright test tests/e2e/handwriting-text.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx playwright test` and `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Handwriting text follows edits; Notebook row; ink event"`

### Task 4: Page API and Python client

**Files:**
- Modify: `src/pdfink-api.ts`, `src/bridge-client.ts` only if events are allow-listed there, `tools/pdfink_page.py`, `README.md` (Talking to the page)
- Test: `tests/e2e/pdfink-api.spec.ts` (extend), `tools/tests/test_pdfink_page.py` (extend)

**Interfaces:**
- Consumes: Task 3.
- Produces (window.pdfink → Python):
  - `pageText(page)` → `{ own: [{text,x,y,w,h}], ink: TextItem[], notebook: boolean }` → `page_text(page)`
  - `inkText(page)` → `ink_text(page)`
  - `setInkText(page, lines, { space?: "page"|"pdf", quiet?: boolean, within?: Rect })` → `set_ink_text(page, lines, space="page", quiet=False, within=None)`; `space: "pdf"` converts each line's rect from PDF user space as `addLink` does.
  - `strokes(page, { space? })` → `strokes(page, space="page")`: `[{id, points:[{x,y,p}], color, width, opacity}]`
  - `notebookTag()` / `setNotebookTag(v)` → `notebook_tag()` / `set_notebook_tag(v)`
  - Event `ink` (`{page}`) available to `subscribe`/`events`.
  - Validation like `addStrokes`: non-finite numbers, non-string text, page out of range → error.
- [ ] **Step 1: Failing tests**: e2e for each call incl. `space:"pdf"` conversion and a rejected bad line; Python fake-bridge tests that each method sends the right `call` and args.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/pdfink-api.spec.ts` and `uv run --script tools/tests/test_pdfink_page.py` — Expected: FAIL.
- [ ] **Step 3: Implement**; document the calls and the `ink` event in the README.
- [ ] **Step 4: Run** both suites — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Page API: page text, handwriting text, strokes, notebook tag"`

### Task 5: Grouping strokes into lines and notes

**Files:**
- Create: `tools/ink_lines.py`
- Test: `tools/tests/test_ink_lines.py`, run from `tests/unit/timestamp.test.ts`-style wrapper `tests/unit/ink-lines.test.ts`

**Interfaces:**
- Produces:
  - `@dataclass Line: stroke_ids: list[str]; x: float; y: float; w: float; h: float; sig: str; note: int`
  - `group(strokes: list[dict]) -> list[Line]` (strokes as the page API returns them, page space), lines in reading order, notes numbered from 0 in reading order.
  - `signature(strokes: list[dict]) -> str`: sha1 hex (first 16 chars) of the sorted strokes' points rounded to 0.1 pt.
  - `is_connector(stroke) -> bool`.
- Rules (from the spec): connectors = bbox width ≥ 3× the median stroke height and bbox height ≤ 0.35× its width, or a stroke whose bbox width ≥ 6× median stroke height; set aside before grouping. Lines: a stroke joins a line when vertical overlap ≥ 50% of the smaller height and the horizontal gap ≤ 2.5× the line's height. Strokes whose height and width are both < 0.3× median height (dots) join the nearest line. Notes: consecutive lines whose vertical gap ≤ 1.2× the taller line's height and whose horizontal extents overlap.
- [ ] **Step 1: Failing tests** with synthetic strokes (each word a few zig-zag strokes ~14 pt tall), modelled on the paper: (a) two columns level with each other ("encoder" left at x 50, "decoder" right at x 450) → two lines, two notes; (b) a five-line narrow margin note → one note of five lines; (c) a dash before a note and a 300 pt arc → both connectors, excluded, line boxes not widened; (d) a dot over an "i" joins its line; (e) `signature` unchanged when points move by < 0.05 pt and changed by a 1 pt move; (f) empty input → `[]`.
- [ ] **Step 2: Run** `uv run --script tools/tests/test_ink_lines.py` — Expected: FAIL.
- [ ] **Step 3: Implement** (stdlib only).
- [ ] **Step 4: Run** it and `npx vitest run tests/unit/ink-lines.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "tools/ink_lines.py: strokes into lines and notes"`

### Task 6: `tools/ocr-page.py`, by hand

**Files:**
- Create: `tools/llm_call.py` (the timeout-and-retry model call moved out of `journal-page.py`, which imports it), `tools/ocr-page.py`
- Modify: `tools/journal-page.py` (use `llm_call.ask`), `pdfink-commands.conf.example`, `README.md`
- Test: `tests/unit/tools-smoke.test.ts` (extend), `tools/tests/test_ocr_page.py` (+ wrapper in `tests/unit/ink-lines.test.ts`)

**Interfaces:**
- Consumes: Task 4 Python calls, Task 5 `group`/`Line`.
- Produces:
  - `llm_call.ask(model, prompt: str, data: bytes, suffix: str, attempts: int = 2, timeout: int = LLM_TIMEOUT) -> str` (journal's behaviour, fence stripping included).
  - `ocr-page.py PAGE [--model M] [--all] [--dry-run]` (PAGE 1-based, `$PAGE` from the menu); exits 1 with "needs the pdfink page (run it from the pen menu)" without `$PDFINK_SOCKET`.
  - Pure helpers for tests: `changed_lines(lines, texts, force: bool, within: Rect | None) -> list[Line]`; `label_image(png: bytes, lines, numbers) -> bytes` (small red numbers beside each line, left of the box, or right when the box starts within 20 pt of the left edge); `parse_answer(text) -> dict[int, str]`; `merge(lines_now, texts, results) -> list[dict]`.
- Flow: strokes → `group` → existing `ink_text` → `changed_lines` (with a selection, lines inside it are forced) → nothing changed: print `up to date`, exit 0 → `page_png(page-1, 2)` → `label_image` → model with the prompt below → `parse_answer` → re-read strokes and regroup → `merge` keeps existing items whose `sig` matches a current line or which have no `sig`, adds results only for lines whose `sig` is still present, drops empty strings → `set_ink_text(..., quiet=...)` → print `N lines` (N = lines newly set). Progress lines `Recognising handwriting…`; cleared at exit.
- Prompt (exact copy):
  `The attached page has handwriting on it. Some handwritten lines have a small red number beside them. For each numbered line, transcribe the handwriting on that line exactly as written: keep spelling, capitals and punctuation; mark unreadable words [illegible]. Ignore printed text, the red numbers themselves, underlines, circles, arrows and other marks that are not words. Answer with JSON only: an object mapping each number (as a string) to its line's text, with "" for a numbered line that has no words.`
- [ ] **Step 1: Failing tests**: `test_ocr_page.py` covers `changed_lines` (sig match skipped; `--all`/forced; within), `parse_answer` (fenced JSON, bad JSON → `{}` and a logged error, non-numeric keys ignored), `merge` (stale result dropped when its line changed mid-run; existing unsigned item kept; vanished line's item dropped), `label_image` returns a PNG of the same size; smoke test `ocr-page.py --help` exits 0 and without a socket exits 1 with the message; a fake-bridge `--dry-run` run prints the numbered lines it would send and calls no `setInkText`.
- [ ] **Step 2: Run** `uv run --script tools/tests/test_ocr_page.py` and `npx vitest run tests/unit/tools-smoke.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; move `ask` into `llm_call.py` and make journal-page.py import it (its tests must stay green); add `[Recognise handwriting]` (`command = uv run --script tools/ocr-page.py "$PAGE"`, `timeout = 300`) to the example config; README paragraph.
- [ ] **Step 4: Run** `npx vitest run` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "tools/ocr-page.py: recognise a page's handwriting into text"`

### Task 7: Automatic mode, `ocr-page.py --watch`

**Files:**
- Modify: `tools/ocr-page.py`, `pdfink-commands.conf.example`, `README.md`
- Test: `tools/tests/test_ocr_page.py` (extend), `tests/e2e/bridge.spec.ts` (extend: two runs at once on one tab)

**Interfaces:**
- Consumes: Task 4 `ink`/`page` events, Task 6 flow (as a function `recognise(page_api, page_index, quiet: bool) -> int`).
- Produces: `class Scheduler(quiet_s: float)` with `ink(page, now)`, `arrived(page, now, has_untexted: bool)`, `due(now) -> list[int]` (pages whose last ink is ≥ `quiet_s` old, and arrived pages with untexted lines, each once, oldest first). `--watch [--quiet SECONDS]` (default 20) runs: subscribe `ink` and `page`, feed the scheduler, every second process due pages one at a time with `quiet=True`, progress `Reading page N…` while busy, nothing printed per page; exit 0 on `PageGone` or the run's `exit`. Example config entry `[Recognise handwriting automatically]` with `detach = true`.
- [ ] **Step 1: Failing tests**: Scheduler unit tests (debounce resets on new ink; two pages queued in order; arrival with untexted lines due at once; arrival without is not; a page is not due again until new ink); e2e: a detached fixture command and a second ordinary command run against one tab simultaneously and both complete with their page calls applied (fixture in `tests/fixtures/bridge-tool.cjs`).
- [ ] **Step 2: Run** them — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run` and `npx playwright test` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "ocr-page.py --watch: recognise pages automatically"`

### Task 8: Trial on real pages, docs, live config

**Files:**
- Modify: `docs/design.md` (data model and file format), `README.md` if anything is missing
- Outside the repo: add both entries to the live `pdfink-commands.conf` in the notebooks folder (absolute uv path, as the existing entries)

- [ ] **Step 1:** Using a copy in a temp directory (never the notebooks folder), open Danny's paper (pages 1–4) and notebook `2026-10.pdf` pages 1, 5, 6 in a pdfink instance on a test port; run `ocr-page.py` on each page through the bridge (a small Playwright or Python driver in the job tmp dir, not committed). Record per page: lines found, connectors set aside, words wrong against the handwriting, `/Contents` text. Then repeat with a local vision model via `--model` if `llm models` lists one; record the same.
- [ ] **Step 2:** If grouping misjudges the paper's notes, tune the thresholds in `ink_lines.py`, adding each fixed case as a synthetic test first (RED → GREEN).
- [ ] **Step 3:** Update docs; add the live config entries; `npm run build`; restart the service (`launchctl kickstart -k gui/$(id -u)/com.spesh.pdfink`).
- [ ] **Step 4: Run** `npx vitest run`, `npx playwright test`, `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Docs for handwriting text"`; report the trial results to Danny.
