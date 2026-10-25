/**
 * PageLink: the page's end of the command bridge (see server/bridge.ts for the
 * wire). One WebSocket per tab session carries requests from running commands
 * to window.pdfink and the page's events back to them. Detached runs get a
 * chip in the toolbar with a dismiss button; when a run exits, its buttons and
 * progress line go with it.
 *
 * On every (re)connect the server re-announces the session's live runs; runs
 * not re-announced within SETTLE_MS ended while the page was away and are
 * dropped. A close with code 4001 means another tab took over this session id
 * (a duplicated tab copies sessionStorage): this tab moves to a fresh id.
 */
import type { App, AppEvent } from "./app";
import { evalInPage, toJson, type PdfinkApi } from "./pdfink-api";

const SESSION_KEY = "pdfink.session";
const EVENTS: AppEvent[] = ["selection", "save", "page", "notebook", "stroke", "button", "bookmarks", "ink"];
const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;
/** How long after a (re)connect the server's re-announced runs have to arrive. */
const SETTLE_MS = 500;
/** The server's close code for a page superseded by a newer one for the same session. */
const REPLACED = 4001;

interface ExitInfo {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  changed: boolean;
  mtime: number | null;
  reload: boolean;
}

interface Frame {
  run?: string;
  id?: string;
  call?: string;
  args?: unknown[];
  eval?: string;
  started?: { label: string; detached: boolean };
  exited?: ExitInfo;
}

export class PageLink {
  private sessionId: string;
  readonly runs = new Map<string, { label: string; detached: boolean }>();
  /** Button ids each run added through addButton, so they go when it exits. */
  private buttons = new Map<string, Set<string>>();
  private ws: WebSocket | null = null;
  private delay = MIN_DELAY;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private wired = false;
  /** The notebook open when each detached run started: the file its exit may have changed. */
  private notebooks = new Map<string, string>();
  /** Runs announced since the socket last opened; null once settled. */
  private announced: Set<string> | null = null;
  /** pagehide has fired and the page has not come back yet: don't reconnect. */
  private leaving = false;

  constructor(
    private readonly app: App,
    private readonly api: PdfinkApi,
    private readonly root: HTMLElement = document.getElementById("runs") as HTMLElement,
  ) {
    this.sessionId = loadSession();
  }

  get session(): string {
    return this.sessionId;
  }

