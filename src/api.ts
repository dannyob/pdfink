/** Client for the pdfink server API (see server/index.ts). */
import type { PageModel, Stroke } from "./model";

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
}

export function fromWirePages(pages: WirePage[]): PageModel[] {
  return pages.map((p) => ({
    width: p.width,
    height: p.height,
    images: [],
    strokes: p.strokes.map((s): Stroke => {
      const points = [];
      for (let i = 0; i + 2 < s.points.length; i += 3) points.push({ x: s.points[i], y: s.points[i + 1], p: s.points[i + 2] });
      return { id: s.id, color: s.color, width: s.width, opacity: s.opacity, points };
    }),
  }));
}

/** Decode the /open envelope: 4-byte JSON length, JSON, base PDF. */
export function decodeOpened(buf: ArrayBuffer): { baseBytes: Uint8Array; pages: PageModel[] } {
  const view = new DataView(buf);
  const jsonLen = view.getUint32(0);
  const json = new TextDecoder().decode(new Uint8Array(buf, 4, jsonLen));
  const { pages } = JSON.parse(json) as { pages: WirePage[] };
  return { baseBytes: new Uint8Array(buf, 4 + jsonLen), pages: fromWirePages(pages) };
}

/** Open a notebook parsed on the server (ink already separated from the base PDF). */
export async function openNotebookParsed(name: string): Promise<{ baseBytes: Uint8Array; pages: PageModel[]; mtime: number }> {
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

/** Build the /save envelope: JSON { pages, images } plus concatenated image bytes (and base PDF, if given). */
export function encodeSaveEnvelope(pages: PageModel[], baseBytes: Uint8Array | null = null): Uint8Array {
  const wirePages = pages.map((p) => ({
    width: p.width,
    height: p.height,
    strokes: p.strokes.map((s) => ({
      id: s.id,
      color: s.color,
      width: s.width,
      opacity: s.opacity,
      points: s.points.flatMap((q) => [Math.round(q.x * 1000) / 1000, Math.round(q.y * 1000) / 1000, Math.round(q.p * 10000) / 10000]),
    })),
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
  const json = new TextEncoder().encode(JSON.stringify({ pages: wirePages, images, baseLength }));
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
export async function saveNotebookParsed(name: string, pages: PageModel[], ifMtime: number | null, baseBytes: Uint8Array | null = null): Promise<NotebookInfo> {
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  if (ifMtime !== null) headers["X-If-Mtime"] = String(ifMtime);
  const res = await fetch(`/api/notebooks/${encodeURIComponent(name)}/save`, { method: "PUT", headers, body: encodeSaveEnvelope(pages, baseBytes) as BodyInit });
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
