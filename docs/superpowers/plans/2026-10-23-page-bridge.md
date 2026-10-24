# Page Bridge Implementation Plan (Part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pen-menu commands get a live line to the page that opened the menu: they can read the selection, show dialogs and progress, add buttons, insert ink and images, and optionally stay attached.

**Architecture:** The page keeps one WebSocket per tab to the Node server (`/api/page?session=`). For each command run the server creates a Unix socket, names it in `PDFINK_SOCKET`, and relays newline-delimited JSON between that socket and the page's WebSocket. In the page, `window.pdfink` is a stable API object; requests are dispatched to it (or to raw eval) by `PageLink`. A standard-library Python module wraps the socket for uv scripts.

**Tech Stack:** TypeScript (Node 24+, Vite, Vitest, Playwright), `ws` for the server-side WebSocket (the only new runtime dependency), Python 3.10+ standard library for `tools/pdfink_page.py`, uv PEP 723 scripts.

**Spec:** `docs/superpowers/specs/2026-10-23-page-bridge-design.md` (Part A sections: 1, 2, 3, 4, 5, 6, 7, 8, 9 minus the Part B items).

## Global Constraints

- Server mode only; browser mode gets `window.pdfink` but no WebSocket and no sockets.
- Sockets live under `path.join(os.tmpdir(), "pdfink")`, directory mode `0o700`, socket mode `0o600`; run ids are 6 base-36 characters so paths stay under the macOS 104-byte limit.
- Normal (`detach = false`) runs are never killed because their page went away; detached runs die on tab goodbye, notebook switch, dismiss, server shutdown, timeout, or after `graceMs` (default `600_000`) of their session having no page.
- `timeout` default: 60 s for normal commands, 0 (unlimited) for `detach = true`.
- Existing config files, `tools/star.py` file-writing behaviour, and the three fixture commands keep working unchanged.
- New runtime dependency allowed: `ws@^8.18.0` (+ `@types/ws` dev). Nothing else.
- No hostnames, private paths or keys from the production machine anywhere in the repo.
- `npm run typecheck`, `npm test`, `npm run test:e2e` green after every task; commit after every task.
- Python module is standard library only, Python ≥ 3.10.

## Review Focus

1. Malformed JSON written to the run socket: the connection stays open and gets `{"error":"bad json"}`; other clients are unaffected. (Task 2)
2. A browser refresh mid-run: requests made while no page is connected get `{"id":…,"error":"page gone"}`, and work again once the same session reconnects. (Task 3)
3. A duplicated tab shares the `sessionStorage` id: the newest WebSocket wins, the old one is closed, no run is killed. (Task 3)
4. A multi-megabyte result (a selection PNG as base64) crosses the relay as one line in both directions without truncation, and the Python reader does not split it. (Tasks 2 and 9)
5. `eval` of an expression yielding a non-serialisable value (a DOM element) returns its string form rather than an error, and a thrown error returns `{"error": message}`. (Task 7)

---

### Task 1: `detach` flag and a startable command handle

**Files:**
- Modify: `server/commands.ts`
- Test: `tests/unit/commands.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CommandSpec { id; label; command; reload; confirm; timeout: number /* 0 = none */; detach: boolean }
  export interface SelectionContext { page: number /* 1-based */; x: number; y: number; w: number; h: number; count: number } // PDF points, bottom-left
  export interface CommandContext { …existing…; selection?: SelectionContext | null }
  export interface RunningCommand { pid: number | undefined; done: Promise<CommandResult>; kill(): void }
  export function startCommand(spec: CommandSpec, ctx: CommandContext, cwd: string, extraEnv?: Record<string, string>): RunningCommand
  export function runCommand(spec: CommandSpec, ctx: CommandContext, cwd: string, extraEnv?: Record<string, string>): Promise<CommandResult> // = startCommand(...).done
  ```
  Env added by `startCommand`: `SELECTED` (`String(count)` or `""`), `SEL_PAGE`, `SEL_X`, `SEL_Y`, `SEL_W`, `SEL_H` (numbers via the existing `num()` or `""` when `selection` is absent), plus every key of `extraEnv`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/commands.test.ts`

```ts
it("parses detach and gives detached commands no timeout by default", () => {
  const [a, b, c] = parseCommands("[A]\ncommand = true\ndetach = yes\n[B]\ncommand = true\n[C]\ncommand = true\ndetach = true\ntimeout = 5\n");
  expect(a.detach).toBe(true); expect(a.timeout).toBe(0);
  expect(b.detach).toBe(false); expect(b.timeout).toBe(60);
  expect(c.timeout).toBe(5);
});
it("puts the selection and extra env in the environment, empty when there is none", async () => {
  const spec = parseCommands('[E]\ncommand = printf "%s|%s|%s|%s|%s|%s|%s" "$SELECTED" "$SEL_PAGE" "$SEL_X" "$SEL_Y" "$SEL_W" "$SEL_H" "$PDFINK_RUN"')[0];
  const r1 = await runCommand(spec, { ...ctx, selection: { page: 2, x: 10, y: 20, w: 30.5, h: 40, count: 3 } }, cwd, { PDFINK_RUN: "abc123" });
  expect(r1.stdout).toBe("3|2|10|20|30.5|40|abc123");
  const r2 = await runCommand(spec, { ...ctx, selection: null }, cwd);
  expect(r2.stdout).toBe("||||||");
});
it("startCommand exposes pid and kill, and kill resolves done with a signal", async () => {
  const spec = parseCommands("[S]\ncommand = sleep 30")[0];
  const h = startCommand(spec, ctx, cwd);
  expect(h.pid).toBeGreaterThan(0);
  h.kill();
  const r = await h.done;
  expect(r.signal).toBe("SIGTERM");
});
```
(`ctx` and `cwd` are the fixtures already used in this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/commands.test.ts`
Expected: FAIL (`detach` undefined, `startCommand` not exported).

