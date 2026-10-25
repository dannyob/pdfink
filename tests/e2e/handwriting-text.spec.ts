import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import { PDFDict, PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts } from "pdf-lib";
import { createBlankPdf } from "../../src/pdf/export";
import { importPdf } from "../../src/pdf/import";
import { readNotebookTag } from "../../src/pdf/text";
import { expect, fakeClipboard, inkAnnots, line, menuAction, menuLabels, openApp, penStroke, state, toClient, waitReady } from "./helpers";

const API = "http://127.0.0.1:5176";
const DIR = "test-results/notebooks";

async function putNotebook(name: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`${API}/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", body: bytes as BodyInit });
  if (!res.ok) throw new Error(`put ${name}: ${res.status}`);
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`;
}

async function openNotebookPage(page: Page, name: string): Promise<void> {
  await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
  await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
}

/** A one-page PDF with `text` printed on it in Helvetica. */
async function printedPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  p.drawText(text, { x: 72, y: 700, size: 12, font });
  return doc.save({ useObjectStreams: false });
}

const hasLayerFont = (doc: PDFDocument, i = 0) => {
  const fonts = doc.getPage(i).node.Resources()?.lookup(PDFName.of("Font"));
  return fonts instanceof PDFDict && fonts.has(PDFName.of("PdfinkF1"));
};

const contentsOf = (d: PDFDict): string | undefined => {
  const c = d.lookup(PDFName.of("Contents"));
  return c instanceof PDFString || c instanceof PDFHexString ? c.decodeText() : undefined;
};

const LINE1 = { x: 72, y: 90, w: 200, h: 20, text: "hello world", sig: "abc" };
const LINE2 = { x: 72, y: 140, w: 150, h: 20, text: "second line" };

