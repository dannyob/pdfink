# pdfink

pdfink lets you write on a PDF with a stylus in the browser, and saves the ink back into the PDF as standard `/Ink` annotations that other PDF apps can show and edit.

![pdfink toolbar, strokes in different pen widths and colours, and a rectangle selection](docs/screenshot.png)

The pen draws. The pen's eraser end or barrel button erases whole strokes. Fingers scroll. A mouse follows the selected tool, so it works on a desktop too.

It has a small server that keeps a folder of PDFs, and a browser-only mode that needs no server at all. This is the server:

```console
$ node server/index.ts --mode server --port 5198 --notebooks /path/to/notebooks --dist dist
pdfink: http://127.0.0.1:5198/  notebooks=/path/to/notebooks  app=/path/to/pdfink/dist

$ curl -s http://127.0.0.1:5198/api/status
{"mode":"server","notebooksDir":"pdfink-demo-notebooks"}

$ curl -s http://127.0.0.1:5198/api/notebooks
[]
```

(That folder was empty. `notebooksDir` is just the folder's name.) And browser-only mode, where the app opens and saves files on your own device:

```console
$ node server/index.ts --mode browser --port 5199 --dist dist
pdfink: http://127.0.0.1:5199/  browser mode (no notebook API)  app=/path/to/pdfink/dist

$ curl -s http://127.0.0.1:5199/api/status
{"mode":"browser"}
```

The app asks `/api/status` on load and picks its storage to match.

## Install

Node 22.18 or later. The server is TypeScript run directly by Node's built-in type stripping, with no runtime dependencies (I developed on Node 26). The app itself uses pdf.js and pdf-lib. Any current browser works; Chromium has the best file handling in browser-only mode.

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

You can also serve `dist/` from any static host. The toolbar has Open..., New, Save, Save as... and + Page. Chromium writes back to the file you opened through the File System Access API. Other browsers download the result.

In either mode, the toolbar also has pen, eraser and rectangle select; pen colour and width; copy, cut, paste; undo, redo; and zoom. New makes a blank Letter PDF.

### Why a server at all

Opening a 300 MB notebook in a tablet browser does not go well. In server mode the server parses the PDF on open and rebuilds it on save, so the browser only handles a small ink-free base PDF plus stroke data.

Saving in server mode:

- Autosave runs 10 seconds after the last change, and when the tab is hidden.
- Before overwriting, the server compares modification times. If something else changed the file, the app asks first.
- Writes go to a temp file and are renamed into place, so a synced folder never sees half a file.

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

## What it does to your PDF

Each stroke becomes an `/Ink` annotation with an appearance stream and per-point pressure in `PDFTron_Pressure_Thickness` arrays. Ink annotations already in a PDF you open become editable strokes. Other annotations (links, squares) are left alone and cannot be edited.

Pressure is drawn as nominal width x (0.4 + pressure). That is an empirical fit to how Xodo renders, which is the app I write notes in. Mice and fingers draw at nominal width.

On import, objects unreachable from the trailer are deleted. Xodo saves with incremental updates and keeps every superseded annotation, so one real 300 MB notebook came out at 14 MB with no visible change. `docs/design.md` has the data model and the import, render and export steps.

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
- Pasted images are flattened into page content on save. After you reopen the file they are no longer editable.
- Encrypted PDFs are refused.
- On tablets without pen hover, the very first pen contact may scroll instead of draw.
- The pressure mapping is a fit to one app, not a spec.
- It has only been tested seriously on one person's notebooks.

## Development

Two terminals:

```sh
npm run api    # API on 127.0.0.1:5174, no static files
npm run dev    # Vite on 5173, proxying /api to 5174
```

To reach the dev server by another hostname, for example from a tablet, list it in `PDFINK_ALLOWED_HOSTS` (comma-separated). `PDFINK_API` changes the proxy target. `npm run build` type-checks and then writes `dist/`.

On macOS, `deploy/launchd.plist.example` is a launchd job that keeps the server running. Replace the ALL-CAPS placeholders and load it with `launchctl bootstrap`.

## Tests

```sh
npm test                          # Vitest: geometry, PDF round trips, pressure, server API
npx playwright install chromium   # once
npm run test:e2e                  # Playwright
```

The e2e run starts its own API server on port 5176 with a throwaway folder, and Vite on 5175, so it never touches your notebooks. It drives the app with a synthetic stylus, `src/harness/stylus-sim.ts`, which is also exposed as `window.__stylusSim` for use in the devtools console. Set `PDFINK_SAMPLES=/folder` to run extra tests against real sample notebooks.

## License

MIT. See `LICENSE`.
