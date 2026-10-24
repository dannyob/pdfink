import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import { readOutline, writeOutline } from "../../src/pdf/outline";
import type { Bookmark, PageModel } from "../../src/model";

const blankPages = (n: number): PageModel[] => Array.from({ length: n }, () => ({ width: 612, height: 792, strokes: [], images: [], links: [] }));

/** Hand-build an outline: `items` become a flat chain of top-level entries under a fresh /Outlines. */
async function pdfWithOutline(pageCount: number, build: (doc: PDFDocument) => { items: Record<string, unknown>[]; count?: number }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  const { items, count } = build(doc);
  const rootRef = doc.context.nextRef();
  const refs = items.map(() => doc.context.nextRef());
  items.forEach((it, i) => {
    const d = doc.context.obj({ ...it, Parent: rootRef } as never) as unknown as PDFDict;
    if (i > 0) d.set(PDFName.of("Prev"), refs[i - 1]);
    if (i < refs.length - 1) d.set(PDFName.of("Next"), refs[i + 1]);
    doc.context.assign(refs[i], d);
  });
  doc.context.assign(
    rootRef,
    doc.context.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: count ?? items.length } as never),
  );
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  return doc.save({ useObjectStreams: false });
}

function outlineRoot(doc: PDFDocument): PDFDict | undefined {
  return doc.catalog.lookup(PDFName.of("Outlines")) as PDFDict | undefined;
}