- [ ] **Step 3: Implement** in `server/commands.ts`: `detach` parsed with `flag(cur.kv.detach, false)`; timeout default `detach ? 0 : 60`; a `timeout` of 0 sets no timer; move the body of `runCommand` into `startCommand` returning `{ pid: child.pid, done, kill }` where `kill()` is the existing `killTree("SIGTERM")` plus the 2 s `SIGKILL` and 4 s forced resolve; `runCommand` calls `startCommand(...).done`. Update the header comment with the new variables.

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/unit/commands.test.ts tests/unit/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/commands.ts tests/unit/commands.test.ts
git commit -m "Commands: detach flag, selection variables, startCommand handle"
```

### Task 2: `Bridge` relay: run sockets, framing, routing

**Files:**
- Create: `server/bridge.ts`
- Test: `tests/unit/bridge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PageSocket { send(text: string): void; close(): void; onMessage(fn: (text: string) => void): void; onClose(fn: () => void): void }
  export interface RunInfo { id: string; session: string | null; label: string; detached: boolean; notebook: string; socketPath: string }
  export interface ExitInfo { status: number | null; signal: string | null; timedOut: boolean; stdout: string; changed: boolean; mtime: number | null; reload: boolean }
  export interface BridgeOptions { socketDir?: string /* default path.join(os.tmpdir(), "pdfink") */; graceMs?: number /* default 600_000 */ }
  export class Bridge {
    constructor(opts?: BridgeOptions);
    addPage(session: string, socket: PageSocket): void;
    hasPage(session: string): boolean;
    openRun(info: Omit<RunInfo, "id" | "socketPath">, onKill: () => void): Promise<RunInfo>;
    closeRun(id: string, exit: ExitInfo): Promise<void>;
    killRun(id: string): void;            // sends {"event":"exit"} to the run's connections, then onKill()
    runsFor(session: string): RunInfo[];
    shutdown(): Promise<void>;
  }
  ```
  Wire (run socket, one JSON object per line):
  - in: `{"id":I,"call":"name","args":[…]}` | `{"id":I,"eval":"js"}` | `{"subscribe":["selection",…]}`
  - out: `{"id":I,"result":…}` | `{"id":I,"error":"…"}` | `{"event":"name","data":…}` | `{"error":"bad json"}`
  Wire (page WebSocket):
  - to page: `{"run":R,"id":T,"call":…,"args":…}` | `{"run":R,"id":T,"eval":…}` | `{"run":R,"started":{"label":…,"detached":…}}` | `{"run":R,"exited":ExitInfo}`
  - from page: `{"run":R,"id":T,"result":…}` | `{"run":R,"id":T,"error":…}` | `{"event":…,"data":…}` | `{"bye":true}` | `{"dismiss":R}` | `{"notebook":"name"}`
  `T` is a server token `"<connection-number>:<client id>"`; the client's own `id` is restored on the reply. A request while `hasPage(session)` is false (or `session` is null) is answered at once with `{"id":I,"error":"page gone"}`.
  Half-close: when a client ends its write side, pending replies are still delivered, then the server ends the connection.

- [ ] **Step 1: Write the failing tests** in `tests/unit/bridge.test.ts` using a `FakePage` implementing `PageSocket` that records sent frames and lets the test inject page messages, and a helper `client(socketPath)` returning `{ send(obj), lines(): AsyncIterable<object>, end(), destroy() }` over `net.connect`.

```ts
it("creates a short socket path under the socket dir, mode 0600", async () => {
  const run = await bridge.openRun({ session: "s1", label: "L", detached: false, notebook: "n.pdf" }, () => {});
  expect(run.id).toMatch(/^[a-z0-9]{6}$/);
  expect(run.socketPath.length).toBeLessThan(100);
  expect(fs.statSync(run.socketPath).mode & 0o777).toBe(0o600);
});
it("relays a call to the page with a token and routes the reply to the asking client", …)
  // two clients send {"id":1,"call":"state"}; page receives two frames with distinct tokens and run id;
  // page answers the second first; each client gets its own {"id":1,"result":…}
it("answers page gone when the session has no page", …)   // expect {"id":7,"error":"page gone"}
it("replies bad json and keeps the connection", …)       // send "not json\n" then a valid call: both answered
it("fans out subscribed events only to subscribers", …)  // client A subscribes ["selection"], B does not; page sends {"event":"selection","data":{x:1}}
it("delivers pending replies after a half-close, then ends", …) // client.end() right after sending; reply still arrives; socket closes
it("carries a 3 MB result as one line", …)              // page replies with "x".repeat(3_000_000); client sees one object with that length
it("closeRun unlinks the socket and tells the page", …)  // fs.existsSync false; page got {"run":id,"exited":{...}}
it("killRun sends the exit event before onKill", …)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/bridge.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `server/bridge.ts`** with `net.createServer` per run, a line splitter that buffers until `\n` with no length cap, per-connection `pending: Map<token, clientId>` and `subs: Set<string>`, and the page-side dispatcher. Create the socket dir with `fs.mkdirSync(dir, { recursive: true, mode: 0o700 })` and `chmodSync(socketPath, 0o600)` after `listen`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/bridge.ts tests/unit/bridge.test.ts
git commit -m "Bridge: Unix socket per run relayed to the page"
```

### Task 3: `Bridge` sessions and detached lifecycle

**Files:**
- Modify: `server/bridge.ts`
- Test: `tests/unit/bridge.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: behaviour only. `addPage` with an existing live socket for the session closes the old one (newest wins). A page close starts a grace timer of `graceMs`; expiry calls `killRun` for the session's detached runs. When the grace period expires, every connection of every run on that session (normal runs too) also receives `{"event":"gone"}`. `{"bye":true}` kills them at once. `{"dismiss":R}` kills run R. `{"notebook":N}` first fans out `{"event":"notebook","data":{"name":N}}` to subscribers, then kills detached runs of that session whose `notebook !== N`. `openRun` of a detached run with the same `label` and `session` as a live detached run kills the old one first. `shutdown()` kills every run and removes every socket.

