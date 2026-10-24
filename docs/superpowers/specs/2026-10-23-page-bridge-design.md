# Page bridge: pen-menu commands that talk to the page, plus links and bookmarks

Status: for Danny's approval, 2026-10-23. Reviewed once by a fresh builder; the
"Calls made after review" section records what that settled.

## Intent

Pen-menu commands today are fire-and-forget: the server runs a shell line with
the pen point in its environment, waits for it to exit, and shows the first
line of output. That is enough for "draw a star here" and "journal this page",
and not enough for what Danny wants next: commands that act on the current
selection, commands that look at what is on the page, ask a question, add a
button, stream progress, and in a few cases stay attached and react to what
happens on the page over time.

The shape he chose: the browser is the UI and the state, scripts (mostly uv
Python) are the logic, and the two talk over a live line. The server hands
each command a local Unix socket; whatever the command writes there is relayed
to the page that opened the menu, evaluated in the page's JavaScript context,
and the answer comes back on the socket. A small Python library wraps the
socket so a script reads like `png = page.selection_png()`.

Because the line is live, the command pulls exactly the data it needs when it
needs it. There is no JSON blob on stdin and no per-command "selection detail"
flag in the config; that was considered and dropped.

While talking it through, two more things came up and were taken into this
round. First, commands should be able to put ink and images on the page
through the browser instead of rewriting the PDF and reloading, so that an
attached command can react to strokes without churn and its work is undoable.
Second, pdfink should gain its first non-ink structures: clickable URL boxes
(`/Link` annotations) and bookmarks (the document outline), both readable,
writable, visible in the page, and reachable from the bridge, so a script can
leave a link next to a note or bookmark the page it just transcribed. FreeText
and file attachments were considered and left for later.

This is two pieces of work sharing one transport. Part A is the bridge and
browser-side insertion; Part B is links and bookmarks. A is built first; B
depends on A only for its bridge calls and can follow in the same plan.

## Goals

- A command can learn what is selected (rectangle, strokes, a rendered PNG of
  the region) and what else the page knows, on demand.
- A command can show things in the page: a status message, a progress line,
  a question with a text answer, a yes/no, a pick from a list, an extra
  button.
- A command can change the page: select, change tool, save, reload, add a
  page, undo.
- Most commands end when done and the menu reports their result, as now.
  Some may stay attached (`detach = true`), receive page events, and keep
  acting until their page goes away or Danny dismisses them.
- Shell one-liners keep working with the flat `$PDF $PAGE $X $Y` variables
  and can also talk to the page with `nc -U`.
- Existing config files and the two shipped tools keep working unchanged.

## Non-goals

- Browser-only mode gets no bridge. There is no server to relay through; the
  page's `window.pdfink` API still exists there for the console.
- No remote (non-loopback) command execution, no authentication layer beyond
  what the server already has. The trust boundary is unchanged: whoever can
  edit `pdfink-commands.conf` and reach the server can already run anything.
- No general plugin system in the browser (no loading of script files into
  the page). Commands drive the page from outside through the bridge.
- No binary framing. A PNG travels base64 inside JSON; selections are small.

## Anti-goals

- A command must never be able to hang the page or the server. A dead page,
  a dead command, a reload mid-conversation, and a command that never reads
  its replies all have to be handled and leave the page usable.
- No new place for data to leak into the repo or onto disk under Desktop,
  Documents or Downloads (see the headless-command trap in `README.md`).
- Scripts must not have to depend on `App` internals. Everything a script
  needs routinely is in the stable `window.pdfink` API; raw eval is an escape
  hatch, not the documented path.

## Constraints

- Server mode only (the notebooks folder on the machine running the server).
  The server is plain Node `http`; Node has no server-side WebSocket, so one
  has to be added (see "Left to the builder").
- In development the page is served by Vite on one port and proxies the API
  to the Node server on another (`PDFINK_API`); the WebSocket path must go
  through that proxy (`ws: true`). In production on the server host the page reaches
  the server through Tailscale Serve, which forwards WebSockets.
