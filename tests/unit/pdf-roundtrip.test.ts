import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { appendBlankPage, createBlankPdf, exportPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import { displayToPdf, pdfToDisplay } from "../../src/pdf/geom";
import type { PageModel } from "../../src/model";

function page(w = 612, h = 792): PageModel {
  return { width: w, height: h, strokes: [], images: [] };
}

describe("geom", () => {
  it("round-trips for every rotation", () => {
    for (const rotate of [0, 90, 180, 270]) {
      const g = { cx: 5, cy: 7, cw: 612, ch: 792, rotate };
      const d = { x: 100, y: 200 };
      const p = displayToPdf(g, d.x, d.y);
      const back = pdfToDisplay(g, p.x, p.y);
      expect(back.x).toBeCloseTo(d.x);
      expect(back.y).toBeCloseTo(d.y);
    }
  });
  it("maps display top-left to pdf (cx, cy+ch) for rotate 0", () => {
    expect(displayToPdf({ cx: 0, cy: 0, cw: 612, ch: 792, rotate: 0 }, 0, 0)).toEqual({ x: 0, y: 792 });
  });
});

describe("pdf export/import", () => {
  it("refuses to export more pages of ink than the base has", async () => {
    const base = await createBlankPdf(1);
    const pages = [{ width: 612, height: 792, strokes: [], images: [] }, { width: 612, height: 792, strokes: [], images: [] }];
    await expect(exportPdf(base, pages)).rejects.toThrow(/2 pages but the PDF has 1/);
  });

  it("creates a blank Letter PDF and appends pages", async () => {
    const bytes = await createBlankPdf();
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const more = await appendBlankPage(bytes);
    expect((await PDFDocument.load(more)).getPageCount()).toBe(2);
  });

  it("writes strokes as /Ink annotations and reads them back", async () => {
    const base = await createBlankPdf(2);
    const pages = [page(), page()];
    pages[0].strokes.push({
      id: "s1",
      color: "#ff0000",
      width: 3,
      opacity: 1,
      points: [
        { x: 100, y: 100, p: 0.5 },
        { x: 200, y: 150, p: 0.5 },
      ],
    });
    pages[0].strokes.push({
      id: "s2",
      color: "#ff0000",
      width: 3,
      opacity: 1,
      points: [{ x: 300, y: 300, p: 0.5 }, { x: 310, y: 300, p: 0.5 }],
    });
    pages[1].strokes.push({
      id: "s3",
      color: "#000000",
      width: 1,
      opacity: 0.5,
      points: [{ x: 10, y: 20, p: 0.5 }, { x: 30, y: 40, p: 0.5 }],
    });
    const out = await exportPdf(base, pages);

    const doc = await PDFDocument.load(out);
    const annots = doc.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(1); // same colour/width → one annotation
    const a = annots.lookup(0, PDFDict);
    expect(a.get(PDFName.of("Subtype"))).toBe(PDFName.of("Ink"));
    const ink = a.lookup(PDFName.of("InkList"), PDFArray);
    expect(ink.size()).toBe(2);
    const first = ink.lookup(0, PDFArray);
    expect(first.lookup(0, PDFNumber).asNumber()).toBe(100);
    expect(first.lookup(1, PDFNumber).asNumber()).toBe(692); // 792 - 100
    expect(a.has(PDFName.of("AP"))).toBe(true);

    const imported = await importPdf(out);
    expect(imported.pages.length).toBe(2);
    expect(imported.pages[0].strokes.length).toBe(2);
    expect(imported.pages[0].strokes[0].color).toBe("#ff0000");
    expect(imported.pages[0].strokes[0].width).toBe(3);
    expect(imported.pages[0].strokes[0].points[1].x).toBeCloseTo(200);
    expect(imported.pages[0].strokes[0].points[1].y).toBeCloseTo(150);
    expect(imported.pages[1].strokes[0].opacity).toBeCloseTo(0.5);
    // The base has no ink left in it
    const stripped = await PDFDocument.load(imported.baseBytes);
    expect(stripped.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it("keeps non-ink annotations when stripping", async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([612, 792]);
    const sq = doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [10, 10, 50, 50], C: [1, 0, 0] });
    p.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(sq)]));
    const bytes = await doc.save();
    const out = await exportPdf(bytes, [
      { ...page(), strokes: [{ id: "x", color: "#000000", width: 1, opacity: 1, points: [{ x: 1, y: 1, p: 1 }, { x: 2, y: 2, p: 1 }] }] },
    ]);
    const imported = await importPdf(out);
    const stripped = await PDFDocument.load(imported.baseBytes);
    const annots = stripped.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(1);
    expect(annots.lookup(0, PDFDict).get(PDFName.of("Subtype"))).toBe(PDFName.of("Square"));
  });

  it("imports the real notebook export format", async () => {
    const fs = await import("node:fs");
    const path = `${process.env.PDFINK_SAMPLES ?? ""}/2026-postscarcity.pdf`;
    if (!process.env.PDFINK_SAMPLES || !fs.existsSync(path)) return;
    const bytes = new Uint8Array(fs.readFileSync(path));
    const imported = await importPdf(bytes);
    expect(imported.pages.length).toBe(100);
    expect(imported.pages[0].strokes.length).toBeGreaterThan(100);
    expect(imported.pages[0].width).toBe(612);
    const s = imported.pages[0].strokes[0];
    expect(s.color).toBe("#000000");
    expect(s.width).toBe(1);
    // all points within page
    for (const p of s.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(612);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(792);
    }
  }, 60_000);
});
