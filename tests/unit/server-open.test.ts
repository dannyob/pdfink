import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PDFDocument } from "pdf-lib";
import { createServer, encodeOpened } from "../../server/index";
import { decodeOpened, encodeSaveEnvelope } from "../../src/api";
import { PDFDict, PDFName } from "pdf-lib";
import { createBlankPdf, exportPdf, appendBlankPage } from "../../src/pdf/export";
import type { Bookmark, PageModel } from "../../src/model";

let dir: string;
let base: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-open-"));
  server = createServer({ mode: "server", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0, commandsFile: null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const page = (): PageModel => ({ width: 612, height: 792, images: [], strokes: [], links: [] });


/** The /Link annotations on page `i`, as dicts. */
function linkAnnots(doc: PDFDocument, i = 0): PDFDict[] {
  const annots = doc.getPage(i).node.Annots();
  const out: PDFDict[] = [];
  for (let k = 0; k < (annots?.size() ?? 0); k++) {
    const d = annots!.lookup(k);
    if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Link")) out.push(d);
  }
  return out;
}

/** Number of top-level entries in the file's outline (0 when it has none). */
function outlineEntries(doc: PDFDocument): number {
  const root = doc.catalog.lookup(PDFName.of("Outlines"));
  if (!(root instanceof PDFDict)) return 0;
  let n = 0;
  for (let it = root.lookup(PDFName.of("First")); it instanceof PDFDict; it = it.lookup(PDFName.of("Next"))) n++;
  return n;
}

async function openAt(name: string): Promise<{ mtime: number; opened: ReturnType<typeof decodeOpened> }> {
  const res = await fetch(`${base}/api/notebooks/${name}/open`);
  expect(res.status).toBe(200);
  return { mtime: Number(res.headers.get("x-mtime")), opened: decodeOpened(await res.arrayBuffer()) };
}

async function save(name: string, mtime: number, body: Uint8Array): Promise<Response> {
  return fetch(`${base}/api/notebooks/${name}/save`, { method: "PUT", headers: { "X-If-Mtime": String(mtime) }, body: body as BodyInit });
}

describe("server-side open", () => {
  it("envelope round-trips pages and base bytes", () => {
    const pages = [page()];
    pages[0].strokes.push({ id: "s", color: "#ff0000", width: 2, opacity: 0.5, points: [{ x: 1.5, y: 2.5, p: 0.25 }, { x: 3, y: 4, p: 1 }] });
    const buf = encodeOpened({ baseBytes: new Uint8Array([37, 80, 68, 70]), pages, geoms: [], bookmarks: [] });
    const back = decodeOpened(new Uint8Array(buf).buffer as ArrayBuffer);
    expect(Array.from(back.baseBytes)).toEqual([37, 80, 68, 70]);
    expect(back.pages[0].strokes[0]).toMatchObject({ id: "s", color: "#ff0000", width: 2, opacity: 0.5 });
    expect(back.pages[0].strokes[0].points).toEqual([{ x: 1.5, y: 2.5, p: 0.25 }, { x: 3, y: 4, p: 1 }]);
  });

  it("GET /open returns the stripped base and strokes, and refreshes when the file changes", async () => {
    const pages = [page(), page()];
    pages[1].strokes.push({ id: "a", color: "#000000", width: 1, opacity: 1, points: [{ x: 10, y: 10, p: 0.6 }, { x: 50, y: 10, p: 0.6 }] });
    fs.writeFileSync(path.join(dir, "n.pdf"), await exportPdf(await createBlankPdf(2), pages));

    let res = await fetch(`${base}/api/notebooks/n.pdf/open`);
    expect(res.status).toBe(200);
    const mtime1 = res.headers.get("x-mtime");
    let opened = decodeOpened(await res.arrayBuffer());
    expect(opened.pages).toHaveLength(2);
    expect(opened.pages[1].strokes).toHaveLength(1);
    expect(opened.pages[1].strokes[0].points[1].x).toBe(50);
    const stripped = await PDFDocument.load(opened.baseBytes);
    expect(stripped.getPage(1).node.Annots()?.size() ?? 0).toBe(0);

    // second call is served from cache (same mtime)
    res = await fetch(`${base}/api/notebooks/n.pdf/open`);
    expect(res.headers.get("x-mtime")).toBe(mtime1);

    // rewrite the file → new content comes through
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(dir, "n.pdf"), await createBlankPdf(3));
    res = await fetch(`${base}/api/notebooks/n.pdf/open`);
    opened = decodeOpened(await res.arrayBuffer());
    expect(opened.pages).toHaveLength(3);

    res = await fetch(`${base}/api/notebooks/missing.pdf/open`);
    expect(res.status).toBe(404);
    fs.writeFileSync(path.join(dir, "bad.pdf"), "%PDF-garbage");
    res = await fetch(`${base}/api/notebooks/bad.pdf/open`);
    expect(res.status).toBe(422);
  });

  it("PUT /save rebuilds the PDF on the server from strokes and images", async () => {
    const pages = [page(), page()];
    pages[0].strokes.push({ id: "old", color: "#000000", width: 1, opacity: 1, points: [{ x: 10, y: 10, p: 0.6 }, { x: 50, y: 10, p: 0.6 }] });
    fs.writeFileSync(path.join(dir, "s.pdf"), await exportPdf(await createBlankPdf(2), pages));
    let res = await fetch(`${base}/api/notebooks/s.pdf/open`);
    const mtime = Number(res.headers.get("x-mtime"));
    const opened = decodeOpened(await res.arrayBuffer());

    // client edits: drop the old stroke, add a pressure stroke on page 2 and an image on page 1
    const edited = opened.pages;
    edited[0].strokes = [];
    edited[1].strokes.push({ id: "n", color: "#ff0000", width: 3, opacity: 1, points: [{ x: 100, y: 100, p: 0.2 }, { x: 200, y: 100, p: 1 }] });
    const png = fs.readFileSync(path.resolve("tests/fixtures/arrow.png"));
    edited[0].images.push({ id: "im", x: 40, y: 40, w: 200, h: 120, mime: "image/png", bytes: new Uint8Array(png) });

    res = await fetch(`${base}/api/notebooks/s.pdf/save`, { method: "PUT", headers: { "X-If-Mtime": String(mtime - 5) }, body: encodeSaveEnvelope(edited) as BodyInit });
    expect(res.status).toBe(409);
    res = await fetch(`${base}/api/notebooks/s.pdf/save`, { method: "PUT", headers: { "X-If-Mtime": String(mtime) }, body: encodeSaveEnvelope(edited) as BodyInit });
    expect(res.status).toBe(200);

    const doc = await PDFDocument.load(fs.readFileSync(path.join(dir, "s.pdf")), { updateMetadata: false });
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    const a = doc.getPage(1).node.Annots()!.lookup(0, PDFDict);
    expect(a.get(PDFName.of("Subtype"))).toBe(PDFName.of("Ink"));
    expect(a.has(PDFName.of("PDFTron_Pressure_Thickness"))).toBe(true);
    expect(String(doc.getPage(0).node.Resources()?.lookup(PDFName.of("XObject")))).toContain("Image");

    // reopening sees the new state
    res = await fetch(`${base}/api/notebooks/s.pdf/open`);
    const again = decodeOpened(await res.arrayBuffer());
    expect(again.pages[0].strokes).toHaveLength(0);
    expect(again.pages[1].strokes[0].points[1].p).toBe(1);
  });

  it("PUT /save refuses more pages of ink than the base has unless the base comes too", async () => {
    fs.writeFileSync(path.join(dir, "grow.pdf"), await createBlankPdf(1));
    let res = await fetch(`${base}/api/notebooks/grow.pdf/open`);
    const mtime = Number(res.headers.get("x-mtime"));
    const opened = decodeOpened(await res.arrayBuffer());
    // The client added a page and wrote on it.
    const pages = [...opened.pages, page()];
    pages[1].strokes.push({ id: "p2", color: "#000000", width: 1, opacity: 1, points: [{ x: 10, y: 10, p: 0.6 }, { x: 50, y: 10, p: 0.6 }] });
    const grownBase = await appendBlankPage(opened.baseBytes);

    // Without its base the server cannot build page 2: it must say so, not drop the ink.
    res = await fetch(`${base}/api/notebooks/grow.pdf/save`, { method: "PUT", headers: { "X-If-Mtime": String(mtime) }, body: encodeSaveEnvelope(pages) as BodyInit });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/2 pages/);
    expect((await PDFDocument.load(fs.readFileSync(path.join(dir, "grow.pdf")), { updateMetadata: false })).getPageCount()).toBe(1);

    // With the base it works and the file grows.
    res = await fetch(`${base}/api/notebooks/grow.pdf/save`, { method: "PUT", headers: { "X-If-Mtime": String(mtime) }, body: encodeSaveEnvelope(pages, grownBase) as BodyInit });
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(fs.readFileSync(path.join(dir, "grow.pdf")), { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(1).node.Annots()!.size()).toBe(1);
  });

  it("/open carries links and bookmarks", async () => {
    const pages = [page()];
    pages[0].links.push({ id: "ln1", x: 72, y: 80, w: 200, h: 64, url: "https://example.org", label: "Example" });
    fs.writeFileSync(path.join(dir, "lk.pdf"), await exportPdf(await createBlankPdf(1), pages, [{ title: "Intro", page: 0, level: 0 }]));
    const { opened } = await openAt("lk.pdf");
    expect(opened.pages[0].links).toHaveLength(1);
    expect(opened.pages[0].links[0]).toMatchObject({ x: 72, y: 80, w: 200, h: 64, url: "https://example.org", label: "Example" });
    expect(opened.bookmarks).toEqual([{ title: "Intro", page: 0, level: 0 }]);
    // The base the browser gets has the URI link lifted out (it lives in the model now).
    expect(linkAnnots(await PDFDocument.load(opened.baseBytes))).toHaveLength(0);
  });

  it("envelopes round-trip links and bookmarks in memory", () => {
    const pages = [page()];
    pages[0].links.push({ id: "ln", x: 1.25, y: 2.5, w: 30, h: 40, url: "mailto:a@example.org" });
    const bms: Bookmark[] = [{ title: "T", page: null, level: 0 }];
    const back = decodeOpened(new Uint8Array(encodeOpened({ baseBytes: new Uint8Array([37]), pages, geoms: [], bookmarks: bms })).buffer as ArrayBuffer);
    expect(back.pages[0].links).toEqual(pages[0].links);
    expect(back.bookmarks).toEqual(bms);
    // The save envelope only names bookmarks when given them.
    const json = (env: Uint8Array) => JSON.parse(new TextDecoder().decode(env.subarray(4, 4 + new DataView(env.buffer).getUint32(0)))) as Record<string, unknown>;
    expect(json(encodeSaveEnvelope(pages))).not.toHaveProperty("bookmarks");
    expect(json(encodeSaveEnvelope(pages, null, []))).toMatchObject({ bookmarks: [] });
    expect(json(encodeSaveEnvelope(pages, null, bms)).pages).toEqual([expect.objectContaining({ links: pages[0].links })]);
  });

  it("/save writes links and bookmarks into the file", async () => {
    fs.writeFileSync(path.join(dir, "ws.pdf"), await createBlankPdf(2));
    const { mtime, opened } = await openAt("ws.pdf");
    expect(opened.bookmarks).toEqual([]);
    const edited = opened.pages;
    edited[1].links.push({ id: "ln2", x: 100, y: 100, w: 150, h: 30, url: "https://example.com/p" });
    const bms: Bookmark[] = [{ title: "One", page: 0, level: 0 }, { title: "Two", page: 1, level: 0 }];
    const res = await save("ws.pdf", mtime, encodeSaveEnvelope(edited, null, bms));
    expect(res.status).toBe(200);

    const doc = await PDFDocument.load(fs.readFileSync(path.join(dir, "ws.pdf")), { updateMetadata: false });
    expect(linkAnnots(doc, 0)).toHaveLength(0);
    expect(linkAnnots(doc, 1)).toHaveLength(1);
    expect(outlineEntries(doc)).toBe(2);

    // The cache is not stale: reopening sees the new links and bookmarks.
    const again = (await openAt("ws.pdf")).opened;
    expect(again.pages[1].links).toEqual([expect.objectContaining({ url: "https://example.com/p", x: 100, y: 100, w: 150, h: 30 })]);
    expect(again.bookmarks).toEqual(bms);
  });

  it("/save without bookmarks keeps the file's outline; an empty list removes it", async () => {
    fs.writeFileSync(path.join(dir, "keep.pdf"), await exportPdf(await createBlankPdf(2), [page(), page()], [{ title: "A", page: 0, level: 0 }, { title: "B", page: 1, level: 0 }]));
    let { mtime, opened } = await openAt("keep.pdf");
    opened.pages[0].strokes.push({ id: "k", color: "#000000", width: 1, opacity: 1, points: [{ x: 10, y: 10, p: 0.6 }, { x: 50, y: 10, p: 0.6 }] });
    let res = await save("keep.pdf", mtime, encodeSaveEnvelope(opened.pages));
    expect(res.status).toBe(200);
    let doc = await PDFDocument.load(fs.readFileSync(path.join(dir, "keep.pdf")), { updateMetadata: false });
    expect(outlineEntries(doc)).toBe(2);

    ({ mtime, opened } = await openAt("keep.pdf"));
    expect(opened.bookmarks.map((b) => b.title)).toEqual(["A", "B"]);
    res = await save("keep.pdf", mtime, encodeSaveEnvelope(opened.pages, null, []));
    expect(res.status).toBe(200);
    doc = await PDFDocument.load(fs.readFileSync(path.join(dir, "keep.pdf")), { updateMetadata: false });
    expect(outlineEntries(doc)).toBe(0);
    expect((await openAt("keep.pdf")).opened.bookmarks).toEqual([]);
  });

  it("a link's style travels through /open and /save", async () => {
    const pages = [page()];
    pages[0].links.push({ id: "st", x: 72, y: 80, w: 200, h: 64, url: "https://example.org/s", style: { border: [0, 0, 0], color: [1, 0, 0] } });
    fs.writeFileSync(path.join(dir, "style.pdf"), await exportPdf(await createBlankPdf(1), pages));
    let { mtime, opened } = await openAt("style.pdf");
    expect(opened.pages[0].links[0].style).toEqual({ border: [0, 0, 0], color: [1, 0, 0] });
    opened.pages[0].links[0].style = { border: [0, 0, 3] };
    const res = await save("style.pdf", mtime, encodeSaveEnvelope(opened.pages));
    expect(res.status).toBe(200);
    ({ opened } = await openAt("style.pdf"));
    expect(opened.pages[0].links[0].style).toEqual({ border: [0, 0, 3] });
  });

  it("/save refuses links on a page the base does not have", async () => {
    fs.writeFileSync(path.join(dir, "lgrow.pdf"), await createBlankPdf(1));
    const { mtime, opened } = await openAt("lgrow.pdf");
    const pages = [...opened.pages, page()];
    pages[1].links.push({ id: "ln3", x: 10, y: 10, w: 20, h: 20, url: "https://example.org" });
    const res = await save("lgrow.pdf", mtime, encodeSaveEnvelope(pages, null, []));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/2 pages/);
  });

  it("/save answers 400 to links or bookmarks of the wrong shape", async () => {
    fs.writeFileSync(path.join(dir, "shape.pdf"), await createBlankPdf(1));
    const { mtime } = await openAt("shape.pdf");
    /** A save envelope with the JSON part replaced by `obj` (no images, no base). */
    const raw = (obj: unknown): Uint8Array => {
      const json = Buffer.from(JSON.stringify(obj), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(json.length, 0);
      return new Uint8Array(Buffer.concat([head, json]));
    };
    const wire = (links: unknown) => ({ pages: [{ width: 612, height: 792, strokes: [], links }], images: [], baseLength: 0 });
    const good = { id: "g", x: 10, y: 10, w: 20, h: 20, url: "https://example.org" };
    const bad: unknown[] = [
      wire([{ ...good, x: "10" }]),
      wire([{ ...good, w: null }]),
      wire([{ ...good, url: 5 }]),
      wire([{ ...good, label: 7 }]),
      wire("nope"),
      { ...wire([good]), bookmarks: { title: "x" } },
      { ...wire([good]), bookmarks: [null] },
      { ...wire([good]), bookmarks: [{ title: 1, page: 0, level: 0 }] },
      { ...wire([good]), bookmarks: [{ title: "t", page: 1.5, level: 0 }] },
      { ...wire([good]), bookmarks: [{ title: "t", page: -1, level: 0 }] },
      { ...wire([good]), bookmarks: [{ title: "t", page: "0", level: 0 }] },
      { ...wire([good]), bookmarks: [{ title: "t", level: 0 }] },
      { ...wire([good]), bookmarks: [{ title: "t", page: 0, level: -1 }] },
      { ...wire([good]), bookmarks: [{ title: "t", page: 0 }] },
      wire([{ ...good, style: { border: "0 0 0" } }]),
      wire([{ ...good, style: { border: [0, 0, 0], color: ["red"] } }]),
    ];
    for (const body of bad) {
      const res = await save("shape.pdf", mtime, raw(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await save("shape.pdf", mtime, raw(wire([{ ...good, label: "fine" }])))).status).toBe(200);
    const { mtime: m2 } = await openAt("shape.pdf");
    const fine = { ...wire([{ ...good, style: { border: [0, 0, 0] } }]), bookmarks: [{ title: "t", page: null, level: 0 }, { title: "u", page: 0, level: 1 }] };
    expect((await save("shape.pdf", m2, raw(fine))).status).toBe(200);
  });
});
