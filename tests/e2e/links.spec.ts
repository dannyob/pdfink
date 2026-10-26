import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { createBlankPdf } from "../../src/pdf/export";
import { expect, menuAction, menuLabels, openApp, state, toClient } from "./helpers";

const API = "http://127.0.0.1:5176";
const DIR = "test-results/notebooks";

async function putNotebook(name: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`${API}/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", body: bytes as BodyInit });
  if (!res.ok) throw new Error(`put ${name}: ${res.status}`);
}

async function readNotebook(name: string): Promise<PDFDocument> {
  return PDFDocument.load(fs.readFileSync(`${DIR}/${name}`), { updateMetadata: false });
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`;
}

/**
 * The most opaque ink-canvas pixel in a page-space rectangle of page `idx`,
 * scanning every device pixel so anti-aliasing cannot hide a thin line.
 */
async function maxPixel(page: Page, idx: number, x: number, y: number, w: number, h: number): Promise<number[]> {
  return page.evaluate(
    ([i, px, py, pw, ph]) => {
      const v = window.__pdfink.views[i];
      const k = v.scale * (v.ink.width / v.ink.clientWidth);
      const x0 = Math.floor(px * k);
      const y0 = Math.floor(py * k);
      const d = v.ink.getContext("2d")!.getImageData(x0, y0, Math.max(1, Math.ceil(pw * k)), Math.max(1, Math.ceil(ph * k))).data;
      let best = [0, 0, 0, 0];
      for (let n = 0; n < d.length; n += 4) if (d[n + 3] > best[3]) best = [d[n], d[n + 1], d[n + 2], d[n + 3]];
      return best;
    },
    [idx, x, y, w, h] as const,
  );
}

const BOX = { x: 100, y: 100, w: 200, h: 40 };

/** Serve every example.* page locally so popups load without the network. */
async function stubExampleSites(page: Page): Promise<void> {
  await page.context().route(/^https?:\/\/([a-z]+\.)?example\.(org|com|net)\//, (r) => r.fulfill({ contentType: "text/html", body: "<p>stub</p>" }));
}

/** Replace window.open with a recorder; returns nothing, read with `openCalls`. */
async function recordOpens(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __opens: unknown[][] };
    w.__opens = [];
    window.open = ((...args: unknown[]) => (w.__opens.push(args), null)) as typeof window.open;
  });
}

async function openCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as unknown as { __opens: unknown[][] }).__opens);
}

/** Fire a touch pointer event at a client point, on whatever element is there. */
async function touchEvent(page: Page, type: string, x: number, y: number, pointerId = 7): Promise<void> {
  await page.evaluate(
    ([t, cx, cy, id]) => {
      const el = document.elementFromPoint(cx, cy) ?? document.body;
      el.dispatchEvent(
        new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, pointerType: "touch", pointerId: id, isPrimary: id === 7, pressure: t === "pointerup" ? 0 : 0.5, buttons: t === "pointerup" ? 0 : 1, button: t === "pointermove" ? -1 : 0, width: 20, height: 20 }),
      );
    },
    [type, x, y, pointerId] as const,
  );
}

