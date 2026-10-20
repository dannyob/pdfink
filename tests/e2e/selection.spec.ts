import { test } from "@playwright/test";
import { expect, line, openApp, pasteKey, penStroke, state, waitReady } from "./helpers";

async function drawThree(page: import("@playwright/test").Page) {
  await penStroke(page, 0, line(100, 100, 200, 100));
  await penStroke(page, 0, line(100, 200, 200, 200));
  await penStroke(page, 0, line(100, 300, 200, 300));
}

test.describe("select / copy / cut / paste", () => {
  test("rectangle select picks strokes with points inside", async ({ page }) => {
    await openApp(page);
    await drawThree(page);
    await page.click("#tool-select");
    await penStroke(page, 0, line(80, 150, 220, 320));
    const s = await state(page);
    expect(s.selection?.strokes).toHaveLength(2);
    expect(s.selection?.rect).toMatchObject({ x: 80, y: 150, w: 140, h: 170 });
  });

  test("cut removes, paste puts a copy at the last pen position", async ({ page }) => {
    await openApp(page);
    await drawThree(page);
    await page.keyboard.press("s");
    await penStroke(page, 0, line(80, 180, 220, 220));
    expect((await state(page)).selection?.strokes).toHaveLength(1);
    await page.keyboard.press("Control+x");
    let s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    expect(s.clip).toMatchObject({ strokes: 1, images: 0 });
    expect(s.clip!.width).toBeCloseTo(101, 3);
    expect(s.clip!.height).toBeCloseTo(1, 3);
    // tap to choose paste location, then paste
    await penStroke(page, 0, [[400, 500]]);
    await pasteKey(page);
    await page.waitForFunction(() => window.__pdfink.pages[0].strokes.length === 3);
    s = await state(page);
    const pasted = s.pages[0].strokes[2];
    expect(pasted.bounds.x + pasted.bounds.w / 2).toBeCloseTo(400, 0);
    expect(pasted.bounds.y + pasted.bounds.h / 2).toBeCloseTo(500, 0);
    expect(s.selection?.strokes).toEqual([pasted.id]);
  });

  test("copy keeps the original; paste button works; delete key", async ({ page }) => {
    await openApp(page);
    await drawThree(page);
    await page.click("#tool-select");
    await penStroke(page, 0, line(50, 50, 250, 350));
    await page.click("#btn-copy");
    expect((await state(page)).clip).toMatchObject({ strokes: 3 });
    await penStroke(page, 0, [[300, 600]]);
    await page.click("#btn-paste");
    await page.waitForFunction(() => window.__pdfink.pages[0].strokes.length === 6);
    let s = await state(page);
    expect(s.selection?.strokes).toHaveLength(3);
    await page.keyboard.press("Delete");
    s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(3);
    expect(s.selection).toBeNull();
  });

  test("paste across pages and undo", async ({ page }) => {
    await openApp(page);
    await drawThree(page);
    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 2);
    await waitReady(page);
    await page.click("#tool-select");
    await penStroke(page, 0, line(50, 50, 250, 350));
    await page.keyboard.press("Control+c");
    await penStroke(page, 1, [[306, 396]]);
    await pasteKey(page);
    await page.waitForFunction(() => window.__pdfink.pages[1].strokes.length === 3);
    let s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(3);
    await page.keyboard.press("Control+z");
    s = await state(page);
    expect(s.pages[1].strokes).toHaveLength(0);
  });

  test("Ctrl+V falls back to the internal clipboard when no paste event arrives", async ({ page }) => {
    await openApp(page);
    await drawThree(page);
    await page.click("#tool-select");
    await penStroke(page, 0, line(50, 50, 250, 350));
    await page.keyboard.press("Control+c");
    await penStroke(page, 0, [[300, 600]]);
    await page.keyboard.press("Control+v");
    await page.waitForFunction(() => window.__pdfink.pages[0].strokes.length === 6);
  });

  test("escape clears selection; tap clears selection", async ({ page }) => {
    await openApp(page);
    await drawThree(page);
    await page.click("#tool-select");
    await penStroke(page, 0, line(50, 50, 250, 350));
    expect((await state(page)).selection?.strokes).toHaveLength(3);
    await page.keyboard.press("Escape");
    expect((await state(page)).selection).toBeNull();
    await penStroke(page, 0, line(50, 50, 250, 350));
    await penStroke(page, 0, [[400, 400]]);
    expect((await state(page)).selection).toBeNull();
  });
});
