import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { PDFDocument } from "pdf-lib";
import { createServer, encodeOpened } from "../../server/index";
import { decodeOpened, encodeSaveEnvelope } from "../../src/api";
import { PDFDict, PDFName } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import type { PageModel } from "../../src/model";

let dir: string;
let base: string;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfink-open-"));
  server = createServer({ mode: "server", notebooksDir: dir, distDir: null, host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const page = (): PageModel => ({ width: 612, height: 792, images: [], strokes: [] });

describe("server-side open", () => {
  it("envelope round-trips pages and base bytes", () => {
    const pages = [page()];
    pages[0].strokes.push({ id: "s", color: "#ff0000", width: 2, opacity: 0.5, points: [{ x: 1.5, y: 2.5, p: 0.25 }, { x: 3, y: 4, p: 1 }] });
    const buf = encodeOpened({ baseBytes: new Uint8Array([37, 80, 68, 70]), pages, geoms: [] });
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
});
