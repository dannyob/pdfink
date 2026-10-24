# Links and Bookmarks Implementation Plan (Part B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pdfink reads, shows, edits and writes clickable URL boxes (`/Link` annotations with URI actions) and bookmarks (the document outline), and exposes both to pen-menu commands through the bridge.

**Architecture:** A third item kind, `LinkItem`, joins strokes and images in `PageModel`; a document-level `Bookmark[]` joins the model, the wire format and the save envelope. `src/pdf/links.ts` and `src/pdf/outline.ts` do the PDF work with pdf-lib (hand-built dictionaries for the outline). The page draws links on the ink canvas, follows them from the pen menu or a finger tap, and lists bookmarks in a toolbar select. `window.pdfink` and `pdfink_page.py` gain the matching calls.

**Tech Stack:** TypeScript, pdf-lib, pdf.js, Vitest, Playwright, Python standard library.

**Spec:** `docs/superpowers/specs/2026-10-23-page-bridge-design.md`, section 4b and the Part B items of sections 4, 7, 8 and 9. Depends on Part A (`docs/superpowers/plans/2026-10-23-page-bridge.md`) being merged: it uses `App.on`, `setSelection`, `dialog`, `PdfinkApi`, `pdfink_page.Page`.

## Global Constraints

- Only `/Link` annotations with `/A << /S /URI >>` are lifted into items; every other annotation, and `GoTo` links, stay in the base PDF byte-for-byte.
- Link URLs must have scheme `http`, `https` or `mailto`; anything else (including `javascript:`) is refused by `addLink`/`setLink` with an error, and a bare `example.com` typed in the dialog gets `https://` prepended.
- Links open with `window.open(url, "_blank", "noopener,noreferrer")`.
- Exported bookmark titles are written with `PDFHexString.fromText` (UTF-16) so non-ASCII survives; page destinations are `[pageRef /XYZ null null null]`.
- `exportPdf(base, pages)` with `bookmarks` undefined leaves the base's `/Outlines` untouched; with an array (even empty) it replaces them.
- Bookmark edits are not undoable (they only mark the document dirty); link edits go through the ordinary per-page undo.
- `npm run typecheck`, `npm test`, `npm run test:e2e` green after every task; the real-notebook tests under `PDFINK_SAMPLES` still pass; commit after every task.

## Review Focus

1. A rotated page (`/Rotate 90`): a link lifted on import lands where the page shows it, and a link added in the page is written back to the right PDF rectangle. (Task 1)
2. A base PDF whose `/Annots` is an indirect reference and mixes a GoTo link with a URI link: only the URI link moves, the array is rewritten with the GoTo link kept. (Task 1)
3. An outline with wrong `/Count` values or an entry whose destination names a missing page: reading does not throw; the entry comes back with `page: null` and is written out title-only. (Task 2)
4. A title containing non-ASCII ("Café 2026-10-19"): identical after export and re-import. (Task 2)
5. A finger tap on a link while finger-draws mode is on: it draws a dot rather than opening the link, and the pen menu is the way to open it. (Task 6)

---

### Task 1: `LinkItem` in the model and the PDF round trip

**Files:**
- Modify: `src/model.ts` (`LinkItem`, `PageModel.links`, `ClipContent.links`), `src/pdf/import.ts`, `src/pdf/export.ts`
- Create: `src/pdf/links.ts`
- Modify: every `PageModel` literal (`src/app.ts:425`, `src/api.ts:48-60`, `server/index.ts:157-170`, tests) to carry `links: []`
- Test: `tests/unit/links.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // model.ts
  export interface LinkItem { id: string; x: number; y: number; w: number; h: number; url: string; label?: string }  // page space, top-left
  export interface PageModel { width; height; strokes: Stroke[]; images: ImageItem[]; links: LinkItem[] }
  export interface ClipContent { strokes; images; links: LinkItem[]; width; height }
  // pdf/links.ts
  export function extractLinks(doc: PDFDocument, items: unknown[] /* kept array from extractInk */, geom: PageGeom): { links: LinkItem[]; kept: unknown[]; removed: PDFRef[] }
  export function addLinkAnnotation(doc: PDFDocument, pageIndex: number, geom: PageGeom, link: LinkItem): void
  export function linkUrlOk(url: string): boolean   // ^(https?|mailto):
  ```
  `importPdf` runs `extractLinks` on the array `extractInk` kept and sets `model.links`; `exportPdf` writes each link after the images and before the ink. The annotation written: `/Type /Annot /Subtype /Link /Rect [...] /Border [0 0 1] /C [0 0 1] /A << /S /URI /URI (url) >> /Contents (label) /NM (pdfink-…) /F 4`. The `/Rect` comes from `displayToPdf` on two corners, normalised.

