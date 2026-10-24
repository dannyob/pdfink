import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { Bookmark, ClipContent, ImageItem, LinkItem, PageModel, Point, Rect, Stroke } from "./model";
import { DEFAULT_PRESSURE, newId } from "./model";
import { barrelBit, barrelHeuristic, heuristicOnly, hoverErase, wantsErase, writingPressure } from "./stylus";
import { ContextMenu, type MenuItem } from "./menu";
import { icons } from "./icons";
import { dialog } from "./dialog";
import {
  imageBounds,
  imageInRect,
  linkBounds,
  normalizeRect,
  pointInRect,
  rectInRect,
  strokeBounds,
  strokeHit,
  strokeInRect,
  translateImage,
  translateRect,
  translateStroke,
  unionRect,
} from "./geometry";
import { importPdf } from "./pdf/import";
import { linkUrlOk } from "./pdf/links";
import { appendBlankPage, createBlankPdf, exportPdf } from "./pdf/export";
import { PageView, drawStroke, pruneImageCache, shortUrl, type SelectionView } from "./render/pageview";
import { normalizeUrl, todayIso } from "./links-ui";
import { displayToPdf, normalizeRotate, type PageGeom } from "./pdf/geom";
import { ConflictError, listCommands, listNotebooks, loadNotebook, openNotebookParsed, runCommand, saveNotebook, saveNotebookParsed, type CommandInfo, type NotebookInfo } from "./api";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export type Tool = "pen" | "eraser" | "select";

/** Events a page-side API can listen to with `App.on`. */
export type AppEvent = "selection" | "save" | "page" | "notebook" | "stroke" | "button" | "bookmarks";

export interface SelectionInfo {
  page: number;
  /** The rectangle the user (or `selectRect`) drew, if any. */
  marquee: Rect | null;
  /** Bounds of the selected strokes, images and links, if any. */
  bounds: Rect | null;
  /** Union of marquee and bounds, in page space. */
  rect: Rect;
  /** `rect` in PDF user space (points, y up). */
  pdfRect: Rect;
  strokeIds: string[];
  imageIds: string[];
  linkIds: string[];
}

interface Selection extends SelectionView {
  page: number;
}

interface PageSnapshot {
  strokes: Stroke[];
  images: ImageItem[];
  links: LinkItem[];
}

interface UndoEntry {
  page: number;
  before: PageSnapshot;
  after: PageSnapshot;
}

interface Pointer {
  pointerId: number;
  page: number;
  mode: "draw" | "erase" | "select";
  stroke?: Stroke;
  drawnUpTo?: number;
  start?: Point;
  snapshot?: PageSnapshot;
  erased?: boolean;
  /** Erase mode came from the barrel heuristic, so pressure may flip it back to drawing. */
  heuristic?: boolean;
  /** Down with contact bit but no pressure: wait for a move before erasing anything. */
  pending?: boolean;
  /** Stroke finished just before switching to erase; the eraser starts on top of it, so spare it briefly. */
  keep?: string;
  keepUntil?: number;
  /** A finger, in finger-draws mode. */
  touch?: boolean;
}

type FileHandle = { name: string; createWritable(): Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }>; getFile(): Promise<File> };
declare global {
  interface Window {
    showOpenFilePicker?: (o?: unknown) => Promise<FileHandle[]>;
    showSaveFilePicker?: (o?: unknown) => Promise<FileHandle>;
  }
}

const ERASE_RADIUS = 5; // page points around the eraser tip
/** How long the segment written just before a barrel press is spared from the eraser. */
const KEEP_MS = 250;

/** Pen pressure for a pointer event; mice and fingers draw at nominal width. */
function pressureOf(e: PointerEvent): number {
  if (e.pointerType !== "pen") return DEFAULT_PRESSURE;
  const p = e.pressure;
  return p > 0 ? Math.max(0.05, Math.min(1, p)) : DEFAULT_PRESSURE;
}
const MIN_SELECT = 3;
/** A finger that lifts within this long and this far (client px) of where it went down tapped. */
const TAP_MS = 300;
const TAP_SLOP_PX = 8;

/** Throw a TypeError naming the bad field unless `s` is a stroke the model can hold. */
function checkStroke(s: unknown, i: number): void {
  const at = `strokes[${i}]`;
  if (!s || typeof s !== "object") throw new TypeError(`${at} must be an object`);
  const { points, color, width, opacity, id } = s as Record<string, unknown>;
  if (!Array.isArray(points) || !points.length) throw new TypeError(`${at}.points must be a non-empty array`);
  points.forEach((pt, k) => {
    const q = pt as Record<string, unknown> | null;
    if (!q || ![q.x, q.y, q.p].every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new TypeError(`${at}.points[${k}] must have finite x, y and p`);
    }
  });
  if (typeof color !== "string" || !color) throw new TypeError(`${at}.color must be a CSS colour string`);
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) throw new TypeError(`${at}.width must be a positive number`);
  if (typeof opacity !== "number" || !(opacity >= 0 && opacity <= 1)) throw new TypeError(`${at}.opacity must be between 0 and 1`);
  if (id !== undefined && (typeof id !== "string" || !id)) throw new TypeError(`${at}.id must be a non-empty string`);
}

export class App {
  pages: PageModel[] = [];
  views: PageView[] = [];
  baseBytes: Uint8Array | null = null;
  pdfDoc: PDFDocumentProxy | null = null;
  tool: Tool = "pen";
  /** Treat pressure pinned to 0 or 1 with the contact bit as a barrel-button press. See stylus.ts. */
  barrelHeuristic = true;
  penColor = "#000000";
  penWidth = 1;
  scale = 1;
  selection: Selection | null = null;
  clip: ClipContent | null = null;
  undoStack: UndoEntry[] = [];
  redoStack: UndoEntry[] = [];
  fileName = "untitled.pdf";
  fileHandle: FileHandle | null = null;
  /**
   * "server": notebooks live in a folder behind the pdfink server.
   * "local": no server; files are opened from and saved to this device.
   */
  storage: "server" | "local" = "local";
  /** Where the current document lives: a notebook on the server, or only in this tab. */
  source: { kind: "server"; name: string; mtime: number } | { kind: "local"; name: string } = { kind: "local", name: "untitled.pdf" };
  /** Tests set this so Export never opens a native picker. */
  forceDownload = false;
  dirty = false;
  saving = false;
  lastSaved: Date | null = null;
  /** Milliseconds of quiet after a change before a server notebook autosaves. */
  autosaveDelay = 10_000;
  private autosaveTimer: number | null = null;
  /** Bumped on every change so a save knows whether edits arrived while it ran. */
  private revision = 0;
  /** Bumped when the base PDF itself changes in the browser (a page added); the
   *  server only has our base once a save has carried it. */
  private baseRevision = 0;
  private baseSaved = 0;
  /** Hooks for confirmations and names, replaceable in tests. */
  confirmFn: (message: string) => Promise<boolean> = dialog.confirm;
  promptFn: (message: string, suggestion: string) => Promise<string | null> = dialog.ask;
  /** Called after the notebook list on the server may have changed. */
  onNotebooksChanged: () => void = () => {};
  /** Fingers draw instead of scrolling (phones and tablets without a pen). */
  fingerDraws = false;
  /** Called when the app itself turns finger drawing off because a pen appeared. */
  onFingerDrawsChanged: (on: boolean) => void = () => {};
  lastPointer: { page: number; x: number; y: number } | null = null;
  currentPage = 0;
  /** The document outline, in page order; replaced on every open. */
  bookmarks: Bookmark[] = [];
  /**
   * Set once the outline is edited here, cleared on open. Until then saves
   * leave the file's /Outlines alone, since the bookmark list cannot carry
   * everything an outline can (closed items, positions, zoom, actions).
   */
  private bookmarksChanged = false;
  /** Id of this tab's page-bridge session (set by main.ts). */
  session: string | null = null;
  private pointers = new Map<number, Pointer>();
  private observer: IntersectionObserver;
  private status: HTMLElement;
  /** Finger scroll done by hand while touch-action is off because a pen was near. */
  private touchScroll: { id: number; x: number; y: number } | null = null;
  /** Fingers down while fingers scroll, and the one that may turn out to be a tap on a link. */
  private touchesDown = new Set<number>();
  private touchTap: { id: number; x: number; y: number; t: number } | null = null;
  private raf = 0;