  connect(): void {
    if (!this.wired) {
      this.wired = true;
      for (const event of EVENTS) {
        this.app.on(event, (data) => {
          this.send({ event, data: toJson(data) });
          if (event === "notebook") this.send({ notebook: (data as { name: string }).name });
        });
      }
      window.addEventListener("pagehide", () => {
        this.send({ bye: true });
        this.leaving = true;
      });
      // pagehide is not always the end: a mobile browser can fire it when the
      // tab is merely backgrounded (and drop the socket while hidden). Coming
      // back in any way means the page is live again.
      const back = () => {
        this.leaving = false;
        if (!this.ws) this.connect();
      };
      window.addEventListener("pageshow", back);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") back();
      });
    }
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/page?session=${encodeURIComponent(this.session)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.delay = MIN_DELAY;
      if (this.app.source.kind === "server") this.send({ notebook: this.app.source.name });
      this.announced = new Set();
      setTimeout(() => {
        if (this.ws === ws) this.prune();
      }, SETTLE_MS);
    };
    ws.onmessage = (e) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(e.data)) as Frame;
      } catch {
        return;
      }
      void this.handle(frame);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.leaving) return;
      if (e.code === REPLACED) {
        this.sessionId = newSession();
        this.app.session = this.sessionId;
        this.delay = MIN_DELAY;
        return this.connect();
      }
      this.retry = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, MAX_DELAY);
    };
  }

  dismiss(runId: string): void {
    this.send({ dismiss: runId });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async handle(f: Frame): Promise<void> {
    const run = f.run;
    if (typeof run !== "string") return;
    if (f.started) return this.startedRun(run, f.started);
    if (f.exited) return this.exited(run, f.exited);
    if (f.id === undefined) return;
    try {
      let result: unknown;
      if (typeof f.eval === "string") {
        result = await evalInPage(this.api, this.app, f.eval);
      } else if (typeof f.call === "string") {
        result = toJson(await this.call(run, f.call, Array.isArray(f.args) ? f.args : []));
      } else {
        return;
      }
      this.send({ run, id: f.id, result });
    } catch (err) {
      this.send({ run, id: f.id, error: String((err as Error)?.message ?? err) });
    }
  }

  private call(run: string, name: string, args: unknown[]): unknown {
    const fn = Object.hasOwn(this.api, name) ? (this.api as unknown as Record<string, unknown>)[name] : undefined;
    if (typeof fn !== "function") throw new Error("no such method");
    const id = args[0];
    if (name === "addButton" && typeof id === "string") {
      // Group the button under its run in the menu's Commands level.
      const opts = (args[2] && typeof args[2] === "object" ? args[2] : {}) as Record<string, unknown>;
      args = [args[0], args[1], { ...opts, run: this.runs.get(run)?.label ?? run }];
    }
    const result = (fn as (...a: unknown[]) => unknown).apply(this.api, args);
    if (name === "addButton" && typeof id === "string") {
      let set = this.buttons.get(run);
      if (!set) this.buttons.set(run, (set = new Set()));
      set.add(id);
    } else if (name === "removeButton" && typeof id === "string") {
      this.buttons.get(run)?.delete(id);
    }
    return result;
  }

  private startedRun(run: string, info: { label: string; detached: boolean }): void {
    this.announced?.add(run);
    this.runs.set(run, { label: String(info.label), detached: !!info.detached });
    if (!info.detached) return;
    if (this.app.source.kind === "server") this.notebooks.set(run, this.app.source.name);
    const chip = document.createElement("span");
    chip.className = "run";
    chip.dataset.run = run;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = String(info.label);
    const x = document.createElement("button");
    x.className = "dismiss";
    x.title = `Stop ${info.label}`;
    x.textContent = "×";
    x.onclick = () => this.dismiss(run);
    chip.append(label, x);
    this.root.querySelector(`.run[data-run="${CSS.escape(run)}"]`)?.remove();
    this.root.appendChild(chip);
  }

  /** Drop every run the server did not re-announce after this connect: it ended while we were away. */
  private prune(): void {
    const live = this.announced ?? new Set<string>();
    this.announced = null;
    const known = new Set([...this.runs.keys(), ...this.buttons.keys()]);
    for (const el of this.root.querySelectorAll<HTMLElement>(".run[data-run]")) known.add(el.dataset.run!);
    let dropped = false;
    for (const run of known) {
      if (live.has(run)) continue;
      this.forget(run);
      dropped = true;
    }
    if (dropped) this.app.progress(null);
  }

  /** Remove a run's chip and buttons and stop tracking it. */
  private forget(run: string): void {
    this.runs.delete(run);
    this.notebooks.delete(run);
    this.root.querySelector(`.run[data-run="${CSS.escape(run)}"]`)?.remove();
    for (const id of this.buttons.get(run) ?? []) this.app.removeButton(id);
    this.buttons.delete(run);
  }

  private async exited(run: string, exit: ExitInfo): Promise<void> {
    const info = this.runs.get(run);
    const notebook = this.notebooks.get(run);
    this.forget(run);
    this.app.progress(null);
    // A normal run's result comes back on its HTTP request, which handles the
    // file change itself; only a detached run's change is ours to apply.
    if (!info?.detached || notebook === undefined) return;
    if (this.app.source.kind !== "server" || this.app.source.name !== notebook) return;
    // The page's own autosaves during the run change the file too.
    if (!this.app.changedByOther(notebook, exit.changed, exit.mtime)) return;
    if (exit.reload) await this.app.reloadNotebook(notebook);
    else this.app.noteExternalChange(notebook, exit.mtime);
  }
}

/** This tab's session id: kept in sessionStorage so a reload finds its runs again. */
function loadSession(): string {
  let id: string | null = null;
  try {
    id = sessionStorage.getItem(SESSION_KEY);
  } catch {
    /* storage blocked */
  }
  if (id && /^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  return newSession();
}

/** A fresh session id, stored for this tab. */
function newSession(): string {
  const id = newId();
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    /* storage blocked: the id lasts as long as the page */
  }
  return id;
}

/** crypto.randomUUID, or the same from getRandomValues where it is missing (plain http to a LAN host). */
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