- [ ] **Step 1: Write the failing tests** `tests/unit/links.test.ts`

```ts
it("lifts a URI link into the model and leaves a GoTo link in the base", async () => {
  // blank 1-page Letter PDF; add two /Link dicts to an indirect /Annots array: URI to https://example.org with /Rect [72 648 272 712]; GoTo to page 1
  const r = await importPdf(bytes);
  expect(r.pages[0].links).toEqual([expect.objectContaining({ x: 72, y: 80, w: 200, h: 64, url: "https://example.org" })]);
  const base = await PDFDocument.load(r.baseBytes);
  expect(base.getPage(0).node.Annots()!.size()).toBe(1);   // the GoTo link
});
it("round-trips a link on a 90° rotated page", …)    // page.setRotation(degrees(90)); link added via exportPdf at display rect; re-import gives the same display rect within 0.01
it("exportPdf writes /Link with a URI action, border and label", …) // check /A /S /URI, /URI text, /Contents, /Border
it("rejects bad schemes", () => { expect(linkUrlOk("javascript:alert(1)")).toBe(false); expect(linkUrlOk("mailto:a@b.c")).toBe(true); })
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/links.test.ts`
Expected: FAIL (`links` undefined).

- [ ] **Step 3: Implement** the model fields, `src/pdf/links.ts`, and the import/export wiring. Fix every `PageModel` literal the type checker flags.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npm test`
Expected: PASS (including `pdf-roundtrip.test.ts` and the sample tests if `PDFINK_SAMPLES` is set).

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/pdf/links.ts src/pdf/import.ts src/pdf/export.ts src/app.ts src/api.ts server/index.ts tests
git commit -m "Links: URI /Link annotations become LinkItems and round-trip"
```

### Task 2: Bookmarks in the model and the outline round trip

**Files:**
- Modify: `src/model.ts` (`Bookmark`), `src/pdf/import.ts` (`ImportedDocument.bookmarks`), `src/pdf/export.ts` (`exportPdf(base, pages, bookmarks?)`)
- Create: `src/pdf/outline.ts`
- Test: `tests/unit/outline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Bookmark { title: string; page: number | null /* 0-based */; level: number /* 0 = top */ }
  export function readOutline(doc: PDFDocument): Bookmark[]          // depth-first; /Dest array, /A GoTo /D, or named destination via catalog /Dests or /Names→/Dests tree; unresolvable → page null; never throws on bad /Count or cycles (visited set)
  export function writeOutline(doc: PDFDocument, bookmarks: Bookmark[]): void   // replaces catalog /Outlines; nests by level (a level jump of more than one is clamped to parent+1); /Count on each node; title via PDFHexString.fromText; entries with page null get no /Dest
  export async function exportPdf(baseBytes: Uint8Array, pages: PageModel[], bookmarks?: Bookmark[]): Promise<Uint8Array>
  ```
  `importPdf` sets `bookmarks: readOutline(doc)` before saving the base.

- [ ] **Step 1: Write the failing tests** `tests/unit/outline.test.ts`

