# Page bridge: pen-menu commands that talk to the page

Status: draft for Danny's approval, 2026-10-23.

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
  `sessionStorage`, so an in-place reload (`reload = true`) reconnects as the
  same session. Reconnect with backoff; a connection drop does not disturb
  editing.
- Messages both ways are JSON text frames.
- The command POST (`/api/commands/<id>`) body gains `session` (the id) and
  `selection` (the current selection's rectangle in display points, or
  null), so the server can route the command's socket to that page and fill
  the selection environment variables.

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
  or null; `rect` in page points top-left, `pdfRect` in PDF points
  bottom-left), `selectionInk()` (the selected strokes with points, pressure,
  colour and width, in page points), `selectionPng({scale})` (base64 PNG of
  the selected region as the page shows it: page background and ink; the
  existing clipboard renderer is the starting point), `pagePng(page, {scale})`.
- Show: `toast(message)` (status bar, as today's first-line-of-output),
  `progress(message | null)` (a persistent line while a command works, cleared
  with null and on exit), `ask(message, {default})` → string or null,
  `confirm(message)` → boolean, `choose(message, options)` → the chosen
  option or null, `addButton(id, label)` / `removeButton(id)` (pressing a
  button emits a `button` event with the id; buttons of a run are removed
  when it exits).
- Act: `select(page, rect)`, `clearSelection()`, `setTool(tool)`, `save()`,
  `reload()`, `undo()`, `redo()`, `addPage()`, `scrollToPage(page)`.
- Events available to `subscribe`: `selection` (changed or cleared), `save`,
  `page` (the page under the pen changed), `button`, `stroke` (a stroke
  finished; data is the stroke in page points), `exit` (own run ended).

Dialogs (`ask`, `confirm`, `choose`) are in-page elements that work with a
stylus and on iOS, not `window.prompt`. Only one dialog shows at a time;
a second request queues.

### 5. Lifecycle

- `detach = false` (default): unchanged. The HTTP response arrives when the
  process exits, with stdout, stderr, exit status, `changed` and `reload`.
  The bridge is available for the whole run, so a normal command can still
  ask questions and show progress before it exits. `timeout` as today.
- `detach = true`: the response arrives once the process is running, with
  `{detached: true, run: id}`. The page shows an "attached" chip with the
  command's label and a dismiss control. `timeout` defaults to unlimited
  (`0`) for detached commands and still applies if set.
- A run is killed (process group, SIGTERM then SIGKILL, as today) when: its
  page's session has been disconnected for 30 seconds (an in-place reload
  reconnects well inside that), Danny dismisses it from the chip, the server
  shuts down, or its timeout fires. A detached run that exits by itself
  clears its chip through the `exited` message.
- The server keeps at most one detached run per label per session; starting
  the same detached command again replaces the earlier run.

### 6. Environment variables

All of today's variables, plus:

| Variable | Value |
|---|---|
| `PDFINK_SOCKET` | path of the run's Unix socket |
| `PDFINK_RUN` | the run id |
| `SELECTED` | number of selected strokes and images, or empty when nothing is selected |
| `SEL_X`, `SEL_Y`, `SEL_W`, `SEL_H` | the selection rectangle in PDF points, origin bottom-left (empty when none) |

### 7. Python library and demos

- `tools/pdfink_page.py`: standard library only, importable from sibling uv
  scripts with `sys.path.insert(0, os.path.dirname(__file__))`. Surface:
  `connect(optional=False)` → `Page`; `Page.call(name, *args)`,
  `Page.eval(js)`, convenience methods mirroring `window.pdfink`
  (`selection()`, `selection_png()` returning bytes, `ask()`, `confirm()`,
  `choose()`, `toast()`, `progress()`, `add_button()`, `select()`, …),
  `Page.events(*names)` as a generator, `Page.close()` and context-manager
  support. Requests have a timeout (default 60 s; dialogs wait indefinitely
  unless told otherwise).
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
