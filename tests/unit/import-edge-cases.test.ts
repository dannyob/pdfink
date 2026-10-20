import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib";
import { importPdf } from "../../src/pdf/import";

describe("import edge cases", () => {
  it("removes an ink annotation's popup from /Annots as well", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const ink = doc.context.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 10, 10], InkList: [[1, 1, 5, 5]], C: [0, 0, 0] });
    const inkRef = doc.context.register(ink);
    const popup = doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [0, 0, 50, 50], Parent: inkRef });
    const popupRef = doc.context.register(popup);
    ink.set(PDFName.of("Popup"), popupRef);
    const link = doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 20, 20] });
    page.node.set(PDFName.of("Annots"), doc.context.obj([inkRef, popupRef, doc.context.register(link)]));
    const bytes = await doc.save({ useObjectStreams: false });

    const imported = await importPdf(bytes);
    expect(imported.pages[0].strokes).toHaveLength(1);
    const stripped = await PDFDocument.load(imported.baseBytes);
    const annots = stripped.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(1);
    expect(annots.lookup(0, PDFDict).get(PDFName.of("Subtype"))).toBe(PDFName.of("Link"));
  });

  it("strips ink annotations stored as direct dictionaries", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const ink = doc.context.obj({ Type: "Annot", Subtype: "Ink", Rect: [0, 0, 10, 10], InkList: [[1, 1, 5, 5]], C: [1, 0, 0] });
    page.node.set(PDFName.of("Annots"), doc.context.obj([ink]));
    const bytes = await doc.save({ useObjectStreams: false });
    const imported = await importPdf(bytes);
    expect(imported.pages[0].strokes).toHaveLength(1);
    expect(imported.pages[0].strokes[0].color).toBe("#ff0000");
    const stripped = await PDFDocument.load(imported.baseBytes);
    expect(stripped.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it("drops objects that nothing references (incremental-update garbage)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    // An orphan form XObject, like a superseded annotation appearance.
    let ops = "";
    for (let i = 0; i < 4000; i++) ops += `${(Math.random() * 600).toFixed(3)} ${(Math.random() * 800).toFixed(3)} l\n`;
    const junk = doc.context.flateStream(`0 0 m\n${ops}S`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 100] });
    doc.context.register(junk);
    const bytes = await doc.save({ useObjectStreams: false });
    const imported = await importPdf(bytes);
    expect(imported.baseBytes.length).toBeLessThan(bytes.length / 2);
    const stripped = await PDFDocument.load(imported.baseBytes);
    const streams = stripped.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFStream);
    expect(streams.map(([, o]) => String((o as PDFStream).dict.get(PDFName.of("Subtype"))))).not.toContain("/Form");
    expect(stripped.getPageCount()).toBe(1);
  });

  it("refuses encrypted PDFs with a clear message", async () => {
    // Minimal PDF with an /Encrypt entry in the trailer.
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const enc = doc.context.obj({ Filter: "Standard", V: 1, R: 2, O: "x", U: "y", P: -1 });
    doc.context.trailerInfo.Encrypt = doc.context.register(enc);
    const bytes = await doc.save({ useObjectStreams: false });
    await expect(importPdf(bytes)).rejects.toThrow(/encrypted/i);
  });
});
