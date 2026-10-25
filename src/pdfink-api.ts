/**
 * window.pdfink: the stable, documented API that pages (and the page end of
 * the bridge) drive. A thin layer over App and the in-page dialog; it keeps
 * no state of its own. App's input checks throw TypeErrors, which propagate.
 */
import type { App, Tool } from "./app";
import { dialog } from "./dialog";
import type { Bookmark, LinkItem, Rect, Stroke, TextItem } from "./model";
import { displayToPdf, pdfToDisplay, type PageGeom } from "./pdf/geom";

export interface PdfinkApi {
  /** The app's compact state snapshot. */
  state(): ReturnType<App["getState"]>;
  /** The open notebook: name, page count, current page, unsaved changes, storage mode. */
  notebook(): { name: string; pages: number; page: number; dirty: boolean; storage: "server" | "local" };
  /** The current selection, or null. */
  selection(): ReturnType<App["selectionInfo"]>;
  /** The selected strokes. */
  selectionInk(): Stroke[];
  /** PNG of the selection as base64 (no data: prefix); rejects "no selection". */
  selectionPng(opts?: { scale?: number }): Promise<string>;
  /** PNG of a whole page as base64 (no data: prefix). */
  pagePng(page: number, opts?: { scale?: number }): Promise<string>;
  /** Show a message in the status line. */
  toast(message: string): void;
  /** Show a progress line; null clears it. */
  progress(message: string | null): void;
  /** Ask for a line of text; null when cancelled. */
  ask(message: string, opts?: { default?: string }): Promise<string | null>;
  /** Ask yes or no. */
  confirm(message: string): Promise<boolean>;
  /** Pick one of `options`; null when cancelled. */
  choose(message: string, options: string[]): Promise<string | null>;
  /** Add (or replace) a command button in the pen menu (default) or the toolbar. */
  /** `run` is set by the bridge to the attached command's label and groups the button in the menu's Commands level. */
  addButton(id: string, label: string, opts?: { where?: "menu" | "toolbar"; run?: string }): void;
  /** Remove a command button. */
  removeButton(id: string): void;
  /** Select what a page-space rectangle covers on `page`. */
  select(page: number, rect: Rect): void;
  /** Clear the selection. */
  clearSelection(): void;
  /** Switch tool. */
  setTool(tool: Tool): void;
  /** Save; true when saved (server mode reports whether the file on disk is current). */
  save(): Promise<boolean>;
  /** Reopen the current server notebook from disk; false in local mode. */
  reload(): Promise<boolean>;
  /** Undo one step. */
  undo(): void;
  /** Redo one step. */
  redo(): void;
  /** Append a blank page. */
  addPage(): Promise<void>;
  /** Scroll page `page` into view. */
  scrollToPage(page: number): void;
  /** Add strokes as one undo step, in page space (default) or PDF points; returns their ids. */
  addStrokes(page: number, strokes: Array<Omit<Stroke, "id"> & { id?: string }>, opts?: { space?: "page" | "pdf" }): string[];
  /** Place a base64 PNG on `page` at a page-space rect; returns its id. */
  addImage(page: number, png: string, rect: Rect): Promise<string>;
  /** Remove strokes, images and links by id; returns how many went. */
  removeItems(ids: string[]): number;
  /** Links on `page`, or on every page, each with its page index. */
  links(page?: number): Array<LinkItem & { page: number }>;
  /** Add a link box (http, https or mailto; else "bad url") at a page-space (default) or PDF-point rect; returns its id. */
  addLink(page: number, rect: Rect, url: string, opts?: { label?: string; space?: "page" | "pdf" }): string;
  /** Change a link's url and/or label (an empty label removes it), as one undo step. */
  setLink(id: string, patch: { url?: string; label?: string }): void;
  /** The document outline, in order. */
  bookmarks(): Bookmark[];
  /** Add an outline entry for `page`, kept in page order and after the subtree it follows; returns its index. */
  addBookmark(page: number, title: string, opts?: { level?: number }): number;
  /** Remove the outline entry at `index` and the entries nested under it. */
  removeBookmark(index: number): void;
  /** Everything known about `page`'s text: the document's own (page space), the handwriting text, and whether it saves as a notebook page. */
  pageText(page: number): Promise<{ own: Array<{ text: string; x: number; y: number; w: number; h: number }>; ink: TextItem[]; notebook: boolean }>;
  /** The page's handwriting text, in page space. */
  inkText(page: number): TextItem[];
  /**
   * Replace the page's handwriting text (with `within`, only the texts whose
   * centre is inside it) with `lines`, in page space (default) or PDF points
   * (`within` too); one undo step unless `quiet`. Returns the new ids.
   */
  setInkText(page: number, lines: Array<Omit<TextItem, "id">>, opts?: { space?: "page" | "pdf"; quiet?: boolean; within?: Rect }): string[];
  /** The page's strokes, copied, in page space (default) or PDF points. */
  strokes(page: number, opts?: { space?: "page" | "pdf" }): Stroke[];
  /** The file's notebook tag: true, false, or null (decided per page). */
  notebookTag(): boolean | null;
  /** Set the notebook tag (null: decide per page). Not an undo step. */
  setNotebookTag(v: boolean | null): void;
}

declare global {
  interface Window {
    pdfink: PdfinkApi;
  }
}

