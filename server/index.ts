/**
 * pdfink server. No dependencies; run with `node server/index.ts` (Node strips
 * the types itself).
 *
 *   --mode server   serve the built app AND the notebook API (default)
 *   --mode browser  serve the built app only; the app then opens and saves
 *                   files on the user's own device
 *   --host, --port  where to listen (default 127.0.0.1:5173)
 *   --notebooks DIR folder of PDFs for the API (default ./notebooks)
 *   --dist DIR      built app to serve (default ./dist; "none" for API only)
 *
 * Environment variables PDFINK_MODE, HOST, PORT, NOTEBOOKS_DIR and DIST_DIR
 * are used when a flag is not given.
 *
 * API (server mode)
 *   GET /api/status               → { mode, notebooksDir }
 *   GET /api/notebooks            → [{ name, size, mtime }]
 *   GET /api/notebooks/<name>     → PDF bytes, X-Mtime header (ms since epoch)
 *   PUT /api/notebooks/<name>     → body = PDF bytes. Header X-If-Mtime: "<ms>"
 *                                   (must match the file on disk) or "new"
 *                                   (file must not exist). 409 on mismatch.
 *   PUT /api/notebooks/<name>/save → body = envelope of stroke/image data (see
 *                                   decodeSaveEnvelope); the server rebuilds
 *                                   the PDF from its ink-free base and writes
 *                                   it. Same X-If-Mtime rules as a plain PUT.
 *   GET /api/notebooks/<name>/open → the notebook parsed on the server: a
 *                                   binary envelope (see encodeOpened) holding
 *                                   the page/stroke JSON and the PDF with the
 *                                   ink stripped out. Keeps the browser from
 *                                   parsing 300 MB files.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { importPdf, type ImportedDocument } from "../src/pdf/import.ts";
import { exportPdf } from "../src/pdf/export.ts";
import type { ImageItem, PageModel } from "../src/model.ts";

export type Mode = "server" | "browser";

export interface ServerOptions {
  mode: Mode;
  notebooksDir: string;
  distDir: string | null;
  host: string;
  port: number;
}

export interface NotebookInfo {
  name: string;
  size: number;
  mtime: number;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*\.pdf$/i;
const MAX_BODY = 1024 * 1024 * 1024; // 1 GB

export function validName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..") && name.length <= 200;
}

export async function listNotebooks(dir: string): Promise<NotebookInfo[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: NotebookInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith(".") || !e.name.toLowerCase().endsWith(".pdf")) continue;
    if (!validName(e.name)) continue;
    const st = await fsp.stat(path.join(dir, e.name));
    out.push({ name: e.name, size: st.size, mtime: Math.round(st.mtimeMs) });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Write bytes to `file` atomically (temp file in the same dir, then rename). */