```ts
it("writes and reads a nested outline", …)           // [{A,0,0},{A1,1,1},{A2,1,2},{B,2,0}] → exportPdf(base, pages, bms) → importPdf → bookmarks deep-equal
it("keeps a non-ASCII title", …)                       // "Café 2026-10-19"
it("resolves a named destination", …)                 // build /Names /Dests tree by hand with one name → page 1
it("survives a wrong /Count and an unresolvable destination", …) // hand-built outline: /Count 99, one item whose /Dest names a missing name → [{title, page: null, level: 0}]; re-export writes it title-only (no /Dest key)
it("leaves the base outline alone when bookmarks is undefined", …) // export without bookmarks keeps the original /Outlines ref
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/outline.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `src/pdf/outline.ts` and the wiring.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/model.ts src/pdf/outline.ts src/pdf/import.ts src/pdf/export.ts tests/unit/outline.test.ts
git commit -m "Bookmarks: the outline round-trips through the model"
```

### Task 3: Links and bookmarks on the wire and through the server

**Files:**
- Modify: `server/index.ts:128-204` (`WirePage.links`, `toWirePages`, `encodeOpened` JSON `{pages, bookmarks}`, `fromWirePages`, `decodeSaveEnvelope` returning `bookmarks`), `/save` handler (pass bookmarks to `exportPdf`), `src/api.ts:42-127` (`WirePage.links`, `decodeOpened` returns `bookmarks`, `openNotebookParsed` returns `bookmarks`, `encodeSaveEnvelope(pages, baseBytes, bookmarks)`, `saveNotebookParsed(name, pages, ifMtime, baseBytes, bookmarks)`)
- Test: `tests/unit/server-open.test.ts`, `tests/unit/server.test.ts`

**Interfaces:**
- Produces: open envelope JSON `{ pages: WirePage[], bookmarks: Bookmark[] }`; save envelope JSON `{ pages, images, baseLength, bookmarks }` (`bookmarks` optional on input: absent means "leave the file's outline alone"). `WirePage.links: LinkItem[]` as plain JSON.

- [ ] **Step 1: Write the failing tests**

```ts
it("/open carries links and bookmarks", …)   // put a PDF with one URI link and a one-entry outline; GET /open; decode: pages[0].links length 1, bookmarks [{title:"Intro", page:0, level:0}]
it("/save writes links and bookmarks into the file", …) // envelope with a link and two bookmarks; read the file: /Link annot present, /Outlines has 2 entries
it("/save without bookmarks keeps the file's outline", …)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/server-open.test.ts tests/unit/server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** both sides of the wire.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/index.ts src/api.ts tests/unit
git commit -m "Wire format: links per page, bookmarks per document"
```

### Task 4: Links in the App: selection, clipboard, undo, drawing

**Files:**
- Modify: `src/app.ts` (`Selection`/`SelectionView` gain `linkIds: Set<string>`; `PageSnapshot` gains `links`; `snapshot`/`apply`/`commit`, `updateSelectionMembers`, `selectedContent`, `copy`, `cut`, `deleteSelection`, `pasteInternal`, `removeItems`, `selectionInfo` bounds include links), `src/render/pageview.ts` (`drawInk` draws links; `SelectionView.linkIds`), `src/geometry.ts` (`rectInRect` if missing)
- Test: `tests/e2e/links.spec.ts`

**Interfaces:**
- Produces, on `App`:
  ```ts
  addLink(page: number, rect: Rect, url: string, label?: string): string;   // throws Error("bad url") unless linkUrlOk; id prefix "ln"; one undo entry; emits "selection"? no: emits nothing beyond markDirty
  setLink(id: string, patch: { url?: string; label?: string }): void;         // throws on bad url; undo entry
  linkAt(page: number, x: number, y: number): LinkItem | null;
  links(page?: number): Array<LinkItem & { page: number }>;
  openLink(link: LinkItem): void;                                             // window.open(url, "_blank", "noopener,noreferrer")
  ```
  `selectionInfo()` gains `linkIds: string[]`, and its `bounds`/`rect` include selected links; `count` sent with a command adds them.
  Drawing (page points, on the ink canvas before strokes): stroke `rgba(30,90,200,0.7)` width `1/scale`, fill `rgba(30,90,200,0.05)`; caption = `label ?? shortUrl(url)` (host plus path, truncated with "…" to fit) in `9px sans-serif` at the box's top-left inset 2 pt when `w ≥ 60 && h ≥ 14`; a selected link gets the dashed `rgba(47,74,122,0.9)` outline images use. `getState().pages[i].links` lists `{id,x,y,w,h,url,label}`; `selection.links` lists ids.

