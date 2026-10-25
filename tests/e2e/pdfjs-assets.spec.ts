import { test } from "@playwright/test";
import { PDFDocument, PDFName } from "pdf-lib";
import { expect, openApp } from "./helpers";

const API = "http://127.0.0.1:5176";

/** One Letter page of Japanese text in a non-embedded CID font: pdf.js needs its CMaps to draw it. */
async function cjkPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const cid = ctx.obj({
    Type: "Font",
    Subtype: "CIDFontType0",
    BaseFont: "KozMinPr6N-Regular",
    CIDSystemInfo: { Registry: ctx.obj("Adobe" as never), Ordering: ctx.obj("Japan1" as never), Supplement: 6 },
    FontDescriptor: ctx.obj({ Type: "FontDescriptor", FontName: "KozMinPr6N-Regular", Flags: 6, FontBBox: [-200, -300, 1200, 1000], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 740, StemV: 80 }),
  });
  // pdf-lib turns plain JS strings into names; the CID system info wants strings.
  const info = cid.lookup(PDFName.of("CIDSystemInfo")) as never as { set: (k: PDFName, v: unknown) => void };
  const { PDFString } = await import("pdf-lib");
  info.set(PDFName.of("Registry"), PDFString.of("Adobe"));
  info.set(PDFName.of("Ordering"), PDFString.of("Japan1"));
  const font = ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "KozMinPr6N-Regular", Encoding: "UniJIS-UCS2-H", DescendantFonts: [ctx.register(cid)] });
  page.node.setFontDictionary(PDFName.of("F1"), ctx.register(font));
  // 日本語 as UCS-2 big-endian.
  const content = ctx.flateStream("BT /F1 72 Tf 100 600 Td <65E5672C8A9E> Tj ET");
  page.node.set(PDFName.of("Contents"), ctx.register(content));
  return doc.save();
}

test("pdf.js fetches its CMaps and draws text in a non-embedded CJK font", async ({ page }) => {
  const name = `cjk-${Date.now().toString(36)}.pdf`;
  const res = await fetch(`${API}/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", body: (await cjkPdf()) as BodyInit });
  expect(res.ok).toBe(true);
  const cmaps: number[] = [];
  page.on("response", (r) => {
    if (/\/pdfjs\/cmaps\/UniJIS-UCS2-H\.bcmap$/.test(r.url())) cmaps.push(r.status());
  });
  await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
  await expect.poll(() => cmaps).toContain(200);
  // Some dark pixels where the text sits (72 pt glyphs from x=100, baseline 600 in PDF space).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const v = window.__pdfink.views[0];
        const k = v.base.width / v.base.clientWidth;
        const s = v.scale * k;
        const d = v.base.getContext("2d")!.getImageData(100 * s, (792 - 680) * s, 260 * s, 100 * s).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 0) dark++;
        return dark;
      }),
    )
    .toBeGreaterThan(200);
});