export async function atomicWrite(file: string, bytes: Uint8Array): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.pdfink-${process.pid}-${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/** Compact wire form of a page: points as a flat [x, y, p, ...] array. */
interface WirePage {
  width: number;
  height: number;
  strokes: { id: string; color: string; width: number; opacity: number; points: number[] }[];
}

export function toWirePages(pages: PageModel[]): WirePage[] {
  return pages.map((p) => ({
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
}

/** Envelope: 4-byte big-endian JSON length, JSON, then the base PDF bytes. */
export function encodeOpened(imported: ImportedDocument): Buffer {
  const json = Buffer.from(JSON.stringify({ pages: toWirePages(imported.pages) }), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length, 0);
  return Buffer.concat([head, json, Buffer.from(imported.baseBytes)]);
}

export function fromWirePages(pages: WirePage[]): PageModel[] {
  return pages.map((p) => ({
    width: p.width,
    height: p.height,
    images: [],
    strokes: p.strokes.map((s) => {
      const points = [];
      for (let i = 0; i + 2 < s.points.length; i += 3) points.push({ x: s.points[i], y: s.points[i + 1], p: s.points[i + 2] });
      return { id: s.id, color: s.color, width: s.width, opacity: s.opacity, points };
    }),
  }));
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
 * Save envelope from the browser: 4-byte JSON length, JSON { pages, images },
 * then the concatenated image bytes that `images[].offset/length` index into.
 */
export function decodeSaveEnvelope(buf: Buffer): { pages: PageModel[]; baseBytes: Uint8Array | null } {
  if (buf.length < 4) throw new Error("short envelope");
  const jsonLen = buf.readUInt32BE(0);
  const json = buf.subarray(4, 4 + jsonLen).toString("utf8");
  const { pages, images, baseLength } = JSON.parse(json) as { pages: WirePage[]; images: WireImage[]; baseLength?: number };
  const blob = buf.subarray(4 + jsonLen);
  // Optional ink-free base PDF at the end of the blob (sent on forced overwrites).
  const baseBytes = baseLength ? new Uint8Array(blob.subarray(blob.length - baseLength)) : null;
  const out = fromWirePages(pages);
  for (const im of images ?? []) {
    const page = out[im.page];
    if (!page) continue;
    const item: ImageItem = { id: im.id, x: im.x, y: im.y, w: im.w, h: im.h, mime: im.mime, bytes: new Uint8Array(blob.subarray(im.offset, im.offset + im.length)) };
    page.images.push(item);
  }
  return { pages: out, baseBytes };
}

/** Parsed notebooks, keyed by name; valid while size and mtime match the file. */
const openCache = new Map<string, { size: number; mtime: number; body: Buffer; baseBytes: Uint8Array }>();
const OPEN_CACHE_MAX = 6;
const inflight = new Map<string, Promise<Buffer>>();

async function openNotebook(dir: string, name: string): Promise<{ body: Buffer; mtime: number } | null> {
  const file = path.join(dir, name);
  const st = await fsp.stat(file).catch(() => null);
  if (!st) return null;
  const mtime = Math.round(st.mtimeMs);
  const hit = openCache.get(name);
  if (hit && hit.size === st.size && hit.mtime === mtime) return { body: hit.body, mtime };
  let p = inflight.get(name);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const bytes = new Uint8Array(await fsp.readFile(file));
      const imported = await importPdf(bytes);
      const body = encodeOpened(imported);
      console.log(`pdfink: parsed ${name} (${(st.size / 1e6).toFixed(1)} MB → ${(body.length / 1e6).toFixed(1)} MB) in ${Date.now() - t0} ms`);
      openCache.set(name, { size: st.size, mtime, body, baseBytes: imported.baseBytes });
      if (openCache.size > OPEN_CACHE_MAX) openCache.delete(openCache.keys().next().value as string);
      return body;
    })().finally(() => inflight.delete(name));
    inflight.set(name, p);
  }
  return { body: await p, mtime };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

async function serveStatic(distDir: string, urlPath: string, res: http.ServerResponse): Promise<void> {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(distDir, rel));
  if (!file.startsWith(path.normalize(distDir + path.sep))) {
    res.writeHead(403).end();
    return;
  }
  let target = file;
  try {
    const st = await fsp.stat(target);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    target = path.join(distDir, "index.html"); // SPA fallback
  }
  const ext = path.extname(target).toLowerCase();
  const immutable = /\/assets\//.test(target) && ext !== ".html";
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(target).pipe(res);
}

async function handleApi(opts: ServerOptions, req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): Promise<void> {
  if (urlPath === "/api/status") {
    send(res, 200, opts.mode === "server" ? { mode: "server", notebooksDir: path.basename(opts.notebooksDir) } : { mode: "browser" });
    return;
  }
  if (opts.mode !== "server") {
    send(res, 404, { error: "notebook API is off (browser mode)" });
    return;
  }
  const m = /^\/api\/notebooks(?:\/([^/]+)(\/open|\/save)?)?$/.exec(urlPath);
  if (!m) {
    send(res, 404, { error: "not found" });
    return;
  }
  const name = m[1] ? decodeURIComponent(m[1]) : null;
  const wantOpen = m[2] === "/open";
  const wantSave = m[2] === "/save";
  if (name === null) {
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      return;
    }
    send(res, 200, await listNotebooks(opts.notebooksDir));
    return;
  }
  if (!validName(name)) {
    send(res, 400, { error: "invalid notebook name" });
    return;
  }
  const file = path.join(opts.notebooksDir, name);
  if (wantOpen) {
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" });
      return;
    }
    let opened: { body: Buffer; mtime: number } | null;
    try {
      opened = await openNotebook(opts.notebooksDir, name);
    } catch (err) {
      send(res, 422, { error: `Could not parse ${name}: ${(err as Error).message}` });
      return;
    }
    if (!opened) {
      send(res, 404, { error: "no such notebook" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(opened.body.length),
      "Cache-Control": "no-store",
      "X-Mtime": String(opened.mtime),
    });
    res.end(opened.body);
    return;
  }
  if (req.method === "GET") {
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      send(res, 404, { error: "no such notebook" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": String(st.size),
      "Cache-Control": "no-store",
      "X-Mtime": String(Math.round(st.mtimeMs)),
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  if (req.method === "PUT" && wantSave) {
    const ifMtime = req.headers["x-if-mtime"];
    const existing = await fsp.stat(file).catch(() => null);
    if (!existing) {
      send(res, 409, { error: "file no longer exists", mtime: null });
      return;
    }
    const mtime = Math.round(existing.mtimeMs);
    if (typeof ifMtime === "string" && ifMtime !== "" && Number(ifMtime) !== mtime) {
      send(res, 409, { error: "changed on disk", mtime });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      send(res, 413, { error: (err as Error).message });
      return;
    }
    let pages: PageModel[];
    let sentBase: Uint8Array | null;
    try {
      ({ pages, baseBytes: sentBase } = decodeSaveEnvelope(body));
    } catch (err) {
      send(res, 400, { error: `bad save envelope: ${(err as Error).message}` });
      return;
    }
    // The ink-free base: the one the client sent (forced overwrite), else the
    // cached one while it still matches the file on disk, else parse the file
    // again (it is the version the client has, since the mtime matched).
    const hit = openCache.get(name);
    let baseBytes: Uint8Array;
    if (sentBase) baseBytes = sentBase;
    else if (hit && hit.mtime === mtime && hit.size === existing.size) baseBytes = hit.baseBytes;
    else baseBytes = (await importPdf(new Uint8Array(await fsp.readFile(file)))).baseBytes;
    const t0 = Date.now();
    let out: Uint8Array;
    try {
      out = await exportPdf(baseBytes, pages);
    } catch (err) {
      // e.g. more pages of ink than the base has: the client must send its base.
      send(res, 422, { error: (err as Error).message });
      return;
    }
    await atomicWrite(file, out);
    openCache.delete(name);
    const st = await fsp.stat(file);
    console.log(`pdfink: saved ${name} (${(out.length / 1e6).toFixed(1)} MB) in ${Date.now() - t0} ms`);
    send(res, 200, { name, size: st.size, mtime: Math.round(st.mtimeMs) });
    return;
  }
  if (req.method === "PUT") {
    const ifMtime = req.headers["x-if-mtime"];
    const existing = await fsp.stat(file).catch(() => null);
    if (ifMtime === "new") {
      if (existing) {
        send(res, 409, { error: "already exists", mtime: Math.round(existing.mtimeMs) });
        return;
      }
    } else if (typeof ifMtime === "string" && ifMtime !== "") {
      if (!existing) {
        send(res, 409, { error: "file no longer exists", mtime: null });
        return;
      }
      if (Math.round(existing.mtimeMs) !== Number(ifMtime)) {
        send(res, 409, { error: "changed on disk", mtime: Math.round(existing.mtimeMs) });
        return;
      }
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      send(res, 413, { error: (err as Error).message });
      return;
    }
    if (body.length < 5 || body.subarray(0, 5).toString("latin1") !== "%PDF-") {
      send(res, 400, { error: "body is not a PDF" });
      return;
    }
    await atomicWrite(file, body);
    const st = await fsp.stat(file);
    send(res, existing ? 200 : 201, { name, size: st.size, mtime: Math.round(st.mtimeMs) });
    return;
  }
  send(res, 405, { error: "method not allowed" });
}

export function createServer(opts: ServerOptions): http.Server {
  return http.createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0];
    const run = urlPath.startsWith("/api/")
      ? handleApi(opts, req, res, urlPath)
      : opts.distDir
        ? serveStatic(opts.distDir, urlPath, res)
        : Promise.resolve(send(res, 404, { error: "no static files configured" }));
    run.catch((err: Error) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.end();
    });
  });
}