- [ ] **Step 1: Write the failing tests** (use `vi.useFakeTimers()` for the grace timer)

```ts
it("newest page wins for a session and nothing is killed", …)
it("kills detached runs after the grace period, not normal ones, and tells both gone", …) // page.close(); vi.advanceTimersByTime(600_000); detached onKill called once; normal onKill never; both runs' clients received {"event":"gone"}
it("a reconnect inside the grace period cancels the kill", …)
it("bye kills detached runs at once", …)
it("dismiss kills just that run", …)
it("a notebook switch sends the event then kills runs bound to another notebook", …)
it("a second detached run with the same label replaces the first", …)
it("requests work again after the same session reconnects", …) // page gone, then addPage, then a call is relayed
it("shutdown kills all runs and removes sockets", …)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/bridge.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** in `server/bridge.ts`: a `sessions: Map<string, { socket: PageSocket | null; graceTimer: NodeJS.Timeout | null }>` and the handlers above.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/bridge.ts tests/unit/bridge.test.ts
git commit -m "Bridge: sessions, detached runs, grace period, dismiss and notebook switch"
```

### Task 4: Server wiring: WebSocket upgrade, run creation, detached responses

**Files:**
- Modify: `server/index.ts` (`ServerOptions`, `handleApi` commands branch, `handleCommand`, `createServer`)
- Modify: `package.json` (add `ws`, `@types/ws`)
- Test: `tests/unit/server.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `ServerOptions.socketDir?: string` and `ServerOptions.graceMs?: number` (optional; tests may pass them).
  - `GET /api/commands` items gain `detach: boolean`.
  - `POST /api/commands/<id>` body: `{ name, page, x, y, session?: string, selection?: { page: number /* 0-based */, rect: { x, y, w, h } /* display points */, count: number } | null }`. The server converts `rect` to PDF points with `displayToPdf` on two opposite corners (normalising after rotation) and fills `SelectionContext` with `page: selection.page + 1` (1-based, like `PAGE`).
  - Response for a normal run: as today plus `run: string`. For `detach = true`: `{ detached: true, run, status: null, signal: null, timedOut: false, stdout: "", stderr: "", changed: false, mtime, reload: false }` sent as soon as the process has started; when it later exits the server stats the file and calls `bridge.closeRun(run, exit)`.
  - WebSocket at `GET /api/page?session=<id>` (upgrade), server mode only; other upgrade paths are destroyed. Adapter from `ws` to `PageSocket`.
  - `createServer` creates one `Bridge` and calls `bridge.shutdown()` on the http server's `close`.

- [ ] **Step 1: Add the dependency**

Run: `npm install ws@^8.18.0 && npm install -D @types/ws`
Expected: `package.json` lists both; `npm run typecheck` still passes.

- [ ] **Step 2: Write the failing tests** in `tests/unit/server.test.ts` (a commands file written into a temp dir; the page connects with Node's global `WebSocket` to `ws://127.0.0.1:${port}/api/page?session=t1`)

```ts
it("GET /api/commands reports detach", …)
it("a command gets PDFINK_SOCKET, PDFINK_RUN and the selection in PDF points", async () => {
  // conf: [Env]\ncommand = printf '%s %s %s %s %s %s' "$PDFINK_RUN" "$SELECTED" "$SEL_PAGE" "$SEL_X" "$SEL_Y" "$SEL_H" ; test -S "$PDFINK_SOCKET" && printf ' sock'
  // POST with page 0, selection {page:0, rect:{x:100,y:92,w:50,h:200}, count:2} on a Letter page → "<run> 2 1 100 500 200 sock"
});
it("a command can call the page through the socket", …)
  // conf: [Call]\ncommand = node -e '…connect to process.env.PDFINK_SOCKET, send {"id":1,"call":"state"}, print result.tool…'
  // the test's WebSocket answers {"run":…,"id":…,"result":{"tool":"pen"}}; response stdout is "pen"
it("a detached command answers at once and the page sees started then exited", …)
  // conf: [D]\ncommand = sleep 1\ndetach = true → response.detached true within 500 ms; ws frames: started{label:"D",detached:true}, later exited{status:0}
it("dismiss over the WebSocket kills a detached run", …) // command = sleep 30; send {"dismiss": run}; exited arrives with signal SIGTERM
it("the upgrade is refused in browser mode and on other paths", …)
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/unit/server.test.ts`
Expected: FAIL (no WebSocket server, no `detach` field).

- [ ] **Step 4: Implement** in `server/index.ts` as described in Interfaces. Selection rect conversion: `const a = displayToPdf(geom, r.x, r.y), b = displayToPdf(geom, r.x + r.w, r.y + r.h)` then `x = min, w = |diff|`. Log line for detached starts: `pdfink: started "<label>" on <name> p<N> (detached, run <id>)`.

