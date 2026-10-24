import { test } from "@playwright/test";
import { expect, openApp, openLocalApp, state } from "./helpers";

const METHODS = [
  "state", "notebook", "selection", "selectionInk", "selectionPng", "pagePng", "toast", "progress",
  "ask", "confirm", "choose", "addButton", "removeButton", "select", "clearSelection", "setTool",
  "save", "reload", "undo", "redo", "addPage", "scrollToPage", "addStrokes", "addImage", "removeItems",
  "links", "addLink", "setLink", "bookmarks", "addBookmark", "removeBookmark",
];

const stroke = (x0: number, y0: number, x1: number, y1: number) => ({
  points: [{ x: x0, y: y0, p: 0.6 }, { x: x1, y: y1, p: 0.6 }],
  color: "#000000",
  width: 2,
  opacity: 1,
});

test.describe("window.pdfink", () => {
  test("window.pdfink exists in both modes with the documented methods", async ({ page }) => {
    for (const open of [openApp, openLocalApp]) {
      await open(page);
      const types = await page.evaluate((names) => names.map((n) => typeof (window.pdfink as unknown as Record<string, unknown>)[n]), METHODS);
      expect(types).toEqual(METHODS.map(() => "function"));
      const nb = await page.evaluate(() => window.pdfink.notebook());
      expect(nb).toEqual({ name: expect.any(String), pages: 1, page: 0, dirty: false, storage: open === openApp ? "server" : "local" });
    }
    // Local mode has nothing to reload from.
    expect(await page.evaluate(() => window.pdfink.reload())).toBe(false);
  });

  test("selectionPng returns base64 of a PNG the size of the selection", async ({ page }) => {
    await openApp(page);
    await expect(page.evaluate(() => window.pdfink.selectionPng())).rejects.toThrow(/no selection/);
    await page.evaluate(() => window.pdfink.select(0, { x: 100, y: 100, w: 50, h: 20 }));
    expect(await page.evaluate(() => window.pdfink.selection()?.rect)).toEqual({ x: 100, y: 100, w: 50, h: 20 });
    const b64 = await page.evaluate(() => window.pdfink.selectionPng({ scale: 2 }));
    expect(b64.startsWith("data:")).toBe(false);
    const png = Buffer.from(b64, "base64");
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // IHDR width and height, big-endian at bytes 16 and 20.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([100, 40]);
    const full = Buffer.from(await page.evaluate(() => window.pdfink.pagePng(0)), "base64");
    expect([full.readUInt32BE(16), full.readUInt32BE(20)]).toEqual([612, 792]);
  });

  test("addStrokes in pdf space lands at the display point", async ({ page }) => {
    await openApp(page);
    const [id] = await page.evaluate((s) => window.pdfink.addStrokes(0, [s], { space: "pdf" }), stroke(300, 500, 310, 500));
    const st = await state(page);
    const b = st.pages[0].strokes.find((s) => s.id === id)!.bounds;
    expect(b.x + b.w / 2).toBeCloseTo(305, 0);
    expect(b.y + b.h / 2).toBeCloseTo(292, 0);
    // Default space is page (display) space.
    const [id2] = await page.evaluate((s) => window.pdfink.addStrokes(0, [s]), stroke(300, 500, 310, 500));
    const b2 = (await state(page)).pages[0].strokes.find((s) => s.id === id2)!.bounds;
    expect(b2.y + b2.h / 2).toBeCloseTo(500, 0);
    // A rotated page goes through its geometry: at 90°, display (x, y) = (yp, xp).
    const rotated = await page.evaluate((s) => {
      window.__pdfink.pageGeom = () => ({ cx: 0, cy: 0, cw: 612, ch: 792, rotate: 90 });
      const [rid] = window.pdfink.addStrokes(0, [s], { space: "pdf" });
      return window.__pdfink.pages[0].strokes.find((x) => x.id === rid)!.points.map((p) => [p.x, p.y]);
    }, stroke(300, 500, 310, 500));
    expect(rotated).toEqual([[500, 300], [500, 310]]);
  });

  test("addLink in pdf space, setLink and links go through to the app", async ({ page }) => {
    await openApp(page);
    const id = await page.evaluate(() => window.pdfink.addLink(0, { x: 300, y: 500, w: 100, h: 50 }, "https://example.com/", { label: "Ex", space: "pdf" }));
    expect(await page.evaluate(() => window.pdfink.links())).toEqual([{ id, x: 300, y: 242, w: 100, h: 50, url: "https://example.com/", label: "Ex", page: 0 }]);
    // Default space is page (display) space.
    const id2 = await page.evaluate(() => window.pdfink.addLink(0, { x: 10, y: 20, w: 30, h: 40 }, "mailto:a@b.org"));
    expect((await page.evaluate(() => window.pdfink.links(0))).find((l) => l.id === id2)).toEqual({ id: id2, x: 10, y: 20, w: 30, h: 40, url: "mailto:a@b.org", page: 0 });
    // A rotated page goes through its geometry: at 90°, display (x, y) = (yp, xp).
    const rotated = await page.evaluate(() => {
      window.__pdfink.pageGeom = () => ({ cx: 0, cy: 0, cw: 612, ch: 792, rotate: 90 });
      const rid = window.pdfink.addLink(0, { x: 300, y: 500, w: 100, h: 50 }, "http://x.org/", { space: "pdf" });
      const { x, y, w, h } = window.pdfink.links(0).find((l) => l.id === rid)!;
      return { x, y, w, h };
    });
    expect(rotated).toEqual({ x: 500, y: 300, w: 50, h: 100 });
    await expect(page.evaluate(() => window.pdfink.addLink(0, { x: 0, y: 0, w: 1, h: 1 }, "javascript:alert(1)"))).rejects.toThrow(/bad url/);
    await page.evaluate((i) => window.pdfink.setLink(i, { url: "https://example.org/", label: "" }), id);
    const ln = (await state(page)).pages[0].links.find((l) => l.id === id)!;
    expect([ln.url, ln.label]).toEqual(["https://example.org/", undefined]);
    expect(await page.evaluate(() => window.pdfink.links(1))).toEqual([]);
  });

  test("bookmarks round trip: addBookmark, bookmarks, removeBookmark", async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => window.pdfink.bookmarks())).toEqual([]);
    expect(await page.evaluate(() => window.pdfink.addBookmark(0, "2026-10-23"))).toBe(0);
    expect(await page.evaluate(() => window.pdfink.addBookmark(0, "Sub", { level: 1 }))).toBe(1);
    expect(await page.evaluate(() => window.pdfink.bookmarks())).toEqual([
      { title: "2026-10-23", page: 0, level: 0 },
      { title: "Sub", page: 0, level: 1 },
    ]);
    expect((await state(page)).bookmarks).toHaveLength(2);
    await page.evaluate(() => window.pdfink.removeBookmark(0));
    expect(await page.evaluate(() => window.pdfink.bookmarks())).toEqual([{ title: "Sub", page: 0, level: 1 }]);
    await expect(page.evaluate(() => window.pdfink.removeBookmark(5))).rejects.toThrow(/No bookmark 5/);
  });

  test("addImage, removeItems, undo and toast go through to the app", async ({ page }) => {
    await openApp(page);
    const png = await page.evaluate(() => window.pdfink.pagePng(0, { scale: 0.1 }));
    const id = await page.evaluate((b64) => window.pdfink.addImage(0, b64, { x: 10, y: 10, w: 61, h: 79 }), png);
    expect((await state(page)).pages[0].images.map((im) => im.id)).toEqual([id]);
    await expect(page.evaluate(() => window.pdfink.addImage(0, "not base64!!", { x: 0, y: 0, w: 1, h: 1 }))).rejects.toThrow();
    expect(await page.evaluate((i) => window.pdfink.removeItems([i]), id)).toBe(1);
    expect((await state(page)).pages[0].images).toEqual([]);
    await page.evaluate(() => window.pdfink.undo());
    expect((await state(page)).pages[0].images).toHaveLength(1);
    await page.evaluate(() => window.pdfink.toast("hello there"));
    await expect(page.locator("#status")).toContainText("hello there");
    await page.evaluate(() => window.pdfink.addButton("b1", "Do it", { where: "toolbar" }));
    await expect(page.locator('#cmd-buttons button[data-id="b1"]')).toHaveText("Do it");
    await page.evaluate(() => window.pdfink.removeButton("b1"));
    expect((await state(page)).buttons).toEqual([]);
  });

  test("eval returns JSON for values and strings for DOM nodes, and errors as messages", async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const m = (await import("/src/pdfink-api.ts" as string)) as typeof import("../../src/pdfink-api");
      const api = window.pdfink, app = window.__pdfink;
      return [await m.evalInPage(api, app, "app.scale * 2"), await m.evalInPage(api, app, "document.body"), await m.evalInPage(api, app, "pdfink.selection()"), app.scale];
    });
    // The page is fitted to the window, so scale is not 1.
    expect(r[0]).toBe((r[3] as number) * 2); expect(r[1]).toBe("[object HTMLBodyElement]"); expect(r[2]).toBeNull();
    await expect(page.evaluate(async () => { const m = (await import("/src/pdfink-api.ts" as string)) as typeof import("../../src/pdfink-api"); return m.evalInPage(window.pdfink, window.__pdfink, "nope.x"); })).rejects.toThrow(/nope/);
  });

  test("toJson makes values JSON-safe", async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const m = (await import("/src/pdfink-api.ts" as string)) as typeof import("../../src/pdfink-api");
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      return m.toJson({
        u: undefined,
        big: 12n,
        bytes: { nested: [new Uint8Array([1, 2, 3])] },
        set: new Set([1, "x"]),
        map: new Map<unknown, unknown>([["k", 1], [2, new Uint8Array([255])]]),
        fn: () => 1,
        cyclic,
      });
    });
    expect(r).toEqual({
      u: null,
      big: "12",
      bytes: { nested: ["AQID"] },
      set: [1, "x"],
      map: { k: 1, "2": "/w==" },
      fn: "() => 1",
      cyclic: { a: 1, self: "[object Object]" },
    });
  });
});
