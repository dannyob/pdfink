import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { createBlankPdf } from "../../src/pdf/export";
import { expect, inkPixel, line, openApp, penStroke, state } from "./helpers";

const API = "http://127.0.0.1:5176";

type Events = { event: string; data: unknown }[];

/** Record every app event into window.__events. */
async function recordEvents(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __events: Events };
    w.__events = [];
    for (const event of ["selection", "save", "page", "notebook", "stroke", "button"] as const) {
      window.__pdfink.on(event, (data) => w.__events.push({ event, data }));
    }
  });
}

async function events(page: import("@playwright/test").Page, name?: string): Promise<Events> {
  const all = await page.evaluate(() => (window as unknown as { __events: Events }).__events);
  return name ? all.filter((e) => e.event === name) : all;
}

test.describe("app API", () => {
  test("addStrokes draws and is one undo step", async ({ page }) => {
    await openApp(page);
    const ids = await page.evaluate(() =>
      window.__pdfink.addStrokes(0, [
        { points: [{ x: 100, y: 100, p: 0.6 }, { x: 200, y: 100, p: 0.6 }], color: "#d91a1a", width: 2, opacity: 1 },
        { points: [{ x: 100, y: 120, p: 0.6 }, { x: 200, y: 120, p: 0.6 }], color: "#000000", width: 1, opacity: 1 },
      ]),
    );
    expect(ids).toHaveLength(2);
    expect((await state(page)).pages[0].strokes).toHaveLength(2);
    expect((await state(page)).undo).toBe(1);
    expect(await inkPixel(page, 0, 150, 100)).toEqual(expect.arrayContaining([217, 26, 26]));
    // A given id is kept; an empty list changes nothing.
    const kept = await page.evaluate(() =>
      window.__pdfink.addStrokes(0, [{ id: "mine", points: [{ x: 10, y: 10, p: 0.6 }], color: "#000000", width: 1, opacity: 1 }]),
    );
    expect(kept).toEqual(["mine"]);
    expect(await page.evaluate(() => window.__pdfink.addStrokes(0, []))).toEqual([]);
    expect((await state(page)).undo).toBe(2);
    await expect(page.evaluate(() => window.__pdfink.addStrokes(9, []))).rejects.toThrow(/page/);
  });

  test("selectRect, selectionInfo and selectionPng describe the union of marquee and strokes", async ({ page }) => {
    await openApp(page);
    await recordEvents(page);
    const pts = line(50, 50, 300, 50, 25).map(([x, y]) => ({ x, y, p: 0.6 }));
    const [id] = await page.evaluate((points) => window.__pdfink.addStrokes(0, [{ points, color: "#000000", width: 1, opacity: 1 }]), pts);
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 100, y: 40, w: 50, h: 20 }));
    const s = await state(page);
    expect(s.tool).toBe("select");
    expect(s.selection?.strokes).toEqual([id]);
    const info = await page.evaluate(() => window.__pdfink.selectionInfo());
    expect(info).not.toBeNull();
    expect(info!.page).toBe(0);
    expect(info!.strokeIds).toEqual([id]);
    expect(info!.imageIds).toEqual([]);
    expect(info!.marquee).toEqual({ x: 100, y: 40, w: 50, h: 20 });
    // Bounds widen the marquee to the whole stroke (half a pen width either side).
    expect(info!.rect.x).toBeCloseTo(49.5, 1);
    expect(info!.rect.y).toBeCloseTo(40, 1);
    expect(info!.rect.w).toBeCloseTo(251, 1);
    expect(info!.rect.h).toBeCloseTo(20, 1);
    // PDF points: y up from the bottom of the Letter page.
    expect(info!.pdfRect.x).toBeCloseTo(49.5, 1);
    expect(info!.pdfRect.y).toBeCloseTo(792 - 60, 1);
    expect(info!.pdfRect.w).toBeCloseTo(251, 1);
    expect(info!.pdfRect.h).toBeCloseTo(20, 1);
    expect(await page.evaluate(() => window.__pdfink.pageGeom(0))).toEqual({ cx: 0, cy: 0, cw: 612, ch: 792, rotate: 0 });
    expect(await page.evaluate(() => window.__pdfink.selectionInk().map((s) => s.id))).toEqual([id]);

    const size = await page.evaluate(async () => {
      const bmp = await createImageBitmap(await window.__pdfink.selectionPng());
      return [bmp.width, bmp.height];
    });
    expect(size).toEqual([Math.ceil(251 * 3), 60]);
    const pageSize = await page.evaluate(async () => {
      const bmp = await createImageBitmap(await window.__pdfink.pagePng(0));
      return [bmp.width, bmp.height];
    });
    expect(pageSize).toEqual([612, 792]);

    const sel = await events(page, "selection");
    expect(sel).toHaveLength(1);
    expect((sel[0].data as { strokeIds: string[] }).strokeIds).toEqual([id]);
    await page.evaluate(() => window.__pdfink.clearSelection());
    expect(await page.evaluate(() => window.__pdfink.selectionInfo())).toBeNull();
    expect((await events(page, "selection")).map((e) => e.data)).toEqual([sel[0].data, null]);
  });

  test("selectionPng renders the page base, the ink and selections running off the page", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() =>
      window.__pdfink.addStrokes(0, [
        { points: [{ x: 590, y: 20, p: 0.6 }, { x: 640, y: 20, p: 0.6 }], color: "#d91a1a", width: 4, opacity: 1 },
      ]),
    );
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 580, y: 10, w: 20, h: 20 }));
    const out = await page.evaluate(async () => {
      const info = window.__pdfink.selectionInfo()!;
      const bmp = await createImageBitmap(await window.__pdfink.selectionPng(2));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const at = (x: number, y: number) => [...ctx.getImageData(Math.round((x - info.rect.x) * 2), Math.round((y - info.rect.y) * 2), 1, 1).data];
      return { w: bmp.width, h: bmp.height, rect: info.rect, red: at(600, 20), paper: at(585, 28) };
    });
    expect(out.rect.x + out.rect.w).toBeGreaterThan(612); // the stroke runs off the page
    expect(out.w).toBe(Math.ceil(out.rect.w * 2));
    expect(out.red.slice(0, 3)).toEqual([217, 26, 26]);
    expect(out.paper).toEqual([255, 255, 255, 255]);
  });

  test("selectRect on a page other than the current one", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__pdfink.addPage());
    await page.waitForFunction(() => window.__pdfink.views.length === 2);
    await page.evaluate(() => window.__pdfink.scrollToPage(0));
    await page.waitForFunction(() => window.__pdfink.currentPage === 0);
    const [id] = await page.evaluate(() =>
      window.__pdfink.addStrokes(1, [{ points: [{ x: 100, y: 100, p: 0.6 }, { x: 120, y: 100, p: 0.6 }], color: "#000000", width: 1, opacity: 1 }]),
    );
    await page.evaluate(() => window.__pdfink.selectRect(1, { x: 90, y: 90, w: 40, h: 20 }));
    const s = await state(page);
    expect(s.currentPage).toBe(0);
    expect(s.selection).toMatchObject({ page: 1, strokes: [id] });
  });

  test("removeItems deletes across pages with one undo entry per page", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__pdfink.addPage());
    await page.waitForFunction(() => window.__pdfink.views.length === 2);
    const stroke = (y: number) => ({ points: [{ x: 100, y, p: 0.6 }, { x: 200, y, p: 0.6 }], color: "#000000", width: 1, opacity: 1 });
    const a = await page.evaluate((s) => window.__pdfink.addStrokes(0, s), [stroke(100), stroke(200)]);
    const b = await page.evaluate((s) => window.__pdfink.addStrokes(1, s), [stroke(100)]);
    const undoBefore = (await state(page)).undo;
    expect(await page.evaluate((ids) => window.__pdfink.removeItems(ids), [a[0], b[0], "nope"])).toBe(2);
    let s = await state(page);
    expect(s.pages[0].strokes.map((x) => x.id)).toEqual([a[1]]);
    expect(s.pages[1].strokes).toHaveLength(0);
    expect(s.undo).toBe(undoBefore + 2);
    expect(await page.evaluate(() => window.__pdfink.removeItems(["nope"]))).toBe(0);
    expect((await state(page)).undo).toBe(undoBefore + 2);
    await page.evaluate(() => window.__pdfink.undo());
    await page.evaluate(() => window.__pdfink.undo());
    s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    expect(s.pages[1].strokes).toHaveLength(1);
  });

  test("addButton puts a button in the pen menu or toolbar and pressing it emits button", async ({ page }) => {
    await openApp(page);
    await recordEvents(page);
    await page.evaluate(() => {
      window.__pdfink.addButton("hello", "Say hello", "menu");
      window.__pdfink.addButton("tb", "Old label", "toolbar");
      window.__pdfink.addButton("tb", "Toolbar cmd", "toolbar"); // same id replaces
    });
    expect((await state(page)).buttons).toEqual(["hello", "tb"]);
    await expect(page.locator("#cmd-buttons button.cmd")).toHaveCount(1);
    await expect(page.locator("#cmd-buttons button.cmd")).toHaveText("Toolbar cmd");

    const [x, y] = await page.evaluate(() => {
      const c = window.__pdfink.views[0].toClient(300, 300);
      return [c.clientX, c.clientY];
    });
    await page.mouse.click(x, y, { button: "right" });
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await page.locator("#ctx-menu button", { hasText: "Say hello" }).click();
    await page.locator("#cmd-buttons button.cmd").click();
    expect((await events(page, "button")).map((e) => e.data)).toEqual([{ id: "hello" }, { id: "tb" }]);

    await page.evaluate(() => {
      window.__pdfink.removeButton("hello");
      window.__pdfink.removeButton("tb");
    });
    expect((await state(page)).buttons).toEqual([]);
    await expect(page.locator("#cmd-buttons button")).toHaveCount(0);
    await page.mouse.click(x, y, { button: "right" });
    await expect(page.locator("#ctx-menu button", { hasText: "Say hello" })).toHaveCount(0);
  });

  test("on returns an unsubscribe function", async ({ page }) => {
    await openApp(page);
    const n = await page.evaluate(() => {
      let n = 0;
      const off = window.__pdfink.on("button", () => n++);
      window.__pdfink.addButton("x", "X", "toolbar");
      (document.querySelector("#cmd-buttons button") as HTMLButtonElement).click();
      off();
      (document.querySelector("#cmd-buttons button") as HTMLButtonElement).click();
      return n;
    });
    expect(n).toBe(1);
  });

  test("progress shows and clears", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__pdfink.progress("Transcribing…"));
    await expect(page.locator("#progress")).toHaveText("Transcribing…");
    expect((await state(page)).progress).toBe("Transcribing…");
    await page.evaluate(() => window.__pdfink.progress(null));
    await expect(page.locator("#progress")).toHaveText("");
    expect((await state(page)).progress).toBeNull();
  });

  test("addImageItem places a PNG in the given rect", async ({ page }) => {
    await openApp(page);
    const bytes = [...fs.readFileSync(path.resolve("tests/fixtures/arrow.png"))];
    const id = await page.evaluate(
      (b) => window.__pdfink.addImageItem(0, new Uint8Array(b), "image/png", { x: 100, y: 150, w: 60, h: 40 }),
      bytes,
    );
    const s = await state(page);
    expect(s.pages[0].images).toEqual([{ id, x: 100, y: 150, w: 60, h: 40, mime: "image/png" }]);
    expect(s.undo).toBe(1);
  });

  test("events: stroke, page, selection from the pen", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__pdfink.addPage());
    await page.waitForFunction(() => window.__pdfink.views.length === 2);
    await page.evaluate(() => window.__pdfink.scrollToPage(0));
    await page.waitForFunction(() => window.__pdfink.currentPage === 0);
    await recordEvents(page);
    await penStroke(page, 0, line(100, 100, 200, 100));
    const strokes = await events(page, "stroke");
    expect(strokes).toHaveLength(1);
    const s = await state(page);
    expect(strokes[0].data).toMatchObject({ page: 0, stroke: { id: s.pages[0].strokes[0].id } });

    await page.keyboard.press("s");
    await penStroke(page, 0, line(80, 80, 220, 120));
    const sel = await events(page, "selection");
    expect(sel).toHaveLength(1);
    expect(sel[0].data).toMatchObject({ page: 0, strokeIds: [s.pages[0].strokes[0].id] });

    await page.evaluate(() => window.__pdfink.scrollToPage(1));
    await page.waitForFunction(() => window.__pdfink.currentPage === 1);
    expect((await events(page, "page")).map((e) => e.data)).toEqual([{ page: 1 }]);
  });

  test("events: notebook after opening, save after saving to the server", async ({ page }) => {
    const name = `api-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`;
    const res = await fetch(`${API}/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", body: (await createBlankPdf(1)) as BodyInit });
    expect(res.ok).toBe(true);
    await openApp(page);
    await recordEvents(page);
    expect(await page.evaluate((n) => window.__pdfink.openNotebook(n), name)).toBe(true);
    expect((await events(page, "notebook")).map((e) => e.data)).toEqual([{ name }]);
    await penStroke(page, 0, line(100, 100, 200, 100));
    expect(await page.evaluate(() => window.__pdfink.saveToServer())).toBe(true);
    const saves = await events(page, "save");
    expect(saves).toHaveLength(1);
    const s = await state(page);
    expect(saves[0].data).toEqual({ name, mtime: (s.source as { mtime: number }).mtime });
  });
});
