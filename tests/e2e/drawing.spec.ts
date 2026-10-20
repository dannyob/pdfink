import { test } from "@playwright/test";
import { PDFArray, PDFName, PDFNumber } from "pdf-lib";
import { expect, exportedPdf, inkAnnots, inkPathCount, inkPixel, line, openApp, penStroke, state } from "./helpers";

test.describe("pen drawing", () => {
  test("new document shows one Letter page", async ({ page }) => {
    await openApp(page);
    const s = await state(page);
    expect(s.pages).toHaveLength(1);
    expect(s.pages[0]).toMatchObject({ width: 612, height: 792 });
    await expect(page.locator(".page")).toHaveCount(1);
  });

  test("pen strokes are recorded and drawn", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 120));
    await penStroke(page, 0, line(100, 200, 300, 220));
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    expect(s.pages[0].strokes[0].n).toBe(21);
    expect(s.pages[0].strokes[0].bounds.x).toBeCloseTo(99.5, 0);
    expect(s.dirty).toBe(true);
    const px = await inkPixel(page, 0, 200, 110);
    expect(px[3]).toBeGreaterThan(0); // something drawn there
    const blank = await inkPixel(page, 0, 200, 400);
    expect(blank[3]).toBe(0);
  });

  test("touch does not draw; mouse follows the tool", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 120), { pointerType: "touch" });
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
    await penStroke(page, 0, line(100, 100, 300, 120), { pointerType: "mouse" });
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
  });

  test("pen colour and width come from the toolbar", async ({ page }) => {
    await openApp(page);
    await page.locator("#pen-color").fill("#ff0000");
    await page.locator("#pen-width").selectOption("2");
    await penStroke(page, 0, line(100, 100, 300, 120));
    const s = await state(page);
    expect(s.pages[0].strokes[0]).toMatchObject({ color: "#ff0000", width: 2 });
  });

  test("pen eraser end removes strokes it crosses", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 200, 300, 200));
    await penStroke(page, 0, line(100, 300, 300, 300));
    // eraser end (buttons=32) vertically through the middle stroke only
    await penStroke(page, 0, line(200, 170, 200, 230), { buttons: 32 });
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    const ys = s.pages[0].strokes.map((x) => x.bounds.y);
    expect(ys[0]).toBeCloseTo(99.5, 3);
    expect(ys[1]).toBeCloseTo(299.5, 3);
    expect((await inkPixel(page, 0, 200, 200))[3]).toBe(0);
    expect((await inkPixel(page, 0, 200, 100))[3]).toBeGreaterThan(0);
  });

  test("barrel button while hovering erases; one sweep is one undo step", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 140, 300, 140));
    await penStroke(page, 0, line(100, 300, 300, 300));
    await page.evaluate(() => {
      const v = window.__pdfink.views[0];
      const pts = [] as [number, number][];
      for (let y = 80; y <= 160; y += 5) {
        const c = v.toClient(200, y);
        pts.push([c.clientX, c.clientY]);
      }
      window.__stylusSim.barrelHover(pts);
      // button released, pen still hovering
      window.__stylusSim.hover(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    });
    let s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(1);
    expect(s.undo).toBe(4); // 3 strokes + 1 sweep
    await page.keyboard.press("Control+z");
    s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(3);
  });

  test("a finger scrolls by hand when the pen had switched panning off", async ({ page }) => {
    await openApp(page);
    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 2);
    await penStroke(page, 0, line(100, 100, 300, 100)); // pen seen → pen-active
    await expect(page.locator("#pages")).toHaveClass(/pen-active/);
    const before = await page.evaluate(() => document.getElementById("pages")!.scrollTop);
    await page.evaluate(() => {
      const el = document.getElementById("pages")!;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const pts: [number, number][] = [];
      for (let y = r.top + 600; y >= r.top + 200; y -= 50) pts.push([x, y]);
      window.__stylusSim.stroke(pts, { pointerType: "touch" });
    });
    const after = await page.evaluate(() => document.getElementById("pages")!.scrollTop);
    expect(after - before).toBeCloseTo(400, 0);
    await expect(page.locator("#pages")).not.toHaveClass(/pen-active/);
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
  });

  test("eraser tool with the pen tip", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.click("#tool-eraser");
    await penStroke(page, 0, line(200, 80, 200, 120));
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });

  test("undo and redo", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 200, 300, 200));
    await page.keyboard.press("Control+z");
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
    await page.click("#btn-redo");
    expect((await state(page)).pages[0].strokes).toHaveLength(2);
    await page.click("#btn-undo");
    await page.click("#btn-undo");
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });

  test("strokes export as /Ink annotations in PDF space", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 200, 300, 200));
    const doc = await exportedPdf(page);
    expect(doc.getPageCount()).toBe(1);
    const annots = inkAnnots(doc, 0);
    expect(annots).toHaveLength(1);
    expect(inkPathCount(annots[0])).toBe(2);
    const rect = annots[0].lookup(PDFName.of("Rect"), PDFArray);
    const nums = [0, 1, 2, 3].map((i) => rect.lookup(i, PDFNumber).asNumber());
    // y is flipped: display y 100..200 → pdf y 592..692 (± half width)
    expect(nums[0]).toBeCloseTo(99.5, 1);
    expect(nums[1]).toBeCloseTo(591.5, 1);
    expect(nums[2]).toBeCloseTo(300.5, 1);
    expect(nums[3]).toBeCloseTo(692.5, 1);
  });
});