- Commands run as children of a launchd service with a minimal PATH and no
  screen. Sockets and temp files go under `os.tmpdir()`.
- `npm test` and `npm run test:e2e` stay green; the e2e Playwright server
  already runs with a fixture commands file.
- The repo is public: no hostnames, paths or keys from the production machine in code, docs
  or fixtures.

## Approaches considered

1. **Unix socket per command, relayed by the server to the page's WebSocket.**
   Chosen. Python needs only the standard library; shell scripts can use
   `nc -U`; the server already has to own command lifetime (timeouts,
   process-group kill) and now owns the connection lifetime too. Cost: one
   relay hop and a routing table inside the server.
2. **Command connects straight to the server's WebSocket.** No relay, but
   every script needs a websocket library, the Python wrapper gains a
   dependency, shell access is gone, and the page-side WebSocket is needed
   either way. Dropped.
3. **Rich JSON on stdin and an instruction protocol on stdout**, executed by
   the page after the command exits. No interactivity, no attached commands,
   no questions mid-run. Dropped; it works against the reason for the
   feature.

## Design

### 1. Page to server: one WebSocket per tab

- The page opens a WebSocket to `/api/page?session=<id>` whenever it is in
  server mode. The session id is random, created once per tab and kept in
  `sessionStorage`, so a browser refresh comes back as the same session.
  (`reload = true` and `pdfink.reload()` are the in-app reopen,
  `reloadNotebook()`; they never drop the socket.) Reconnect with backoff; a
  connection drop does not disturb editing. A closing tab sends `{"bye":true}`
  from `pagehide` when it can.
- Messages both ways are JSON text frames.
- The command POST (`/api/commands/<id>`) body gains `session` (the id,
  optional so an old page still runs bridge-less commands) and `selection`
  (`{page, rect}` in display points, or null; the selection may be on a
  different page from the menu point), so the server can route the command's
  socket to that page and fill the selection environment variables.

### 2. Server to command: a Unix socket per run

- For each run the server creates `<os.tmpdir()>/pdfink/<run-id>.sock`
  (directory and socket mode 0700/0600) and sets `PDFINK_SOCKET` to its path
  and `PDFINK_RUN` to the run id. The socket is removed when the run ends.
- Protocol on the socket: newline-delimited JSON, one object per line.
  Several clients may connect to the same socket during a run (a script and
  a `nc` one-liner, say); each request carries its own `id` and the reply
  goes back on the connection that asked.
- If `PDFINK_SOCKET` is missing (browser mode, or the script run from a
  shell for testing), the Python library raises a clear error on connect,
  and offers `pdfink.connect(optional=True)` returning `None` so scripts can
  degrade to printing.

### 3. The messages

Command to page, relayed verbatim by the server with the run id attached:

| Message | Meaning |
|---|---|
| `{"id":1,"call":"selection_png","args":[{"scale":3}]}` | Call a `window.pdfink` method. |
| `{"id":2,"eval":"app.scale"}` | Evaluate JavaScript with `pdfink` and `app` in scope; the result is awaited if it is a promise. |
| `{"subscribe":["selection","save","button"]}` | Ask for page events on this connection. |

Page to command:

| Message | Meaning |
|---|---|
| `{"id":1,"result":...}` | Return value, JSON-serialised (non-serialisable values become their string form). |
| `{"id":1,"error":"..."}` | The call threw or the method does not exist. |
| `{"event":"selection","data":{...}}` | A subscribed event. |
| `{"event":"gone"}` | The page disconnected and did not come back within the grace period; further requests get errors. |

Server to page, alongside the relayed requests: `{"run":"<id>","started":{label}}`
and `{"run":"<id>","exited":{status,signal}}` so the page can show and clear an
attached-command indicator.

### 4. The page API: `window.pdfink`

A stable object created in `main.ts` (replacing the test-only `__pdfink`
alias with a documented one; keep `__pdfink` and `__stylusSim` for the
harness). Methods, all returning plain JSON-able values:

