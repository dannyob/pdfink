import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, degrees } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import { linkUrlOk } from "../../src/pdf/links";
import type { LinkItem, PageModel } from "../../src/model";

const page = (w: number, h: number, links: LinkItem[] = []): PageModel => ({ width: w, height: h, strokes: [], images: [], links });

/** One Letter page whose /Annots is an indirect array holding `annots` (each registered). */
async function pdfWithAnnots(build: (doc: PDFDocument, pageRef: PDFRef) => PDFDict[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  const refs = build(doc, p.ref).map((d) => doc.context.register(d));
  p.node.set(PDFName.of("Annots"), doc.context.register(doc.context.obj(refs)));
  return doc.save({ useObjectStreams: false });
}

function linkAnnots(doc: PDFDocument, i = 0): PDFDict[] {
  const annots = doc.getPage(i).node.Annots();
  if (!annots) return [];
  const out: PDFDict[] = [];
  for (let k = 0; k < annots.size(); k++) {
    const d = annots.lookup(k);
    if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Link")) out.push(d);
  }
  return out;
}

function text(o: unknown): string {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : "";
}

describe("links", () => {
  it("lifts a URI link into the model and leaves a GoTo link in the base", async () => {
    const bytes = await pdfWithAnnots((doc, pageRef) => [
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 648, 272, 712], A: { S: "URI", URI: PDFString.of("https://example.org") } }),
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 500, 272, 560], A: { S: "GoTo", D: [pageRef, "Fit"] } }),
    ]);
    const r = await importPdf(bytes);
    expect(r.pages[0].links).toEqual([expect.objectContaining({ x: 72, y: 80, w: 200, h: 64, url: "https://example.org" })]);
    expect(r.pages[0].links[0].id).toMatch(/^ln/);
    const base = await PDFDocument.load(r.baseBytes);
    const annots = base.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(1); // the GoTo link
    expect(annots.lookup(0, PDFDict).lookup(PDFName.of("A"), PDFDict).get(PDFName.of("S"))).toBe(PDFName.of("GoTo"));
  });

  it("lifts a link whose /A is an indirect reference; leaves /Dest links and zero-size links alone", async () => {
    const bytes = await pdfWithAnnots((doc, pageRef) => {
      const action = doc.context.register(doc.context.obj({ S: "URI", URI: PDFString.of("https://a.example/x") }));
      return [
        doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [272, 712, 72, 648], A: action }),
        doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], Dest: [pageRef, "Fit"] }),
        doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [5, 5, 5, 5], A: { S: "URI", URI: PDFString.of("https://zero.example") } }),
      ];
    });
    const r = await importPdf(bytes);
    expect(r.pages[0].links).toEqual([expect.objectContaining({ x: 72, y: 80, w: 200, h: 64, url: "https://a.example/x" })]);
    const base = await PDFDocument.load(r.baseBytes);
    expect(linkAnnots(base)).toHaveLength(2);
  });

  it("round-trips a link on a 90° rotated page", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).setRotation(degrees(90));
    const blank = await doc.save({ useObjectStreams: false });
    const link: LinkItem = { id: "l1", x: 100, y: 50, w: 150, h: 30, url: "https://example.org/rot" };
    const out = await exportPdf(blank, [page(792, 612, [link])]);
    const r = await importPdf(out);
    const [got] = r.pages[0].links;
    expect(r.pages[0].links).toHaveLength(1);
    for (const k of ["x", "y", "w", "h"] as const) expect(got[k]).toBeCloseTo(link[k], 2);
    expect(got.url).toBe(link.url);
  });

  it("exportPdf writes /Link with a URI action, border and label", async () => {
    const link: LinkItem = { id: "l1", x: 72, y: 80, w: 200, h: 64, url: "https://example.org", label: "Example" };
    const out = await exportPdf(await createBlankPdf(1), [page(612, 792, [link])]);
    const doc = await PDFDocument.load(out);
    const [annot] = linkAnnots(doc);
    expect(annot).toBeDefined();
    const a = annot.lookup(PDFName.of("A"), PDFDict);
    expect(a.get(PDFName.of("S"))).toBe(PDFName.of("URI"));
    expect(text(a.get(PDFName.of("URI")))).toBe("https://example.org");
    expect(text(annot.get(PDFName.of("Contents")))).toBe("Example");
    expect(annot.lookup(PDFName.of("Border"), PDFArray).asArray().map(String)).toEqual(["0", "0", "1"]);
    expect(annot.lookup(PDFName.of("C"), PDFArray).asArray().map(String)).toEqual(["0", "0", "1"]);
    expect(annot.lookup(PDFName.of("Rect"), PDFArray).asArray().map(String)).toEqual(["72", "648", "272", "712"]);
    expect(String(annot.get(PDFName.of("F")))).toBe("4");
    expect(text(annot.get(PDFName.of("NM")))).toMatch(/^pdfink-/);
    const r = await importPdf(out);
    expect(r.pages[0].links).toEqual([expect.objectContaining({ x: 72, y: 80, w: 200, h: 64, url: "https://example.org", label: "Example" })]);
  });

  it("keeps an imported link's /Border and /C; /BS /W stands in for a missing /Border", async () => {
    const uri = (u: string) => ({ S: "URI", URI: PDFString.of(u) });
    const bytes = await pdfWithAnnots((doc) => [
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 648, 272, 712], Border: [0, 0, 0], C: [1, 0, 0], A: uri("https://a.example") }),
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 500, 272, 560], BS: { W: 2, S: "S" }, A: uri("https://b.example") }),
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 400, 272, 460], A: uri("https://c.example") }),
    ]);
    const r = await importPdf(bytes);
    expect(r.pages[0].links.map((l) => l.style)).toEqual([{ border: [0, 0, 0], color: [1, 0, 0] }, { border: [0, 0, 2] }, undefined]);
    const doc = await PDFDocument.load(await exportPdf(r.baseBytes, r.pages));
    const byUrl = new Map(linkAnnots(doc).map((d) => [text(d.lookup(PDFName.of("A"), PDFDict).get(PDFName.of("URI"))), d]));
    const nums = (d: PDFDict | undefined, key: string) => d?.lookup(PDFName.of(key), PDFArray).asArray().map(String);
    expect(nums(byUrl.get("https://a.example"), "Border")).toEqual(["0", "0", "0"]);
    expect(nums(byUrl.get("https://a.example"), "C")).toEqual(["1", "0", "0"]);
    expect(nums(byUrl.get("https://b.example"), "Border")).toEqual(["0", "0", "2"]);
    expect(byUrl.get("https://b.example")!.has(PDFName.of("C"))).toBe(false);
    // No border information at all: pdfink's own default.
    expect(nums(byUrl.get("https://c.example"), "Border")).toEqual(["0", "0", "1"]);
    expect(nums(byUrl.get("https://c.example"), "C")).toEqual(["0", "0", "1"]);
  });

  it("keeps parentheses, backslashes and non-ASCII in the URL and label", async () => {
    const link: LinkItem = { id: "l1", x: 10, y: 10, w: 50, h: 20, url: "https://en.wikipedia.org/wiki/Café_(film)\\x)", label: "Café (日本)" };
    const out = await exportPdf(await createBlankPdf(1), [page(612, 792, [link])]);
    const r = await importPdf(out);
    expect(r.pages[0].links).toEqual([expect.objectContaining({ url: link.url, label: link.label })]);
  });

  it("rejects bad schemes", () => {
    expect(linkUrlOk("javascript:alert(1)")).toBe(false);
    expect(linkUrlOk("mailto:a@b.c")).toBe(true);
    expect(linkUrlOk("https://example.org")).toBe(true);
    expect(linkUrlOk("http://example.org")).toBe(true);
    expect(linkUrlOk("file:///etc/passwd")).toBe(false);
  });

  it("never writes a link whose url is not http, https or mailto", async () => {
    const bad: LinkItem[] = [
      { id: "a", x: 72, y: 72, w: 100, h: 20, url: "javascript:alert(1)" },
      { id: "b", x: 72, y: 120, w: 100, h: 20, url: "file:///etc/passwd" },
      { id: "c", x: 72, y: 170, w: 100, h: 20, url: "https://example.org/ok" },
    ];
    const doc = await PDFDocument.load(await exportPdf(await createBlankPdf(1), [page(612, 792, bad)]));
    const annots = linkAnnots(doc);
    expect(annots).toHaveLength(1);
    expect(text(annots[0].lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI")))).toBe("https://example.org/ok");
  });
});