test.describe("links", () => {
  test("addLink draws a blue box with a caption and is undoable", async ({ page }) => {
    await openApp(page);
    const undo0 = (await state(page)).undo;
    const id = await page.evaluate((r) => window.__pdfink.addLink(0, r, "https://example.com/some/path"), BOX);
    expect(id).toMatch(/^ln/);
    let s = await state(page);
    expect(s.pages[0].links).toEqual([{ id, ...BOX, url: "https://example.com/some/path", label: undefined }]);
    expect(s.undo).toBe(undo0 + 1);
    expect(s.dirty).toBe(true);

    // Left edge, straddled: bluish and clearly more than the faint fill.
    const edge = await maxPixel(page, 0, BOX.x - 1, BOX.y + 15, 2, 10);
    expect(edge[3]).toBeGreaterThan(60);
    expect(edge[2]).toBeGreaterThan(edge[0] + 80);
    // Inside, away from the caption: only the faint fill.
    const inside = await maxPixel(page, 0, BOX.x + 100, BOX.y + 25, 10, 10);
    expect(inside[3]).toBeGreaterThan(0);
    expect(inside[3]).toBeLessThan(40);
    // The caption sits at the top-left, inset 2 pt.
    const caption = await maxPixel(page, 0, BOX.x + 2, BOX.y + 2, 60, 10);
    expect(caption[3]).toBeGreaterThan(100);
    // A small box gets no caption.
    await page.evaluate(() => window.__pdfink.addLink(0, { x: 400, y: 400, w: 40, h: 12 }, "https://example.com/some/path"));
    expect((await maxPixel(page, 0, 403, 403, 30, 7))[3]).toBeLessThan(40);

    await page.evaluate(() => window.__pdfink.undo());
    await page.evaluate(() => window.__pdfink.undo());
    s = await state(page);
    expect(s.pages[0].links).toEqual([]);
    expect((await maxPixel(page, 0, BOX.x - 1, BOX.y + 15, 2, 10))[3]).toBe(0);
    await page.evaluate(() => window.__pdfink.redo());
    expect((await state(page)).pages[0].links.map((l) => l.id)).toEqual([id]);
  });

  test("select, copy, paste and delete work on links like images", async ({ page }) => {
    await openApp(page);
    const id = await page.evaluate((r) => window.__pdfink.addLink(0, r, "https://example.com/", "Example"), BOX);
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 50, y: 50, w: 300, h: 150 }));
    let s = await state(page);
    expect(s.selection?.links).toEqual([id]);
    expect(s.selection?.strokes).toEqual([]);
    const info = await page.evaluate(() => window.__pdfink.selectionInfo());
    expect(info?.linkIds).toEqual([id]);
    expect(info?.bounds).toEqual(BOX);

    // A marquee that misses the link's centre does not select it.
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 50, y: 50, w: 100, h: 150 }));
    expect((await state(page)).selection?.links).toEqual([]);

    // The selected link gets the dashed selection outline.
    await page.evaluate(() => window.__pdfink.clearSelection());
    const plain = await maxPixel(page, 0, BOX.x - 1, BOX.y + 15, 2, 10);
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 90, y: 90, w: 220, h: 60 }));
    const outlined = await maxPixel(page, 0, BOX.x - 1, BOX.y + 15, 2, 10);
    expect(outlined[3]).toBeGreaterThan(plain[3]);

    expect(await page.evaluate(() => window.__pdfink.copy())).toBe(true);
    expect((await state(page)).clip).toMatchObject({ strokes: 0, images: 0, links: 1, width: BOX.w, height: BOX.h });

    expect(await page.evaluate(() => window.__pdfink.pasteInternal())).toBe(true);
    s = await state(page);
    expect(s.pages[0].links).toHaveLength(2);
    const pasted = s.pages[0].links[1];
    expect(pasted.id).not.toBe(id);
    expect(pasted.id).toMatch(/^ln/);
    expect(pasted).toMatchObject({ w: BOX.w, h: BOX.h, url: "https://example.com/", label: "Example" });
    expect(s.selection?.links).toEqual([pasted.id]);

    await page.evaluate(() => window.__pdfink.deleteSelection());
    s = await state(page);
    expect(s.pages[0].links.map((l) => l.id)).toEqual([id]);
    await page.evaluate(() => window.__pdfink.undo());
    expect((await state(page)).pages[0].links).toHaveLength(2);

    // Cut takes it away and puts it on the clip; removeItems knows links too.
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 90, y: 90, w: 220, h: 60 }));
    expect(await page.evaluate(() => window.__pdfink.cut())).toBe(true);
    expect((await state(page)).pages[0].links.map((l) => l.id)).toEqual([pasted.id]);
    expect(await page.evaluate((i) => window.__pdfink.removeItems([i]), pasted.id)).toBe(1);
    expect((await state(page)).pages[0].links).toEqual([]);
  });

  test("setLink changes the url; a javascript: url is refused", async ({ page }) => {
    await openApp(page);
    const id = await page.evaluate((r) => window.__pdfink.addLink(0, r, "https://a.example/"), BOX);
    await page.evaluate((i) => window.__pdfink.setLink(i, { url: "mailto:me@example.com", label: "Me" }), id);
    expect((await state(page)).pages[0].links[0]).toMatchObject({ url: "mailto:me@example.com", label: "Me" });
    await page.evaluate(() => window.__pdfink.undo());
    expect((await state(page)).pages[0].links[0]).toMatchObject({ url: "https://a.example/", label: undefined });

    await expect(page.evaluate((i) => window.__pdfink.setLink(i, { url: "javascript:alert(1)" }), id)).rejects.toThrow(/bad url/);
    await expect(page.evaluate((r) => window.__pdfink.addLink(0, r, "javascript:alert(1)"), BOX)).rejects.toThrow(/bad url/);
    expect((await state(page)).pages[0].links).toHaveLength(1);
    expect((await state(page)).pages[0].links[0].url).toBe("https://a.example/");

    // linkAt finds the topmost link under a point; links() lists them with their page.
    const top = await page.evaluate(() => window.__pdfink.addLink(0, { x: 150, y: 110, w: 100, h: 50 }, "https://b.example/"));
    expect(await page.evaluate(() => window.__pdfink.linkAt(0, 120, 120)?.id)).toBe(id);
    expect(await page.evaluate(() => window.__pdfink.linkAt(0, 200, 120)?.id)).toBe(top);
    expect(await page.evaluate(() => window.__pdfink.linkAt(0, 500, 500))).toBeNull();
    expect(await page.evaluate(() => window.__pdfink.links().map((l) => [l.page, l.id]))).toEqual([
      [0, id],
      [0, top],
    ]);
    expect(await page.evaluate(() => window.__pdfink.links(1))).toEqual([]);

    // openLink opens a new window without an opener.
    const opened = await page.evaluate(() => {
      const calls: unknown[][] = [];
      window.open = ((...args: unknown[]) => (calls.push(args), null)) as typeof window.open;
      window.__pdfink.openLink(window.__pdfink.linkAt(0, 120, 120)!);
      return calls;
    });
    expect(opened).toEqual([["https://a.example/", "_blank", "noopener,noreferrer"]]);
  });

  test("saving writes the link and reopening shows it", async ({ page }) => {
    const name = unique("links");
    await putNotebook(name, await createBlankPdf(1));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    await page.evaluate((r) => window.__pdfink.addLink(0, r, "https://example.com/saved", "Saved"), BOX);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);

    const doc = await readNotebook(name);
    const annots = doc.getPage(0).node.Annots();
    const links: PDFDict[] = [];
    for (let k = 0; k < (annots?.size() ?? 0); k++) {
      const d = annots!.lookup(k);
      if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Link")) links.push(d);
    }
    expect(links).toHaveLength(1);
    const uri = links[0].lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI"));
    expect(uri instanceof PDFString && uri.decodeText()).toBe("https://example.com/saved");

    await page.reload();
    await page.waitForFunction(() => window.__pdfink?.pages.length > 0 && window.__pdfink.views.length === window.__pdfink.pages.length);
    const s = await state(page);
    expect(s.pages[0].links).toEqual([expect.objectContaining({ ...BOX, url: "https://example.com/saved", label: "Saved" })]);
    expect(s.pages[0].links[0].x).toBeCloseTo(BOX.x, 2);
  });

  test("the pen menu over a link offers Open and Edit URL", async ({ page }) => {
    await openApp(page);
    const id = await page.evaluate((r) => window.__pdfink.addLink(0, r, "https://example.org/"), BOX);
    const [cx, cy] = await toClient(page, 0, BOX.x + 50, BOX.y + 20);
    await page.mouse.click(cx, cy, { button: "right" });
    const items = page.locator("#ctx-menu .menuitem");
    await expect(items.nth(0)).toHaveText("Open example.org");
    await expect(items.nth(1)).toHaveText("Edit URL…");
    // The rows about the link stand apart from plain rows: tinted, with a dark left edge.
    const look = (i: number) =>
      items.nth(i).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, left: getComputedStyle(el).borderLeftWidth }));
    const plain = await look(await items.count() - 1);
    expect(plain.bg).toBe("rgb(255, 255, 255)");
    for (const i of [0, 1]) {
      const c = await look(i);
      expect(c.bg).not.toBe(plain.bg);
      expect(parseFloat(c.left)).toBeGreaterThanOrEqual(2);
    }
    await expect(page.locator("#ctx-menu .row").first().locator(".tile").first()).toHaveAttribute("aria-label", "Pen");

    await menuAction(page, "Edit URL…");
    await expect(page.locator("#dialog .dialog-input")).toHaveValue("https://example.org/");
    await page.fill("#dialog .dialog-input", "example.com/x");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await state(page)).pages[0].links[0]?.url).toBe("https://example.com/x");
    expect((await state(page)).pages[0].links[0].id).toBe(id);
    const undo = (await state(page)).undo;

    // The same url again records no change; a bad scheme is refused with a message.
    await page.mouse.click(cx, cy, { button: "right" });
    await menuAction(page, "Edit URL…");
    await expect(page.locator("#dialog .dialog-input")).toHaveValue("https://example.com/x");
    await page.keyboard.press("Enter");
    await expect(page.locator("#dialog .dialog-input")).toHaveCount(0);
    expect((await state(page)).undo).toBe(undo);

    await page.mouse.click(cx, cy, { button: "right" });
    await menuAction(page, "Edit URL…");
    await page.fill("#dialog .dialog-input", "JAVASCRIPT:alert(1)");
    await page.keyboard.press("Enter");
    await expect(page.locator("#status")).toHaveText("Not a web link: JAVASCRIPT:alert(1)");
    expect((await state(page)).pages[0].links[0].url).toBe("https://example.com/x");

    // Cancelled or emptied leaves it.
    await page.mouse.click(cx, cy, { button: "right" });
    await menuAction(page, "Edit URL…");
    await page.fill("#dialog .dialog-input", "");
    await page.keyboard.press("Enter");
    await expect(page.locator("#dialog .dialog-input")).toHaveCount(0);
    expect((await state(page)).pages[0].links[0].url).toBe("https://example.com/x");
    expect((await state(page)).undo).toBe(undo);

    // Away from the link the menu starts with the tools.
    const [ox, oy] = await toClient(page, 0, 400, 400);
    await page.mouse.click(ox, oy, { button: "right" });
    await expect(page.locator("#ctx-menu .context")).toHaveCount(0);
    await expect(items.nth(0)).toHaveText("Add link…");
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Edit URL…" })).toHaveCount(0);
  });

  test("Open launches the url in a new tab", async ({ page }) => {
    await stubExampleSites(page);
    await openApp(page);
    await page.evaluate((r) => window.__pdfink.addLink(0, r, "https://example.org/page"), BOX);
    const [cx, cy] = await toClient(page, 0, BOX.x + 50, BOX.y + 20);
    await page.mouse.click(cx, cy, { button: "right" });
    const popup = page.waitForEvent("popup");
    await menuAction(page, "Open example.org/page");
    const tab = await popup;
    await tab.waitForLoadState();
    expect(tab.url()).toBe("https://example.org/page");
    expect(await tab.evaluate(() => window.opener)).toBeNull();
  });

  test("a finger tap opens the link, but not in finger-draws mode", async ({ page }) => {
    await stubExampleSites(page);
    await openApp(page);
    await page.evaluate((r) => window.__pdfink.addLink(0, r, "https://example.org/tap"), BOX);
    const [cx, cy] = await toClient(page, 0, BOX.x + 50, BOX.y + 20);
    const popup = page.waitForEvent("popup");
    await page.evaluate(([x, y]) => window.__stylusSim.tap(x, y, { pointerType: "touch" }), [cx, cy] as const);
    const tab = await popup;
    await tab.waitForLoadState();
    expect(tab.url()).toBe("https://example.org/tap");
    await tab.close();

    await recordOpens(page);
    // Moved 9 px: a scroll, not a tap.
    await touchEvent(page, "pointerdown", cx, cy);
    await touchEvent(page, "pointermove", cx + 9, cy);
    await touchEvent(page, "pointerup", cx + 9, cy);
    // A second finger joins (a pinch): not a tap either.
    await touchEvent(page, "pointerdown", cx, cy, 7);
    await touchEvent(page, "pointerdown", cx + 40, cy, 8);
    await touchEvent(page, "pointerup", cx, cy, 7);
    await touchEvent(page, "pointerup", cx + 40, cy, 8);
    // Off the link: nothing to open.
    const [ox, oy] = await toClient(page, 0, 400, 400);
    await page.evaluate(([x, y]) => window.__stylusSim.tap(x, y, { pointerType: "touch" }), [ox, oy] as const);
    expect(await openCalls(page)).toEqual([]);
    // Moved under 8 px still counts (sent in one go so a slow runner stays under 300 ms).
    await page.evaluate(([x, y]) => window.__stylusSim.stroke([[x, y], [x + 5, y + 3]], { pointerType: "touch" }), [cx, cy] as const);
    expect(await openCalls(page)).toEqual([["https://example.org/tap", "_blank", "noopener,noreferrer"]]);

    // A palm touch while the pen is writing, or while it is in range, opens nothing.
    await recordOpens(page);
    const [px, py] = await toClient(page, 0, 400, 450);
    await page.evaluate(([x, y]) => {
      window.__stylusSim.hover(x, y);
      const el = document.elementFromPoint(x, y)!;
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: "pen", pointerId: 2, isPrimary: true, pressure: 0.6, buttons: 1, button: 0 }));
    }, [px, py] as const);
    await page.evaluate(([x, y]) => window.__stylusSim.tap(x, y, { pointerType: "touch" }), [cx, cy] as const);
    expect(await openCalls(page)).toEqual([]);
    await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)!;
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: "pen", pointerId: 2, isPrimary: true, pressure: 0, buttons: 0, button: 0 }));
      window.__stylusSim.hover(x, y); // lifted but still hovering in range
    }, [px, py] as const);
    await page.evaluate(([x, y]) => window.__stylusSim.tap(x, y, { pointerType: "touch" }), [cx, cy] as const);
    expect(await openCalls(page)).toEqual([]);
    // Out of range: taps follow links again.
    await page.evaluate(() => window.__pdfink.container.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "pen", pointerId: 2 })));
    await page.evaluate(([x, y]) => window.__stylusSim.tap(x, y, { pointerType: "touch" }), [cx, cy] as const);
    expect(await openCalls(page)).toEqual([["https://example.org/tap", "_blank", "noopener,noreferrer"]]);

    // Held 400 ms: a long press, not a tap (the one deliberate wait).
    await recordOpens(page);
    await touchEvent(page, "pointerdown", cx, cy);
    await page.waitForTimeout(400);
    await touchEvent(page, "pointerup", cx, cy);
    expect(await openCalls(page)).toEqual([]);

    // In finger-draws mode a tap draws a dot.
    await page.evaluate(() => window.__pdfink.setFingerDraws(true));
    const before = (await state(page)).pages[0].strokes.length;
    await page.evaluate(([x, y]) => window.__stylusSim.tap(x, y, { pointerType: "touch" }), [cx, cy] as const);
    expect(await openCalls(page)).toEqual([]);
    expect((await state(page)).pages[0].strokes).toHaveLength(before + 1);
  });

  test("Add link… puts a link on the selection rectangle", async ({ page }) => {
    await openApp(page);
    const [cx, cy] = await toClient(page, 0, 300, 300);
    await page.mouse.click(cx, cy, { button: "right" });
    const add = page.locator("#ctx-menu .menuitem", { hasText: "Add link…" });
    await expect(add).toBeDisabled();
    // It is the first text row, straight after the icon rows.
    const labels = await menuLabels(page);
    expect(labels[0]).toBe("Add link…");
    await page.keyboard.press("Escape");

    // A zero-area marquee cannot hold a link.
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 250, y: 250, w: 0, h: 30 }));
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(add).toBeDisabled();
    await page.keyboard.press("Escape");

    const rect = { x: 250, y: 260, w: 120, h: 30 };
    await page.evaluate((r) => window.__pdfink.selectRect(0, r), rect);
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.locator("#dialog .dialog-input")).toHaveValue("https://");
    await page.fill("#dialog .dialog-input", "example.net/a");
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await state(page)).pages[0].links.length).toBe(1);
    expect((await state(page)).pages[0].links[0]).toMatchObject({ ...rect, url: "https://example.net/a" });

    // A bad scheme is refused with a message and adds nothing.
    await page.evaluate((r) => window.__pdfink.selectRect(0, r), { x: 400, y: 400, w: 50, h: 20 });
    await page.mouse.click(cx, cy, { button: "right" });
    await add.click();
    await page.fill("#dialog .dialog-input", "javascript:alert(1)");
    await page.keyboard.press("Enter");
    await expect(page.locator("#status")).toHaveText("Not a web link: javascript:alert(1)");
    expect((await state(page)).pages[0].links).toHaveLength(1);
  });
});
