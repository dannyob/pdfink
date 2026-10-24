# pdfink — design note (2026-10-19)

Browser app for scribbling on PDFs with a stylus and writing the result back out
as a PDF, in the same shape that the author's notebook exports (Xodo on a
Daylight DC-1 tablet) use.

## What the notebook exports look like

- Letter pages (612 x 792 pt), empty page content.
- Each handwritten blob is a `/Ink` annotation: `/InkList` of polylines in PDF
  user space, `/C` stroke colour, `/BS /W` width, `/CA` opacity, plus an
  `/AP /N` appearance stream (form XObject) that draws the strokes.
- Other annotations (`/Square`, `/Link`) appear occasionally.

## Approach

- **Model**: per page, a list of strokes (points in page space: points, origin
  top-left, y down), a list of pasted images and a list of link boxes; per
  document, a flat list of bookmarks (title, 0-based page or null, level).
  Page geometry comes from the PDF crop box and `/Rotate`.
- **Import** (pdf-lib): load bytes, pull every `/Ink` annotation into the
  stroke model and every URI `/Link` into the link list, strip those
  annotations, read the outline, and keep the stripped bytes as the "base".
  Other annotations are left in place so pdf.js still shows them.
- **Render** (pdf.js): each page is a pdf.js canvas (base) plus an ink canvas
  (strokes, images, selection). Pages render lazily as they scroll into view.
- **Export** (pdf-lib): load the base bytes, write each stroke back as an
  `/Ink` annotation with an appearance stream (one stroked segment per step
  when pressure varies) and a `PDFTron_Pressure_Thickness` array; add each
  link as a `/Link` with a URI action (keeping the border and colour it was
  imported with); draw pasted images into page content; and, only when the
  bookmarks were changed since the file was opened, replace `/Outlines` with
  the bookmark list (otherwise the base's outline is kept as it is).
- **Two storage modes.** Browser-only: import and export run in the browser;
  files come from and go to the device (File System Access API or download).
  Server: `server/index.ts` keeps a folder of PDFs; it parses on open (and
  sweeps unreferenced objects left by incremental updates) and rebuilds on
  save, so the browser only ever handles the small ink-free base plus stroke
  data. Saves check the file's mtime first and write atomically.
- **Input**: Pointer Events. Pen draws; pen eraser (buttons & 32) or barrel
  button (buttons & 2) erases whole strokes; touch scrolls; mouse follows the
  toolbar tool so the app is usable on a desktop too. Touch-action is switched
  off while a pen is near (same trick as almnck's pen-marginalia.js).
- **Tools**: pen, eraser, rectangle select; copy / cut / paste (strokes, or an
  image from the system clipboard); undo / redo; new document; add page.
- **Harness**: `src/harness/stylus-sim.ts` synthesises pen PointerEvents so
  Playwright can "write" on the page; e2e tests draw, erase, select, cut,
  paste, export, and then parse the exported PDF to check the ink came out.

## What pdfink reads and writes

Three things round-trip through the model: ink (`/Ink` annotations), web
links (`/Link` annotations whose action is `/URI`), and the outline. Every
other PDF structure stays in the base untouched: other annotations,
including `/GoTo` and named-destination links, page content, forms, and the
rest of the catalog.

- **Links** (`src/pdf/links.ts`): only `http`, `https` and `mailto` URLs are
  read; a URI link with any other scheme stays in the base as it was. Export
  writes each link with a fresh `/Rect`, `/URI` (UTF-8 when not plain ASCII)
  and its label as `/Contents`, and skips any URL with another scheme.
- **Outline** (`src/pdf/outline.ts`): read depth-first, following `/First`
  and `/Next` (`/Count` ignored, cycles cut), into title, page and level. A
  destination may be an explicit array, a name in `/Dests` or the `/Names`
  tree, or a GoTo action. On save the whole outline is rebuilt from the list:
  nested by level (a jump of more than one level nests under the entry
  before), titles as UTF-16 hex strings, every item open, each destination
  the top of its page (`/XYZ null null null`). An entry whose destination
  could not be resolved to a page in this document (a remote or launch
  action, a missing name) is kept title-only, with no destination. An empty
  list removes `/Outlines`; a save that sends no list leaves the file's
  outline alone.

## Pressure

Per-point pressure is kept through import, rendering and export. Drawn width
is nominal width × (0.4 + pressure); 0.6 gives the nominal width and is what
mice and fingers use. The factor was fitted against Xodo's own appearance
streams, measured in a rasterised page.

## Page bridge

Pen-menu commands can drive the open page while they run. `server/bridge.ts`
holds two kinds of socket and relays between them.

- **Run sockets**: each command run gets a fresh Unix socket (mode 0600, in a
  0700 folder under the system temp directory), passed to it as
  `$PDFINK_SOCKET`. Clients speak newline-delimited JSON: `call` a page
  function, `eval` JavaScript, or `subscribe` to page events.
- **Page WebSocket**: each browser tab opens `/api/page?session=<id>`; the
  session id lives in `sessionStorage`, so it survives a reload. A session has
  at most one page: a newer one closes the older with code 4001, and a tab
  closed that way (a duplicated tab that copied the id) picks a fresh id.
- **Relay**: the server rewrites each request's id to
  `<connection>:<client id>` and tags it with the run, so replies go back to
  the connection that asked; page events fan out to subscribers on the
  session. With no live page a request is answered at once with "page gone".
- **Page API**: requests land on `window.pdfink` (`src/pdfink-api.ts`), a thin,
  documented layer over the app and its dialogs; `eval` reaches everything
  else. `src/bridge-client.ts` is the page's end and draws the chips for
  detached runs.
- **Lifetimes**: a normal run belongs to its HTTP request and is never killed
  for want of a page. A detached run ends on dismiss, on a switch to another
  notebook, 5 s after the page says goodbye (a refresh reconnects inside
  that and keeps it), after 10 minutes with no page for its session, on its
  timeout, or at server shutdown; a new run of the same detached command
  from the same session replaces it. Before a kill its connections get an
  `exit` event. On reconnect the server replays `started` for every live run
  of the session, so the page drops chips for runs that ended while it was
  away.

## Non-goals (for now)

- Editing other annotations, text, forms.
- Moving a selection by dragging (cut + paste covers it).
