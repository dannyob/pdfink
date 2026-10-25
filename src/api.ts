/** Client for the pdfink server API (see server/index.ts). */
import type { Bookmark, LinkItem, PageModel, Rect, Stroke, TextItem } from "./model";

export interface NotebookInfo {
  name: string;
  size: number;
  mtime: number;
}

export class ConflictError extends Error {
  constructor(
    message: string,
    readonly mtime: number | null,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function listNotebooks(): Promise<NotebookInfo[]> {
  const res = await fetch("/api/notebooks", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not list notebooks: ${await errorMessage(res)}`);
  return (await res.json()) as NotebookInfo[];
}

export async function loadNotebook(name: string): Promise<{ bytes: Uint8Array; mtime: number }> {
  const res = await fetch(`/api/notebooks/${encodeURIComponent(name)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ${name}: ${await errorMessage(res)}`);
  const mtime = Number(res.headers.get("X-Mtime") ?? 0);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mtime };
}

interface WirePage {
  width: number;
  height: number;
  strokes: { id: string; color: string; width: number; opacity: number; points: number[] }[];
  /** Absent from envelopes sent by older servers. */
  links?: LinkItem[];
  /** Absent from envelopes sent by older servers. */
  texts?: TextItem[];
}

export function fromWirePages(pages: WirePage[]): PageModel[] {
  return pages.map((p) => ({
    width: p.width,
    height: p.height,
    images: [],
    links: p.links ?? [],
    texts: p.texts ?? [],
    strokes: p.strokes.map((s): Stroke => {
      const points = [];
      for (let i = 0; i + 2 < s.points.length; i += 3) points.push({ x: s.points[i], y: s.points[i + 1], p: s.points[i + 2] });
      return { id: s.id, color: s.color, width: s.width, opacity: s.opacity, points };
    }),
  }));
}

/** What the server's /open sends back, decoded. */
export interface OpenedNotebook {
  baseBytes: Uint8Array;
  pages: PageModel[];
  bookmarks: Bookmark[];
  /** The file's notebook tag; null when it has none (or the server is older). */
  notebook: boolean | null;
}

/** Decode the /open envelope: 4-byte JSON length, JSON { pages, bookmarks, notebook }, base PDF. */
export function decodeOpened(buf: ArrayBuffer): OpenedNotebook {
  const view = new DataView(buf);
  const jsonLen = view.getUint32(0);
  const json = new TextDecoder().decode(new Uint8Array(buf, 4, jsonLen));
  const { pages, bookmarks, notebook } = JSON.parse(json) as { pages: WirePage[]; bookmarks?: Bookmark[]; notebook?: boolean | null };
  return { baseBytes: new Uint8Array(buf, 4 + jsonLen), pages: fromWirePages(pages), bookmarks: bookmarks ?? [], notebook: notebook ?? null };
}

/** Open a notebook parsed on the server (ink already separated from the base PDF). */
export async function openNotebookParsed(name: string): Promise<OpenedNotebook & { mtime: number }> {
  const res = await fetch(`/api/notebooks/${encodeURIComponent(name)}/open`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not open ${name}: ${await errorMessage(res)}`);
  const mtime = Number(res.headers.get("X-Mtime") ?? 0);
  return { ...decodeOpened(await res.arrayBuffer()), mtime };
}

interface WireImage {
  page: number;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mime: "image/png" | "image/jpeg";
  offset: number;
  length: number;
}

/**
 * How the server should write a saved notebook. `textLayers[i]` adds page i's
 * invisible text layer; `notebook` undefined leaves the file's notebook tag,
 * null removes it, a boolean sets it.
 */
export interface SaveOptions {
  textLayers?: boolean[];
  notebook?: boolean | null;
}

/**
 * Build the /save envelope: JSON { pages, images, baseLength, bookmarks?,
 * textLayers?, notebook? } plus concatenated image bytes (and base PDF, if
 * given). Leave `bookmarks` undefined to keep the file's outline; an array
 * (even empty) replaces it. Options left undefined are left out.
 */
export function encodeSaveEnvelope(pages: PageModel[], baseBytes: Uint8Array | null = null, bookmarks?: Bookmark[], opts: SaveOptions = {}): Uint8Array {
  const wirePages = pages.map((p): WirePage => ({
    width: p.width,
    height: p.height,
    strokes: p.strokes.map((s) => ({
      id: s.id,
      color: s.color,
      width: s.width,
      opacity: s.opacity,
      points: s.points.flatMap((q) => [Math.round(q.x * 1000) / 1000, Math.round(q.y * 1000) / 1000, Math.round(q.p * 10000) / 10000]),
    })),
    links: p.links,
    texts: p.texts,
  }));
  const images: WireImage[] = [];
  const blobs: Uint8Array[] = [];
  let offset = 0;
  pages.forEach((p, pageIndex) => {
    for (const im of p.images) {
      images.push({ page: pageIndex, id: im.id, x: im.x, y: im.y, w: im.w, h: im.h, mime: im.mime, offset, length: im.bytes.length });
      blobs.push(im.bytes);
      offset += im.bytes.length;
    }
  });
  const baseLength = baseBytes ? baseBytes.length : 0;
  const json = new TextEncoder().encode(
    JSON.stringify({
      pages: wirePages,
      images,
      baseLength,
      ...(bookmarks !== undefined ? { bookmarks } : {}),
      ...(opts.textLayers !== undefined ? { textLayers: opts.textLayers } : {}),
      ...(opts.notebook !== undefined ? { notebook: opts.notebook } : {}),
    }),
  );
  const out = new Uint8Array(4 + json.length + offset + baseLength);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  let pos = 4 + json.length;
  for (const b of blobs) {
    out.set(b, pos);
    pos += b.length;
  }
  if (baseBytes) out.set(baseBytes, pos);
  return out;
}

/** Save a server notebook by sending only the ink; the server rebuilds the PDF. */
export async function saveNotebookParsed(name: string, pages: PageModel[], ifMtime: number | null, baseBytes: Uint8Array | null = null, bookmarks?: Bookmark[], opts: SaveOptions = {}): Promise<NotebookInfo> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (ifMtime !== null) headers["X-If-Mtime"] = String(ifMtime);
  const res = await fetch(`/api/notebooks/${encodeURIComponent(name)}/save`, { method: "PUT", headers, body: encodeSaveEnvelope(pages, baseBytes, bookmarks, opts) as BodyInit });
  if (res.status === 409) {
    const j = (await res.json()) as { error: string; mtime: number | null };
    throw new ConflictError(j.error, j.mtime);
  }
  if (!res.ok) throw new Error(`Could not save ${name}: ${await errorMessage(res)}`);
  return (await res.json()) as NotebookInfo;
}

/**
 * Save bytes as notebook `name`. `ifMtime` is the mtime we loaded (to detect
 * changes on disk), "new" to refuse overwriting, or null to force.
 */
export async function saveNotebook(name: string, bytes: Uint8Array, ifMtime: number | "new" | null): Promise<NotebookInfo> {
  const headers: Record<string, string> = { "Content-Type": "application/pdf" };
  if (ifMtime !== null) headers["X-If-Mtime"] = String(ifMtime);
  const res = await fetch(`/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", headers, body: bytes as BodyInit });
  if (res.status === 409) {
    const j = (await res.json()) as { error: string; mtime: number | null };
    throw new ConflictError(j.error, j.mtime);
  }
  if (!res.ok) throw new Error(`Could not save ${name}: ${await errorMessage(res)}`);
  return (await res.json()) as NotebookInfo;
}

/** A pen-menu command the server offers (from its commands file). */
export interface CommandInfo {
  id: string;
  label: string;
  reload: boolean;
  confirm: boolean;
  /** Runs in the background with a chip in the toolbar; the request answers at once. */
  detach: boolean;
}

/** What a command run is told: where the pen was, this tab's session and the selection. */
export interface RunRequest {
  name: string;
  page: number;
  x: number;
  y: number;
  session?: string;
  selection?: { page: number; rect: Rect; count: number } | null;
}

export interface CommandRun {
  status: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  changed: boolean;
  mtime: number | null;
  reload: boolean;
  /** True when the command was detached: it has started and goes on in the background. */
  detached?: boolean;
  /** The bridge's id for the run. */
  run?: string;
}

export async function listCommands(): Promise<CommandInfo[]> {
  const res = await fetch("/api/commands", { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not list commands: ${await errorMessage(res)}`);
  return (await res.json()) as CommandInfo[];
}

/** Run command `id` for display point (x, y) on page index `page` of notebook `name`. */
export async function runCommand(id: string, req: RunRequest): Promise<CommandRun> {
  const res = await fetch(`/api/commands/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`Could not run command: ${await errorMessage(res)}`);
  return (await res.json()) as CommandRun;
}