  constructor(readonly container: HTMLElement) {
    this.status = document.getElementById("status") as HTMLElement;
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: container,
      rootMargin: "100% 0px",
    });
    this.bindPointerEvents();
    this.bindKeyboard();
    this.bindDrop();
    this.setTool("pen");
    this.showEmpty();
    this.container.addEventListener("scroll", () => this.updateCurrentPage(), { passive: true });
    window.addEventListener("resize", () => this.fitWidth());
  }

  // ---------------------------------------------------------------- loading

  private showEmpty(error?: string): void {
    const div = document.createElement("div");
    div.className = "empty";
    div.innerHTML = `<p><b>pdfink</b></p><p>Open a PDF, start a new one, or drop a PDF here.</p><p>Pen writes. Pen eraser (or barrel button) erases. Fingers scroll, or draw when <i>finger draws</i> is on.</p>`;
    if (error) {
      const p = document.createElement("p");
      p.className = "error";
      p.textContent = error;
      div.appendChild(p);
    }
    this.container.replaceChildren(div);
    this.setStatus();
  }

  async loadBytes(bytes: Uint8Array, name: string, handle: FileHandle | null = null): Promise<boolean> {
    this.setStatus("Loading…");
    this.cancelAutosave();
    try {
      const imported = await importPdf(bytes);
      return await this.loadParsed(imported.baseBytes, imported.pages, name, handle, imported.bookmarks);
    } catch (err) {
      console.error(err);
      this.setStatus(`Could not open ${name}: ${(err as Error).message}`);
      if (!this.views.length) this.showEmpty(`Could not open ${name}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Install an already-separated document (base PDF without ink + stroke pages). */
  async loadParsed(baseBytes: Uint8Array, pages: PageModel[], name: string, handle: FileHandle | null = null, bookmarks: Bookmark[] = []): Promise<boolean> {
    this.cancelAutosave();
    try {
      await this.setDocument(baseBytes, pages);
      this.bookmarks = bookmarks;
      this.bookmarksChanged = false;
      this.fileName = name;
      this.fileHandle = handle;
      this.source = { kind: "local", name };
      this.undoStack = [];
      this.redoStack = [];
      this.dirty = false;
      this.lastSaved = null;
      this.setStatus();
      this.emit("bookmarks", this.bookmarks);
      return true;
    } catch (err) {
      console.error(err);
      this.setStatus(`Could not open ${name}: ${(err as Error).message}`);
      if (!this.views.length) this.showEmpty(`Could not open ${name}: ${(err as Error).message}`);
      return false;
    }
  }

  /** A blank document that lives only in this tab until exported or saved as a notebook. */
  async newDocument(): Promise<void> {
    const bytes = await createBlankPdf(1);
    await this.loadBytes(bytes, "untitled.pdf", null);
  }

  // ---------------------------------------------------------------- local files (browser mode)

  /** Open a PDF from this device. Keeps a file handle where the browser offers one, so Save writes back. */
  async open(): Promise<void> {
    if (!(await this.readyToLeave())) return;
    if (window.showOpenFilePicker && !this.forceDownload) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
        });
        const file = await handle.getFile();
        await this.loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, handle);
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    (document.getElementById("file-input") as HTMLInputElement).click();
  }

  async openFile(file: File): Promise<void> {
    if (!(await this.readyToLeave())) return;
    await this.loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, null);
  }

  /** Save as: forget the current file handle so the browser asks where to put it. */
  async saveAs(): Promise<void> {
    this.fileHandle = null;
    await this.exportLocal();
  }

  // ---------------------------------------------------------------- notebooks (server)

  async refreshNotebooks(): Promise<NotebookInfo[]> {
    return listNotebooks();
  }

  /** Save-or-discard check before replacing the current document. */
  private async readyToLeave(): Promise<boolean> {
    if (!this.dirty || !this.baseBytes) return true;
    if (this.source.kind === "server") {
      await this.saveToServer();
      return !this.dirty;
    }
    return this.confirmFn(`${this.source.name} has unsaved changes that will be lost. Continue?`);
  }

  async openNotebook(name: string): Promise<boolean> {
    if (!(await this.readyToLeave())) return false;
    this.setStatus(`Loading ${name}…`);
    let loaded: { baseBytes: Uint8Array; pages: PageModel[]; bookmarks: Bookmark[]; mtime: number };
    try {
      // The server separates ink from the PDF, so even very large notebooks
      // arrive here as a small base PDF plus stroke data.
      loaded = await openNotebookParsed(name);
    } catch (err) {
      this.setStatus((err as Error).message);
      return false;
    }
    if (!(await this.loadParsed(loaded.baseBytes, loaded.pages, name, null, loaded.bookmarks))) return false;
    this.source = { kind: "server", name, mtime: loaded.mtime };
    this.baseSaved = this.baseRevision;
    this.setStatus();
    this.emit("notebook", { name });
    return true;
  }

  static normalizeNotebookName(raw: string): string | null {
    let name = raw.trim().replace(/[\/:]+/g, "-");
    if (!name) return null;
    if (!/\.pdf$/i.test(name)) name += ".pdf";
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]*\.pdf$/i.test(name) || name.includes("..")) return null;
    return name;
  }

  async newNotebook(): Promise<boolean> {
    if (!(await this.readyToLeave())) return false;
    const today = new Date().toISOString().slice(0, 10);
    const raw = await this.promptFn("Name for the new notebook", `${today}.pdf`);
    if (raw === null) return false;
    const name = App.normalizeNotebookName(raw);
    if (!name) {
      this.setStatus(`"${raw}" is not a usable notebook name (letters, digits, spaces, . _ - ( ) only).`);
      return false;
    }
    try {
      const bytes = await createBlankPdf(1);
      await saveNotebook(name, bytes, "new");
    } catch (err) {
      this.setStatus(err instanceof ConflictError ? `${name} already exists.` : (err as Error).message);
      return false;
    }
    this.onNotebooksChanged();
    return this.openNotebook(name);
  }

  /** Store the current document on the server under `name` (asking before overwriting). */
  async saveAsNotebook(name: string): Promise<boolean> {
    if (!this.baseBytes) return false;
    this.setStatus(`Saving ${name}…`);
    let bytes: Uint8Array;
    try {
      bytes = await this.exportBytes();
    } catch (err) {
      this.setStatus(`Could not build the PDF: ${(err as Error).message}`);
      return false;
    }
    const rev = this.revision;
    try {
      let info: NotebookInfo;
      try {
        info = await saveNotebook(name, bytes, "new");
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        if (!(await this.confirmFn(`${name} already exists in the notebooks folder. Replace it?`))) {
          this.setStatus(`Not saved: ${name} already exists.`);
          return false;
        }
        info = await saveNotebook(name, bytes, null);
      }
      this.fileName = name;
      this.source = { kind: "server", name, mtime: info.mtime };
      this.baseSaved = this.baseRevision; // the upload carried our base
      this.lastSaved = new Date();
      if (rev === this.revision) this.dirty = false;
      else this.scheduleAutosave();
      this.onNotebooksChanged();
      this.setStatus();
      return true;
    } catch (err) {
      console.error(err);
      this.setStatus((err as Error).message);
      return false;
    }
  }

  /** Write the current server notebook back. Returns true when the file on disk is now current. */
  async saveToServer(force = false): Promise<boolean> {
    if (this.source.kind !== "server" || !this.baseBytes) return false;
    if (this.saving) {
      this.scheduleAutosave(500);
      return false;
    }
    this.cancelAutosave();
    this.saving = true;
    const { name } = this.source;
    const rev = this.revision;
    this.setStatus(`Saving ${name}…`);
    try {
      // Only the ink travels; the server rebuilds the PDF from its ink-free
      // base. Our own base goes too when it differs from the server's (a page
      // was added here) or on a forced overwrite, so the result is exactly
      // this tab's version.
      const baseRev = this.baseRevision;
      const sendBase = force || baseRev !== this.baseSaved;
      const info = await saveNotebookParsed(name, this.pages, force ? null : this.source.mtime, sendBase ? this.baseBytes : null, this.outlineToSave());
      this.source = { kind: "server", name, mtime: info.mtime };
      if (sendBase) this.baseSaved = baseRev;
      this.lastSaved = new Date();
      this.saving = false;
      if (rev === this.revision) this.dirty = false;
      else this.scheduleAutosave();
      this.setStatus();
      this.emit("save", { name, mtime: info.mtime });
      return true;
    } catch (err) {
      this.saving = false;
      if (err instanceof ConflictError) {
        if (err.mtime === null) {
          // The file is gone, so the server has no base to rebuild from:
          // write a complete PDF from the browser instead.
          if (await this.confirmFn(`${name} no longer exists in the notebooks folder. Save it again anyway?`)) {
            return this.saveAsNotebook(name);
          }
          this.setStatus(`Not saved: ${name} no longer exists on disk. Export to keep this version.`);
          return false;
        }
        const msg = `${name} changed in the notebooks folder since you opened it (perhaps synced from another device). Overwrite it with this version?`;
        if (await this.confirmFn(msg)) return this.saveToServer(true);
        this.setStatus(`Not saved: ${name} changed on disk. Export to keep this version, or Save again to overwrite.`);
        return false;
      }
      console.error(err);
      this.setStatus(`Could not save ${name}: ${(err as Error).message}`);
      return false;
    } finally {
      this.saving = false;
    }
  }

  private scheduleAutosave(delay = this.autosaveDelay): void {
    if (this.source.kind !== "server") return;
    this.cancelAutosave();
    this.autosaveTimer = window.setTimeout(() => {
      this.autosaveTimer = null;
      if (!this.dirty) return;
      if (this.pointers.size || this.saving) {
        this.scheduleAutosave(1000);
        return;
      }
      void this.saveToServer();
    }, delay);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  async addPage(): Promise<void> {
    if (!this.baseBytes) return this.newDocument();
    try {
      const bytes = await appendBlankPage(this.baseBytes);
      const last = this.pages[this.pages.length - 1];
      const pages = [...this.pages, { width: last?.width ?? 612, height: last?.height ?? 792, strokes: [], images: [], links: [] }];
      await this.setDocument(bytes, pages);
      this.baseRevision += 1;
      this.markDirty();
      this.scrollToPage(pages.length - 1);
      this.setStatus();
    } catch (err) {
      console.error(err);
      this.setStatus(`Could not add a page: ${(err as Error).message}`);
    }
  }

  /** Replace base bytes + models and rebuild the page views. */
  private async setDocument(baseBytes: Uint8Array, pages: PageModel[]): Promise<void> {
    // Parse first so a bad file leaves the current document untouched.
    // pdf.js transfers the buffer to the worker, so give it a copy.
    const pdfDoc = await pdfjs.getDocument({ data: baseBytes.slice() }).promise;
    const geoms = await Promise.all(
      Array.from({ length: pdfDoc.numPages }, async (_, i): Promise<PageGeom> => {
        const { view, rotate } = await pdfDoc.getPage(i + 1);
        return { cx: view[0], cy: view[1], cw: view[2] - view[0], ch: view[3] - view[1], rotate: normalizeRotate(rotate) };
      }),
    );
    for (const v of this.views) {
      this.observer.unobserve(v.el);
      v.destroy();
    }
    this.views = [];
    this.setSelection(null);
    this.pointers.clear();
    if (this.pdfDoc) void this.pdfDoc.loadingTask.destroy();
    this.pdfDoc = pdfDoc;
    this.geoms = geoms;
    this.baseBytes = baseBytes;
    this.pages = pages;
    pruneImageCache(new Set(pages.flatMap((p) => p.images.map((im) => im.id))));
    this.container.innerHTML = "";
    for (let i = 0; i < pages.length; i++) {
      const v = new PageView(i, pages[i]);
      this.views.push(v);
      this.container.appendChild(v.el);
      this.observer.observe(v.el);
    }
    this.fitWidth();
  }

  // ---------------------------------------------------------------- layout

  fitWidth(): void {
    if (!this.views.length) return;
    const maxW = Math.max(...this.pages.map((p) => p.width));
    const avail = this.container.clientWidth - 32;
    const scale = Math.max(0.2, Math.min(avail / maxW, 3));
    this.setScale(scale);
  }

  setScale(scale: number): void {
    this.scale = scale;
    for (const v of this.views) v.setScale(scale);
    this.renderVisible();
  }

  zoom(factor: number): void {
    this.setScale(Math.max(0.2, Math.min(this.scale * factor, 6)));
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const idx = Number((e.target as HTMLElement).dataset.page);
      const v = this.views[idx];
      if (!v) continue;
      if (e.isIntersecting) {
        void v.renderBase(this.pdfDoc!);
        v.drawInk(this.selectionFor(idx));
      } else if (!this.pointers.size || ![...this.pointers.values()].some((p) => p.page === idx)) {
        v.release();
      }
    }
  }

  private renderVisible(): void {
    const r = this.container.getBoundingClientRect();
    for (const v of this.views) {
      const b = v.el.getBoundingClientRect();
      if (b.bottom >= r.top - r.height && b.top <= r.bottom + r.height) {
        void v.renderBase(this.pdfDoc!);
        v.drawInk(this.selectionFor(v.index), null, true);
      }
    }
    this.updateCurrentPage();
  }

  private updateCurrentPage(): void {
    if (!this.views.length) return;
    const r = this.container.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    let best = 0;
    let bestDist = Infinity;
    for (const v of this.views) {
      const b = v.el.getBoundingClientRect();
      const d = Math.abs((b.top + b.bottom) / 2 - mid);
      if (d < bestDist) {
        bestDist = d;
        best = v.index;
      }
    }
    if (best !== this.currentPage) {
      this.currentPage = best;
      this.setStatus();
      this.emit("page", { page: best });
    }
  }

  scrollToPage(i: number): void {
    const v = this.views[i];
    if (v) v.el.scrollIntoView({ block: "start" });
  }

  setStatus(msg?: string): void {
    if (msg !== undefined) {
      this.status.textContent = msg;
      return;
    }
    const n = this.pages.length;
    const sel = this.selection ? ` · ${this.selection.strokeIds.size + this.selection.imageIds.size + this.selection.linkIds.size} selected` : "";
    let state = "";
    if (this.saving) state = " · saving…";
    else if (this.dirty) state = this.source.kind === "server" || this.storage === "local" ? " · unsaved" : " (not in notebooks)";
    else if (this.lastSaved) state = ` · saved ${this.lastSaved.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    else if (this.source.kind === "local" && this.storage === "server") state = " (not in notebooks)";
    this.status.textContent = n ? `${this.fileName}${state} · page ${this.currentPage + 1}/${n}${sel}` : "";
  }

  // ---------------------------------------------------------------- tools

  setBarrelHeuristic(on: boolean): void {
    this.barrelHeuristic = on;
  }

  setFingerDraws(on: boolean): void {
    this.fingerDraws = on;
    this.container.classList.toggle("finger-draws", on);
  }

  /** A pen is present: hand scrolling back to fingers unless the user insisted. */
  private penSeen(): void {
    if (this.fingerDraws && !this.fingerDrawsPinned) {
      this.setFingerDraws(false);
      this.onFingerDrawsChanged(false);
    }
  }

  /** Set when the user ticked "finger draws" themselves, so a pen doesn't undo it. */
  fingerDrawsPinned = false;

  /** The pen's context menu: barrel button (when it isn't set to erase) or right-click. */
  readonly menu = new ContextMenu();
  /** Pointer whose held barrel button already opened the menu, so a hover doesn't reopen it. */
  private menuPointer: number | null = null;
  private lastPointerType = "";

  /** Commands from the server's commands file (server mode). */
  commands: CommandInfo[] = [];
  /** Where the menu was opened, in page space, for commands. */
  private menuPoint: { page: number; x: number; y: number } | null = null;

  async refreshCommands(): Promise<void> {
    if (this.storage !== "server") return;
    try {
      this.commands = await listCommands();
    } catch {
      this.commands = [];
    }
  }

  /** Run a configured command at the point the menu was opened. */
  async runMenuCommand(cmd: CommandInfo): Promise<void> {
    const at = this.menuPoint ?? this.lastPointer;
    if (!at || this.source.kind !== "server") {
      this.setStatus("Commands need a notebook saved in the notebooks folder.");
      return;
    }
    if (cmd.confirm && !(await this.confirmFn(`Run "${cmd.label}" on page ${at.page + 1} of ${this.source.name}?`))) return;
    // The command works on the file, so it must see what is on screen.
    if (this.dirty && !(await this.saveToServer())) return;
    const { name } = this.source;
    const running = `Running ${cmd.label}…`;
    this.setStatus(running);
    const sel = this.selectionInfo();
    const selection = sel ? { page: sel.page, rect: sel.rect, count: sel.strokeIds.length + sel.imageIds.length + sel.linkIds.length } : null;
    let run;
    try {
      run = await runCommand(cmd.id, { name, page: at.page, x: at.x, y: at.y, session: this.session ?? undefined, selection });
    } catch (err) {
      this.setStatus((err as Error).message);
      return;
    }
    if (run.detached) {
      this.setStatus(`${cmd.label} attached`);
      return;
    }
    const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
    const changed = this.changedByOther(name, run.changed, run.mtime);
    if (run.status !== 0) {
      const why = run.timedOut ? "timed out" : firstLine(run.stderr) || firstLine(run.stdout) || `exit ${run.status ?? run.signal}`;
      this.setStatus(`${cmd.label} failed: ${why}`);
      if (changed) this.noteExternalChange(name, run.mtime);
      return;
    }
    if (changed) {
      if (run.reload) {
        await this.reloadNotebook(name);
      } else {
        this.noteExternalChange(name, run.mtime);
      }
    }
    const said = firstLine(run.stdout);
    // A command that showed its own message (pdfink.toast) and printed nothing keeps it.
    if (!said && this.status.textContent !== running) return;
    this.setStatus(said ? `${cmd.label}: ${said}` : `${cmd.label} done`);
  }

  /**
   * Whether a finished command's "the file changed" is someone else's doing.
   * The page may have saved during the run (an autosave in a long or detached
   * one); when the file's mtime at exit is the one our last save got, the
   * last writer was us and there is nothing to reload or adopt.
   */
  changedByOther(name: string, changed: boolean, mtime: number | null): boolean {
    if (!changed) return false;
    return !(this.source.kind === "server" && this.source.name === name && mtime !== null && mtime === this.source.mtime);
  }

  /** The file changed under us (by a command we ran): accept its new mtime so the next save doesn't conflict. */
  noteExternalChange(name: string, mtime: number | null): void {
    if (this.source.kind === "server" && this.source.name === name && mtime !== null) {
      // Only the mtime: a page added here since the last save has still not reached the server.
      this.source = { kind: "server", name, mtime };
    }
  }

  /** Reopen the notebook from disk, keeping zoom and scroll position. */
  async reloadNotebook(name: string): Promise<boolean> {
    // Not under the pen: a reload rebuilds the pages and would drop a stroke in progress.
    while (this.pointers.size) await new Promise((r) => setTimeout(r, 200));
    const scale = this.scale;
    const { scrollTop, scrollLeft } = this.container;
    const ok = await this.openNotebook(name);
    if (!ok) return false;
    if (this.scale !== scale) this.setScale(scale);
    this.container.scrollTop = scrollTop;
    this.container.scrollLeft = scrollLeft;
    return true;
  }

  private penMenuItems(): MenuItem[] {
    const sel = !!this.selectedContent();
    const at = this.menuPoint;
    const link = at ? this.linkAt(at.page, at.x, at.y) : null;
    const linkItems: MenuItem[] = link
      ? [
          { label: `Open ${shortUrl(link.url)}`, tint: "context", action: () => this.openLink(link) },
          { label: "Edit URL…", tint: "context", action: () => void this.editLinkUrl(link) },
          { separator: true },
        ]
      : [];
    const marquee = this.selectionInfo()?.marquee;
    const commandItems: MenuItem[] = [
      ...this.commands.map((c): MenuItem => ({ label: c.label, tint: "command", disabled: this.source.kind !== "server", action: () => void this.runMenuCommand(c) })),
      ...this.menuButtonItems(),
    ];
    const commands: MenuItem[] = commandItems.length ? [{ separator: true }, { kind: "submenu", label: "Commands", heading: "Commands", items: commandItems }] : [];
    return [
      ...linkItems,
      {
        kind: "row",
        items: [
          { label: "Pen", icon: icons.pen, checked: this.tool === "pen", action: () => this.setTool("pen") },
          { label: "Eraser", icon: icons.eraser, checked: this.tool === "eraser", action: () => this.setTool("eraser") },
          { label: "Select", icon: icons.select, checked: this.tool === "select", action: () => this.setTool("select") },
        ],
      },
      {
        kind: "row",
        items: [
          { label: "Copy", icon: icons.copy, disabled: !sel, action: () => void this.copy() },
          { label: "Cut", icon: icons.cut, disabled: !sel, action: () => void this.cut() },
          { label: "Paste", icon: icons.paste, action: () => void this.pasteFromButton() },
          { label: "Delete", icon: icons.trash, disabled: !sel, action: () => this.deleteSelection() },
        ],
      },
      {
        kind: "row",
        items: [
          { label: "Undo", icon: icons.undo, disabled: this.undoStack.length === 0, action: () => this.undo() },
          { label: "Redo", icon: icons.redo, disabled: this.redoStack.length === 0, action: () => this.redo() },
        ],
      },
      { separator: true },
      { label: "Add link…", disabled: !(marquee && marquee.w > 0 && marquee.h > 0), action: () => void this.addLinkOnSelection() },
      { label: "Bookmark this page…", action: () => void this.bookmarkMenuPage(at?.page ?? this.currentPage) },
      { label: "Add page", action: () => void this.addPage() },
      { label: "Save", action: () => void this.save() },
      ...commands,
    ];
  }

  /** Ask for a new url for `link`; blank or cancelled leaves it. */
  private async editLinkUrl(link: LinkItem): Promise<void> {
    const answer = await this.promptFn("Link URL", link.url);
    const url = normalizeUrl(answer ?? "");
    if (!url || url === link.url) return;
    if (!linkUrlOk(url)) {
      this.setStatus(`Not a web link: ${answer!.trim()}`);
      return;
    }
    this.setLink(link.id, { url });
  }

  /** Ask for a url and put a link on the selection's marquee. */
  private async addLinkOnSelection(): Promise<void> {
    const sel = this.selectionInfo();
    if (!sel?.marquee) return;
    const answer = await this.promptFn("Link URL", "https://");
    const url = normalizeUrl(answer ?? "");
    if (!url) return;
    if (!linkUrlOk(url)) {
      this.setStatus(`Not a web link: ${answer!.trim()}`);
      return;
    }
    this.addLink(sel.page, sel.rect, url);
  }

  /** Ask for a title (today's date by default) and bookmark `page`. */
  private async bookmarkMenuPage(page: number): Promise<void> {
    const title = (await this.promptFn("Bookmark title", todayIso()))?.trim();
    if (!title || !this.pages[page]) return;
    this.addBookmark(page, title);
  }

  openPenMenu(x: number, y: number, pointerId: number | null = null): void {
    this.menuPoint = this.pagePointAt(x, y);
    this.menu.show(x, y, this.penMenuItems(), pointerId);
    void this.refreshCommands(); // for next time; the file may have been edited
  }

  /** Page index and page-space point under a client point, if it is on a page. */
  private pagePointAt(clientX: number, clientY: number): { page: number; x: number; y: number } | null {
    for (const v of this.views) {
      const r = v.el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        const p = v.toPage(clientX, clientY);
        return { page: v.index, x: p.x, y: p.y };
      }
    }
    return null;
  }

  /** Barrel pressed while the button is not set to erase: that opens the menu. */
  private barrelMenuPress(e: { pointerType: string; buttons: number; pressure: number }): boolean {
    return !this.barrelHeuristic && e.pointerType === "pen" && (barrelBit(e) || barrelHeuristic(e));
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    for (const t of ["pen", "eraser", "select"] as Tool[]) {
      this.container.classList.toggle(`tool-${t}`, t === tool);
    }
    this.paintToolButtons();
    if (tool !== "select") this.clearSelection();
  }

  /** True while any pen gesture is erasing (eraser end, barrel button, or heuristic). */
  get erasing(): boolean {
    if (this.hoverErase) return true;
    for (const p of this.pointers.values()) if (p.mode === "erase" && !p.pending) return true;
    return false;
  }

  /** Highlight the tool in effect: the Eraser button lights up while erasing with the pen. */
  private paintToolButtons(): void {
    const shown: Tool = this.erasing ? "eraser" : this.tool;
    for (const t of ["pen", "eraser", "select"] as Tool[]) {
      document.getElementById(`tool-${t}`)?.classList.toggle("active", t === shown);
    }
  }

  private selectionFor(page: number): SelectionView | null {
    return this.selection && this.selection.page === page ? this.selection : null;
  }

  clearSelection(): void {
    if (!this.selection) return;
    const p = this.selection.page;
    this.setSelection(null);
    this.redraw(p);
    this.setStatus();
  }

  private redraw(page: number): void {
    const v = this.views[page];
    if (!v) return;
    v.invalidate();
    v.drawInk(this.selectionFor(page));
  }

  // ---------------------------------------------------------------- undo

  private snapshot(page: number): PageSnapshot {
    const m = this.pages[page];
    return { strokes: m.strokes, images: m.images, links: m.links };
  }

  private apply(page: number, snap: PageSnapshot): void {
    const m = this.pages[page];
    m.strokes = snap.strokes;
    m.images = snap.images;
    m.links = snap.links;
    this.markDirty();
    this.redraw(page);
  }

  private markDirty(): void {
    this.dirty = true;
    this.revision += 1;
    this.scheduleAutosave();
  }

  /** Replace a page's content, recording an undo step. */
  private commit(page: number, before: PageSnapshot, after: PageSnapshot): void {
    if (before.strokes === after.strokes && before.images === after.images && before.links === after.links) return;
    this.undoStack.push({ page, before, after });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.apply(page, after);
    this.setStatus();
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.clearSelection();
    this.apply(e.page, e.before);
    this.setStatus();
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.clearSelection();
    this.apply(e.page, e.after);
    this.setStatus();
  }

  // ---------------------------------------------------------------- pointer input

  private enablePenMode(): void {
    this.container.classList.add("pen-active");
  }

  /** A pen (or mouse) gesture is in progress, or the pen is in range. */
  private penBusy(): boolean {
    return this.container.classList.contains("pen-active") || [...this.pointers.values()].some((p) => !p.touch);
  }

  private disablePenMode(): void {
    if (this.pointers.size) return; // a pen stroke is in progress; keep panning off
    this.container.classList.remove("pen-active");
  }

  private viewFromEvent(e: Event): PageView | null {
    const t = e.target as HTMLElement | null;
    const el = t?.closest?.(".page") as HTMLElement | null;
    if (!el) return null;
    return this.views[Number(el.dataset.page)] ?? null;
  }

  /** Decide what a pointer wants to do, or null to let the browser have it. */
  private classify(e: PointerEvent): Pointer["mode"] | null {
    if (e.pointerType === "touch" && !this.fingerDraws) return null;
    if (e.pointerType === "pen") {
      if (wantsErase(e, this.barrelHeuristic)) return "erase";
    } else if (e.pointerType === "mouse" && e.button !== 0 && e.type === "pointerdown") {
      return null;
    }
    if (this.tool === "eraser") return "erase";
    if (this.tool === "select") return "select";
    return "draw";
  }

  private bindPointerEvents(): void {
    const c = this.container;
    c.addEventListener("pointerdown", (e) => this.onPointerDown(e), { passive: false });
    c.addEventListener("pointermove", (e) => this.onPointerMove(e), { passive: false });
    c.addEventListener("pointerup", (e) => this.onPointerUp(e));
    c.addEventListener("pointercancel", (e) => this.onPointerUp(e, true));
    c.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // A pen's barrel press can also fire contextmenu; when that press means
      // "erase", or a gesture is in progress, the browser's event is noise.
      if (this.lastPointerType === "pen" && this.barrelHeuristic) return;
      if (this.erasing || this.pointers.size) return;
      this.openPenMenu(e.clientX, e.clientY);
    });
    // Pen proximity → stop the browser from panning with the pen; give
    // panning back a moment after the pen goes out of range.
    c.addEventListener("pointerover", (e) => {
      if (e.pointerType === "pen") {
        this.enablePenMode();
        this.penSeen();
      }
    });
    c.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "pen") {
        this.endHoverErase();
        this.disablePenMode();
      }
    });
  }

  private onPointerDown(e: PointerEvent): void {
    this.lastPointerType = e.pointerType;
    if (e.pointerType === "pen") {
      this.enablePenMode();
      this.penSeen();
      if (this.barrelMenuPress(e)) {
        e.preventDefault();
        if (this.menuPointer !== e.pointerId || !this.menu.open) {
          this.menuPointer = e.pointerId;
          this.openPenMenu(e.clientX, e.clientY, e.pointerId);
        }
        return;
      }
    } else if (e.pointerType === "touch") {
      // The first finger of a gesture: forget any id whose pointerup never came.
      if (e.isPrimary) this.touchesDown.clear();
      this.touchesDown.add(e.pointerId);
      // One finger, fingers scrolling: it may be a tap on a link. A second finger is a pinch;
      // a touch while the pen is down or near is a palm.
      this.touchTap = !this.fingerDraws && this.touchesDown.size === 1 && !this.penBusy() ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
      if (this.fingerDraws) {
        // One finger draws. A second finger cancels that stroke and pans instead.
        const drawing = [...this.pointers.values()].find((p) => p.touch);
        if (drawing) {
          this.pointers.delete(drawing.pointerId);
          this.paintToolButtons();
          if (drawing.mode === "erase" && drawing.snapshot) this.apply(drawing.page, drawing.snapshot);
          else this.redraw(drawing.page);
          if (!this.touchScroll) this.touchScroll = { id: e.pointerId, x: e.clientX, y: e.clientY };
          return;
        }
        if (this.touchScroll) return;
      } else {
        // touch-action was sampled before this event: if the pen had turned it
        // off, the browser won't pan for this finger, so pan by hand instead.
        if (this.container.classList.contains("pen-active") && !this.pointers.size && !this.touchScroll) {
          this.touchScroll = { id: e.pointerId, x: e.clientX, y: e.clientY };
        }
        this.disablePenMode();
        return;
      }
    }
    const view = this.viewFromEvent(e);
    if (!view) return;
    const mode = this.classify(e);
    if (!mode) return;
    e.preventDefault();
    this.container.focus({ preventScroll: true });
    const p = view.toPage(e.clientX, e.clientY);
    const page = view.index;
    this.lastPointer = { page, x: p.x, y: p.y };
    const ptr: Pointer = { pointerId: e.pointerId, page, mode, touch: e.pointerType === "touch" };
    try {
      view.ink.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
    if (mode !== "select" && this.selection) this.clearSelection();
    if (mode === "draw") {
      ptr.stroke = {
        id: newId(),
        points: [{ x: p.x, y: p.y, p: pressureOf(e) }],
        color: this.penColor,
        width: this.penWidth,
        opacity: 1,
      };
      ptr.drawnUpTo = 0;
      view.drawStrokeTail(ptr.stroke, 0);
    } else if (mode === "erase") {
      ptr.snapshot = this.snapshot(page);
      if (e.pointerType === "pen" && heuristicOnly(e, this.barrelHeuristic)) {
        ptr.heuristic = true;
        // Contact bit with zero pressure might be a pen that reports 0 on its
        // first sample; don't erase under the tip until a move confirms it.
        if (e.pressure === 0) ptr.pending = true;
      }
      if (!ptr.pending) this.eraseAt(page, { x: p.x, y: p.y, p: 0 }, ptr);
    } else {
      ptr.start = { x: p.x, y: p.y, p: 0 };
      if (this.selection && this.selection.page !== page) this.clearSelection();
      this.setSelection({ page, rect: null, strokeIds: new Set(), imageIds: new Set(), linkIds: new Set() });
      this.redraw(page);
    }
    this.pointers.set(e.pointerId, ptr);
    this.paintToolButtons();
  }

  /** One undo step per barrel-button sweep, keyed by pointer. */
  private hoverErase: Pointer | null = null;

  private endHoverErase(): void {
    const h = this.hoverErase;
    if (!h) return;
    this.hoverErase = null;
    if (h.erased && h.snapshot) this.commit(h.page, h.snapshot, this.snapshot(h.page));
    this.paintToolButtons();
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      const tap = this.touchTap;
      if (tap && tap.id === e.pointerId && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP_PX) this.touchTap = null;
      const ts = this.touchScroll;
      if (ts && ts.id === e.pointerId) {
        this.container.scrollLeft -= e.clientX - ts.x;
        this.container.scrollTop -= e.clientY - ts.y;
        ts.x = e.clientX;
        ts.y = e.clientY;
        return;
      }
      if (!this.pointers.has(e.pointerId)) return;
    }
    if (e.pointerType === "pen") {
      this.lastPointerType = "pen";
      this.enablePenMode();
      const active = this.pointers.get(e.pointerId);
      if (!active && e.buttons === 0) this.menuPointer = null; // button released
      // Barrel held while hovering, with the button set to open the menu.
      if (!active && !this.barrelHeuristic && hoverErase(e, true)) {
        if (this.menuPointer !== e.pointerId && !this.menu.open) {
          this.menuPointer = e.pointerId;
          this.openPenMenu(e.clientX, e.clientY, e.pointerId);
        }
        return;
      }
      // Barrel-button hover erase: button held, no contact.
      if (!active && hoverErase(e, this.barrelHeuristic)) {
        const view = this.viewFromEvent(e);
        if (view) {
          if (this.hoverErase && this.hoverErase.page !== view.index) this.endHoverErase();
          if (!this.hoverErase) {
            this.hoverErase = { pointerId: e.pointerId, page: view.index, mode: "erase", snapshot: this.snapshot(view.index) };
            this.paintToolButtons();
          }
          const coalesced = e.getCoalescedEvents?.();
          for (const ev of coalesced && coalesced.length ? coalesced : [e]) {
            const p = view.toPage(ev.clientX, ev.clientY);
            this.eraseAt(view.index, { x: p.x, y: p.y, p: 0 }, this.hoverErase);
          }
        }
        return;
      }
      if (this.hoverErase) this.endHoverErase();
    }
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    e.preventDefault();
    const view = this.views[ptr.page];
    if (!view) return;
    const coalesced = e.getCoalescedEvents?.();
    const events = coalesced && coalesced.length ? coalesced : [e];
    if (ptr.mode !== "select") {
      for (const ev of events) {
        const p = view.toPage(ev.clientX, ev.clientY);
        if (e.pointerType === "pen" && !this.barrelHeuristic && ptr.mode === "draw" && barrelHeuristic(ev) && ev.pressure >= 1) {
          // Barrel pressed mid-stroke, set to open the menu: finish the stroke first.
          this.pointers.delete(ptr.pointerId);
          this.finishPointer(ptr, false);
          this.menuPointer = e.pointerId;
          this.openPenMenu(ev.clientX, ev.clientY, e.pointerId);
          return;
        }
        if (e.pointerType === "pen" && this.barrelHeuristic && this.tool === "pen") {
          // Barrel press/release mid-gesture on pens that only pin the pressure.
          if (ptr.mode === "draw" && barrelHeuristic(ev) && ev.pressure >= 1) {
            this.switchMode(ptr, "erase", p);
          } else if (ptr.mode === "erase" && ptr.heuristic && writingPressure(ev)) {
            this.switchMode(ptr, "draw", p);
            continue; // the new stroke already starts at p
          } else if (ptr.pending && ev.pressure === 0) {
            ptr.pending = false; // still no pressure: it really is a button hover
            this.paintToolButtons();
          }
        }
        if (ptr.pending) continue;
        if (ptr.mode === "draw" && ptr.stroke) ptr.stroke.points.push({ x: p.x, y: p.y, p: pressureOf(ev) });
        else if (ptr.mode === "erase") this.eraseAt(ptr.page, { x: p.x, y: p.y, p: 0 }, ptr);
      }
      if (ptr.mode === "draw" && ptr.stroke) {
        view.drawStrokeTail(ptr.stroke, ptr.drawnUpTo ?? 0);
        ptr.drawnUpTo = ptr.stroke.points.length;
      }
    } else if (ptr.mode === "select" && ptr.start && this.selection) {
      const p = view.toPage(e.clientX, e.clientY);
      this.selection.rect = normalizeRect(ptr.start.x, ptr.start.y, p.x, p.y);
      this.updateSelectionMembers();
      this.scheduleRedraw(ptr.page);
    }
  }

  /** Finish the gesture in progress and continue it in another mode from `p`. */
  private switchMode(ptr: Pointer, mode: "draw" | "erase", p: { x: number; y: number }): void {
    const page = ptr.page;
    if (ptr.mode === "draw" && ptr.stroke) {
      const s = ptr.stroke;
      if (s.points.length > 1) {
        const before = this.snapshot(page);
        this.commit(page, before, { ...before, strokes: [...before.strokes, s] });
        ptr.keep = s.id;
        ptr.keepUntil = performance.now() + KEEP_MS;
      } else {
        this.redraw(page);
      }
      ptr.stroke = undefined;
      ptr.drawnUpTo = undefined;
    } else if (ptr.mode === "erase" && ptr.snapshot) {
      if (ptr.erased) this.commit(page, ptr.snapshot, this.snapshot(page));
      ptr.snapshot = undefined;
      ptr.erased = false;
      ptr.keep = undefined;
    }
    ptr.mode = mode;
    ptr.pending = false;
    this.paintToolButtons();
    if (mode === "draw") {
      ptr.heuristic = false;
      ptr.stroke = { id: newId(), points: [{ x: p.x, y: p.y, p: DEFAULT_PRESSURE }], color: this.penColor, width: this.penWidth, opacity: 1 };
      ptr.drawnUpTo = 0;
    } else {
      ptr.heuristic = true;
      ptr.snapshot = this.snapshot(page);
    }
  }

  private onPointerUp(e: PointerEvent, cancelled = false): void {
    if (this.touchScroll && this.touchScroll.id === e.pointerId) this.touchScroll = null;
    if (e.pointerType === "touch") {
      this.touchesDown.delete(e.pointerId);
      const tap = this.touchTap;
      if (tap && tap.id === e.pointerId) {
        this.touchTap = null;
        if (!cancelled && !this.fingerDraws && !this.penBusy() && performance.now() - tap.t <= TAP_MS && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= TAP_SLOP_PX) {
          const at = this.pagePointAt(tap.x, tap.y);
          const link = at && this.linkAt(at.page, at.x, at.y);
          if (link) this.openLink(link);
        }
      }
    }
    if (e.pointerType === "pen" && this.hoverErase) this.endHoverErase();
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    this.pointers.delete(e.pointerId);
    this.finishPointer(ptr, cancelled);
  }

  /** Commit whatever a finished gesture did (the pointer is already removed). */
  private finishPointer(ptr: Pointer, cancelled: boolean): void {
    this.paintToolButtons();
    const page = ptr.page;
    if (ptr.mode === "draw" && ptr.stroke) {
      const s = ptr.stroke;
      if (!cancelled || s.points.length > 1) {
        const before = this.snapshot(page);
        this.commit(page, before, { ...before, strokes: [...before.strokes, s] });
        this.emit("stroke", { page, stroke: s });
      } else {
        this.redraw(page);
      }
    } else if (ptr.mode === "erase" && ptr.snapshot) {
      if (ptr.erased) this.commit(page, ptr.snapshot, this.snapshot(page));
    } else if (ptr.mode === "select" && this.selection) {
      const r = this.selection.rect;
      if (!r || (r.w < MIN_SELECT && r.h < MIN_SELECT)) {
        // A tap: clear selection but remember the spot as the paste target.
        this.setSelection(null);
        this.redraw(page);
      } else {
        this.updateSelectionMembers();
        this.setSelection(this.selection); // announce the finished marquee
        this.redraw(page);
      }
      this.setStatus();
    }
  }

  private scheduleRedraw(page: number): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.redraw(page);
    });
  }

  /** Remove strokes/images under the eraser; mutates the page's arrays immutably. */
  private eraseAt(page: number, p: Point, ptr: Pointer): void {
    const m = this.pages[page];
    if (ptr.keep && performance.now() > (ptr.keepUntil ?? 0)) ptr.keep = undefined;
    const keep = m.strokes.filter((s) => s.id === ptr.keep || !strokeHit(s, p, ERASE_RADIUS));
    const keepImages = m.images.filter((im) => !(p.x >= im.x && p.x <= im.x + im.w && p.y >= im.y && p.y <= im.y + im.h));
    if (keep.length !== m.strokes.length || keepImages.length !== m.images.length) {
      m.strokes = keep;
      m.images = keepImages;
      ptr.erased = true;
      this.markDirty();
      this.redraw(page);
    }
  }

  private updateSelectionMembers(): void {
    const sel = this.selection;
    if (!sel || !sel.rect) return;
    const m = this.pages[sel.page];
    sel.strokeIds = new Set(m.strokes.filter((s) => strokeInRect(s, sel.rect!)).map((s) => s.id));
    sel.imageIds = new Set(m.images.filter((im) => imageInRect(im, sel.rect!)).map((im) => im.id));
    sel.linkIds = new Set(m.links.filter((ln) => rectInRect(ln, sel.rect!)).map((ln) => ln.id));
  }

  // ---------------------------------------------------------------- clipboard

  private selectedContent(): { page: number; strokes: Stroke[]; images: ImageItem[]; links: LinkItem[] } | null {
    const sel = this.selection;
    if (!sel) return null;
    const m = this.pages[sel.page];
    const strokes = m.strokes.filter((s) => sel.strokeIds.has(s.id));
    const images = m.images.filter((im) => sel.imageIds.has(im.id));
    const links = m.links.filter((ln) => sel.linkIds.has(ln.id));
    if (!strokes.length && !images.length && !links.length) return null;
    return { page: sel.page, strokes, images, links };
  }

  copy(): boolean {
    const c = this.selectedContent();
    if (!c) return false;
    let bounds: Rect | null = null;
    for (const s of c.strokes) bounds = unionRect(bounds, strokeBounds(s));
    for (const im of c.images) bounds = unionRect(bounds, imageBounds(im));
    for (const ln of c.links) bounds = unionRect(bounds, linkBounds(ln));
    const b = bounds!;
    this.clip = {
      strokes: c.strokes.map((s) => translateStroke(s, -b.x, -b.y)),
      images: c.images.map((im) => translateImage(im, -b.x, -b.y)),
      links: c.links.map((ln) => translateRect(ln, -b.x, -b.y)),
      width: b.w,
      height: b.h,
    };
    this.pendingClipWrite = this.copyToSystemClipboard(this.clip).finally(() => (this.pendingClipWrite = null));
    return true;
  }

  /**
   * What we last wrote to the system clipboard, so we can recognise it on paste.
   * Browsers re-encode clipboard images, so compare pixel size and recency,
   * not bytes.
   */
  private ownClip: { width: number; height: number; at: number } | null = null;
  private pendingClipWrite: Promise<void> | null = null;
  private pasteFallback: number | null = null;

  /** Best-effort: also put a PNG of the selection on the system clipboard. */
  private async copyToSystemClipboard(clip: ClipContent): Promise<void> {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return;
      const size = this.clipPixelSize(clip);
      this.ownClip = { ...size, at: Date.now() };
      // Hand the ClipboardItem a promise so Safari keeps the user activation.
      const png = this.renderClipToPng(clip);
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    } catch {
      this.ownClip = null; /* clipboard permission denied or unsupported; internal clip still works */
    }
  }

  private static readonly CLIP_PX_PER_PT = 3;

  private clipPixelSize(clip: ClipContent): { width: number; height: number } {
    const k = App.CLIP_PX_PER_PT;
    return { width: Math.max(1, Math.ceil(clip.width * k)), height: Math.max(1, Math.ceil(clip.height * k)) };
  }

  /** True when the image is (very probably) the PNG we put on the clipboard ourselves. */
  private async isOwnClipImage(bytes: Uint8Array, mime: string): Promise<boolean> {
    const own = this.ownClip;
    if (!own || !this.clip) return false;
    try {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      const match = bmp.width === own.width && bmp.height === own.height;
      bmp.close();
      return match;
    } catch {
      return false;
    }
  }

  private async renderClipToPng(clip: ClipContent): Promise<Blob> {
    const pxPerPt = App.CLIP_PX_PER_PT;
    const canvas = document.createElement("canvas");
    const size = this.clipPixelSize(clip);
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(pxPerPt, pxPerPt);
    for (const im of clip.images) {
      const bmp = await createImageBitmap(new Blob([im.bytes as BlobPart], { type: im.mime }));
      ctx.drawImage(bmp, im.x, im.y, im.w, im.h);
    }
    for (const s of clip.strokes) drawStroke(ctx, s);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));
  }

  cut(): boolean {
    if (!this.copy()) return false;
    this.deleteSelection();
    return true;
  }

  deleteSelection(): void {
    const c = this.selectedContent();
    if (!c) return;
    const before = this.snapshot(c.page);
    const sIds = new Set(c.strokes.map((s) => s.id));
    const iIds = new Set(c.images.map((i) => i.id));
    const lIds = new Set(c.links.map((ln) => ln.id));
    this.setSelection(null);
    this.commit(c.page, before, {
      strokes: before.strokes.filter((s) => !sIds.has(s.id)),
      images: before.images.filter((im) => !iIds.has(im.id)),
      links: before.links.filter((ln) => !lIds.has(ln.id)),
    });
  }

  /** Where a paste should land: centred on the last pen/mouse position, else page centre. */
  private pasteTarget(): { page: number; x: number; y: number } {
    if (this.lastPointer) return this.lastPointer;
    const page = this.currentPage;
    const m = this.pages[page];
    return { page, x: m.width / 2, y: m.height / 2 };
  }

  /** Paste the internal clipboard. Returns false when there is nothing to paste. */
  pasteInternal(): boolean {
    const clip = this.clip;
    if (!clip || !this.pages.length) return false;
    const t = this.pasteTarget();
    const m = this.pages[t.page];
    let dx = t.x - clip.width / 2;
    let dy = t.y - clip.height / 2;
    dx = Math.max(0, Math.min(dx, m.width - clip.width));
    dy = Math.max(0, Math.min(dy, m.height - clip.height));
    const strokes = clip.strokes.map((s) => ({ ...translateStroke(s, dx, dy), id: newId() }));
    const images = clip.images.map((im) => ({ ...translateImage(im, dx, dy), id: newId("im") }));
    const links = clip.links.map((ln) => ({ ...translateRect(ln, dx, dy), id: newId("ln") }));
    const before = this.snapshot(t.page);
    this.commit(t.page, before, { strokes: [...before.strokes, ...strokes], images: [...before.images, ...images], links: [...before.links, ...links] });
    this.setSelection({
      page: t.page,
      rect: { x: dx, y: dy, w: clip.width, h: clip.height },
      strokeIds: new Set(strokes.map((s) => s.id)),
      imageIds: new Set(images.map((im) => im.id)),
      linkIds: new Set(links.map((ln) => ln.id)),
    });
    this.redraw(t.page);
    this.setStatus();
    return true;
  }

  /** Paste an encoded image (PNG/JPEG bytes) centred on the paste target. */
  async pasteImage(bytes: Uint8Array, mime: string): Promise<boolean> {
    if (!this.pages.length) return false;
    let data = bytes;
    let type: ImageItem["mime"] = mime === "image/jpeg" ? "image/jpeg" : "image/png";
    if (mime !== "image/png" && mime !== "image/jpeg") {
      // Convert anything else (gif, webp, bmp…) to PNG via a canvas.
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d")!.drawImage(bmp, 0, 0);
      const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
      data = new Uint8Array(await blob.arrayBuffer());
      type = "image/png";
    }
    const bmp = await createImageBitmap(new Blob([data as BlobPart], { type }));
    const t = this.pasteTarget();
    const m = this.pages[t.page];
    // Natural size at 96 dpi → points, capped to fit the page.
    let w = (bmp.width * 72) / 96;
    let h = (bmp.height * 72) / 96;
    const fit = Math.min(1, (m.width * 0.9) / w, (m.height * 0.9) / h);
    w *= fit;
    h *= fit;
    bmp.close();
    const x = Math.max(0, Math.min(t.x - w / 2, m.width - w));
    const y = Math.max(0, Math.min(t.y - h / 2, m.height - h));
    const im: ImageItem = { id: newId("im"), x, y, w, h, mime: type, bytes: data };
    const before = this.snapshot(t.page);
    this.commit(t.page, before, { ...before, images: [...before.images, im] });
    this.setSelection({ page: t.page, rect: { x, y, w, h }, strokeIds: new Set(), imageIds: new Set([im.id]), linkIds: new Set() });
    this.redraw(t.page);
    this.setStatus();
    return true;
  }

  /** Paste button: prefer a system-clipboard image, else the internal clip. */
  async pasteFromButton(): Promise<void> {
    if (this.pendingClipWrite) await this.pendingClipWrite;
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type) {
            const blob = await item.getType(type);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (await this.isOwnClipImage(bytes, type)) break;
            await this.pasteImage(bytes, type);
            return;
          }
        }
      }
    } catch {
      /* no permission / nothing readable; fall through */
    }
    this.pasteInternal();
  }

  /** Handle a DOM paste event (Ctrl+V / Cmd+V). */
  async pasteFromEvent(e: ClipboardEvent): Promise<void> {
    if (this.pasteFallback) {
      clearTimeout(this.pasteFallback);
      this.pasteFallback = null;
    }
    const dt = e.clipboardData;
    if (dt) {
      for (const item of Array.from(dt.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            const bytes = new Uint8Array(await f.arrayBuffer());
            if (await this.isOwnClipImage(bytes, f.type)) break;
            await this.pasteImage(bytes, f.type);
            return;
          }
        }
      }
    }
    if (this.pasteInternal()) e.preventDefault();
  }

  // ---------------------------------------------------------------- files

  async exportBytes(): Promise<Uint8Array> {
    if (!this.baseBytes) throw new Error("No document");
    return exportPdf(this.baseBytes, this.pages, this.outlineToSave());
  }

  /** The bookmarks to write, or undefined to keep the base's outline as it is. */
  private outlineToSave(): Bookmark[] | undefined {
    return this.bookmarksChanged ? this.bookmarks : undefined;
  }

  /** Import: pick a PDF on this device, load it, and store it in the notebooks folder. */
  async importLocal(): Promise<void> {
    if (window.showOpenFilePicker && !this.forceDownload) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
        });
        await this.importFile(await handle.getFile());
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
      }
    }
    (document.getElementById("file-input") as HTMLInputElement).click();
  }

  async importFile(file: File): Promise<void> {
    if (!(await this.readyToLeave())) return;
    const raw = await this.promptFn("Save the imported PDF in the notebooks folder as", file.name);
    if (raw === null) {
      // Tab-only: parse in the browser.
      const ok = await this.loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, null);
      if (ok) this.setStatus(`${file.name} imported but not saved to notebooks (Export to keep it).`);
      return;
    }
    const name = App.normalizeNotebookName(raw);
    if (!name) {
      this.setStatus(`"${raw}" is not a usable notebook name.`);
      return;
    }
    // Upload the file untouched and let the server parse it, so big PDFs
    // never have to be parsed in the browser.
    this.setStatus(`Uploading ${file.name}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      try {
        await saveNotebook(name, bytes, "new");
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        if (!(await this.confirmFn(`${name} already exists in the notebooks folder. Replace it?`))) {
          this.setStatus(`Not imported: ${name} already exists.`);
          return;
        }
        await saveNotebook(name, bytes, null);
      }
    } catch (err) {
      this.setStatus((err as Error).message);
      return;
    }
    this.onNotebooksChanged();
    await this.openNotebook(name);
  }

  /**
   * Save: server notebooks go back to the notebooks folder; in local mode the
   * file is written to this device; a tab-only document in server mode is
   * offered a place in the notebooks folder.
   */
  async save(): Promise<void> {
    if (!this.baseBytes) return;
    if (this.source.kind === "server") {
      await this.saveToServer();
      return;
    }
    if (this.storage === "local") {
      await this.exportLocal();
      return;
    }
    const raw = await this.promptFn("Save in the notebooks folder as", this.fileName);
    if (raw === null) return;
    const name = App.normalizeNotebookName(raw);
    if (!name) {
      this.setStatus(`"${raw}" is not a usable notebook name.`);
      return;
    }
    await this.saveAsNotebook(name);
  }

  /** Export: write the current document to a file on this device. */
  async exportLocal(): Promise<void> {
    if (!this.baseBytes) return;
    this.setStatus("Exporting…");
    let bytes: Uint8Array;
    try {
      if (this.source.kind === "server") {
        // Let the server build it (it may be far too big to build here);
        // make sure the file is current first.
        if (this.dirty && !(await this.saveToServer())) return;
        bytes = (await loadNotebook(this.source.name)).bytes;
      } else {
        bytes = await this.exportBytes();
      }
    } catch (err) {
      console.error(err);
      this.setStatus(`Could not build the PDF: ${(err as Error).message}`);
      return;
    }
    if (!this.forceDownload) {
      try {
        if (!this.fileHandle && window.showSaveFilePicker) {
          this.fileHandle = await window.showSaveFilePicker({
            suggestedName: this.fileName,
            types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
          });
        }
        if (this.fileHandle) {
          const w = await this.fileHandle.createWritable();
          await w.write(bytes);
          await w.close();
          this.afterExport();
          return;
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          this.setStatus();
          return;
        }
        console.error(err);
        this.fileHandle = null;
      }
    }
    const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.afterExport();
  }

  private afterExport(): void {
    // For a tab-only document the export is its save; a server notebook stays
    // whatever it was.
    if (this.source.kind === "local") {
      this.dirty = false;
      this.lastSaved = new Date();
    }
    this.setStatus();
  }

  private bindDrop(): void {
    const c = this.container;
    c.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    c.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f && (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))) {
        void (this.storage === "server" ? this.importFile(f) : this.openFile(f));
      }
      else if (f && f.type.startsWith("image/")) void f.arrayBuffer().then((b) => this.pasteImage(new Uint8Array(b), f.type));
    });
  }

  // ---------------------------------------------------------------- keyboard

  private bindKeyboard(): void {
    document.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        switch (e.key.toLowerCase()) {
          case "z":
            e.preventDefault();
            e.shiftKey ? this.redo() : this.undo();
            return;
          case "y":
            e.preventDefault();
            this.redo();
            return;
          case "c":
            if (this.copy()) e.preventDefault();
            return;
          case "x":
            if (this.cut()) e.preventDefault();
            return;
          case "s":
            e.preventDefault();
            void this.save();
            return;
          case "o":
            e.preventDefault();
            void (this.storage === "server" ? this.importLocal() : this.open());
            return;
          case "=":
          case "+":
            e.preventDefault();
            this.zoom(1.25);
            return;
          case "-":
            e.preventDefault();
            this.zoom(0.8);
            return;
          case "0":
            e.preventDefault();
            this.fitWidth();
            return;
        }
        if (e.key.toLowerCase() === "v" && this.clip) {
          // The paste event normally follows and handles this; if the browser
          // never sends one (no editable focus, some WebViews), paste the
          // internal clipboard ourselves.
          if (this.pasteFallback) clearTimeout(this.pasteFallback);
          this.pasteFallback = window.setTimeout(() => {
            this.pasteFallback = null;
            this.pasteInternal();
          }, 150);
        }
        return;
      }
      switch (e.key) {
        case "p": case "P": this.setTool("pen"); break;
        case "e": case "E": this.setTool("eraser"); break;
        case "s": case "S": this.setTool("select"); break;
        case "Escape": this.clearSelection(); break;
        case "Delete": case "Backspace":
          if (this.selection) {
            e.preventDefault();
            this.deleteSelection();
          }
          break;
      }
    });
    document.addEventListener("paste", (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      void this.pasteFromEvent(e);
    });
  }

  // ---------------------------------------------------------------- page API
  // What the page bridge (window.pdfink) drives: events, selection queries,
  // programmatic ink, command buttons and a progress line.

  private listeners = new Map<AppEvent, Set<(data: unknown) => void>>();
  /** Crop box and rotation of each page of the current document, from pdf.js. */
  private geoms: PageGeom[] = [];
  /** Whether the last `selection` event carried a selection (so clearing twice fires once). */
  private selectionAnnounced = false;
  private buttons = new Map<string, { label: string; where: "menu" | "toolbar"; run?: string; el: HTMLButtonElement | null }>();
  private progressText: string | null = null;

  on(event: AppEvent, fn: (data: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => void set.delete(fn);
  }

  private emit(event: AppEvent, data: unknown): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      try {
        fn(data);
      } catch (err) {
        console.error(err);
      }
    }
  }

  /** The one place the selection changes; tells listeners. */
  private setSelection(sel: Selection | null): void {
    this.selection = sel;
    const info = this.selectionInfo();
    if (!info && !this.selectionAnnounced) return;
    this.selectionAnnounced = !!info;
    this.emit("selection", info);
  }

  private checkPage(page: number): PageModel {
    const m = this.pages[page];
    if (!Number.isInteger(page) || !m) throw new RangeError(`No page ${page} (the document has ${this.pages.length})`);
    return m;
  }

  pageGeom(page: number): PageGeom {
    const m = this.checkPage(page);
    return this.geoms[page] ?? { cx: 0, cy: 0, cw: m.width, ch: m.height, rotate: 0 };
  }

  selectionInfo(): SelectionInfo | null {
    const sel = this.selection;
    if (!sel) return null;
    const c = this.selectedContent();
    let bounds: Rect | null = null;
    for (const s of c?.strokes ?? []) bounds = unionRect(bounds, strokeBounds(s));
    for (const im of c?.images ?? []) bounds = unionRect(bounds, imageBounds(im));
    for (const ln of c?.links ?? []) bounds = unionRect(bounds, linkBounds(ln));
    const marquee = sel.rect ? { ...sel.rect } : null;
    const rect = marquee ? (bounds ? unionRect(marquee, bounds) : { ...marquee }) : bounds;
    if (!rect) return null;
    const g = this.pageGeom(sel.page);
    const a = displayToPdf(g, rect.x, rect.y);
    const b = displayToPdf(g, rect.x + rect.w, rect.y + rect.h);
    return {
      page: sel.page,
      marquee,
      bounds,
      rect,
      pdfRect: normalizeRect(a.x, a.y, b.x, b.y),
      strokeIds: c?.strokes.map((s) => s.id) ?? [],
      imageIds: c?.images.map((im) => im.id) ?? [],
      linkIds: c?.links.map((ln) => ln.id) ?? [],
    };
  }

  selectionInk(): Stroke[] {
    return this.selectedContent()?.strokes ?? [];
  }

  /** PNG of the selection's union rect: page base, images and ink. */
  async selectionPng(scale = App.CLIP_PX_PER_PT): Promise<Blob> {
    const info = this.selectionInfo();
    if (!info) throw new Error("Nothing is selected");
    return this.renderRegionPng(info.page, info.rect, scale);
  }

  async pagePng(page: number, scale = 1): Promise<Blob> {
    const m = this.checkPage(page);
    return this.renderRegionPng(page, { x: 0, y: 0, w: m.width, h: m.height }, scale);
  }

  /** Render a page-space rectangle of one page at `scale` px per point. */
  private async renderRegionPng(page: number, rect: Rect, scale: number): Promise<Blob> {
    const m = this.pages[page];
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(rect.w * scale));
    canvas.height = Math.max(1, Math.ceil(rect.h * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (this.pdfDoc && page < this.pdfDoc.numPages) {
      const pdfPage = await this.pdfDoc.getPage(page + 1);
      const viewport = pdfPage.getViewport({ scale, offsetX: -rect.x * scale, offsetY: -rect.y * scale });
      await pdfPage.render({ canvasContext: ctx, canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    }
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-rect.x, -rect.y);
    for (const im of m.images) {
      const bmp = await createImageBitmap(new Blob([im.bytes as BlobPart], { type: im.mime }));
      ctx.drawImage(bmp, im.x, im.y, im.w, im.h);
      bmp.close();
    }
    for (const s of m.strokes) drawStroke(ctx, s);
    ctx.restore();
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png"));
  }

  /** Select what a rectangle covers on `page`, as the Select tool would. */
  selectRect(page: number, rect: Rect): void {
    const m = this.checkPage(page);
    this.setTool("select");
    const old = this.selection?.page;
    const r = normalizeRect(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    this.setSelection({
      page,
      rect: r,
      strokeIds: new Set(m.strokes.filter((s) => strokeInRect(s, r)).map((s) => s.id)),
      imageIds: new Set(m.images.filter((im) => imageInRect(im, r)).map((im) => im.id)),
      linkIds: new Set(m.links.filter((ln) => rectInRect(ln, r)).map((ln) => ln.id)),
    });
    if (old !== undefined && old !== page) this.redraw(old);
    this.redraw(page);
    this.setStatus();
  }

  /** Add strokes to a page as one undo step; returns their ids (new ones where none was given). */
  addStrokes(page: number, strokes: Array<Omit<Stroke, "id"> & { id?: string }>): string[] {
    const m = this.checkPage(page);
    if (!Array.isArray(strokes)) throw new TypeError("strokes must be an array");
    const ids = new Set(m.strokes.map((s) => s.id));
    strokes.forEach((s, i) => {
      checkStroke(s, i);
      if (s.id === undefined) return;
      if (ids.has(s.id)) throw new TypeError(`strokes[${i}].id "${s.id}" is already on page ${page}`);
      ids.add(s.id);
    });
    if (!strokes.length) return [];
    const added: Stroke[] = strokes.map((s) => ({ ...s, id: s.id ?? newId() }));
    const before = this.snapshot(page);
    this.commit(page, before, { ...before, strokes: [...before.strokes, ...added] });
    return added.map((s) => s.id);
  }

  addImageItem(page: number, bytes: Uint8Array, mime: "image/png" | "image/jpeg", rect: Rect): string {
    this.checkPage(page);
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new TypeError("bytes must be a non-empty Uint8Array");
    if (mime !== "image/png" && mime !== "image/jpeg") throw new TypeError(`mime must be image/png or image/jpeg, not ${String(mime)}`);
    if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) {
      throw new TypeError("rect must have finite x, y and positive w, h");
    }
    const im: ImageItem = { id: newId("im"), x: rect.x, y: rect.y, w: rect.w, h: rect.h, mime, bytes };
    const before = this.snapshot(page);
    this.commit(page, before, { ...before, images: [...before.images, im] });
    return im.id;
  }

  /** Add a link box to a page as one undo step; returns its id. */
  addLink(page: number, rect: Rect, url: string, label?: string): string {
    this.checkPage(page);
    if (typeof url !== "string" || !linkUrlOk(url)) throw new Error("bad url");
    if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) {
      throw new TypeError("rect must have finite x, y and positive w, h");
    }
    if (label !== undefined && typeof label !== "string") throw new TypeError("label must be a string");
    const ln: LinkItem = { id: newId("ln"), x: rect.x, y: rect.y, w: rect.w, h: rect.h, url };
    if (label) ln.label = label;
    const before = this.snapshot(page);
    this.commit(page, before, { ...before, links: [...before.links, ln] });
    return ln.id;
  }

  /** Change a link's url and/or label (an empty label removes it) as one undo step. */
  setLink(id: string, patch: { url?: string; label?: string }): void {
    const page = this.pages.findIndex((p) => p.links.some((ln) => ln.id === id));
    if (page < 0) throw new RangeError(`No link ${id}`);
    if (patch.url !== undefined && (typeof patch.url !== "string" || !linkUrlOk(patch.url))) throw new Error("bad url");
    if (patch.label !== undefined && typeof patch.label !== "string") throw new TypeError("label must be a string");
    const before = this.snapshot(page);
    const links = before.links.map((ln) => {
      if (ln.id !== id) return ln;
      const next: LinkItem = { ...ln, url: patch.url ?? ln.url };
      if (patch.label !== undefined) {
        if (patch.label) next.label = patch.label;
        else delete next.label;
      }
      return next;
    });
    this.commit(page, before, { ...before, links });
  }

  /** The topmost (last drawn) link under a page-space point, or null. */
  linkAt(page: number, x: number, y: number): LinkItem | null {
    const m = this.pages[page];
    if (!m) return null;
    for (let i = m.links.length - 1; i >= 0; i--) if (pointInRect({ x, y }, m.links[i])) return m.links[i];
    return null;
  }

  /** Links on one page, or on every page, each with its page index. */
  links(page?: number): Array<LinkItem & { page: number }> {
    const out: Array<LinkItem & { page: number }> = [];
    this.pages.forEach((m, i) => {
      if (page !== undefined && i !== page) return;
      for (const ln of m.links) out.push({ ...ln, page: i });
    });
    return out;
  }

  /**
   * Add an outline entry for `page`, after the last bookmark on that page or
   * an earlier one, so the list stays in page order, and after any entries
   * nested deeper than `level` that follow it, so it adopts none of them.
   * Not an undo step. Returns its index.
   */
  addBookmark(page: number, title: string, level = 0): number {
    this.checkPage(page);
    if (typeof title !== "string") throw new TypeError("title must be a string");
    if (!Number.isInteger(level) || level < 0) throw new TypeError("level must be a whole number ≥ 0");
    let at = 0;
    this.bookmarks.forEach((b, i) => {
      if (b.page !== null && b.page <= page) at = i + 1;
    });
    while (at < this.bookmarks.length && this.bookmarks[at].level > level) at++;
    this.bookmarks = [...this.bookmarks.slice(0, at), { title, page, level }, ...this.bookmarks.slice(at)];
    this.bookmarksChanged = true;
    this.markDirty();
    this.setStatus();
    this.emit("bookmarks", this.bookmarks);
    return at;
  }

  /** Remove the outline entry at `index` and the entries nested under it. Not an undo step. */
  removeBookmark(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.bookmarks.length) throw new RangeError(`No bookmark ${index}`);
    let end = index + 1;
    while (end < this.bookmarks.length && this.bookmarks[end].level > this.bookmarks[index].level) end++;
    this.bookmarks = [...this.bookmarks.slice(0, index), ...this.bookmarks.slice(end)];
    this.bookmarksChanged = true;
    this.markDirty();
    this.setStatus();
    this.emit("bookmarks", this.bookmarks);
  }

  /** Index of the first top-level bookmark that opens `page`, or null. */
  bookmarkOnPage(page: number): number | null {
    const i = this.bookmarks.findIndex((b) => b.level === 0 && b.page === page);
    return i < 0 ? null : i;
  }

  /** Follow a link in a new tab, without giving it a handle on this one. */
  openLink(link: LinkItem): void {
    if (!linkUrlOk(link.url)) return;
    window.open(link.url, "_blank", "noopener,noreferrer");
  }

  /** Remove strokes, images and links by id from any page; one undo step per page touched. */
  removeItems(ids: string[]): number {
    const gone = new Set(ids);
    let removed = 0;
    this.pages.forEach((_, page) => {
      const before = this.snapshot(page);
      const strokes = before.strokes.filter((s) => !gone.has(s.id));
      const images = before.images.filter((im) => !gone.has(im.id));
      const links = before.links.filter((ln) => !gone.has(ln.id));
      const n = before.strokes.length - strokes.length + before.images.length - images.length + before.links.length - links.length;
      if (!n) return;
      removed += n;
      this.commit(page, before, { strokes, images, links });
    });
    return removed;
  }

  /** Show a progress line next to the status; null clears it. */
  progress(message: string | null): void {
    this.progressText = message;
    const el = document.getElementById("progress");
    if (el) el.textContent = message ?? "";
  }

  /** A command button in the pen menu or the toolbar; pressing it emits `button`. Same id replaces. */
  /** `run` names the attached command the button belongs to; menu buttons are grouped under it. */
  addButton(id: string, label: string, where: "menu" | "toolbar", run?: string): void {
    this.removeButton(id);
    let el: HTMLButtonElement | null = null;
    if (where === "toolbar") {
      el = document.createElement("button");
      el.className = "cmd";
      el.textContent = label;
      el.dataset.id = id;
      el.onclick = () => this.emit("button", { id });
      document.getElementById("cmd-buttons")?.appendChild(el);
    }
    this.buttons.set(id, { label, where, run, el });
  }

  removeButton(id: string): void {
    this.buttons.get(id)?.el?.remove();
    this.buttons.delete(id);
  }

  /** Buttons added by attached commands, grouped under a label per run, for the Commands level. */
  private menuButtonItems(): MenuItem[] {
    const byRun = new Map<string, MenuItem[]>();
    for (const [id, b] of this.buttons) {
      if (b.where !== "menu") continue;
      const list = byRun.get(b.run ?? "") ?? [];
      list.push({ label: b.label, action: () => this.emit("button", { id }) });
      byRun.set(b.run ?? "", list);
    }
    const out: MenuItem[] = [];
    for (const [run, items] of byRun) {
      out.push({ kind: "label", label: run ? `Attached: ${run}` : "Buttons" }, ...items);
    }
    return out;
  }

  /** Compact state for tests. */
  getState() {
    return {
      fileName: this.fileName,
      storage: this.storage,
      source: this.source,
      saving: this.saving,
      lastSaved: this.lastSaved ? this.lastSaved.getTime() : null,
      tool: this.tool,
      barrelHeuristic: this.barrelHeuristic,
      fingerDraws: this.fingerDraws,
      menuOpen: this.menu.open,
      commands: this.commands.map((c) => c.label),
      scale: this.scale,
      dirty: this.dirty,
      currentPage: this.currentPage,
      bookmarks: this.bookmarks.map((b) => ({ ...b })),
      pages: this.pages.map((p) => ({
        width: p.width,
        height: p.height,
        strokes: p.strokes.map((s) => ({ id: s.id, n: s.points.length, color: s.color, width: s.width, bounds: strokeBounds(s) })),
        images: p.images.map((im) => ({ id: im.id, x: im.x, y: im.y, w: im.w, h: im.h, mime: im.mime })),
        links: p.links.map((ln) => ({ id: ln.id, x: ln.x, y: ln.y, w: ln.w, h: ln.h, url: ln.url, label: ln.label })),
      })),
      selection: this.selection
        ? { page: this.selection.page, rect: this.selection.rect, strokes: [...this.selection.strokeIds], images: [...this.selection.imageIds], links: [...this.selection.linkIds] }
        : null,
      clip: this.clip ? { strokes: this.clip.strokes.length, images: this.clip.images.length, links: this.clip.links.length, width: this.clip.width, height: this.clip.height } : null,
      undo: this.undoStack.length,
      redo: this.redoStack.length,
      buttons: [...this.buttons.keys()],
      progress: this.progressText,
    };
  }
}