- Inspect: `state()` (today's `getState()`), `notebook()` (`{name, pages,
  page, dirty}`), `selection()` (`{page, rect, pdfRect, strokeIds, imageIds}`
  or null; `rect` is the rectangle handed to commands: the union of the
  marquee and the bounds of the selected strokes and images, so nothing
  selected is cropped; `marquee` and `bounds` are also given separately;
  all in page points, top-left origin, with `pdfRect` the same union in PDF
  points, bottom-left origin), `selectionInk()` (the selected strokes with points, pressure,
  colour and width, in page points), `selectionPng({scale})` (base64 PNG of
  the selected region as the page shows it: page background and ink; the
  existing clipboard renderer is the starting point), `pagePng(page, {scale})`.
- Show: `toast(message)` (status bar, as today's first-line-of-output),
  `progress(message | null)` (a persistent line while a command works, cleared
  with null and on exit), `ask(message, {default})` → string or null,
  `confirm(message)` → boolean, `choose(message, options)` → the chosen
  option or null, `addButton(id, label, {where})` / `removeButton(id)`
  (pressing a button emits a `button` event with the id; buttons of a run
  are removed when it exits; `where` is `"menu"`, an entry in the pen menu
  below the commands, which is the default because that is where the pen
  already is, or `"toolbar"`, a button in the header bar).
- Act: `select(page, rect)`, `clearSelection()`, `setTool(tool)`, `save()`,
  `reload()`, `undo()`, `redo()`, `addPage()`, `scrollToPage(page)`.
- Insert and remove (Part A): `addStrokes(page, strokes, {space})` with
  strokes as point lists carrying pressure, colour, width and opacity, in
  page points by default or PDF points with `space: "pdf"`; `addImage(page,
  png, rect)` with a base64 PNG, the path paste already uses, and also how a
  script puts text on the page (render it to an image first; pdfink has no
  text item); `removeItems(ids)` for strokes, images and links. All three go
  through the page model like a pen stroke: drawn at once, one undo entry,
  saved by the normal autosave, never racing the file.
- Links and bookmarks (Part B): `links(page?)`, `addLink(page, rect, url,
  {label, space})`, `bookmarks()`, `addBookmark(page, title, {level})`,
  `removeBookmark(index)`.
- Events available to `subscribe`: `selection` (changed or cleared), `save`,
  `page` (the page under the pen changed), `notebook` (the tab opened a
  different notebook), `button`, `stroke` (a stroke finished; data is the
  stroke in page points), `exit` (the server is about to end this run; sent
  just before SIGTERM).

Dialogs (`ask`, `confirm`, `choose`) are in-page elements that work with a
stylus and on iOS, not `window.prompt`. Only one dialog shows at a time;
a second request queues.

### 4b. Part B: links and bookmarks in the model and the file

Links:

- A third item kind, `LinkItem {id, x, y, w, h, url, label?}` in page space,
  in `PageModel.links`, with the wire format, undo snapshots, copy/cut/paste
  and selection membership extended to match. A link's rectangle selects
  like an image's.
- Import lifts `/Link` annotations whose action is `/URI` into items and
  removes them from the base, exactly as ink is lifted. Links with other
  actions (internal `GoTo`, named destinations) stay in the base untouched.
- Export writes each link back as a `/Link` annotation with `/A << /S /URI
  /URI (url) >>`, `/Border [0 0 1]`, `/C [0 0 1]` and `/Contents` set to the
  label, so Xodo and other readers show and open it.
- The page draws links itself (pdf.js draws nothing for a bare `/Link`): a
  faint blue outline, with the label or a shortened URL as a small caption
  when the box is big enough. The pen writes over links freely.
- Following a link (my call, not yet tried on the Daylight): the pen menu
  opened over a link gets an "Open <url>" entry at the top; a finger tap on a
  link opens it in a new tab (a finger tap is never a stroke, and finger-draws
  mode shows the entry in the menu instead). Links open with
  `noopener,noreferrer`.
- Creating one by hand: the pen menu gets "Add link…" when there is a
  selection, asking for the URL with the in-page dialog and placing the box
  on the selection rectangle. Scripts use `addLink`.

Bookmarks:

- A document-level list `bookmarks: {title, page, level}[]`, flat with a
  nesting level, in the document model and the wire format. One level is
  all pdfink's UI creates; deeper outlines in a base PDF survive the round
  trip.
- Import walks `/Outlines` (`First`/`Next`/`Count`, destinations given
  directly or through `GoTo` actions, named destinations resolved where
  possible) into the list; entries whose destination cannot be resolved are
  kept with `page: null` and written back unchanged. Export rebuilds
  `/Outlines` from the list; pdf-lib has no outline API, so the dictionaries
  are built by hand. Page-level `/Dest` arrays use `/XYZ null null null` so
  readers keep their zoom.
- UI (my call): a "Bookmarks" select in the toolbar lists them and jumps on
  pick; the pen menu gets "Bookmark this page…", which asks for a title with
  today's date in ISO form as the default. Removing is through the select's
  "Remove this bookmark" entry while on a bookmarked page.
- `journal-page.py`, when the bridge is present, adds a bookmark named for
  the entry's date at the page it transcribed, if none is there already.

### 5. Lifecycle

- `detach = false` (default): unchanged. The HTTP response arrives when the
  process exits, with stdout, stderr, exit status, `changed` and `reload`.
  The bridge is available for the whole run, so a normal command can still
  ask questions and show progress before it exits. `timeout` as today.
- A normal run is never ended because its page went away: `journal-page.py`
  must finish even when the tablet is put down and the tab suspended. Bridge
  requests from a run whose page is gone get `{"error":"page gone"}`.
- `detach = true`: the response arrives once the process is running, with
  `{detached: true, run: id}`. The page shows an "attached" chip in the
  toolbar with the command's label and a dismiss control. `timeout` defaults
  to unlimited (`0`) for detached commands and still applies if set.
- A detached run is killed (process group, SIGTERM then SIGKILL, as today)
  when: its tab says goodbye or opens a different notebook (its `$PDF` would
  be stale), its session has been silent for ten minutes (tablets drop
  WebSockets within seconds of being backgrounded, so a short grace would
  kill runs every time Danny switches apps), Danny dismisses it from the
  chip, the server shuts down, or its timeout fires. A detached run that
  exits by itself clears its chip through the `exited` message.
- File changes: a run that rewrites the PDF calls `pdfink.reload()` afterwards;
  that is the sanctioned path and what the demos do. The server also stats
  the file when any run exits and puts `changed`, `mtime` and `reload`
  (honouring `reload = true`) into the `exited` message, so the page adopts
  the new mtime instead of raising a conflict on its next autosave.
- The server keeps at most one detached run per label per session; starting
  the same detached command again replaces the earlier run.

### 6. Environment variables

All of today's variables, plus:

| Variable | Value |
|---|---|
| `PDFINK_SOCKET` | path of the run's Unix socket |
| `PDFINK_RUN` | the run id |
| `SELECTED` | number of selected strokes and images, or empty when nothing is selected |
| `SEL_PAGE` | 1-based page the selection is on (empty when none) |
| `SEL_X`, `SEL_Y`, `SEL_W`, `SEL_H` | the selection rectangle (marquee united with the selected items' bounds) in PDF points, origin bottom-left (empty when none) |

### 7. Python library and demos

- `tools/pdfink_page.py`: standard library only, importable from sibling uv
  scripts with `sys.path.insert(0, os.path.dirname(__file__))`. Surface:
  `connect(optional=False)` → `Page`; `Page.call(name, *args)`,
  `Page.eval(js)`, convenience methods mirroring `window.pdfink`
  (`selection()`, `selection_png()` returning bytes, `ask()`, `confirm()`,
  `choose()`, `toast()`, `progress()`, `add_button()`, `select()`, …),
  `Page.events(*names)` as a generator, `Page.close()` and context-manager
  support. Requests have a timeout (default 60 s; dialogs wait indefinitely
  unless told otherwise). `toast()` and `progress()` are fire-and-forget and
  never raise when the page is gone; `ask()`, `confirm()`, `choose()` and
  data calls raise `PageGone`.
- `tools/star.py` draws through the bridge (`add_strokes`) when
  `PDFINK_SOCKET` is set, so the star appears at once and is undoable, and
  falls back to rewriting the file and `reload = true` when it is not. It is
  the smallest example of the library and shows the degrade path.
- `tools/describe-selection.py`: a normal (non-detached) demo. Takes the
  selection PNG, asks a vision model through `llm` what it shows, and offers
  the answer through `choose` (copy to status / print / cancel). Degrades to
  the whole page when nothing is selected.
- `journal-page.py` uses the bridge when present: `progress()` while
  transcribing, and `ask()` for the date when the model reports `UNDATED`
  and `--date` was not given.
- Shell example in the config file comments:
  `printf '{"id":1,"call":"toast","args":["hello from sh"]}\n' | nc -U "$PDFINK_SOCKET"`.

### 8. Tests

- Unit (Vitest): JSON-lines framing and multi-client routing on the Unix
  socket; env variables including selection; detached run killed after the
  session grace period; chip messages; `window.pdfink` method results
  (jsdom-free where possible, through `App` directly).
- E2E (Playwright, fixture commands file): a command that fetches the
  selection PNG and toasts its size; `ask` answered through the in-page
  dialog; a detached command whose button event is delivered and whose chip
  disappears on dismiss; the in-place reload keeping the session.
- Python: the library against a fake socket server, run under uv and skipped
  when uv is absent (same pattern as `star.test.ts`).
- Part B: round-trip tests for links and outlines (import, export, re-import
  equal; a base PDF with `GoTo` links and a nested outline comes back
  byte-for-byte in those parts); e2e for drawing a link, opening it with a
  finger tap and from the pen menu, adding a bookmark and jumping to it;
  the real-notebook tests (`PDFINK_SAMPLES`) still pass.

### 9. Documentation

- README: a "Talking to the page" section under pen-menu commands with the
  Python example and the shell one-liner, the new variables, `detach`, and
  the lifecycle rules.
- `pdfink-commands.conf.example`: the two demo entries.
- `docs/design.md`: the bridge as a component.

## Left to the builder

- WebSocket server implementation: add the `ws` package (the repo's only new
  runtime dependency) or hand-roll RFC 6455; `ws` is recommended.
- Reconnect backoff values, the exact chip and dialog styling, and whether
  `progress` lives in the status bar or its own line.
- Base64 PNG size limits and the `scale` default (3 px per point matches the
  clipboard renderer).
- How the Vite proxy is configured for the WebSocket path.
- Link caption typography and the outline-selection styling; how a link is
  moved once selected (image handling is the model).
- Whether `GoTo` links in a base PDF become clickable later; out of scope now.

## Calls made after review

A fresh builder read the draft and asked six questions. Danny answered one:
where a command's buttons go is specified in the `addButton` call (`where`),
with the pen menu as the default. The rest were settled as follows:

- Only detached runs are tied to their page; normal runs always finish.
  Detached runs end on goodbye, notebook switch, dismiss, ten minutes of
  silence, server shutdown or timeout.
- Switching notebooks in a tab ends that tab's detached runs; a `notebook`
  event exists for scripts that want to know first.
- Runs that write the PDF call `reload()`; the server also reports file
  changes in `exited`.
- The selection rectangle given to commands is the union of the marquee and
  the selected items' bounds; both parts are exposed too.
- `reload()` is the in-app reopen; the session id in `sessionStorage` only
  matters for a browser refresh.
- Also noted by the reviewer and adopted: the server treats a client
  half-close (the `nc -U` one-liner) as "flush pending replies, then close";
  run ids are short so socket paths stay under the macOS 104-byte limit;
  when two tabs share a copied session id the newest WebSocket wins; e2e
  fixture commands use `node -e` rather than `nc` for CI portability.
- Later in the conversation Danny asked for ink insertion through the
  browser, then chose links and bookmarks for this round (FreeText and
  attachments deferred). How a link is followed on the tablet and the
  bookmark UI are my calls, marked above.
