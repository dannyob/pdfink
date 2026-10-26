import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, decodePDFRawStream, type PDFRawStream } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import { INK_TOLERANCE, thinPoints } from "../../src/pdf/thin";
import type { PageModel, Point, Stroke } from "../../src/model";

const pt = (x: number, y: number, p = 0.6): Point => ({ x, y, p });

function page(strokes: Stroke[]): PageModel {
  return { width: 612, height: 792, strokes, images: [], links: [], texts: [] };
}

function stroke(points: Point[], width = 2): Stroke {
  return { id: "s1", points, color: "#000000", width, opacity: 1 };
}

/** A gently jittered line: many points, all within a hair of the straight line. */
function denseLine(n: number): Point[] {
  return Array.from({ length: n }, (_, i) => pt(100 + i * 0.5, 200 + (i % 2) * 0.01));
}

async function inkAnnots(bytes: Uint8Array): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(0).node.Annots();
  const out: PDFDict[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const d = annots!.lookup(i);
    if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Ink")) out.push(d);
  }
  return out;
}

describe("thinPoints", () => {
  it("keeps only the ends of a jittery straight line", () => {
    const out = thinPoints(denseLine(200), 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(pt(100, 200));
    expect(out[1].x).toBeCloseTo(199.5, 2);
  });

  it("keeps a corner", () => {
    const pts = [...Array.from({ length: 20 }, (_, i) => pt(i, 0)), ...Array.from({ length: 20 }, (_, i) => pt(19, i + 1))];
    const out = thinPoints(pts, 2);
    expect(out.map((p) => [p.x, p.y])).toEqual([[0, 0], [19, 0], [19, 20]]);
  });

  it("keeps a pressure change that visibly changes the width", () => {
    // Straight line, pressure jumps from 0.2 to 0.9 halfway: a 2 pt pen changes width by 1.4 pt.
    const pts = Array.from({ length: 40 }, (_, i) => pt(i, 0, i < 20 ? 0.2 : 0.9));
    const out = thinPoints(pts, 2);
    expect(out.length).toBeGreaterThan(2);
    expect(out.some((p) => p.p === 0.2) && out.some((p) => p.p === 0.9)).toBe(true);
  });

  it("drops pressure jitter too small to see", () => {
    const pts = Array.from({ length: 40 }, (_, i) => pt(i, 0, 0.6 + (i % 2) * 0.001));
    expect(thinPoints(pts, 2)).toHaveLength(2);
  });

  it("is idempotent", () => {
    const pts = Array.from({ length: 300 }, (_, i) => pt(i * 0.3, 20 * Math.sin(i / 15), 0.5 + 0.3 * Math.sin(i / 7)));
    const once = thinPoints(pts, 2);
    expect(thinPoints(once, 2)).toEqual(once);
    expect(once.length).toBeLessThan(pts.length / 2);
  });

  it("rounds to hundredths of a point and thousandths of pressure", () => {
    const out = thinPoints([pt(1.23456, 2.34567, 0.123456), pt(9.87654, 8.76543, 0.654321)], 2);
    expect(out).toEqual([pt(1.23, 2.35, 0.123), pt(9.88, 8.77, 0.654)]);
  });

  it("leaves a dot alone", () => {
    expect(thinPoints([pt(5, 5)], 2)).toEqual([pt(5, 5)]);
  });

  it("never moves a kept point further than the tolerance from the original line", () => {
    const pts = Array.from({ length: 300 }, (_, i) => pt(i * 0.3, 20 * Math.sin(i / 15)));
    const out = thinPoints(pts, 2);
    // Every original point lies within tolerance (+ rounding) of the thinned polyline.
    const dist = (p: Point, a: Point, b: Point) => {
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    };
    for (const p of pts) {
      const d = Math.min(...out.slice(1).map((b, i) => dist(p, out[i], b)));
      expect(d).toBeLessThanOrEqual(INK_TOLERANCE + 0.01);
    }
  });
});

describe("smaller saved PDFs", () => {
  it("saves with compressed object streams", async () => {
    const out = await exportPdf(await createBlankPdf(1), [page([stroke(denseLine(10))])]);
    expect(Buffer.from(out).toString("latin1")).toContain("/ObjStm");
    expect((await importPdf(out)).pages[0].strokes).toHaveLength(1);
  });

  it("writes coordinates to hundredths and marks the ink as thinned", async () => {
    const out = await exportPdf(await createBlankPdf(1), [page([stroke([pt(10.123, 20.456, 0.61234), pt(30.789, 40.987, 0.4)])])]);
    const [a] = await inkAnnots(out);
    const nums = (a.lookup(PDFName.of("InkList")) as PDFArray).lookup(0) as PDFArray;
    for (let i = 0; i < nums.size(); i++) {
      const v = (nums.lookup(i) as PDFNumber).asNumber();
      expect(Math.round(v * 100) / 100).toBe(v);
    }
    expect((a.lookup(PDFName.of("PdfinkInk")) as PDFNumber).asNumber()).toBe(2);
  });

  it("draws runs of equal width as one path in the appearance", async () => {
    // Pressure steps once: a light run, the step segment (its average width) and a
    // heavy run — three stroke operations, not one per segment (five).
    const pts = [pt(0, 0, 0.3), pt(10, 5, 0.3), pt(20, 0, 0.3), pt(30, 5, 0.9), pt(40, 0, 0.9), pt(50, 5, 0.9)];
    const out = await exportPdf(await createBlankPdf(1), [page([stroke(pts)])]);
    const [a] = await inkAnnots(out);
    const n = (a.lookup(PDFName.of("AP")) as PDFDict).lookup(PDFName.of("N")) as PDFStream;
    const ops = new TextDecoder().decode(decodePDFRawStream(n as PDFRawStream).decode());
    expect(ops.match(/\bS\b/g)).toHaveLength(3);
  });

  it("thins ink from other apps on import, but not ink pdfink already thinned", async () => {
    const raw = await exportPdf(await createBlankPdf(1), [page([stroke(denseLine(5))])]);
    // Pretend another app wrote it: drop the marker and give it a dense path.
    const doc = await PDFDocument.load(raw);
    const [a] = await inkAnnots(await doc.save());
    void a;
    const annots = doc.getPage(0).node.Annots()!;
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i) as PDFDict;
      if (d.get(PDFName.of("Subtype")) !== PDFName.of("Ink")) continue;
      d.delete(PDFName.of("PdfinkInk"));
      d.set(PDFName.of("InkList"), doc.context.obj([denseLine(200).flatMap((p) => [p.x, 792 - p.y])]));
      d.delete(PDFName.of("PDFTron_Pressure_Thickness"));
    }
    const foreign = await importPdf(await doc.save());
    expect(foreign.pages[0].strokes[0].points).toHaveLength(2);

    // Ink pdfink wrote keeps every point it saved, even collinear ones.
    const ours = await exportPdf(await createBlankPdf(1), [page([stroke([pt(0, 0), pt(1, 0), pt(2, 0)])])]);
    expect((await importPdf(ours)).pages[0].strokes[0].points).toHaveLength(3);
  });
});