- [ ] **Step 5: Run all unit tests and typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json server/index.ts tests/unit/server.test.ts
git commit -m "Server: page WebSocket, bridged command runs, detached commands"
```

### Task 5: In-page dialogs

**Files:**
- Create: `src/dialog.ts`
- Modify: `index.html` (add `<div id="dialog" role="dialog" hidden>` before `#file-input`), `src/style.css`, `src/app.ts:121-122` (defaults of `confirmFn`/`promptFn`)
- Test: `tests/e2e/dialog.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export class Dialog {
    constructor(root?: HTMLElement /* default document.getElementById("dialog") */);
    ask(message: string, suggestion?: string): Promise<string | null>;
    confirm(message: string): Promise<boolean>;
    choose(message: string, options: string[]): Promise<string | null>;
  }
  export const dialog: Dialog;  // created lazily on first use
  ```
  DOM inside `#dialog`: `.dialog-box` > `.dialog-message`, `input.dialog-input` (ask only), `.dialog-options` with `button.dialog-option` per option (choose only), `.dialog-buttons` with `button.dialog-ok` and `button.dialog-cancel`. Enter confirms, Escape cancels; only one dialog shows at a time, further requests queue. `App.confirmFn` defaults to `dialog.confirm`, `App.promptFn` to `dialog.ask`.

- [ ] **Step 1: Write the failing e2e test** `tests/e2e/dialog.spec.ts`

```ts
test("ask shows an in-page dialog and resolves with the typed text", async ({ page }) => {
  await openApp(page);
  const p = page.evaluate(() => window.__pdfink.promptFn("Your name?", "Ada"));
  await expect(page.locator("#dialog")).toBeVisible();
  await expect(page.locator("#dialog .dialog-message")).toHaveText("Your name?");
  await expect(page.locator("#dialog .dialog-input")).toHaveValue("Ada");
  await page.fill("#dialog .dialog-input", "Danny");
  await page.keyboard.press("Enter");
  expect(await p).toBe("Danny");
  await expect(page.locator("#dialog")).toBeHidden();
});
test("confirm resolves false on Escape and choose returns the picked option", …)
test("a second dialog waits for the first", …) // two asks; one visible at a time; both resolve in order
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/dialog.spec.ts`
Expected: FAIL (`#dialog` hidden; `window.prompt` would block).

- [ ] **Step 3: Implement** `src/dialog.ts`, the markup and styles (stylus-sized buttons, ≥ 44 px tall; `#dialog[hidden]{display:none}` because the box uses flex), and switch the two App defaults.

- [ ] **Step 4: Run the e2e suite**

Run: `npx playwright test tests/e2e/dialog.spec.ts tests/e2e/notebooks.spec.ts`
Expected: PASS (existing tests that override `confirmFn` still pass).

- [ ] **Step 5: Commit**

```bash
git add src/dialog.ts index.html src/style.css src/app.ts tests/e2e/dialog.spec.ts
git commit -m "In-page ask/confirm/choose dialogs replace window.prompt and confirm"
```

### Task 6: App capabilities the API needs

**Files:**
- Modify: `src/app.ts`, `src/pdf/geom.ts` (no change expected; reuse `pdfToDisplay`/`displayToPdf`), `index.html` (add `<div id="cmd-buttons" class="group server-only"></div>` after the copy/paste group, `<div id="progress"></div>` next to `#status`), `src/style.css`
- Test: `tests/e2e/app-api.spec.ts` (drives `window.__pdfink` with `page.evaluate`)

**Interfaces:**
- Produces, on `App`:
  ```ts
  export type AppEvent = "selection" | "save" | "page" | "notebook" | "stroke" | "button";
  on(event: AppEvent, fn: (data: unknown) => void): () => void;      // returns unsubscribe
  session: string | null;                                              // set by main.ts
  pageGeom(page: number): PageGeom;                                    // from pdfDoc page: view box + rotate, cached per document
  selectionInfo(): { page: number; marquee: Rect | null; bounds: Rect | null; rect: Rect; pdfRect: Rect; strokeIds: string[]; imageIds: string[] } | null;  // rect = union of marquee and bounds
  selectionInk(): Stroke[];
  selectionPng(scale?: number): Promise<Blob>;                        // default 3 px/pt; base rendered by pdf.js for the cropped viewport, then images and strokes via drawStroke
  pagePng(page: number, scale?: number): Promise<Blob>;               // default 1
  selectRect(page: number, rect: Rect): void;                          // tool → select, selection set, members updated
  addStrokes(page: number, strokes: Array<Omit<Stroke, "id"> & { id?: string }>): string[];  // one undo entry, ids returned
  addImageItem(page: number, bytes: Uint8Array, mime: "image/png" | "image/jpeg", rect: Rect): string;
  removeItems(ids: string[]): number;                                  // one undo entry per page touched; returns count removed
  progress(message: string | null): void;                              // #progress text; null clears
  addButton(id: string, label: string, where: "menu" | "toolbar"): void;  // press → emit("button", { id })
  removeButton(id: string): void;
  noteExternalChange(name: string, mtime: number | null): void;        // made public
  ```
  Events and their `data`: `selection` → `selectionInfo()` (null when cleared), fired from one private `setSelection(sel: Selection | null)` that replaces every direct `this.selection =` assignment; `save` → `{ name, mtime }` after a successful `saveToServer`; `page` → `{ page }` when `currentPage` changes; `notebook` → `{ name }` at the end of a successful `openNotebook`; `stroke` → `{ page, stroke }` when a pen stroke is committed; `button` → `{ id }`. Menu buttons appear in `penMenuItems()` after the commands, under a separator; toolbar buttons are `<button class="cmd">` in `#cmd-buttons`. `getState()` gains `buttons: string[]` and `progress: string | null`.

