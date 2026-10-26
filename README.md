# pdfink

[![CI](https://github.com/dannyob/pdfink/actions/workflows/ci.yml/badge.svg)](https://github.com/dannyob/pdfink/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Demo](https://img.shields.io/badge/demo-pdfink.libertyh.dev-brightgreen)](https://pdfink.libertyh.dev/)

PDFink lets you write on a PDF with a stylus in the browser, and saves the ink back into the PDF as standard `/Ink` annotations that other PDF apps can show and edit. It's a good way to quickly make annotations to an uploaded PDF, and then re-export to a local PDF, or annotate a set of PDFs on a remote server. I use it scribble handwritten notes to myself.

**Try it:** <https://pdfink.libertyh.dev/> runs the browser-only build. Open a PDF from your device, write on it, and save it back. Nothing is uploaded or shared beyond your browser. You can use a stylus or a mouse (or your finger).

![pdfink toolbar, strokes in different pen widths and colours, and a rectangle selection](docs/screenshot.png)

PDFink can run as a small server that offers a folder of PDFs stored on the server,
and a browser-only mode that needs no server at all. This is the server:

```console
$ node server/index.ts --mode server --port 5198 --notebooks /path/to/notebooks --dist dist
pdfink: http://127.0.0.1:5198/  notebooks=/path/to/notebooks  app=/path/to/pdfink/dist

$ curl -s http://127.0.0.1:5198/api/status
{"mode":"server","notebooksDir":"pdfink-demo-notebooks"}

$ curl -s http://127.0.0.1:5198/api/notebooks
[]
```

(That folder was empty. `notebooksDir` is just the folder's name.) 

This is browser-only mode, where the app opens and saves files on your own device:

```console
$ node server/index.ts --mode browser --port 5199 --dist dist
pdfink: http://127.0.0.1:5199/  browser mode (no notebook API)  app=/path/to/pdfink/dist

$ curl -s http://127.0.0.1:5199/api/status
{"mode":"browser"}
```

The app asks `/api/status` on load and picks its storage to match.

## Install

Node 22.18 or later. The server is TypeScript run directly by Node's built-in type stripping, with no runtime dependencies (I developed on Node 26). The app itself uses pdf.js and pdf-lib. Any modern, 2026-onwards browser should work.

```sh
npm install
npm run build
```

## Quick start

Server mode is the default:

```sh
npm start -- --notebooks /path/to/folder
```

Open http://127.0.0.1:5173/. The folder is created if it is missing. The toolbar has Open notebook... (a menu of the PDFs in the folder), New, Save, + Page, Import... (copy a PDF from the device into the folder) and Export... (download the current notebook).

Browser-only mode:

```sh
npm start -- --mode browser
```

You can also serve the static HTML/javascript build in `dist/` from any static host. 

The toolbar has Open..., New, Save, Save as... and + Page. Chromium writes back to the file you opened through the File System Access API. Other browsers download the result.

In either mode, the toolbar also has pen, eraser and rectangle select; pen colour and width; copy, cut, paste; undo, redo; zoom; and a Bookmarks… list. New makes a blank Letter PDF.

Saving in server mode:

- Autosave runs 10 seconds after the last change, and when the tab is hidden.
- Before overwriting, the server compares modification times. If something else changed the file, the app asks first.
- Writes go to a temp file and are renamed into place, so a synced folder never sees half a file.

## What it does to your PDF

Each stroke becomes an `/Ink` annotation with an appearance stream and per-point pressure in `PDFTron_Pressure_Thickness` arrays. Ink annotations already in a PDF you open become editable strokes. Web links (`/Link` annotations with a URI action to an `http`, `https` or `mailto` address) become editable link boxes and are written back as `/Link` annotations with the border and colour they came with, and the PDF's outline becomes the bookmark list. Other annotations (links to another page, squares) are left alone and cannot be edited.

Handwriting can carry text (see `tools/ocr-page.py` below). The text is kept in a page entry of pdfink's own, `/PdfinkText`, which is what pdfink reads back. So that other readers can find it, every page with handwriting text also gets the text as the `/Contents` of its first ink annotation (one paragraph per note, notes separated by blank lines), and a notebook page gets an invisible text layer over the ink, so it can be searched, selected and copied in any PDF viewer. A page is a notebook page when it has no text of its own (a blank or ruled page rather than a printed paper); the pen menu's **Notebook** row overrides that for the whole file, and the choice is saved in the file as `/PdfinkNotebook`.

Pressure is drawn as nominal width x (0.4 + pressure). That is an empirical fit to how Xodo renders, which is the app I write notes in. Mice and fingers draw at nominal width.

To prevent large PDFs, on import, objects unreachable from the trailer are deleted. Xodo saves with incremental updates and keeps every superseded annotation, so one real 300 MB notebook came out at 14 MB with no visible change. `docs/design.md` has the data model and the import, render and export steps.

## Editing

- Pen draws. Fingers scroll, except with **finger draws** on (the default on phones and pen-less tablets, switched off as soon as a pen appears): then one finger draws and a second finger scrolls. Eraser end or barrel button erases whole strokes. Many EMR pens don't report their barrel button to the browser; with **barrel button erase** ticked (the default), a pen whose pressure is pinned to exactly 0 while hovering or exactly 1 while touching is taken as a barrel press. Unticked, a barrel press (or a mouse right-click) opens the pen menu instead: three rows of icon tiles (Pen, Eraser, Select; Copy, Cut, Paste, Delete; Undo, Redo), then Add link…, Bookmark this page…, Notebook (see below), Add page and Save, then a **Commands ›** row that opens your pen-menu commands in place, with a Back row at the top; buttons added by attached commands live there too (their toolbar buttons are unchanged), and the row is hidden when there is nothing in it. Every tile and row is 44 px tall and nothing opens on hover. `/stylus-test.html` shows what your pen reports.
- Select drags a rectangle and picks every stroke with a point inside it, and every handwriting text line whose centre is inside it, so the text moves, cuts and pastes with its ink. Ctrl+C, Ctrl+X and Ctrl+V work on the selection. Delete removes it.
- Paste an image from the system clipboard, or drop an image file on the page.
- Dropping a PDF imports it (server mode) or opens it (browser mode).

| Keys | Action |
| --- | --- |
| Ctrl+S | save |
| Ctrl+O | open (browser mode) or import (server mode) |
| Ctrl+Z, Ctrl+Shift+Z | undo, redo |
| Ctrl+=, Ctrl+-, Ctrl+0 | zoom in, zoom out, fit width |
| p, e, s | pen, eraser, select |
| Esc | clear selection |

## Links and bookmarks

A link shows as a faint blue box captioned, when there is room, with its label or URL.

- A short finger tap on a link opens it in a new tab: not while the pen is down or in range, and not with finger draws on.
- Over a link, the pen menu starts with **Open** *url* and **Edit URL…**.
- To make a link, drag a rectangle with Select and pick **Add link…** (the first text row of the pen menu). A URL without a scheme gets `https://`; only `http`, `https` and `mailto` are accepted.
- Select picks up a link whose centre is inside the rectangle, so copy, cut, paste and Delete carry links with the strokes. The eraser leaves links alone; select and delete them instead.
- Adding, editing and deleting links are undo steps.

Bookmarks are the PDF's outline. The toolbar's Bookmarks… list shows them, indented by level; picking one jumps to its page. If the current page has a top-level bookmark, the list ends with Remove "*title*". **Bookmark this page…** (in the pen menu) asks for a title, today's date by default, and files the bookmark in page order. Removing a top-level bookmark removes the entries nested under it too. Bookmark changes are saved with the notebook but are not undo steps; until the outline is changed in pdfink, saving leaves it exactly as the file had it. An outline entry whose page pdfink cannot find is greyed out in the list and saved back as a title with no destination.

## Deep links

In server mode the address bar follows you: `?f=2026-10.pdf#page=3` names the notebook and the page you are looking at, and while something is selected the hash carries the selection too, as `#page=3;x=323pdf;y=400pdf;w=200pdf;h=200pdf` (PDF points, origin bottom-left, the same space pen-menu commands see in `$X`/`$Y`). The URL is rewritten in place as you scroll or select, so Back is not flooded. Opening such a link opens the notebook, scrolls to the page and restores the selection.

## Pen-menu commands

In server mode the pen menu can run your own programs on the notebook. Put a `pdfink-commands.conf` in the notebooks folder (or pass `--commands FILE`), one section per menu item:

```ini
[Draw a star here]
command = uv run --script tools/star.py "$PDF" "$PAGE" "$X" "$Y"
reload = true
```

The notebook is saved first, then the command runs under `sh -c` in the config file's folder with the notebook and the pen position in its environment: `$PDF` (path), `$NAME`, `$NOTEBOOKS`, `$PAGE` (1-based), `$PAGES`, `$X` and `$Y` in PDF points with the origin at the bottom left (rotation accounted for), `$DX`/`$DY` in top-left display points, `$PAGE_WIDTH`, `$PAGE_HEIGHT` and `$ROTATE`. Flags: `reload` reopens the notebook afterwards at the same zoom and scroll, `confirm` asks first, `timeout` is in seconds (default 60; 0 means no timeout, the default for detached commands), and `detach` lets the command keep running after the menu returns (see below). The file is re-read every time the menu opens. The first line of the command's output shows in the status bar.

Commands run headless. On macOS that means they must not touch Desktop, Documents or Downloads (or anything symlinked into them): the system gates those folders behind a consent dialog, the server's child has no screen to show it on, and the open call hangs until the command times out. Keep scratch files under `~/.cache` or the notebooks folder.

`tools/star.py` is the demo: it stamps a small star at the pen tip as an `/Ink` annotation, so after the reload pdfink treats it as a stroke you can select or erase. It needs only [uv](https://docs.astral.sh/uv/), which fetches pypdf from the script's inline metadata. `tools/journal-page.py` is a second, longer one: it extracts the page, has a vision model (through [llm](https://llm.datasette.io/)) transcribe the entry as markdown under a `## YYYY-MM-DD` heading read from the page itself, and then runs `claude -p` in a [life](https://github.com/dannyob/life) directory to file it in that day's journal. Run from the pen menu, it also bookmarks the page it started from with the entry's date. `--dry-run` prints the markdown instead, and bookmarks nothing. `tools/timestamp.py` writes a diary timestamp at the pen tip: a small red chevron, then the date and time in ink, and a bookmark titled with the same date and time. `journal-page.py` takes an entry's date from such a bookmark, and keeps the stamp's time in the transcript. `pdfink-commands.conf.example` has more.

### Talking to the page

While a command runs it can talk to the browser tab it was started from: read the selection, take a PNG of it, ask a question, draw strokes, show progress. These variables join the ones above:

| Variable | Meaning |
| --- | --- |
| `SELECTED` | Number of selected items (strokes, images and links); empty when nothing is selected. |
| `SEL_PAGE` | Page of the selection, 1-based; empty without one. |
| `SEL_X`, `SEL_Y`, `SEL_W`, `SEL_H` | The selection's bounding box in PDF points, origin bottom-left; empty without one. |
| `PDFINK_SOCKET` | A Unix socket that relays requests to the page. |
| `PDFINK_RUN` | This run's identifier. |

The socket speaks newline-delimited JSON. Each request names a function of `window.pdfink` (listed in `src/pdfink-api.ts`, which is the supported API) and gets back `{"id":…,"result":…}` or `{"id":…,"error":…}`; `{"id":…,"eval":"js"}` evaluates any JavaScript in the page, as an escape hatch. From the shell:

```sh
printf '{"id":1,"call":"toast","args":["hello from sh"]}\n' | nc -U "$PDFINK_SOCKET"
```

From Python, `tools/pdfink_page.py` wraps it, using only the standard library:

```python
import pdfink_page
page = pdfink_page.connect()
sel = page.selection()
page.toast(f"{len(sel['strokeIds'])} strokes selected" if sel else "nothing selected")
```

The module sits next to the uv scripts in `tools/`; a script there finds it by adding its own directory to `sys.path` before the import (`sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))`). Its methods are the `window.pdfink` ones in snake_case, plus `call(name, *args)`, `eval(js)` and `events(*names)` for page events such as `selection`, `notebook`, `button`, `ink` and `bookmarks` (sent with the new list whenever it changes). `connect()` raises `PageGone` when there is no socket to talk to; `connect(optional=True)` returns `None` instead when `$PDFINK_SOCKET` is unset, for scripts that can also work on the file alone. Any call that waits for a reply can raise `PageGone` if the page goes away mid-run. A call the page rejects raises `PageError`.

Links and bookmarks have their own calls. Pages are 0-based here, unlike `$PAGE`.

| Call | What it does |
| --- | --- |
| `links(page?)` | Links on one page or all of them: `{ id, x, y, w, h, url, label?, page }`, in page space. |
| `addLink(page, rect, url, { label?, space? })` | Adds a link box as one undo step and returns its id. `space: "pdf"` takes the rect in PDF points, origin bottom-left. A URL that is not `http`, `https` or `mailto` fails with "bad url". |
| `setLink(id, { url?, label? })` | Changes a link as one undo step; an empty label removes it. |
| `bookmarks()` | The outline in order: `{ title, page, level }`, `page` null when it could not be resolved. |
| `addBookmark(page, title, { level? })` | Adds an entry in page order, after any deeper entries nested under the one it follows, and returns its index. |
| `removeBookmark(index)` | Removes an entry and the entries nested under it. |

In Python: `links(page=None)`, `add_link(page, rect, url, label=None, space="page")`, `set_link(id, url=None, label=None)`, `bookmarks()`, `add_bookmark(page, title, level=0)` and `remove_bookmark(index)`.

Handwriting text, strokes and the notebook tag have calls too. A handwriting text line is `{ id, x, y, w, h, text, sig?, note? }` in page space: `sig` fingerprints the strokes it was read from, and lines with the same `note` number form one paragraph.

| Call | What it does |
| --- | --- |
| `pageText(page)` | `{ own, ink, notebook }`: the document's own text as `{ text, x, y, w, h }` runs, the handwriting text, and whether the page saves as a notebook page (with an invisible text layer). |
| `inkText(page)` | The page's handwriting text. |
| `setInkText(page, lines, { space?, quiet?, within? })` | Replaces the page's handwriting text with `lines` (each without `id`) and returns the new ids. With `within`, only texts whose centre is inside that rect are replaced. `space: "pdf"` takes the lines and `within` in PDF points, origin bottom-left. One undo step, or none with `quiet`. A line with a non-finite number, non-string text or a `note` that is not a whole number ≥ 0 fails. |
| `strokes(page, { space? })` | The page's strokes: `{ id, points: [{ x, y, p }], color, width, opacity }`, in page space or, with `space: "pdf"`, PDF points. |
| `notebookTag()` | The file's notebook tag: `true`, `false`, or `null` when each page decides (a page with no text of its own is a notebook page). |
| `setNotebookTag(v)` | Sets the tag (`true`, `false` or `null`); not an undo step. |

The `ink` event, `{ page, sig }`, fires when a page's strokes change, and for every page when a document opens. `sig` is a short fingerprint of that page's strokes (their points rounded to 0.1 pt, in any order): it changes when the strokes do and stays the same across a reload of an unchanged file, so a listener can skip pages whose ink it has already seen without fetching their strokes. In Python: `page_text(page)`, `ink_text(page)`, `set_ink_text(page, lines, space="page", quiet=False, within=None)`, `strokes(page, space="page")`, `notebook_tag()` and `set_notebook_tag(value)`.

The demos use it. `tools/star.py` draws its star in the browser as one undoable stroke, and falls back to rewriting the file when there is no page, which is why its entry keeps `reload = true`. `tools/describe-selection.py` sends a PNG of the selection (or of the page, when nothing is selected) to a vision model and offers the answer in a dialog. `tools/journal-page.py` shows each stage as a progress line, asks for the date when it cannot read one off the page, and bookmarks the page with that date unless the same bookmark is already there.

`tools/ocr-page.py` turns a page's handwriting into text the PDF carries, so it can be searched and copied. It groups the strokes into lines (`tools/ink_lines.py`), renders the page with a small red number beside each line, asks a vision model what each numbered line says, and sets the answers with `set_ink_text`, one text item per line over its ink. Each line is fingerprinted by its shape, so a later run sends only lines that are new or redrawn, and the rest (moved ones too) keep their text; if the model fails or its answer is unusable, the text is left alone and the command exits 1; `--all` sends every line, and with a selection only the lines inside it are read and only the texts inside it replaced. `--dry-run` prints the numbered lines without calling the model. `ink_lines.py` decides what a line is: dashes, underlines, arrows and long arcs to a note are set aside, small marks such as the dot or hook of a `?` join the line they belong to, and lines stacked closely form a note (a paragraph in `/Contents`). Its thresholds are named constants at the top of the file. The model is `--model`, else `$PDFINK_OCR_MODEL`, else the same default as the other tools.

`ocr-page.py --watch` is the automatic version, for a `detach = true` entry (`[Recognise handwriting automatically]` in the example config). It subscribes to `ink` and `page` events and reads a page once its ink has been still for `--quiet` seconds (default 20) after its lines change, or once you have stayed for 3 seconds on a page, including the one in view when it starts, that has lines without text; scrolling past pages reads none of them. Opening or reloading a document fires `ink` for every page, but that reads nothing by itself: the watcher compares each event's `sig` with what it last saw for that page and fetches strokes only when it differs (then comparing the page's line fingerprints), so a reload of an unchanged notebook costs nothing and existing ink is read one page at a time as you stop on it. It reads one page at a time and queues the rest, sets the text as quiet updates (no undo step), and shows only a `Reading page N…` progress line while busy. If a page fails, for whatever reason, the error goes to stderr and that page waits for new ink before it is tried again. It exits when you dismiss its chip or the tab goes away. Other commands keep working alongside it, since each run has its own socket.

A normal run is never killed because its page went away; its requests just fail with "page gone" until the page returns. A `detach = true` command answers the menu at once and keeps going, with a chip in the toolbar and no timeout unless one is set. It ends when it exits, when you dismiss its chip, when you switch to another notebook, five seconds after its tab closes (a refresh reconnects in time and keeps it), when its session has had no page for ten minutes, when it times out, or when the server stops. Starting the same detached command again from the same tab replaces the old run.

## Options

Flags win over environment variables.

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--mode` | `PDFINK_MODE` | `server` | `server` serves the app and API. `browser` serves the app only. |
| `--host` | `HOST` | `127.0.0.1` | Address to listen on. |
| `--port` | `PORT` | `5173` | Port to listen on. |
| `--notebooks` | `NOTEBOOKS_DIR` | `./notebooks` | Folder of PDFs. Created if missing. |
| `--dist` | `DIST_DIR` | `./dist` | Built app to serve. `none` serves the API only. |
| `--commands` | `PDFINK_COMMANDS` | `<notebooks>/pdfink-commands.conf` | Pen-menu commands file. `none` disables the menu's commands. |

To force the app's storage mode, add `?storage=local` or `?storage=server` to the URL, or set `VITE_STORAGE=local|server` at build time.

## API

Server mode only. Names are plain basenames ending in `.pdf`; paths are refused.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/status` | `{ mode, notebooksDir }` |
| GET | `/api/notebooks` | `[{ name, size, mtime }]`, newest first |
| GET | `/api/notebooks/<name>` | PDF bytes. `X-Mtime` header is the modification time in ms. |
| PUT | `/api/notebooks/<name>` | Body is a PDF. `X-If-Mtime: <ms>` must match the file on disk, or be `new` to require that it does not exist. Otherwise 409. |
| GET | `/api/notebooks/<name>/open` | The notebook parsed on the server: stroke, link and bookmark data plus the PDF with ink and web links removed. |
| PUT | `/api/notebooks/<name>/save` | Stroke, image, link and bookmark data. The server rebuilds the PDF and writes it; without bookmarks the outline is left alone. Same `X-If-Mtime` rules. |
| GET | `/api/commands` | `[{ id, label, reload, confirm, detach }]` from the commands file, re-read each time. |
| POST | `/api/commands/<id>` | Body `{ name, page, x, y, session?, selection? }` (pages 0-based, coordinates in display points). Runs the command; returns its run id, exit status, output, and whether the file changed. A detached command answers at once with `detached: true`. |
| GET | `/api/page?session=<id>` | WebSocket upgrade: the page's end of the command bridge (see `server/bridge.ts`). |

## Limits

- No authentication. Anyone who can reach the server can read, write and overwrite every PDF in the folder. Bind it to `127.0.0.1`, and if other devices need it, put a VPN or an authenticating proxy in front.
- PDFs are rewritten to save space -- PDFink may mangle your PDFs! Make backups!
- Pasted images are flattened into page content on save. After you reopen the file they are no longer editable.
- Encrypted PDFs are refused.
- On tablets without pen hover, the very first pen contact may scroll instead of draw.
- The pressure mapping is a fit to one app, not a spec.
- It has only been tested seriously on one person's PDFs.

## Development

Two terminals:

```sh
npm run api    # API on 127.0.0.1:5174, no static files
npm run dev    # Vite on 5173, proxying /api to 5174
```

To reach the dev server by another hostname, for example from a tablet, list it in `PDFINK_ALLOWED_HOSTS` (comma-separated). `PDFINK_API` changes the proxy target. `npm run build` type-checks and then writes `dist/`.

On macOS, `deploy/launchd.plist.example` is a launchd job that keeps the server running. Replace the ALL-CAPS placeholders and load it with `launchctl bootstrap`.

### Publishing the browser-only build

`npm run deploy` builds the bundle with local storage baked in (no server, no `/api` calls) into `dist-local/` and rsyncs it to any static web host. Copy `deploy.env.example` to `deploy.env` and set the rsync destination, the ssh command if the host needs a port or key, and optionally the public URL to check afterwards. `deploy.env` is gitignored. This is how <https://pdfink.libertyh.dev/> is built.

## Tests

```sh
npm test                          # Vitest: geometry, PDF round trips, pressure, server API
npx playwright install chromium   # once
npm run test:e2e                  # Playwright
```

The e2e run starts its own API server on port 5176 with a throwaway folder, and Vite on 5175, so it never touches your notebooks. It drives the app with a synthetic stylus, `src/harness/stylus-sim.ts`, which is also exposed as `window.__stylusSim` for use in the devtools console. Set `PDFINK_SAMPLES=/folder` to run extra tests against real sample notebooks.

## Original Prompt

Claude Fable 5.1 pretty much one-shotted this. Here was my original instruction:

"I annotate PDFs and handwrite notes on a Daylight DC-1 using a stylus and
[Xodo Mobile](https://xodo.com/mobile-apps). Take look at the PDFs I've been
writing with a stylus that end up as output in my notebooks directory and see
if you can write a full webapp that will allow me to do the same in a browser,
generating the same kind of output into a PDF. You don't need to support
much more than write with stylus, erase with stylus eraser, select
rectangle, copy from selected rectangle, cut (delete) selected rectangle,
and paste (either image or from the area copied from before). Maybe create
new PDF page, and add new PDF page (letter size is fine for now). Take a
look at the stylus detection/writing in the
[almnck/assets/js/pen-marginalia.js](https://code.almnck.com/Almanack/almnck/src/branch/main/assets/js/pen-marginalia.js)
to get an idea of what browser events should be detected; use these event
to write a test harness to simulate writing with a stylus so you can see if
the webapp works. Write in typescript. The idea here, to be clear, is
something that will let me load up a PDF in the browser, scribble notes,
and then write it back out with the notes included in the new PDF. I'd like
you to keep working on this until it's done."

## License

MIT. See `LICENSE`.
