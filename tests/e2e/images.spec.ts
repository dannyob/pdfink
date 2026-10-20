import { test } from "@playwright/test";
import { expect, exportedPdf, inkPixel, openApp, penStroke, state } from "./helpers";
import { PDFName } from "pdf-lib";

/** Make a solid red PNG of the given pixel size inside the browser. */
async function redPng(page: import("@playwright/test").Page, size: number): Promise<string> {
  return page.evaluate(async (n) => {
    const c = document.createElement("canvas");
    c.width = n;
    c.height = n;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, n, n);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }, size);
}

test.describe("images", () => {
  test("pasting an image from the clipboard event adds an image item and exports it", async ({ page }) => {
    await openApp(page);
    const RED_PNG = await redPng(page, 2);
    await penStroke(page, 0, [[200, 300]]);
    await page.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "red.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
    }, RED_PNG);
    await page.waitForFunction(() => window.__pdfink.pages[0].images.length === 1);
    const s = await state(page);
    const im = s.pages[0].images[0];
    expect(im.w).toBeCloseTo(1.5, 2); // 2px @ 96dpi = 1.5pt
    expect(im.x + im.w / 2).toBeCloseTo(200, 1);
    expect(im.y + im.h / 2).toBeCloseTo(300, 1);
    expect(s.selection?.images).toEqual([im.id]);

    const doc = await exportedPdf(page);
    const xo = doc.getPage(0).node.Resources()?.lookup(PDFName.of("XObject"));
    expect(xo).toBeTruthy();
    expect(String(xo)).toContain("Image");
  });

  test("pasteImage API and erase over an image", async ({ page }) => {
    await openApp(page);
    const RED_PNG = await redPng(page, 64);
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await window.__pdfink.pasteImage(bytes, "image/png");
    }, RED_PNG);
    expect((await state(page)).pages[0].images).toHaveLength(1);
    // Image is centred on the page (no last pointer): 306, 396
    await page.waitForTimeout(100);
    const px = await inkPixel(page, 0, 306, 396);
    expect(px[0]).toBeGreaterThan(200);
    expect(px[1]).toBeLessThan(60);
    await page.click("#tool-eraser");
    await penStroke(page, 0, [[306, 396]]);
    expect((await state(page)).pages[0].images).toHaveLength(0);
  });
});