- [ ] **Step 1: Write the failing e2e tests** `tests/e2e/app-api.spec.ts`

```ts
test("addStrokes draws and is one undo step", async ({ page }) => {
  await openApp(page);
  const ids = await page.evaluate(() => window.__pdfink.addStrokes(0, [
    { points: [{ x: 100, y: 100, p: 0.6 }, { x: 200, y: 100, p: 0.6 }], color: "#d91a1a", width: 2, opacity: 1 },
    { points: [{ x: 100, y: 120, p: 0.6 }, { x: 200, y: 120, p: 0.6 }], color: "#000000", width: 1, opacity: 1 },
  ]));
  expect(ids).toHaveLength(2);
  expect((await state(page)).pages[0].strokes).toHaveLength(2);
  expect((await state(page)).undo).toBe(1);
  expect(await inkPixel(page, 0, 150, 100)).toEqual(expect.arrayContaining([217, 26, 26]));
});
test("selectRect, selectionInfo and selectionPng describe the union of marquee and strokes", …)
  // stroke from (50,50) to (300,50); selectRect(0,{x:100,y:40,w:50,h:20}) → info.rect = {x:50,y:40,w:250,h:20} (bounds widen it); png decoded size ≈ 750×60 at scale 3
test("removeItems deletes across pages with one undo entry per page", …)
test("addButton puts a button in the pen menu or toolbar and pressing it emits button", …)
  // on("button") recorded into window.__events; menu: right-click page, click button text; toolbar: #cmd-buttons button
test("progress shows and clears", …)
test("addImageItem places a PNG in the given rect", …) // use tests/fixtures/arrow.png bytes
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/app-api.spec.ts`
Expected: FAIL (methods undefined).

