import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream, degrees, rgb } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import { notesText } from "../../src/pdf/text";
import type { PageModel, Stroke, TextItem } from "../../src/model";

const STANDARD_FONTS = fileURLToPath(new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url));

const HELLO: TextItem = { id: "t1", x: 72, y: 100, w: 120, h: 20, text: "hello there", sig: "a1", note: 0 };
const GRUSSE: TextItem = { id: "t2", x: 72, y: 124, w: 80, h: 20, text: "Grüße — ok", note: 0 };
const STROKE: Stroke = { id: "s1", color: "#000000", width: 2, opacity: 1, points: [{ x: 80, y: 300, p: 0.6 }, { x: 140, y: 310, p: 0.6 }] };

const page = (texts: TextItem[], strokes: Stroke[] = [], w = 612, h = 792): PageModel => ({ width: w, height: h, strokes, images: [], links: [], texts });

interface PdfjsText {
  str: string;
  transform: number[];
  width: number;
}

const nonBlank = (items: PdfjsText[]) => items.filter((it) => it.str.trim() !== "");

/** The text items pdf.js finds on each page, with each page's viewport. */
async function pdfjsText(bytes: Uint8Array): Promise<{ items: PdfjsText[]; viewport: { convertToViewportPoint(x: number, y: number): number[] } }[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: STANDARD_FONTS });
  const doc = await task.promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const content = await p.getTextContent();
    const items = (content.items as PdfjsText[]).filter((it) => typeof it.str === "string");
    out.push({ items, viewport: p.getViewport({ scale: 1 }) });
  }
  await task.destroy();
  return out;
}

function contentCount(pdf: PDFDocument, i = 0): number {
  const c = pdf.getPage(i).node.Contents();
  if (!c) return 0;
  return c instanceof PDFArray ? c.size() : 1;
}

/** The page's content streams, decoded, in order. */
function contentData(pdf: PDFDocument, i = 0): string[] {
  const raw = pdf.getPage(i).node.get(PDFName.of("Contents"));
  const c = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw;
  const items = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, k) => c.lookup(k)) : [c];
  return items.map((s) => (s instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()) : String(s)));
}

function firstInk(pdf: PDFDocument, i = 0): PDFDict | undefined {
  const annots = pdf.getPage(i).node.Annots();
  if (!annots) return undefined;
  for (let k = 0; k < annots.size(); k++) {
    const d = annots.lookup(k);
    if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Ink")) return d;
  }
  return undefined;
}

