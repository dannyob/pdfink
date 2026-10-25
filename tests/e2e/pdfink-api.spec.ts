import { test } from "@playwright/test";
import { expect, openApp, openLocalApp, state } from "./helpers";

const METHODS = [
  "state", "notebook", "selection", "selectionInk", "selectionPng", "pagePng", "toast", "progress",
  "ask", "confirm", "choose", "addButton", "removeButton", "select", "clearSelection", "setTool",
  "save", "reload", "undo", "redo", "addPage", "scrollToPage", "addStrokes", "addImage", "removeItems",
  "links", "addLink", "setLink", "bookmarks", "addBookmark", "removeBookmark",
  "pageText", "inkText", "setInkText", "strokes", "notebookTag", "setNotebookTag",
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

  test("setInkText, inkText and pageText: page and pdf space, quiet, within, bad lines", async ({ page }) => {
    await openApp(page);
    const line = { x: 300, y: 500, w: 100, h: 20, text: "hello", sig: "s1", note: 0 };
    const [id] = await page.evaluate((l) => window.pdfink.setInkText(0, [l]), line);
    expect(await page.evaluate(() => window.pdfink.inkText(0))).toEqual([{ id, ...line }]);
    const undo = (await state(page)).undo;
    // PDF space flips y like addLink: y = 792 - 500 - 20.
    const [id2] = await page.evaluate((l) => window.pdfink.setInkText(0, [l], { space: "pdf", quiet: true }), line);
    expect(await page.evaluate(() => window.pdfink.inkText(0))).toEqual([{ ...line, id: id2, y: 272 }]);
    expect((await state(page)).undo).toBe(undo); // quiet: no undo step
    // within (in the same space as the lines) replaces only the texts inside it.
    const [id3] = await page.evaluate(() => window.pdfink.setInkText(0, [{ x: 10, y: 10, w: 50, h: 10, text: "top" }], { within: { x: 0, y: 0, w: 200, h: 50 } }));
    expect((await page.evaluate(() => window.pdfink.inkText(0))).map((t) => t.id)).toEqual([id2, id3]);
    await page.evaluate(() => window.pdfink.setInkText(0, [], { space: "pdf", within: { x: 0, y: 742, w: 200, h: 50 } }));
    expect((await page.evaluate(() => window.pdfink.inkText(0))).map((t) => t.id)).toEqual([id2]);
    await page.evaluate(() => window.pdfink.undo());
    expect((await page.evaluate(() => window.pdfink.inkText(0))).map((t) => t.id)).toEqual([id2, id3]);
    // A rotated page goes through its geometry: at 90°, display (x, y) = (yp, xp).
    const rotated = await page.evaluate(() => {
      const g = window.__pdfink.pageGeom;
      window.__pdfink.pageGeom = () => ({ cx: 0, cy: 0, cw: 612, ch: 792, rotate: 90 });
      window.pdfink.setInkText(0, [{ x: 300, y: 500, w: 100, h: 20, text: "r" }], { space: "pdf" });
      window.__pdfink.pageGeom = g;
      const { x, y, w, h } = window.pdfink.inkText(0)[0];
      return { x, y, w, h };
    });
    expect(rotated).toEqual({ x: 500, y: 300, w: 20, h: 100 });
    for (const bad of [{ ...line, x: Number.NaN }, { ...line, text: 5 }, { ...line, w: "1" }]) {
      for (const space of ["page", "pdf"] as const) {
        await expect(page.evaluate(([l, sp]) => window.pdfink.setInkText(0, [l as never], { space: sp as "page" | "pdf" }), [bad, space] as const)).rejects.toThrow(/lines\[0\]/);
      }
    }
    await expect(page.evaluate((l) => window.pdfink.setInkText(3, [l]), line)).rejects.toThrow(/No page 3/);
    await expect(page.evaluate(() => window.pdfink.inkText(3))).rejects.toThrow(/No page 3/);
    await expect(page.evaluate(() => window.pdfink.pageText(3))).rejects.toThrow(/No page 3/);
    const pt = await page.evaluate(() => window.pdfink.pageText(0));
    expect(pt).toEqual({ own: [], ink: await page.evaluate(() => window.pdfink.inkText(0)), notebook: true });
    expect(pt.ink).toHaveLength(1);
  });

  test("strokes in page and pdf space", async ({ page }) => {
    await openApp(page);
    const [id] = await page.evaluate((s) => window.pdfink.addStrokes(0, [s]), stroke(300, 500, 310, 500));
    expect(await page.evaluate(() => window.pdfink.strokes(0))).toEqual([{ id, ...stroke(300, 500, 310, 500) }]);
    const pdf = await page.evaluate(() => window.pdfink.strokes(0, { space: "pdf" }));
    expect(pdf).toEqual([{ id, ...stroke(300, 292, 310, 292) }]);
    // Round trip: pdf-space strokes added back land where the first one is.
    const { id: _, ...back } = pdf[0];
    const [id2] = await page.evaluate((s) => window.pdfink.addStrokes(0, [s], { space: "pdf" }), back);
    expect((await page.evaluate(() => window.pdfink.strokes(0)))[1]).toEqual({ id: id2, ...stroke(300, 500, 310, 500) });
    // A copy: changing it leaves the page alone.
    await page.evaluate(() => { window.pdfink.strokes(0)[0].points.length = 0; });
    expect((await page.evaluate(() => window.pdfink.strokes(0)))[0].points).toHaveLength(2);
    await expect(page.evaluate(() => window.pdfink.strokes(2))).rejects.toThrow(/No page 2/);
  });

  test("notebookTag and setNotebookTag", async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => window.pdfink.notebookTag())).toBe(true); // New makes a notebook
    await page.evaluate(() => window.pdfink.setNotebookTag(false));
    expect(await page.evaluate(() => window.pdfink.notebookTag())).toBe(false);
    expect((await page.evaluate(() => window.pdfink.pageText(0))).notebook).toBe(false);
    expect((await state(page)).dirty).toBe(true);
    await page.evaluate(() => window.pdfink.setNotebookTag(null));
    expect(await page.evaluate(() => window.pdfink.notebookTag())).toBeNull();
    await expect(page.evaluate(() => window.pdfink.setNotebookTag("yes" as never))).rejects.toThrow(/true, false or null/);
  });

  test("the bridge forwards ink events", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __sent: string[]; __sockets: WebSocket[] };
      w.__sent = [];
      w.__sockets = [];
      const Real = window.WebSocket;
      window.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          w.__sockets.push(this);
        }
        send(data: Parameters<WebSocket["send"]>[0]) {
          if (typeof data === "string") w.__sent.push(data);
          super.send(data);
        }
      };
    });
    await openApp(page);
    await page.waitForFunction(() => (window as unknown as { __sockets: WebSocket[] }).__sockets.some((s) => s.readyState === WebSocket.OPEN && s.url.includes("/api/page")));
    // Only what follows the stroke: the document-open ink events are already out (or dropped).
    await page.evaluate(() => ((window as unknown as { __sent: string[] }).__sent.length = 0));
    await page.evaluate((s) => window.pdfink.addStrokes(0, [s]), stroke(300, 500, 310, 500));
    const ink = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.map((m) => JSON.parse(m)).filter((m) => m.event === "ink"));
    expect(ink).toEqual([{ event: "ink", data: { page: 0 } }]);
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
    await page.evaluate(() => window.pdfink.removeBookmark(1));
    expect(await page.evaluate(() => window.pdfink.bookmarks())).toEqual([{ title: "2026-10-23", page: 0, level: 0 }]);
    // Removing a parent takes the entries nested under it.
    await page.evaluate(() => window.pdfink.addBookmark(0, "Sub", { level: 1 }));
    await page.evaluate(() => window.pdfink.removeBookmark(0));
    expect(await page.evaluate(() => window.pdfink.bookmarks())).toEqual([]);
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