describe("outline", () => {
  it("writes and reads a nested outline", async () => {
    const bms: Bookmark[] = [
      { title: "A", page: 0, level: 0 },
      { title: "A1", page: 1, level: 1 },
      { title: "A2", page: 1, level: 2 },
      { title: "B", page: 2, level: 0 },
    ];
    const out = await exportPdf(await createBlankPdf(3), blankPages(3), bms);
    const r = await importPdf(out);
    expect(r.bookmarks).toEqual(bms);
    // /Count totals: root counts all open descendants; A has A1 (+A2) open below it.
    const doc = await PDFDocument.load(out);
    const root = outlineRoot(doc)!;
    expect((root.lookup(PDFName.of("Count")) as PDFNumber).asNumber()).toBe(4);
    const a = root.lookup(PDFName.of("First")) as PDFDict;
    expect((a.lookup(PDFName.of("Count")) as PDFNumber).asNumber()).toBe(2);
    const dest = a.lookup(PDFName.of("Dest"));
    expect(dest?.toString()).toMatch(/^\[ \d+ 0 R \/XYZ null null null \]$/);
  });

  it("clamps a level jump to parent+1 and nests deeper than two levels", async () => {
    const doc = await PDFDocument.load(await createBlankPdf(2));
    writeOutline(doc, [
      { title: "T", page: 0, level: 0 },
      { title: "deep", page: 1, level: 3 },
      { title: "x", page: 1, level: 4 },
      { title: "y", page: 0, level: 5 },
    ]);
    expect(readOutline(doc)).toEqual([
      { title: "T", page: 0, level: 0 },
      { title: "deep", page: 1, level: 1 },
      { title: "x", page: 1, level: 2 },
      { title: "y", page: 0, level: 3 },
    ]);
  });

  it("keeps two deeper siblings as siblings: input levels [0, 2, 2] nest as [0, 1, 1]", async () => {
    const doc = await PDFDocument.load(await createBlankPdf(1));
    writeOutline(doc, [
      { title: "T", page: 0, level: 0 },
      { title: "a", page: 0, level: 2 },
      { title: "b", page: 0, level: 2 },
    ]);
    expect(readOutline(doc)).toEqual([
      { title: "T", page: 0, level: 0 },
      { title: "a", page: 0, level: 1 },
      { title: "b", page: 0, level: 1 },
    ]);
  });

  it("resolves a /Dest whose first element is an integer page index", async () => {
    const bytes = await pdfWithOutline(3, () => ({
      items: [
        { Title: PDFString.of("Second"), Dest: [1, PDFName.of("XYZ"), 0, 792, 0] },
        { Title: PDFString.of("Past the end"), Dest: [3, PDFName.of("Fit")] },
        { Title: PDFString.of("Negative"), Dest: [-1, PDFName.of("Fit")] },
      ],
    }));
    expect((await importPdf(bytes)).bookmarks).toEqual([
      { title: "Second", page: 1, level: 0 },
      { title: "Past the end", page: null, level: 0 },
      { title: "Negative", page: null, level: 0 },
    ]);
  });

  it("keeps a non-ASCII title", async () => {
    const bms: Bookmark[] = [{ title: "Café 2026-10-19", page: 0, level: 0 }];
    const r = await importPdf(await exportPdf(await createBlankPdf(1), blankPages(1), bms));
    expect(r.bookmarks).toEqual(bms);
  });

  it("resolves a named destination", async () => {
    const bytes = await pdfWithOutline(2, (doc) => {
      const page1 = doc.getPage(1).ref;
      const leaf = doc.context.obj({ Names: [PDFString.of("chap1"), doc.context.obj([page1, PDFName.of("Fit")])], Limits: [PDFString.of("chap1"), PDFString.of("chap1")] });
      const tree = doc.context.obj({ Kids: [doc.context.register(leaf)] });
      doc.catalog.set(PDFName.of("Names"), doc.context.obj({ Dests: doc.context.register(tree) }));
      return {
        items: [
          { Title: PDFString.of("Named"), Dest: PDFString.of("chap1") },
          { Title: PDFString.of("Hex"), Dest: PDFHexString.fromText("chap1") },
          { Title: PDFString.of("Action"), A: { S: "GoTo", D: PDFString.of("chap1") } },
        ],
      };
    });
    const r = await importPdf(bytes);
    expect(r.bookmarks).toEqual([
      { title: "Named", page: 1, level: 0 },
      { title: "Hex", page: 1, level: 0 },
      { title: "Action", page: 1, level: 0 },
    ]);
  });

  it("resolves a name in the catalog /Dests dict and a /D dict", async () => {
    const bytes = await pdfWithOutline(2, (doc) => {
      doc.catalog.set(PDFName.of("Dests"), doc.context.obj({ old: doc.context.obj({ D: [doc.getPage(1).ref, PDFName.of("Fit")] }) }));
      return { items: [{ Title: PDFString.of("Old"), Dest: PDFName.of("old") }] };
    });
    expect((await importPdf(bytes)).bookmarks).toEqual([{ title: "Old", page: 1, level: 0 }]);
  });

  it("survives a wrong /Count and an unresolvable destination", async () => {
    const bytes = await pdfWithOutline(1, () => ({ items: [{ Title: PDFString.of("Lost"), Dest: PDFString.of("nowhere") }], count: 99 }));
    const r = await importPdf(bytes);
    expect(r.bookmarks).toEqual([{ title: "Lost", page: null, level: 0 }]);
    const out = await PDFDocument.load(await exportPdf(r.baseBytes, r.pages, r.bookmarks));
    const first = outlineRoot(out)!.lookup(PDFName.of("First")) as PDFDict;
    expect((first.lookup(PDFName.of("Title")) as PDFHexString).decodeText()).toBe("Lost");
    expect(first.has(PDFName.of("Dest"))).toBe(false);
    expect(first.has(PDFName.of("A"))).toBe(false);
  });

  it("gives page null to an item with no destination or a page outside the document", async () => {
    const bytes = await pdfWithOutline(1, (doc) => {
      const stray = doc.context.register(doc.context.obj({ Type: "Page" }));
      return { items: [{ Title: PDFString.of("Bare") }, { Title: PDFString.of("Stray"), Dest: [stray, PDFName.of("Fit")] }] };
    });
    const doc = await PDFDocument.load(bytes);
    expect(readOutline(doc)).toEqual([
      { title: "Bare", page: null, level: 0 },
      { title: "Stray", page: null, level: 0 },
    ]);
  });

  it("does not loop on a cycle in the /Next chain", async () => {
    const doc = await PDFDocument.load(await createBlankPdf(1));
    writeOutline(doc, [
      { title: "one", page: 0, level: 0 },
      { title: "two", page: 0, level: 0 },
    ]);
    const root = outlineRoot(doc)!;
    const firstRef = root.get(PDFName.of("First")) as PDFRef;
    (root.lookup(PDFName.of("Last")) as PDFDict).set(PDFName.of("Next"), firstRef);
    // and a child loop back to the root
    (root.lookup(PDFName.of("First")) as PDFDict).set(PDFName.of("First"), firstRef);
    expect(readOutline(doc)).toEqual([
      { title: "one", page: 0, level: 0 },
      { title: "two", page: 0, level: 0 },
    ]);
  });

  it("reads no bookmarks from a document without /Outlines", async () => {
    expect((await importPdf(await createBlankPdf(1))).bookmarks).toEqual([]);
  });

  it("leaves the base outline alone when bookmarks is undefined", async () => {
    const bytes = await pdfWithOutline(1, (doc) => ({ items: [{ Title: PDFString.of("Keep"), Dest: [doc.getPage(0).ref, PDFName.of("Fit")] }] }));
    const r = await importPdf(bytes);
    expect(r.bookmarks).toEqual([{ title: "Keep", page: 0, level: 0 }]);
    const base = await PDFDocument.load(r.baseBytes);
    const baseRef = base.catalog.get(PDFName.of("Outlines")) as PDFRef;
    const baseRoot = base.context.lookup(baseRef) as PDFDict;
    const out = await PDFDocument.load(await exportPdf(r.baseBytes, r.pages));
    const outRef = out.catalog.get(PDFName.of("Outlines")) as PDFRef;
    expect(outRef.toString()).toBe(baseRef.toString());
    expect(out.context.lookup(outRef)!.toString()).toBe(baseRoot.toString());
    const first = (out.context.lookup(outRef) as PDFDict).lookup(PDFName.of("First")) as PDFDict;
    expect(first.toString()).toBe((baseRoot.lookup(PDFName.of("First")) as PDFDict).toString());
  });

  it("an empty bookmarks array removes the outline, and the old tree is unreachable", async () => {
    const bytes = await pdfWithOutline(1, (doc) => ({ items: [{ Title: PDFString.of("Gone"), Dest: [doc.getPage(0).ref, PDFName.of("Fit")] }] }));
    const r = await importPdf(bytes);
    const out = await exportPdf(r.baseBytes, r.pages, []);
    const doc = await PDFDocument.load(out);
    expect(doc.catalog.has(PDFName.of("Outlines"))).toBe(false);
    const again = await importPdf(out);
    expect(again.bookmarks).toEqual([]);
    expect(new TextDecoder("latin1").decode(again.baseBytes)).not.toContain("Gone");
  });

  it("replacing an outline leaves the old one unreachable", async () => {
    const bytes = await pdfWithOutline(1, (doc) => ({ items: [{ Title: PDFString.of("Old"), Dest: [doc.getPage(0).ref, PDFName.of("Fit")] }] }));
    const r = await importPdf(bytes);
    const out = await exportPdf(r.baseBytes, r.pages, [{ title: "New", page: 0, level: 0 }]);
    const again = await importPdf(out);
    expect(again.bookmarks).toEqual([{ title: "New", page: 0, level: 0 }]);
    expect(new TextDecoder("latin1").decode(again.baseBytes)).not.toContain("(Old)");
  });
});
