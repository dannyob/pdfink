import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import { pressureFactor, isUniformPressure, DEFAULT_PRESSURE } from "../../src/model";
import { strokeBounds } from "../../src/geometry";
import type { PageModel, Stroke } from "../../src/model";

describe("pressure model", () => {
  it("gives nominal width at the default pressure and scales with it", () => {
    expect(pressureFactor(DEFAULT_PRESSURE)).toBeCloseTo(1, 6);
    expect(pressureFactor(0)).toBeCloseTo(0.4, 6);
    expect(pressureFactor(1)).toBeCloseTo(1.4, 6);
    expect(pressureFactor(5)).toBeCloseTo(1.4, 6);
  });
  it("bounds grow with the heaviest point", () => {
    const s: Stroke = { id: "a", color: "#000", width: 10, opacity: 1, points: [{ x: 0, y: 0, p: 1 }, { x: 10, y: 0, p: 0.2 }] };
    expect(strokeBounds(s).x).toBeCloseTo(-7, 6);
    expect(isUniformPressure(s)).toBe(false);
  });
});

describe("pressure round trip", () => {
  it("imports PDFTron-style PDFTron_Pressure_Thickness as point pressure", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const ink = doc.context.obj({
      Type: "Annot",
      Subtype: "Ink",
      Rect: [0, 0, 100, 100],
      InkList: [[10, 700, 20, 700, 30, 700]],
      PDFTron_Pressure_Thickness: [[0.1, 0.5, 0.9]],
      C: [0, 0, 0],
      BS: { W: 12.7 },
    });
    page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(ink)]));
    const imported = await importPdf(await doc.save({ useObjectStreams: false }));
    const s = imported.pages[0].strokes[0];
    expect(s.width).toBe(12.7);
    expect(s.points.map((p) => p.p)).toEqual([0.1, 0.5, 0.9]);
  });

  it("exports variable-width strokes segment by segment and writes the pressure array back", async () => {
    const pages: PageModel[] = [
      {
        width: 612,
        height: 792,
        images: [],
        links: [],
        texts: [],
        strokes: [
          { id: "v", color: "#000000", width: 2, opacity: 1, points: [{ x: 10, y: 10, p: 0.2 }, { x: 20, y: 10, p: 0.6 }, { x: 30, y: 10, p: 1 }] },
          { id: "u", color: "#000000", width: 2, opacity: 1, points: [{ x: 10, y: 50, p: 0.6 }, { x: 30, y: 50, p: 0.6 }] },
        ],
      },
    ];
    const out = await exportPdf(await createBlankPdf(1), pages);
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const a = doc.getPage(0).node.Annots()!.lookup(0, PDFDict);
    const pr = a.lookup(PDFName.of("PDFTron_Pressure_Thickness"), PDFArray);
    expect(pr.size()).toBe(2);
    expect(pr.lookup(0, PDFArray).lookup(2, PDFNumber).asNumber()).toBe(1);
    const ap = a.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N")) as PDFRawStream;
    const content = Buffer.from(decodePDFRawStream(ap).decode()).toString("latin1");
    // variable stroke: two segments at widths 2*(0.4+0.4)=1.6 and 2*(0.4+0.8)=2.4
    expect(content).toContain("1.6 w");
    expect(content).toContain("2.4 w");
    // uniform stroke: one path at nominal width
    expect(content).toContain("2 w\n10 742 m\n30 742 l\nS");
    // Rect allows for the heaviest point: half width 2*1.4/2 = 1.4
    const rect = a.lookup(PDFName.of("Rect"), PDFArray);
    expect(rect.lookup(0, PDFNumber).asNumber()).toBeCloseTo(8.6, 6);

    const again = await importPdf(out);
    expect(again.pages[0].strokes[0].points.map((p) => p.p)).toEqual([0.2, 0.6, 1]);
  });
});