describe("handwriting text in the PDF", () => {
  it("texts round-trip through /PdfinkText", async () => {
    const bytes = await exportPdf(await createBlankPdf(1), [page([HELLO, GRUSSE])]);
    const r = await importPdf(bytes);
    const texts = r.pages[0].texts;
    expect(texts).toHaveLength(2);
    for (const [got, want] of texts.map((t, i) => [t, [HELLO, GRUSSE][i]] as const)) {
      expect(got.x).toBeCloseTo(want.x, 2);
      expect(got.y).toBeCloseTo(want.y, 2);
      expect(got.w).toBeCloseTo(want.w, 2);
      expect(got.h).toBeCloseTo(want.h, 2);
      expect(got.text).toBe(want.text);
      expect(got.sig).toBe(want.sig);
      expect(got.note).toBe(want.note);
      expect(typeof got.id).toBe("string");
      expect(got.id).not.toBe(want.id);
    }
    expect(texts[0].id).not.toBe(texts[1].id);
    // The base no longer carries the entry.
    const base = await PDFDocument.load(r.baseBytes);
    expect(base.getPage(0).node.get(PDFName.of("PdfinkText"))).toBeUndefined();
  });

  it("notebook pages get one invisible layer, never two", async () => {
    let bytes = await exportPdf(await createBlankPdf(1), [page([HELLO, GRUSSE])], undefined, { textLayers: [true] });
    for (let n = 0; n < 3; n++) {
      const r = await importPdf(bytes);
      const [basePage] = await pdfjsText(r.baseBytes);
      expect(nonBlank(basePage.items)).toEqual([]);
      bytes = await exportPdf(r.baseBytes, r.pages, undefined, { textLayers: [true] });
    }
    const [final] = await pdfjsText(bytes);
    const joined = final.items.map((it) => it.str).join(" ");
    expect(joined.split("hello there")).toHaveLength(2);
  });

  it("the layer sits inside each line's box", async () => {
    const bytes = await exportPdf(await createBlankPdf(1), [page([HELLO])], undefined, { textLayers: [true] });
    const [p] = await pdfjsText(bytes);
    const item = p.items.find((it) => it.str === "hello there")!;
    expect(item).toBeDefined();
    // Baseline start: the box's bottom-left, lifted by the 0.2 h descender allowance.
    expect(Math.abs(item.transform[4] - 72)).toBeLessThanOrEqual(1);
    expect(Math.abs(item.transform[5] - (792 - 120 + 0.2 * 20))).toBeLessThanOrEqual(1);
    expect(Math.abs(item.width - 120)).toBeLessThanOrEqual(2);
  });

  it.each([90, 180, 270])("the layer sits inside each line's box on a page rotated %i degrees", async (rot) => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).setRotation(degrees(rot));
    const base = await doc.save({ useObjectStreams: false });
    const box = { id: "r1", x: 300, y: 200, w: 150, h: 24, text: "hello there" };
    const [dw, dh] = rot % 180 ? [792, 612] : [612, 792];
    const bytes = await exportPdf(base, [page([box], [], dw, dh)], undefined, { textLayers: [true] });
    const [p] = await pdfjsText(bytes);
    const item = p.items.find((it) => it.str === "hello there")!;
    expect(item).toBeDefined();
    const [a, b, , , e, f] = item.transform;
    const len = Math.hypot(a, b);
    const start = p.viewport.convertToViewportPoint(e, f);
    const end = p.viewport.convertToViewportPoint(e + (item.width * a) / len, f + (item.width * b) / len);
    for (const [x, y] of [start, end]) {
      expect(x).toBeGreaterThanOrEqual(box.x - 2);
      expect(x).toBeLessThanOrEqual(box.x + box.w + 2);
      expect(y).toBeGreaterThanOrEqual(box.y - 1);
      expect(y).toBeLessThanOrEqual(box.y + box.h + 1);
    }
    expect(Math.abs(end[0] - start[0] - box.w)).toBeLessThanOrEqual(2);
  });

  it("document pages get no layer", async () => {
    const bytes = await exportPdf(await createBlankPdf(1), [page([HELLO, GRUSSE], [STROKE])], undefined, { textLayers: [false] });
    const [p] = await pdfjsText(bytes);
    expect(nonBlank(p.items)).toEqual([]);
    const ink = firstInk(await PDFDocument.load(bytes))!;
    const contents = ink.lookup(PDFName.of("Contents"));
    expect(contents instanceof PDFHexString || contents instanceof PDFString).toBe(true);
    expect((contents as PDFHexString).decodeText()).toBe("hello there Grüße — ok");
  });

  it("contents groups notes into paragraphs", () => {
    const t = (text: string, y: number, note?: number): TextItem => ({ id: text, x: 72, y, w: 50, h: 15, text, ...(note === undefined ? {} : { note }) });
    expect(notesText([t("d", 500), t("c", 300, 1), t("b", 120, 0), t("a", 100, 0)])).toBe("a b\n\nc\n\nd");
  });

  it("non-WinAnsi text becomes ? in the layer only", async () => {
    const kanji: TextItem = { id: "k", x: 72, y: 100, w: 120, h: 20, text: "漢字 ok" };
    const bytes = await exportPdf(await createBlankPdf(1), [page([kanji])], undefined, { textLayers: [true] });
    const [p] = await pdfjsText(bytes);
    expect(p.items.map((it) => it.str).join("")).toBe("?? ok");
    const r = await importPdf(bytes);
    expect(r.pages[0].texts.map((t) => t.text)).toEqual(["漢字 ok"]);
  });

  it("the notebook tag round-trips", async () => {
    const blank = await createBlankPdf(1, { notebook: true });
    let r = await importPdf(blank);
    expect(r.notebook).toBe(true);
    r = await importPdf(await exportPdf(r.baseBytes, r.pages, undefined, { notebook: false }));
    expect(r.notebook).toBe(false);
    const fromFalse = r;
    r = await importPdf(await exportPdf(fromFalse.baseBytes, fromFalse.pages));
    expect(r.notebook).toBe(false);
    r = await importPdf(await exportPdf(r.baseBytes, r.pages, undefined, { notebook: null }));
    expect(r.notebook).toBe(null);
    r = await importPdf(await exportPdf(r.baseBytes, r.pages));
    expect(r.notebook).toBe(null);
    expect((await importPdf(await createBlankPdf(1))).notebook).toBe(null);
  });

  it("a file with /PdfinkText but no layer and no ink still opens and exports both", async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([612, 792]);
    // [x0 y0 x1 y1 (text) (sig) note] in PDF user space; HELLO's box is 72..192 x 672..692.
    p.node.set(
      PDFName.of("PdfinkText"),
      doc.context.obj([doc.context.obj([72, 672, 192, 692, PDFHexString.fromText("hello there"), PDFHexString.fromText(""), -1])]),
    );
    const r = await importPdf(await doc.save({ useObjectStreams: false }));
    expect(r.pages[0].texts).toEqual([expect.objectContaining({ x: 72, y: 100, w: 120, h: 20, text: "hello there" })]);
    expect(r.pages[0].texts[0].sig).toBeUndefined();
    expect(r.pages[0].texts[0].note).toBeUndefined();
    const bytes = await exportPdf(r.baseBytes, r.pages, undefined, { textLayers: [true] });
    const [layer] = await pdfjsText(bytes);
    expect(nonBlank(layer.items).map((it) => it.str)).toEqual(["hello there"]);
    const again = await importPdf(bytes);
    expect(again.pages[0].texts.map((t) => t.text)).toEqual(["hello there"]);
  });

  it("pages without texts are unchanged", async () => {
    const base = await createBlankPdf(1);
    const before = contentCount(await PDFDocument.load(base));
    const bytes = await exportPdf(base, [page([])], undefined, { textLayers: [true] });
    const out = await PDFDocument.load(bytes);
    expect(contentCount(out)).toBe(before);
    expect(out.getPage(0).node.get(PDFName.of("PdfinkText"))).toBeUndefined();
  });

  it("repeated layered saves of a page with its own content keep /Contents stable and the content untouched", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawRectangle({ x: 50, y: 50, width: 100, height: 40, color: rgb(1, 0, 0) });
    const base = await doc.save({ useObjectStreams: false });
    const original = contentData(await PDFDocument.load(base));
    let bytes = await exportPdf(base, [page([HELLO])], undefined, { textLayers: [true] });
    const layeredCount = contentCount(await PDFDocument.load(bytes));
    for (let n = 0; n < 5; n++) {
      const r = await importPdf(bytes);
      expect(contentData(await PDFDocument.load(r.baseBytes))).toEqual(original);
      bytes = await exportPdf(r.baseBytes, r.pages, undefined, { textLayers: [true] });
      expect(contentCount(await PDFDocument.load(bytes))).toBe(layeredCount);
    }
    const [p] = await pdfjsText(bytes);
    expect(nonBlank(p.items).map((it) => it.str)).toEqual(["hello there"]);
  });

  it("a page whose /Contents is a single stream gets it back as a single stream", async () => {
    const doc = await PDFDocument.create();
    const pg = doc.addPage([612, 792]);
    const stream = doc.context.register(doc.context.flateStream("0 0 1 rg 10 10 50 50 re f"));
    pg.node.set(PDFName.of("Contents"), stream);
    const base = await doc.save({ useObjectStreams: false });
    const original = contentData(await PDFDocument.load(base));
    const r = await importPdf(await exportPdf(base, [page([HELLO])], undefined, { textLayers: [true] }));
    const back = await PDFDocument.load(r.baseBytes);
    const c = back.getPage(0).node.Contents();
    expect(c instanceof PDFStream).toBe(true);
    expect(contentData(back)).toEqual(original);
  });

  it("the layer is not moved by a base whose content leaves the CTM changed", async () => {
    const doc = await PDFDocument.create();
    const pg = doc.addPage([612, 792]);
    pg.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream("2 0 0 2 0 0 cm 0 0 1 rg 1 1 5 5 re f")));
    const bytes = await exportPdf(await doc.save({ useObjectStreams: false }), [page([HELLO])], undefined, { textLayers: [true] });
    const [p] = await pdfjsText(bytes);
    const item = p.items.find((it) => it.str === "hello there")!;
    expect(Math.abs(item.transform[4] - 72)).toBeLessThanOrEqual(1);
    expect(Math.abs(item.width - 120)).toBeLessThanOrEqual(2);
  });

  it("a coalesced /Contents (one stream holding the page content and the layer) keeps the page content", async () => {
    const doc0 = await PDFDocument.create();
    doc0.addPage([612, 792]).drawRectangle({ x: 50, y: 50, width: 100, height: 40, color: rgb(1, 0, 0) });
    const layered = await PDFDocument.load(await exportPdf(await doc0.save({ useObjectStreams: false }), [page([HELLO])], undefined, { textLayers: [true] }));
    const parts = contentData(layered);
    expect(parts.length).toBeGreaterThan(1);
    // Another tool merges the content array into one stream (qpdf --coalesce-contents style).
    layered.getPage(0).node.set(PDFName.of("Contents"), layered.context.register(layered.context.flateStream(parts.join("\n"))));
    const r = await importPdf(await layered.save({ useObjectStreams: false }));
    expect(r.pages[0].texts.map((t) => t.text)).toEqual(["hello there"]);
    const back = contentData(await PDFDocument.load(r.baseBytes));
    expect(back.join("\n")).toContain("1 0 0 rg");
    // And it still exports.
    const again = await exportPdf(r.baseBytes, r.pages, undefined, { textLayers: [true] });
    expect(contentData(await PDFDocument.load(again)).join("\n")).toContain("1 0 0 rg");
  });
});