export function createPdfinkApi(app: App): PdfinkApi {
  return {
    state: () => app.getState(),
    notebook: () => ({ name: app.source.name, pages: app.pages.length, page: app.currentPage, dirty: app.dirty, storage: app.storage }),
    selection: () => app.selectionInfo(),
    selectionInk: () => app.selectionInk(),
    async selectionPng(opts) {
      if (!app.selectionInfo()) throw new Error("no selection");
      return blobToBase64(await app.selectionPng(opts?.scale));
    },
    async pagePng(page, opts) {
      return blobToBase64(await app.pagePng(page, opts?.scale));
    },
    toast: (message) => app.setStatus(message),
    progress: (message) => app.progress(message),
    ask: (message, opts) => dialog.ask(message, opts?.default),
    confirm: (message) => dialog.confirm(message),
    choose: (message, options) => dialog.choose(message, options),
    addButton: (id, label, opts) => app.addButton(id, label, opts?.where ?? "menu", opts?.run),
    removeButton: (id) => app.removeButton(id),
    select: (page, rect) => app.selectRect(page, rect),
    clearSelection: () => app.clearSelection(),
    setTool: (tool) => app.setTool(tool),
    async save() {
      if (app.source.kind === "server") return app.saveToServer();
      await app.save();
      return true;
    },
    async reload() {
      if (app.source.kind !== "server") return false;
      return app.reloadNotebook(app.source.name);
    },
    undo: () => app.undo(),
    redo: () => app.redo(),
    addPage: () => app.addPage(),
    scrollToPage: (page) => app.scrollToPage(page),
    addStrokes(page, strokes, opts) {
      if (opts?.space === "pdf" && Array.isArray(strokes)) {
        const g = app.pageGeom(page);
        strokes = strokes.map((s) => ({ ...s, points: Array.isArray(s?.points) ? s.points.map((p) => ({ ...p, ...pdfToDisplay(g, p.x, p.y) })) : s?.points }));
      }
      return app.addStrokes(page, strokes);
    },
    async addImage(page, png, rect) {
      return app.addImageItem(page, base64ToBytes(png), "image/png", rect);
    },
    removeItems: (ids) => app.removeItems(ids),
    links: (page) => app.links(page),
    addLink(page, rect, url, opts) {
      if (opts?.space === "pdf" && rect) rect = rectFromPdf(app.pageGeom(page), rect);
      return app.addLink(page, rect, url, opts?.label);
    },
    setLink: (id, patch) => app.setLink(id, patch),
    bookmarks: () => app.bookmarks.map((b) => ({ ...b })),
    addBookmark: (page, title, opts) => app.addBookmark(page, title, opts?.level ?? 0),
    removeBookmark: (index) => app.removeBookmark(index),
    async pageText(page) {
      const ink = app.inkText(page);
      const [own, notebook] = await Promise.all([app.ownText(page), app.isNotebookPage(page)]);
      return { own, ink, notebook };
    },
    inkText: (page) => app.inkText(page),
    setInkText(page, lines, opts) {
      let within = opts?.within;
      if (opts?.space === "pdf") {
        const g = app.pageGeom(page);
        if (Array.isArray(lines)) lines = lines.map((l) => (isRect(l) ? { ...l, ...rectFromPdf(g, l) } : l));
        if (isRect(within)) within = rectFromPdf(g, within);
      }
      return app.setInkText(page, lines, { quiet: opts?.quiet, within });
    },
    strokes(page, opts) {
      const g = app.pageGeom(page); // checks the page
      const toPdf = opts?.space === "pdf";
      return app.pages[page].strokes.map((s) => ({
        ...s,
        points: s.points.map((p) => (toPdf ? { ...p, ...displayToPdf(g, p.x, p.y) } : { ...p })),
      }));
    },
    notebookTag: () => app.notebookTag,
    setNotebookTag: (v) => app.setNotebookTag(v),
  };
}

/** Whether `r` has finite numbers for x, y, w and h (anything else is left for App's checks to reject). */
function isRect(r: unknown): r is Rect {
  if (!r || typeof r !== "object") return false;
  const { x, y, w, h } = r as Record<string, unknown>;
  return [x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v));
}

/** A PDF-point rect as a page-space one, through the page's geometry. */
function rectFromPdf(g: PageGeom, rect: Rect): Rect {
  const a = pdfToDisplay(g, rect.x, rect.y);
  const b = pdfToDisplay(g, rect.x + rect.w, rect.y + rect.h);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Evaluate a JavaScript expression with `pdfink` and `app` in scope; the awaited result goes through toJson. */
export async function evalInPage(api: PdfinkApi, app: App, js: string): Promise<unknown> {
  const fn = new Function("pdfink", "app", `return (${js})`) as (pdfink: PdfinkApi, app: App) => unknown;
  return toJson(await fn(api, app));
}

/**
 * Make a value JSON-safe: undefined → null, bigint → string, Uint8Array →
 * base64, Set → array, Map → object, plain objects and arrays recursively,
 * anything else that isn't JSON (a DOM node, a function, a cycle) → String(value).
 */
export function toJson(value: unknown): unknown {
  return convert(value, []);
}

function convert(v: unknown, parents: object[]): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v !== "object" || parents.includes(v)) return String(v);
  if (v instanceof Uint8Array) return bytesToBase64(v);
  const inner = [...parents, v];
  if (Array.isArray(v) || v instanceof Set) return [...v].map((x) => convert(x, inner));
  if (v instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of v) out[String(k)] = convert(x, inner);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return String(v);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = convert(x, inner);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== "string") throw new TypeError("png must be a base64 string");
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new TypeError("png is not valid base64");
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
