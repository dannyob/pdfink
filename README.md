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

In either mode, the toolbar also has pen, eraser and rectangle select; pen colour and width; copy, cut, paste; undo, redo; and zoom. New makes a blank Letter PDF.

Saving in server mode:

- Autosave runs 10 seconds after the last change, and when the tab is hidden.
- Before overwriting, the server compares modification times. If something else changed the file, the app asks first.
- Writes go to a temp file and are renamed into place, so a synced folder never sees half a file.

## What it does to your PDF

Each stroke becomes an `/Ink` annotation with an appearance stream and per-point pressure in `PDFTron_Pressure_Thickness` arrays. Ink annotations already in a PDF you open become editable strokes. Other annotations (links, squares) are left alone and cannot be edited.

Pressure is drawn as nominal width x (0.4 + pressure). That is an empirical fit to how Xodo renders, which is the app I write notes in. Mice and fingers draw at nominal width.

To prevent large PDFs, on import, objects unreachable from the trailer are deleted. Xodo saves with incremental updates and keeps every superseded annotation, so one real 300 MB notebook came out at 14 MB with no visible change. `docs/design.md` has the data model and the import, render and export steps.

## Editing

- Pen draws. Eraser end or barrel button erases whole strokes.
- Select drags a rectangle and picks every stroke with a point inside it. Ctrl+C, Ctrl+X and Ctrl+V work on the selection. Delete removes it.
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

## Options

Flags win over environment variables.

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--mode` | `PDFINK_MODE` | `server` | `server` serves the app and API. `browser` serves the app only. |
| `--host` | `HOST` | `127.0.0.1` | Address to listen on. |
| `--port` | `PORT` | `5173` | Port to listen on. |
| `--notebooks` | `NOTEBOOKS_DIR` | `./notebooks` | Folder of PDFs. Created if missing. |
| `--dist` | `DIST_DIR` | `./dist` | Built app to serve. `none` serves the API only. |

To force the app's storage mode, add `?storage=local` or `?storage=server` to the URL, or set `VITE_STORAGE=local|server` at build time.

## API

Server mode only. Names are plain basenames ending in `.pdf`; paths are refused.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/status` | `{ mode, notebooksDir }` |
| GET | `/api/notebooks` | `[{ name, size, mtime }]`, newest first |
| GET | `/api/notebooks/<name>` | PDF bytes. `X-Mtime` header is the modification time in ms. |
| PUT | `/api/notebooks/<name>` | Body is a PDF. `X-If-Mtime: <ms>` must match the file on disk, or be `new` to require that it does not exist. Otherwise 409. |
| GET | `/api/notebooks/<name>/open` | The notebook parsed on the server: stroke data plus the PDF with ink removed. |
| PUT | `/api/notebooks/<name>/save` | Stroke and image data. The server rebuilds the PDF and writes it. Same `X-If-Mtime` rules. |

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