- [ ] **Step 3: Implement** in `src/app.ts` and the markup/styles. `pageGeom(i)`: `const p = await pdfDoc.getPage(i+1)` is async, so cache geoms when the document is set (`setDocument` builds `this.geoms` from each page's `view` and `rotate` via `normalizeRotate`). `selectionPng`: offscreen canvas `ceil(rect.w*scale) × ceil(rect.h*scale)`, `pdfPage.render({ canvasContext, viewport: pdfPage.getViewport({ scale, offsetX: -rect.x*scale, offsetY: -rect.y*scale }) })`, then `ctx.scale(scale, scale); ctx.translate(-rect.x, -rect.y)` and draw images and strokes of that page.

- [ ] **Step 4: Run e2e and typecheck**

Run: `npm run typecheck && npx playwright test tests/e2e/app-api.spec.ts tests/e2e/selection.spec.ts tests/e2e/drawing.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app.ts index.html src/style.css tests/e2e/app-api.spec.ts
git commit -m "App: events, selection info and PNG, programmatic insert and remove, buttons, progress"
```

### Task 7: `window.pdfink` API object

**Files:**
- Create: `src/pdfink-api.ts`
- Modify: `src/main.ts:125-132` (expose `window.pdfink`, keep `__pdfink` and `__stylusSim`)
- Test: `tests/e2e/pdfink-api.spec.ts`

**Interfaces:**
- Consumes: Task 6 App methods, Task 5 `dialog`.
- Produces:
  ```ts
  export interface PdfinkApi {
    state(): ReturnType<App["getState"]>;
    notebook(): { name: string; pages: number; page: number; dirty: boolean; storage: "server" | "local" };
    selection(): ReturnType<App["selectionInfo"]>;
    selectionInk(): Stroke[];
    selectionPng(opts?: { scale?: number }): Promise<string>;   // base64, no data: prefix; rejects "no selection"
    pagePng(page: number, opts?: { scale?: number }): Promise<string>;
    toast(message: string): void;                                 // app.setStatus(message)
    progress(message: string | null): void;
    ask(message: string, opts?: { default?: string }): Promise<string | null>;
    confirm(message: string): Promise<boolean>;
    choose(message: string, options: string[]): Promise<string | null>;
    addButton(id: string, label: string, opts?: { where?: "menu" | "toolbar" }): void;   // default "menu"
    removeButton(id: string): void;
    select(page: number, rect: Rect): void;
    clearSelection(): void;
    setTool(tool: Tool): void;
    save(): Promise<boolean>;
    reload(): Promise<boolean>;         // app.reloadNotebook(current name); false in local mode
    undo(): void; redo(): void;
    addPage(): Promise<void>;
    scrollToPage(page: number): void;
    addStrokes(page: number, strokes: Array<Omit<Stroke, "id"> & { id?: string }>, opts?: { space?: "page" | "pdf" }): string[];
    addImage(page: number, png: string /* base64 */, rect: Rect): Promise<string>;
    removeItems(ids: string[]): number;
  }
  export function createPdfinkApi(app: App): PdfinkApi;
  export async function evalInPage(api: PdfinkApi, app: App, js: string): Promise<unknown>;  // new Function("pdfink","app",`return (${js})`) awaited; result passed through toJson()
  export function toJson(value: unknown): unknown;  // JSON-safe: undefined→null, bigint→string, Uint8Array→base64, non-serialisable object→String(value)
  ```
  `space: "pdf"` converts each point with `pdfToDisplay(app.pageGeom(page), x, y)`. `declare global { interface Window { pdfink: PdfinkApi } }`.

- [ ] **Step 1: Write the failing e2e tests** `tests/e2e/pdfink-api.spec.ts`

```ts
test("window.pdfink exists in both modes with the documented methods", …) // openApp and openLocalApp; typeof each method === "function"
test("selectionPng returns base64 of a PNG the size of the selection", …) // decode header bytes 0x89 'P' 'N' 'G'
test("addStrokes in pdf space lands at the display point", …) // Letter page: pdf (300,500) → display y 292
test("eval returns JSON for values and strings for DOM nodes, and errors as messages", async ({ page }) => {
  await openApp(page);
  const r = await page.evaluate(async () => {
    const m = await import("/src/pdfink-api.ts");
    const api = window.pdfink, app = window.__pdfink;
    return [await m.evalInPage(api, app, "app.scale * 2"), await m.evalInPage(api, app, "document.body"), await m.evalInPage(api, app, "pdfink.selection()")];
  });
  expect(r[0]).toBe(2); expect(r[1]).toBe("[object HTMLBodyElement]"); expect(r[2]).toBeNull();
  await expect(page.evaluate(async () => { const m = await import("/src/pdfink-api.ts"); return m.evalInPage(window.pdfink, window.__pdfink, "nope.x"); })).rejects.toThrow(/nope/);
});
```
(Vite serves `/src/pdfink-api.ts` to the test page; if the import path differs under the dev server, expose `evalInPage` on `window.__pdfinkEval` from `main.ts` instead and call that.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/pdfink-api.spec.ts`
Expected: FAIL (`window.pdfink` undefined).

- [ ] **Step 3: Implement** `src/pdfink-api.ts` and the `main.ts` wiring.

- [ ] **Step 4: Run**

Run: `npm run typecheck && npx playwright test tests/e2e/pdfink-api.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pdfink-api.ts src/main.ts tests/e2e/pdfink-api.spec.ts
git commit -m "window.pdfink: the stable page API, with eval behind it"
```

### Task 8: `PageLink`: the page end of the bridge, chips, and command plumbing

**Files:**
- Create: `src/bridge-client.ts`
- Modify: `src/api.ts:157-190` (`CommandInfo.detach`, `RunRequest`, `runCommand(id, req)`, `CommandRun.detached?/run?`), `src/app.ts` (`runMenuCommand`), `src/main.ts`, `vite.config.ts` (proxy `ws: true`), `index.html` (`<div id="runs" class="server-only"></div>` in the toolbar), `src/style.css`
- Create: `tests/fixtures/bridge-tool.cjs`; Modify: `tests/fixtures/pdfink-commands.conf`
- Test: `tests/e2e/bridge.spec.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7.
- Produces:
  ```ts
  export class PageLink {
    constructor(app: App, api: PdfinkApi, root?: HTMLElement /* #runs */);
    readonly session: string;          // sessionStorage["pdfink.session"], created with crypto.randomUUID()
    connect(): void;                   // (location.protocol==="https:"?"wss":"ws")://host/api/page?session=…; reconnect 1 s doubling to 30 s
    readonly runs: Map<string, { label: string; detached: boolean }>;
    dismiss(runId: string): void;      // sends {"dismiss":runId}
  }
  ```
  Behaviour: incoming `call` → `api[name](...args)` (unknown name → error `no such method`), `eval` → `evalInPage`; replies `{run,id,result}` / `{run,id,error}`. `started` with `detached` → chip `#runs .run[data-run]` with the label and a `button.dismiss` (×). `exited` → remove chip, remove that run's buttons (PageLink records `addButton` ids per run), clear progress, then `if (exited.changed) exited.reload ? app.reloadNotebook(name) : app.noteExternalChange(name, exited.mtime)`. Subscribes to every `AppEvent` and forwards `{event, data}`; `notebook` additionally sends `{"notebook": name}`. `pagehide` sends `{"bye":true}`.
  `api.ts`:
  ```ts
  export interface CommandInfo { id: string; label: string; reload: boolean; confirm: boolean; detach: boolean }
  export interface RunRequest { name: string; page: number; x: number; y: number; session?: string; selection?: { page: number; rect: Rect; count: number } | null }
  export interface CommandRun { …existing…; detached?: boolean; run?: string }
  export async function runCommand(id: string, req: RunRequest): Promise<CommandRun>
  ```
  `App.runMenuCommand` sends `session: this.session ?? undefined` and `selection` from `selectionInfo()` (`count = strokeIds.length + imageIds.length`); on `detached` it sets status `"<label> attached"` and returns. `main.ts`: `const api = createPdfinkApi(app); window.pdfink = api;` and, when storage is server, `const link = new PageLink(app, api); app.session = link.session; link.connect();`.
  `tests/fixtures/bridge-tool.cjs` (CommonJS, Node ≥ 20, no deps): connects to `process.env.PDFINK_SOCKET`, exposes `call(name, ...args)` and `events(names)`, and runs a subcommand from `argv[2]`:
  - `selection`: `s = call("selection")`, `png = call("selectionPng")`, `toast(`${s.strokeIds.length} strokes ${Math.round(s.rect.w)}x${Math.round(s.rect.h)} png ${png.length}`)` or `toast("nothing selected")`.
  - `ask`: `name = call("ask","Your name?",{default:"Ada"})`, `toast(`hello ${name}`)`.
  - `draw`: `call("addStrokes", Number(PAGE)-1, [line from (DX-40,DY) to (DX+40,DY), red, width 2])`, prints `drew`.
  - `buttons` (used with `detach = true`): `addButton("hello","Say hello")`, `addButton("bye","Finish",{where:"toolbar"})`, subscribe `["button"]`; on `hello` → `toast("hello pressed")`; on `bye` → exit 0.
  Conf additions:
  ```
  [Describe selection]
  command = node bridge-tool.cjs selection
  [Ask my name]
  command = node bridge-tool.cjs ask
  [Draw via bridge]
  command = node bridge-tool.cjs draw
  [Buttons]
  command = node bridge-tool.cjs buttons
  detach = true
  ```

- [ ] **Step 1: Write the failing e2e tests** `tests/e2e/bridge.spec.ts` (helpers: `openMenuAt(page, idx, x, y)` right-clicks the page at a page point; `runMenu(page, label)` clicks `#ctx-menu button:has-text(label)`)

```ts
test("a command reads the selection and shows a toast", …)   // two strokes, selectRect over them, run "Describe selection" → #status contains "2 strokes" and "png "
test("a command asks a question through the in-page dialog", …) // run "Ask my name"; #dialog visible; fill "Danny"; Enter; #status "hello Danny"
test("a command draws through the bridge, undoable", …)       // run "Draw via bridge"; strokes +1; undo count +1; #status "Draw via bridge: drew"
test("a detached command shows a chip, its buttons work, dismiss removes everything", …)
  // run "Buttons" → #runs .run has text "Buttons"; open menu → "Say hello" present → click → #status "hello pressed";
  // #cmd-buttons button "Finish" present; click #runs .dismiss → chip gone; menu lacks "Say hello"; #cmd-buttons empty
test("a detached command that finishes by itself clears its chip", …) // click toolbar "Finish" → chip disappears
test("a browser refresh keeps the session id", …)                 // read sessionStorage before/after page.reload()
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx playwright test tests/e2e/bridge.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `src/bridge-client.ts`, the `api.ts` changes, `runMenuCommand`, `main.ts`, `vite.config.ts` (`proxy: { "/api": { target, ws: true } }`), markup and styles, the fixture tool and conf.

- [ ] **Step 4: Run the whole suite**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bridge-client.ts src/api.ts src/app.ts src/main.ts vite.config.ts index.html src/style.css tests/fixtures tests/e2e/bridge.spec.ts
git commit -m "PageLink: the page talks to its commands; detached runs get a chip"
```

### Task 9: Python library `tools/pdfink_page.py`

**Files:**
- Create: `tools/pdfink_page.py`, `tools/tests/test_pdfink_page.py` (uv script, `requires-python = ">=3.10"`, no dependencies, `unittest`)
- Create: `tests/unit/pdfink-page.test.ts` (runs the Python test under uv, `describe.skipIf(!haveUv)` like `star.test.ts`)

**Interfaces:**
- Produces:
  ```python
  class PageGone(Exception): ...
  class PageError(Exception): ...        # the page returned {"error": ...}
  class Page:
      def __init__(self, path: str, timeout: float = 60.0): ...   # connects; starts a reader thread
      def call(self, name: str, *args, timeout: float | None = ...) -> Any
      def eval(self, js: str, timeout: float | None = ...) -> Any
      def subscribe(self, *events: str) -> None
      def events(self, *names: str, timeout: float | None = None) -> Iterator[tuple[str, Any]]   # subscribes, then yields (event, data) forever
      def close(self) -> None;  __enter__/__exit__
      # convenience, mirroring window.pdfink:
      state, notebook, selection, selection_ink, selection_png -> bytes, page_png(page, scale=1) -> bytes,
      toast(msg), progress(msg_or_None), ask(msg, default="", timeout=None), confirm(msg, timeout=None), choose(msg, options, timeout=None),
      add_button(id, label, where="menu"), remove_button(id), select(page, rect), clear_selection(), set_tool(tool),
      save(), reload(), undo(), redo(), add_page(), scroll_to_page(page),
      add_strokes(page, strokes, space="page") -> list[str], add_image(page, png_bytes, rect) -> str, remove_items(ids) -> int
  def connect(optional: bool = False, timeout: float = 60.0) -> Page | None   # reads PDFINK_SOCKET; raises PageGone("no PDFINK_SOCKET: not run from pdfink's pen menu") unless optional
  ```
  `toast` and `progress` send and return without waiting for a reply; a `page gone` error from them is swallowed. Every other call raises `PageGone` on `{"error":"page gone"}` and `PageError` on any other error. Requests carry increasing integer ids; the reader thread matches replies by id and queues events. `rect` dicts are `{"x","y","w","h"}`.

- [ ] **Step 1: Write the failing Python test** `tools/tests/test_pdfink_page.py`: a fake server on a temp Unix socket in a thread that: answers `call` `state` with `{"tool":"pen"}`, `selectionPng` with 3 000 000 base64 chars of `"QUJD"` repeated (decodes), `ask` after 0.2 s with `"Danny"`, `boom` with `{"error":"no such method"}`, `gone` with `{"error":"page gone"}`, and after a `subscribe` sends two `{"event":"button","data":{"id":"hello"}}` lines. Tests: `test_call_and_mirror`, `test_large_result_one_line`, `test_errors_map_to_exceptions`, `test_toast_does_not_wait`, `test_events_generator`, `test_connect_without_env` (optional → None, else raises), `test_context_manager_closes`.

- [ ] **Step 2: Write the Vitest wrapper** `tests/unit/pdfink-page.test.ts`: `execFileSync("uv", ["run", "--script", "tools/tests/test_pdfink_page.py"], { timeout: 120_000 })` passes.

- [ ] **Step 3: Run to verify it fails**

Run: `uv run --script tools/tests/test_pdfink_page.py`
Expected: ImportError for `pdfink_page`.

- [ ] **Step 4: Implement** `tools/pdfink_page.py` (test file adds `sys.path.insert(0, str(Path(__file__).resolve().parents[1]))`).

- [ ] **Step 5: Run**

Run: `uv run --script tools/tests/test_pdfink_page.py && npx vitest run tests/unit/pdfink-page.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/pdfink_page.py tools/tests/test_pdfink_page.py tests/unit/pdfink-page.test.ts
git commit -m "pdfink_page: standard-library Python client for the page bridge"
```

### Task 10: `star.py` through the bridge, with the file path as fallback

**Files:**
- Modify: `tools/star.py`
- Modify: `tests/unit/star.test.ts`, `tests/fixtures/pdfink-commands.conf` (add `[Star via bridge]` with `command = uv run --script ../../tools/star.py "$PDF" "$PAGE" "$X" "$Y"`), `tests/e2e/bridge.spec.ts`

**Interfaces:**
- Consumes: `pdfink_page.connect(optional=True)`, `add_strokes(page, strokes, space="pdf")`.
- Produces: with a socket, `star.py` sends the star's eleven points as one stroke (`color "#d91a1a"`, `width 1.5`, `opacity 1`, `p 0.6`) to page `PAGE-1` and prints `star at (x, y) on page N (drawn in the browser)`, touching no file; without one it behaves as today. The radius argument still applies.

- [ ] **Step 1: Extend tests.** In `tests/unit/star.test.ts` add a case that runs star.py with `PDFINK_SOCKET` pointing at a fake socket server (a tiny Node `net` server in the test answering `addStrokes` with `["s1"]`): output contains `drawn in the browser`, the file's mtime is unchanged, and the request carried `space: "pdf"` and 11 points. In `tests/e2e/bridge.spec.ts` add `test.skip(!haveUv)("the star demo draws through the bridge", …)`: run "Star via bridge", strokes +1 on that page, `#status` contains `drawn in the browser`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/star.test.ts`
Expected: FAIL (file rewritten; no browser message).

- [ ] **Step 3: Implement** in `tools/star.py` (import `pdfink_page` from its own directory).

- [ ] **Step 4: Run**

Run: `npx vitest run tests/unit/star.test.ts && npx playwright test tests/e2e/bridge.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/star.py tests/unit/star.test.ts tests/fixtures/pdfink-commands.conf tests/e2e/bridge.spec.ts
git commit -m "star.py draws through the bridge when it can"
```

### Task 11: Demos: `describe-selection.py`, and `journal-page.py` with progress and a date question

**Files:**
- Create: `tools/describe-selection.py` (uv script; deps `llm>=0.27`, `llm-openrouter`, `llm-gemini`, `llm-anthropic`)
- Modify: `tools/journal-page.py`
- Test: `tests/unit/tools-smoke.test.ts` (skipIf no uv)

**Interfaces:**
- Consumes: `pdfink_page`.
- Produces:
  - `describe-selection.py [--model M] [--dry-run]`: `page = connect()`; `png = page.selection_png()` or, when `selection()` is None, `page.page_png(int(PAGE)-1, scale=2)`; `page.progress("Looking…")`; asks the model (default `$PDFINK_DESCRIBE_MODEL` or `openrouter/google/gemini-3.7-flash`) "Describe what this handwritten or drawn selection shows, in one short paragraph; transcribe any words."; `choice = page.choose(answer, ["Show in status", "Print", "Cancel"])`; "Show in status" → `toast(answer)`; "Print" → prints answer to stdout; exits 0. `--dry-run` skips the model and uses the text `"(dry run) 1 image"`.
  - `journal-page.py`: `page = pdfink_page.connect(optional=True)`; if present, `page.progress(...)` at each stage (transcribing pages A–B…, filing…), cleared at the end; when the model returns `UNDATED` and `--date` was not given, `page.ask("No date found on the page. Which day is this entry for?", default=today)` replaces the error exit, with the answer validated as before.
- [ ] **Step 1: Write the smoke test** `tests/unit/tools-smoke.test.ts`: `uv run --script tools/describe-selection.py --help` and `uv run --script tools/journal-page.py --help` exit 0; running `describe-selection.py --dry-run` with `PDFINK_SOCKET` set to a fake socket (same helper as Task 10, answering `selection` → `{...}`, `selectionPng` → small base64, `choose` → `"Print"`) prints `(dry run) 1 image`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/tools-smoke.test.ts`
Expected: FAIL (no such script).

- [ ] **Step 3: Implement** both scripts.

- [ ] **Step 4: Run**

Run: `npx vitest run tests/unit/tools-smoke.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/describe-selection.py tools/journal-page.py tests/unit/tools-smoke.test.ts
git commit -m "Demos: describe the selection with a vision model; journal-page shows progress and asks for a date"
```

### Task 12: Documentation

**Files:**
- Modify: `README.md` (after the "Pen-menu commands" paragraph: a "Talking to the page" subsection with the Python example, the `nc -U` one-liner, the new variables table rows, `detach`, lifecycle rules; API table rows for `/api/page`), `pdfink-commands.conf.example` (the two demo entries, `detach`), `docs/design.md` (a "Page bridge" section: the two sockets, the relay, lifetime rules), `server/commands.ts` header comment (new variables).

- [ ] **Step 1: Write the docs.** Python example to include verbatim:
```python
import pdfink_page
page = pdfink_page.connect()
sel = page.selection()
page.toast(f"{len(sel['strokeIds'])} strokes selected" if sel else "nothing selected")
```
Shell example: `printf '{"id":1,"call":"toast","args":["hello from sh"]}\n' | nc -U "$PDFINK_SOCKET"`.

- [ ] **Step 2: Check the README renders** (`npx markdownlint-cli2 README.md` if present; otherwise read it once).

- [ ] **Step 3: Commit**

```bash
git add README.md pdfink-commands.conf.example docs/design.md server/commands.ts
git commit -m "Docs: the page bridge"
```