test.describe("handwriting text", () => {
  test("setInkText then save: the file has the layer and contents", async ({ page }) => {
    const name = unique("tx-save");
    await putNotebook(name, await createBlankPdf(1));
    await openNotebookPage(page, name);
    await penStroke(page, 0, line(80, 100, 260, 100));
    const ids = await page.evaluate(([a, b]) => window.__pdfink.setInkText(0, [a, b]), [LINE1, LINE2] as const);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^tx/);
    const s = await state(page);
    expect(s.pages[0].texts.map((t) => t.text)).toEqual(["hello world", "second line"]);
    expect(await page.evaluate(() => window.__pdfink.inkText(0).map((t) => t.sig))).toEqual(["abc", undefined]);
    expect(await page.evaluate(() => window.__pdfink.saveToServer())).toBe(true);

    const bytes = new Uint8Array(fs.readFileSync(`${DIR}/${name}`));
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(hasLayerFont(doc)).toBe(true); // a blank page has no text of its own: a notebook page
    expect(contentsOf(inkAnnots(doc, 0)[0])).toBe("hello world\n\nsecond line");
    const imported = await importPdf(bytes);
    expect(imported.pages[0].texts.map(({ id: _id, ...rest }) => rest)).toEqual([LINE1, LINE2]);
    expect(imported.notebook).toBeNull(); // never changed here, so never written

    // Bad lines are refused and change nothing.
    await expect(page.evaluate(() => window.__pdfink.setInkText(0, [{ x: 1, y: 2, w: 3, h: 4 } as never]))).rejects.toThrow(/text/);
    expect((await state(page)).pages[0].texts).toHaveLength(2);

    // Local export carries the same.
    const out = await page.evaluate(async () => Array.from(await window.__pdfink.exportBytes()));
    const exported = await importPdf(new Uint8Array(out));
    expect(exported.pages[0].texts.map((t) => t.text)).toEqual(["hello world", "second line"]);
    expect(hasLayerFont(await PDFDocument.load(new Uint8Array(out), { updateMetadata: false }))).toBe(true);
  });

  test("moving a selection moves its text; cut/paste and delete carry it; undo restores it", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(80, 100, 260, 100));
    await page.evaluate((a) => window.__pdfink.setInkText(0, [a]), LINE1);
    const first = await state(page);
    const id = first.pages[0].texts[0].id;
    const ink0 = first.pages[0].strokes[0].bounds;

    // A marquee round the line selects its text with the stroke.
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 60, y: 80, w: 220, h: 40 }));
    let s = await state(page);
    expect(s.selection?.texts).toEqual([id]);
    expect(await page.evaluate(() => window.__pdfink.selectionInfo()?.textIds)).toEqual([id]);
    // A marquee missing the line's centre leaves it out.
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 60, y: 80, w: 50, h: 40 }));
    expect((await state(page)).selection?.texts).toEqual([]);

    // Move = cut, then paste somewhere else: the text goes along, under a new id.
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 60, y: 80, w: 220, h: 40 }));
    expect(await page.evaluate(() => window.__pdfink.cut())).toBe(true);
    s = await state(page);
    expect(s.pages[0].texts).toEqual([]);
    expect(s.clip?.texts).toBe(1);
    await page.evaluate(() => (window.__pdfink.lastPointer = { page: 0, x: 300, y: 400 }));
    expect(await page.evaluate(() => window.__pdfink.pasteInternal())).toBe(true);
    s = await state(page);
    expect(s.pages[0].texts).toHaveLength(1);
    const moved = s.pages[0].texts[0];
    expect(moved.id).not.toBe(id);
    expect(moved.id).toMatch(/^tx/);
    expect(moved.text).toBe("hello world");
    const stroke = s.pages[0].strokes[0].bounds;
    // Same offset from its ink as before the move.
    expect(moved.x - stroke.x).toBeCloseTo(LINE1.x - ink0.x, 5);
    expect(moved.y - stroke.y).toBeCloseTo(LINE1.y - ink0.y, 5);
    expect(moved.y).toBeGreaterThan(300);
    expect(s.selection?.texts).toEqual([moved.id]);

    // Delete takes it; undo brings it back; undo again undoes the paste, then the cut.
    await page.evaluate(() => window.__pdfink.deleteSelection());
    expect((await state(page)).pages[0].texts).toEqual([]);
    await page.evaluate(() => window.__pdfink.undo());
    expect((await state(page)).pages[0].texts.map((t) => t.id)).toEqual([moved.id]);
    await page.evaluate(() => window.__pdfink.undo());
    expect((await state(page)).pages[0].texts).toEqual([]);
    await page.evaluate(() => window.__pdfink.undo());
    s = await state(page);
    expect(s.pages[0].texts.map((t) => t.id)).toEqual([id]);
    expect(s.pages[0].texts[0]).toMatchObject({ x: LINE1.x, y: LINE1.y });

    // removeItems knows texts too; setInkText is itself one undo step.
    expect(await page.evaluate((i) => window.__pdfink.removeItems([i]), id)).toBe(1);
    expect((await state(page)).pages[0].texts).toEqual([]);
    await page.evaluate(() => window.__pdfink.undo());
    expect((await state(page)).pages[0].texts).toHaveLength(1);
    await page.evaluate(() => window.__pdfink.undo()); // the setInkText
    expect((await state(page)).pages[0].texts).toEqual([]);
    await page.evaluate(() => window.__pdfink.redo());
    expect((await state(page)).pages[0].texts.map((t) => t.id)).toEqual([id]);
  });

  test("setInkText within a rect replaces only the texts inside it", async ({ page }) => {
    await openApp(page);
    await page.evaluate(([a, b]) => window.__pdfink.setInkText(0, [a, b]), [LINE1, LINE2] as const);
    await page.evaluate(() => window.__pdfink.setInkText(0, [{ x: 72, y: 140, w: 150, h: 20, text: "new second" }], { within: { x: 50, y: 130, w: 300, h: 50 } }));
    expect((await state(page)).pages[0].texts.map((t) => t.text)).toEqual(["hello world", "new second"]);
  });

  test("a quiet update is not undoable and survives undoing an earlier stroke", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(80, 100, 260, 100));
    await penStroke(page, 0, line(80, 150, 260, 150));
    await page.evaluate(() => window.__pdfink.undo()); // a redo to keep
    await page.evaluate(() => (window.__pdfink.dirty = false));
    let s = await state(page);
    expect([s.undo, s.redo]).toEqual([1, 1]);

    await page.evaluate((a) => window.__pdfink.setInkText(0, [a], { quiet: true }), LINE1);
    s = await state(page);
    expect([s.undo, s.redo]).toEqual([1, 1]);
    expect(s.dirty).toBe(true);
    expect(s.pages[0].texts.map((t) => t.text)).toEqual(["hello world"]);

    // Undoing the stroke (an entry that never touched texts) keeps the text; so does redo.
    await page.evaluate(() => window.__pdfink.undo());
    s = await state(page);
    expect(s.pages[0].strokes).toEqual([]);
    expect(s.pages[0].texts.map((t) => t.text)).toEqual(["hello world"]);
    await page.evaluate(() => window.__pdfink.redo());
    await page.evaluate(() => window.__pdfink.redo());
    s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    expect(s.pages[0].texts.map((t) => t.text)).toEqual(["hello world"]);
  });

  test("New makes a notebook: the Notebook row is ticked; untick it and save → tag false", async ({ page }) => {
    await fakeClipboard(page);
    await page.goto("/");
    await page.waitForFunction(() => document.body.dataset.storage === "server");
    const name = unique("tx-new");
    await page.evaluate((n) => (window.__pdfink.promptFn = async () => n), name);
    await page.click("#btn-new");
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    await waitReady(page);
    expect(readNotebookTag(await PDFDocument.load(fs.readFileSync(`${DIR}/${name}`), { updateMetadata: false }))).toBe(true);
    expect(await page.evaluate(() => window.__pdfink.notebookTag)).toBe(true);

    const [px, py] = await toClient(page, 0, 300, 300);
    await page.mouse.click(px, py, { button: "right" });
    const labels = await menuLabels(page);
    expect(labels[labels.indexOf("Bookmark this page…") + 1]).toBe("Notebook");
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Notebook" })).toHaveClass(/checked/);
    await menuAction(page, "Notebook");
    expect(await page.evaluate(() => window.__pdfink.notebookTag)).toBe(false);
    expect((await state(page)).dirty).toBe(true);
    expect(await page.evaluate(() => window.__pdfink.isNotebookPage(0))).toBe(false);

    await page.mouse.click(px, py, { button: "right" });
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Notebook" })).not.toHaveClass(/checked/);
    await page.keyboard.press("Escape");

    // With texts on the page, an unticked notebook gets no layer.
    await page.evaluate((a) => window.__pdfink.setInkText(0, [a]), LINE1);
    expect(await page.evaluate(() => window.__pdfink.saveToServer())).toBe(true);
    const doc = await PDFDocument.load(fs.readFileSync(`${DIR}/${name}`), { updateMetadata: false });
    expect(readNotebookTag(doc)).toBe(false);
    expect(hasLayerFont(doc)).toBe(false);

    // The tab-only New is a notebook too.
    await page.evaluate(() => window.__pdfink.newDocument());
    await page.waitForFunction(() => window.__pdfink.source.kind === "local");
    expect(await page.evaluate(() => window.__pdfink.notebookTag)).toBe(true);
  });

  test("a page with printed text is not a notebook page; a whitespace-only text page is", async ({ page }) => {
    const doc = unique("tx-doc");
    const blank = unique("tx-ws");
    await putNotebook(doc, await printedPdf("Attention is all you need"));
    await putNotebook(blank, await printedPdf("   "));

    await openNotebookPage(page, doc);
    expect(await page.evaluate(() => window.__pdfink.notebookTag)).toBeNull();
    const own = await page.evaluate(() => window.__pdfink.ownText(0));
    expect(own.map((t) => t.text).join("")).toContain("Attention");
    // Page space: top-left origin, so y near 792 - 700 - 12.
    expect(own[0].x).toBeCloseTo(72, 0);
    expect(own[0].y).toBeGreaterThan(70);
    expect(own[0].y).toBeLessThan(95);
    expect(own[0].w).toBeGreaterThan(50);
    expect(own[0].h).toBeGreaterThan(5);
    expect(await page.evaluate(() => window.__pdfink.isNotebookPage(0))).toBe(false);
    // The menu says so.
    const [px, py] = await toClient(page, 0, 300, 300);
    await page.mouse.click(px, py, { button: "right" });
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Notebook" })).not.toHaveClass(/checked/);
    // Ticking it makes the whole file a notebook.
    await menuAction(page, "Notebook");
    expect(await page.evaluate(() => window.__pdfink.notebookTag)).toBe(true);
    expect(await page.evaluate(() => window.__pdfink.isNotebookPage(0))).toBe(true);
    await page.evaluate(() => window.__pdfink.setNotebookTag(null));
    expect(await page.evaluate(() => window.__pdfink.isNotebookPage(0))).toBe(false);
    // A document page with texts gets the annotation contents but no layer.
    await penStroke(page, 0, line(80, 300, 260, 300));
    await page.evaluate((a) => window.__pdfink.setInkText(0, [a]), { ...LINE1, y: 290 });
    expect(await page.evaluate(() => window.__pdfink.saveToServer())).toBe(true);
    const saved = await PDFDocument.load(fs.readFileSync(`${DIR}/${doc}`), { updateMetadata: false });
    expect(hasLayerFont(saved)).toBe(false);
    expect(contentsOf(inkAnnots(saved, 0)[0])).toBe("hello world");
    expect(readNotebookTag(saved)).toBeNull(); // set and cleared again: sent as null

    await openNotebookPage(page, blank);
    expect(await page.evaluate(() => window.__pdfink.ownText(0))).toEqual([]);
    expect(await page.evaluate(() => window.__pdfink.isNotebookPage(0))).toBe(true);
  });

  test("ink events fire for draw, erase, undo, redo, delete and reload", async ({ page }) => {
    const name = unique("tx-ink");
    await putNotebook(name, await createBlankPdf(2));
    await openNotebookPage(page, name);
    await page.evaluate(() => {
      const w = window as unknown as { __ink: number[] };
      w.__ink = [];
      window.__pdfink.on("ink", (d) => w.__ink.push((d as { page: number }).page));
    });
    const take = () =>
      page.evaluate(() => {
        const w = window as unknown as { __ink: number[] };
        const out = w.__ink;
        w.__ink = [];
        return out;
      });

    await penStroke(page, 0, line(80, 100, 260, 100));
    expect(await take()).toEqual([0]);
    // Text changes alone are not ink.
    await page.evaluate((a) => window.__pdfink.setInkText(0, [a]), LINE1);
    await page.evaluate((a) => window.__pdfink.setInkText(0, [a], { quiet: true }), LINE2);
    expect(await take()).toEqual([]);

    await page.evaluate(() => window.__pdfink.setTool("eraser"));
    await penStroke(page, 0, line(170, 90, 170, 110));
    expect(await take()).toEqual([0]);
    await page.evaluate(() => window.__pdfink.setTool("pen"));

    await page.evaluate(() => window.__pdfink.undo());
    expect(await take()).toEqual([0]);
    await page.evaluate(() => window.__pdfink.redo());
    expect(await take()).toEqual([0]);
    await page.evaluate(() => window.__pdfink.undo());
    await take();

    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 60, y: 80, w: 220, h: 40 }));
    await page.evaluate(() => window.__pdfink.deleteSelection());
    expect(await take()).toEqual([0]);

    await page.evaluate(() => window.__pdfink.addStrokes(1, [{ points: [{ x: 1, y: 1, p: 0.5 }, { x: 9, y: 9, p: 0.5 }], color: "#000", width: 1, opacity: 1 }]));
    expect(await take()).toEqual([1]);

    expect(await page.evaluate(() => window.__pdfink.saveToServer())).toBe(true);
    expect(await page.evaluate((n) => window.__pdfink.reloadNotebook(n), name)).toBe(true);
    expect((await take()).sort()).toEqual([0, 1]);
  });
});