- [ ] **Step 1: Write the failing e2e tests** `tests/e2e/links.spec.ts`

```ts
test("addLink draws a blue box with a caption and is undoable", …)   // pixel at the box edge is bluish; undo removes it
test("select, copy, paste and delete work on links like images", …)
test("setLink changes the url; a javascript: url is refused", …)      // expect evaluate to reject /bad url/
test("saving writes the link and reopening shows it", …)              // readNotebook: /Link annot; reload; state has the link
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/links.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx playwright test tests/e2e/links.spec.ts tests/e2e/selection.spec.ts tests/e2e/images.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/render/pageview.ts src/geometry.ts tests/e2e/links.spec.ts
git commit -m "Links in the page: drawn, selectable, copied, undone"
```

### Task 5: Bookmarks in the App and the toolbar

**Files:**
- Modify: `src/app.ts` (`bookmarks: Bookmark[]`; set in `setDocument`/`openNotebook`/`loadParsed` from the imported document; sent on save), `src/main.ts`, `index.html` (`<select id="bookmark-select" title="Bookmarks"><option value="">Bookmarks…</option></select>` in the first toolbar group), `src/style.css`
- Test: `tests/e2e/bookmarks.spec.ts`

**Interfaces:**
- Produces, on `App`:
  ```ts
  bookmarks: Bookmark[];
  addBookmark(page: number, title: string, level?: number): number;   // index; inserted after the last bookmark whose page ≤ page; markDirty; emits "bookmarks"
  removeBookmark(index: number): void;                                 // markDirty; emits "bookmarks"
  bookmarkOnPage(page: number): number | null;                         // index of the first level-0 bookmark on that page
  ```
  `AppEvent` gains `"bookmarks"` (data: the array). `main.ts` fills `#bookmark-select` on `bookmarks` and `notebook` events: one option per bookmark, text indented by two spaces per level, value = index; when the current page has a bookmark, a final option `Remove "<title>"` with value `remove:<index>`; `onchange` jumps with `scrollToPage` or removes, then resets the select to the placeholder. Local mode: `exportPdf(base, pages, bookmarks)` in `save`/`saveAs`.

- [ ] **Step 1: Write the failing e2e tests** `tests/e2e/bookmarks.spec.ts`

```ts
test("adding a bookmark lists it and selecting it jumps to the page", …)  // 3-page notebook; addBookmark(2,"Third"); option "Third"; selectOption → currentPage 2
test("bookmarks are saved into the outline and come back on reopen", …)  // readNotebook catalog /Outlines; reload; option still there
test("remove option removes the bookmark on the current page", …)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/bookmarks.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx playwright test tests/e2e/bookmarks.spec.ts tests/e2e/notebooks.spec.ts tests/e2e/local-mode.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/main.ts index.html src/style.css tests/e2e/bookmarks.spec.ts
git commit -m "Bookmarks in the page: toolbar list, add, remove, saved to the outline"
```

### Task 6: Pen menu and finger tap: Open, Edit URL, Add link, Bookmark this page

**Files:**
- Modify: `src/app.ts` (`penMenuItems`, `openPenMenu`, touch pointer handling around `src/app.ts:862-880` and `1066`)
- Test: `tests/e2e/links.spec.ts`, `tests/e2e/bookmarks.spec.ts`

**Interfaces:**
- Produces: `penMenuItems()` starts with, when `menuPoint` is over a link: `{ label: "Open " + shortUrl(url) }` (→ `openLink`), `{ label: "Edit URL…" }` (→ `promptFn("Link URL", url)`; empty/null leaves it; otherwise `setLink(id, { url: normalizeUrl(answer) })`, where `normalizeUrl` prepends `https://` when there is no scheme; a bad scheme shows status `Not a web link: …`), then a separator. After the Delete entry: `{ label: "Add link…", disabled: !selection?.rect }` (→ `promptFn("Link URL", "https://")` → `addLink(sel.page, sel.rect, normalizeUrl(answer))`). After "Add page": `{ label: "Bookmark this page…" }` (→ `promptFn("Bookmark title", todayIso())` → `addBookmark(menuPage, title)`), where `menuPage` is the page under the menu point, else `currentPage`. Finger tap: a touch pointer that goes down and up within 300 ms and 8 px, over a link, while `fingerDraws` is false, calls `openLink`.