/** Options from command-line flags, falling back to environment variables, then defaults. */
export function optionsFrom(argv: string[], env: NodeJS.ProcessEnv = process.env): ServerOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      notebooks: { type: "string" },
      dist: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log("usage: node server/index.ts [--mode server|browser] [--host H] [--port P] [--notebooks DIR] [--dist DIR|none]");
    process.exit(0);
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const mode = (values.mode ?? env.PDFINK_MODE ?? "server") as Mode;
  if (mode !== "server" && mode !== "browser") throw new Error(`--mode must be "server" or "browser", not "${mode}"`);
  const dist = values.dist ?? (env.DIST_DIR === "" ? "none" : env.DIST_DIR) ?? path.resolve(here, "..", "dist");
  return {
    mode,
    notebooksDir: path.resolve(values.notebooks ?? env.NOTEBOOKS_DIR ?? "notebooks"),
    distDir: dist === "none" ? null : path.resolve(dist),
    host: values.host ?? env.HOST ?? "127.0.0.1",
    port: Number(values.port ?? env.PORT ?? 5173),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const opts = optionsFrom(process.argv.slice(2));
  if (opts.mode === "server") fs.mkdirSync(opts.notebooksDir, { recursive: true });
  if (opts.distDir && !fs.existsSync(path.join(opts.distDir, "index.html"))) {
    console.warn(`pdfink: no built app at ${opts.distDir} (run \`npm run build\` first); serving the API only`);
    opts.distDir = null;
  }
  createServer(opts).listen(opts.port, opts.host, () => {
    const where = opts.mode === "server" ? `notebooks=${opts.notebooksDir}` : "browser mode (no notebook API)";
    console.log(`pdfink: http://${opts.host}:${opts.port}/  ${where}  app=${opts.distDir ?? "(none)"}`);
  });
}
