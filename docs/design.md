# pdfink — design note (2026-10-19)

Browser app for scribbling on PDFs with a stylus and writing the result back out
as a PDF, in the same shape that the author's notebook exports (Xodo on a
Daylight DC-1 tablet) use.

## What the notebook exports look like

- Letter pages (612 x 792 pt), empty page content.
- Each handwritten blob is a `/Ink` annotation: `/InkList` of polylines in PDF
  user space, `/C` stroke colour, `/BS /W` width, `/CA` opacity, plus an
  `/AP /N` appearance stream (form XObject) that draws the strokes.
- Other annotations (`/Square`, `/Link`) appear occasionally and are left alone.

## Approach

- **Model**: per page, a list of strokes (points in page space: points, origin
  top-left, y down) and a list of pasted images. Page geometry comes from the
  PDF crop box and `/Rotate`.
- **Import** (pdf-lib): load bytes, pull every `/Ink` annotation into the
  stroke model, strip those annotations, keep the stripped bytes as the "base".
  Non-ink annotations are left in place so pdf.js still shows them.
- **Render** (pdf.js): each page is a pdf.js canvas (base) plus an ink canvas
  (strokes, images, selection). Pages render lazily as they scroll into view.
- **Export** (pdf-lib): load the base bytes, write each stroke back as an
  `/Ink` annotation with an appearance stream (one stroked segment per step
  when pressure varies) and a `PDFTron_Pressure_Thickness` array; draw pasted
  images into page content.
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

## Pressure

Per-point pressure is kept through import, rendering and export. Drawn width
is nominal width × (0.4 + pressure); 0.6 gives the nominal width and is what
mice and fingers use. The factor was fitted against Xodo's own appearance
streams, measured in a rasterised page.

## Non-goals (for now)

- Editing non-ink annotations, text, forms.
- Moving a selection by dragging (cut + paste covers it).