- [ ] **Step 1: Write the failing e2e tests**

```ts
test("the pen menu over a link offers Open and Edit URL", …)   // right-click inside the link; menu has "Open example.org" and "Edit URL…"; Edit → dialog prefilled with url; type "example.com/x"; Enter → url "https://example.com/x"
test("Open launches the url in a new tab", …)                    // const popup = page.waitForEvent("popup"); click "Open …"; (await popup).url() === link url
test("a finger tap opens the link, but not in finger-draws mode", …) // window.__stylusSim.tap(cx, cy, { pointerType: "touch" }) → popup; set fingerDraws true → no popup, one stroke added
test("Add link… puts a link on the selection rectangle", …)
test("Bookmark this page… defaults to today's date", …)         // dialog input value matches /^\d{4}-\d{2}-\d{2}$/; Enter; option appears
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/links.spec.ts tests/e2e/bookmarks.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run**

Run: `npm run typecheck && npm run test:e2e`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app.ts tests/e2e/links.spec.ts tests/e2e/bookmarks.spec.ts
git commit -m "Pen menu: Open, Edit URL, Add link, Bookmark this page; finger tap follows links"
```

### Task 7: Bridge and Python calls; journal bookmarks

**Files:**
- Modify: `src/pdfink-api.ts`, `tools/pdfink_page.py`, `tools/tests/test_pdfink_page.py`, `tools/journal-page.py`
- Test: `tests/e2e/pdfink-api.spec.ts`, `tools/tests/test_pdfink_page.py`

**Interfaces:**
- Produces, on `PdfinkApi`:
  ```ts
  links(page?: number): Array<LinkItem & { page: number }>;
  addLink(page: number, rect: Rect, url: string, opts?: { label?: string; space?: "page" | "pdf" }): string;
  setLink(id: string, patch: { url?: string; label?: string }): void;
  bookmarks(): Bookmark[];
  addBookmark(page: number, title: string, opts?: { level?: number }): number;
  removeBookmark(index: number): void;
  ```
  Python: `links(page=None)`, `add_link(page, rect, url, label=None, space="page")`, `set_link(id, url=None, label=None)`, `bookmarks()`, `add_bookmark(page, title, level=0)`, `remove_bookmark(index)`. `journal-page.py`, after a successful transcription with `dates`, when `page` is connected: `if not any(b["title"] == dates[0] and b["page"] == a.page - 1 for b in page.bookmarks()): page.add_bookmark(a.page - 1, dates[0])`.

- [ ] **Step 1: Write the failing tests:** e2e cases in `pdfink-api.spec.ts` for `addLink` with `space: "pdf"` (PDF rect `[300 500 400 550]` on Letter → display `{x:300,y:242,w:100,h:50}`), `setLink`, `bookmarks` round trip; Python test `test_links_and_bookmarks_mirror` asserting the call names and argument shapes sent to the fake server.

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/pdfink-api.spec.ts && uv run --script tools/tests/test_pdfink_page.py`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run**

Run: `npm run typecheck && npm test && npx playwright test tests/e2e/pdfink-api.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pdfink-api.ts tools tests/e2e/pdfink-api.spec.ts
git commit -m "Bridge: links and bookmarks for scripts; journal-page bookmarks its entry"
```

### Task 8: Documentation

**Files:**
- Modify: `README.md` (features list: links and bookmarks; pen-menu section: Open/Edit URL/Add link/Bookmark this page; API section: new `window.pdfink` calls), `docs/design.md` ("What pdfink reads and writes": ink, links, outline; everything else untouched), `pdfink-commands.conf.example` (mention `add_link`/`add_bookmark` in the journal entry comment)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Commit**

```bash
git add README.md docs/design.md pdfink-commands.conf.example
git commit -m "Docs: links and bookmarks"
```
