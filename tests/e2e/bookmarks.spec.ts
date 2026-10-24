import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRef, PDFString } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { readOutline } from "../../src/pdf/outline";
import type { Bookmark, PageModel } from "../../src/model";
import { FIXTURES, expect, fakeClipboard, line, openApp, penStroke, state, toClient, waitReady } from "./helpers";

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

function blankPages(n: number): PageModel[] {
  return Array.from({ length: n }, () => ({ width: 612, height: 792, strokes: [], images: [], links: [] }));
}

/** The option texts of the bookmark select. */
async function bookmarkOptions(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator("#bookmark-select option").allTextContents();
}

async function openNotebookPage(page: import("@playwright/test").Page, name: string): Promise<void> {
  await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
  await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
}

/**
 * Three pages; an outline the model cannot represent exactly: a closed item
 * (/Count -1) on page 0 whose child points at page 2 by integer index, then an
 * item with a positioned /XYZ destination on page 1.
 */
async function pdfWithRichOutline(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([612, 792]);
  const [p0, p1] = doc.getPages();
  const ctx = doc.context;
  const [root, closed, kid, positioned] = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()];
  ctx.assign(closed, ctx.obj({ Title: PDFString.of("Closed"), Parent: root, Next: positioned, First: kid, Last: kid, Count: -1, Dest: [p0.ref, PDFName.of("Fit")] }));
  ctx.assign(kid, ctx.obj({ Title: PDFString.of("Kid"), Parent: closed, Dest: [2, PDFName.of("XYZ"), 0, 792, 0] }));
  ctx.assign(positioned, ctx.obj({ Title: PDFString.of("Positioned"), Parent: root, Prev: closed, Dest: [p1.ref, PDFName.of("XYZ"), 72, 500, 1.5] }));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: closed, Last: positioned, Count: 2 }));
  doc.catalog.set(PDFName.of("Outlines"), root);
  return doc.save({ useObjectStreams: false });
}

/** The outline's item dictionaries as text, links between items dropped and page refs shown as page numbers. */
function dumpOutline(doc: PDFDocument): string {
  const pageKeys = doc.getPages().map((p) => p.ref.toString());
  const skip = new Set(["Parent", "First", "Last", "Next", "Prev"]);
  const value = (o: PDFObject | undefined): string => {
    if (o instanceof PDFRef) {
      const i = pageKeys.indexOf(o.toString());
      return i >= 0 ? `page#${i}` : value(doc.context.lookup(o));
    }
    if (o instanceof PDFArray) return `[${o.asArray().map(value).join(" ")}]`;
    if (o instanceof PDFDict) return `<<${[...o.entries()].map(([k, v]) => `${k.toString()} ${value(v)}`).join(" ")}>>`;
    return String(o);
  };
  const items = (parent: PDFDict, depth: number): string[] => {
    const out: string[] = [];
    let item = parent.lookup(PDFName.of("First"));
    while (item instanceof PDFDict) {
      const entries = [...item.entries()].filter(([k]) => !skip.has(k.decodeText())).map(([k, v]) => `${k.toString()} ${value(v)}`);
      out.push(`${"  ".repeat(depth)}${entries.sort().join(" ")}`, ...items(item, depth + 1));
      item = item.lookup(PDFName.of("Next"));
    }
    return out;
  };
  const root = doc.catalog.lookup(PDFName.of("Outlines"));
  if (!(root instanceof PDFDict)) return "";
  return [`Count ${value(root.get(PDFName.of("Count")))}`, ...items(root, 0)].join("\n");
}

test.describe("bookmarks", () => {
  test("server mode: an ink-only save leaves the outline as it was; a bookmark edit rebuilds it", async ({ page }) => {
    const name = unique("bm-ink");
    await putNotebook(name, await pdfWithRichOutline());
    const before = dumpOutline(await readNotebook(name));
    expect(before).toContain("/Count -1");
    expect(before).toContain("/XYZ 72 500 1.5");
    await openNotebookPage(page, name);
    expect((await state(page)).bookmarks).toEqual([
      { title: "Closed", page: 0, level: 0 },
      { title: "Kid", page: 2, level: 1 },
      { title: "Positioned", page: 1, level: 0 },
    ]);

    await penStroke(page, 0, line(100, 100, 300, 200));
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    const inked = await readNotebook(name);
    expect(inked.getPage(0).node.Annots()?.size()).toBe(1);
    expect(dumpOutline(inked)).toBe(before);

    // A bookmark added through the pen menu: now the outline is rebuilt from the list.
    await page.evaluate(() => window.__pdfink.views[1].el.scrollIntoView({ block: "start" }));
    const [px, py] = await toClient(page, 1, 300, 300);
    await page.mouse.click(px, py, { button: "right" });
    await page.locator("#ctx-menu button", { hasText: "Bookmark this page…" }).click();
    await page.fill("#dialog .dialog-input", "Added");
    await page.keyboard.press("Enter");
    await expect.poll(() => bookmarkOptions(page)).toContain("Added");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    const rebuilt = await readNotebook(name);
    expect(dumpOutline(rebuilt)).not.toBe(before);
    expect(readOutline(rebuilt)).toEqual([
      { title: "Closed", page: 0, level: 0 },
      { title: "Kid", page: 2, level: 1 },
      { title: "Positioned", page: 1, level: 0 },
      { title: "Added", page: 1, level: 0 },
    ]);
  });

  test("a top-level bookmark goes after the whole subtree it follows; removing a parent removes its children", async ({ page }) => {
    const name = unique("bm-tree");
    await putNotebook(name, await createBlankPdf(3));
    await openNotebookPage(page, name);
    await page.evaluate(() => {
      window.__pdfink.addBookmark(0, "P");
      window.__pdfink.addBookmark(2, "C", 1);
    });
    expect((await state(page)).bookmarks).toEqual([
      { title: "P", page: 0, level: 0 },
      { title: "C", page: 2, level: 1 },
    ]);
    expect(await page.evaluate(() => window.__pdfink.addBookmark(1, "X"))).toBe(2);
    expect((await state(page)).bookmarks).toEqual([
      { title: "P", page: 0, level: 0 },
      { title: "C", page: 2, level: 1 },
      { title: "X", page: 1, level: 0 },
    ]);
    await page.evaluate(() => window.__pdfink.removeBookmark(0));
    expect((await state(page)).bookmarks).toEqual([{ title: "X", page: 1, level: 0 }]);
  });

  test("adding a bookmark lists it and selecting it jumps to the page", async ({ page }) => {
    const name = unique("bm-jump");
    await putNotebook(name, await createBlankPdf(3));
    await openNotebookPage(page, name);
    expect(await bookmarkOptions(page)).toEqual(["Bookmarks…"]);

    const index = await page.evaluate(() => window.__pdfink.addBookmark(2, "Third"));
    expect(index).toBe(0);
    expect(await bookmarkOptions(page)).toContain("Third");
    expect((await state(page)).bookmarks).toEqual([{ title: "Third", page: 2, level: 0 }]);
    expect((await state(page)).dirty).toBe(true);

    await page.selectOption("#bookmark-select", { label: "Third" });
    await page.waitForFunction(() => window.__pdfink.currentPage === 2);
    expect(await page.locator("#bookmark-select").inputValue()).toBe("");
  });

  test("bookmarks are saved into the outline and come back on reopen", async ({ page }) => {
    const name = unique("bm-save");
    await putNotebook(name, await createBlankPdf(3));
    await openNotebookPage(page, name);
    await page.evaluate(() => {
      window.__pdfink.addBookmark(2, "Third");
      window.__pdfink.addBookmark(0, "Café first");
      window.__pdfink.addBookmark(2, "Third, inside", 1);
    });
    expect((await state(page)).bookmarks).toEqual([
      { title: "Café first", page: 0, level: 0 },
      { title: "Third", page: 2, level: 0 },
      { title: "Third, inside", page: 2, level: 1 },
    ]);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);

    const doc = await readNotebook(name);
    expect(doc.catalog.has(PDFName.of("Outlines"))).toBe(true);
    expect(readOutline(doc)).toEqual([
      { title: "Café first", page: 0, level: 0 },
      { title: "Third", page: 2, level: 0 },
      { title: "Third, inside", page: 2, level: 1 },
    ]);

    await page.reload();
    await waitReady(page);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    expect(await bookmarkOptions(page)).toEqual(["Bookmarks…", "Café first", "Third", "\u00a0\u00a0Third, inside", 'Remove "Café first"']);
  });

  test("remove option removes the bookmark on the current page", async ({ page }) => {
    const name = unique("bm-remove");
    await putNotebook(name, await createBlankPdf(3));
    await openNotebookPage(page, name);
    await page.evaluate(() => {
      window.__pdfink.addBookmark(0, "First");
      window.__pdfink.addBookmark(2, "Third");
    });
    expect(await bookmarkOptions(page)).toEqual(["Bookmarks…", "First", "Third", 'Remove "First"']);
    await page.selectOption("#bookmark-select", { label: 'Remove "First"' });
    expect((await state(page)).bookmarks).toEqual([{ title: "Third", page: 2, level: 0 }]);
    expect(await bookmarkOptions(page)).toEqual(["Bookmarks…", "Third"]);
    expect(await page.locator("#bookmark-select").inputValue()).toBe("");

    // The Remove entry follows the current page.
    await page.selectOption("#bookmark-select", { label: "Third" });
    await page.waitForFunction(() => window.__pdfink.currentPage === 2);
    await expect(page.locator("#bookmark-select option")).toHaveText(["Bookmarks…", "Third", 'Remove "Third"']);
    await page.selectOption("#bookmark-select", { label: 'Remove "Third"' });
    expect((await state(page)).bookmarks).toEqual([]);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    expect((await readNotebook(name)).catalog.has(PDFName.of("Outlines"))).toBe(false);
  });

  test("local mode: a nested outline from disk is listed indented and saved unchanged", async ({ page }) => {
    const outline: Bookmark[] = [
      { title: "Part one", page: 0, level: 0 },
      { title: "Chapter", page: 1, level: 1 },
      { title: "Section", page: 1, level: 2 },
      { title: "Nowhere", page: null, level: 0 },
    ];
    fs.mkdirSync(FIXTURES, { recursive: true });
    const file = path.join(FIXTURES, "outlined.pdf");
    fs.writeFileSync(file, await exportPdf(await createBlankPdf(2), blankPages(2), outline));

    await fakeClipboard(page);
    await page.goto("/?nofs=1&storage=local");
    await page.waitForFunction(() => document.body.dataset.storage === "local");
    await page.setInputFiles("#file-input", file);
    await waitReady(page);
    expect((await state(page)).bookmarks).toEqual(outline);
    await expect(page.locator("#bookmark-select")).toBeVisible();
    expect(await bookmarkOptions(page)).toEqual(["Bookmarks…", "Part one", "\u00a0\u00a0Chapter", "\u00a0\u00a0\u00a0\u00a0Section", "Nowhere", 'Remove "Part one"']);
    expect(await page.locator("#bookmark-select option", { hasText: "Nowhere" }).isDisabled()).toBe(true);

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-saveas")]);
    const doc = await PDFDocument.load(fs.readFileSync((await download.path())!), { updateMetadata: false });
    expect(readOutline(doc)).toEqual(outline);

    // An added bookmark goes into the downloaded file too.
    await page.evaluate(() => window.__pdfink.addBookmark(1, "Added"));
    const [again] = await Promise.all([page.waitForEvent("download"), page.click("#btn-save")]);
    const doc2 = await PDFDocument.load(fs.readFileSync((await again.path())!), { updateMetadata: false });
    expect(readOutline(doc2)).toEqual([...outline.slice(0, 3), { title: "Added", page: 1, level: 0 }, outline[3]]);
  });

  test("Bookmark this page… defaults to today's date", async ({ page }) => {
    const name = unique("bm-menu");
    await putNotebook(name, await createBlankPdf(3));
    await openNotebookPage(page, name);
    await page.evaluate(() => window.__pdfink.views[1].el.scrollIntoView({ block: "start" }));
    const [px, py] = await toClient(page, 1, 300, 300);
    await page.mouse.click(px, py, { button: "right" });
    const labels = await page.locator("#ctx-menu button").allTextContents();
    expect(labels[labels.indexOf("Add page") + 1]).toBe("Bookmark this page…");
    await page.locator("#ctx-menu button", { hasText: "Bookmark this page…" }).click();
    const input = page.locator("#dialog .dialog-input");
    await expect(input).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    const today = await input.inputValue();
    await page.keyboard.press("Enter");
    await expect.poll(() => bookmarkOptions(page)).toContain(today);
    expect((await state(page)).bookmarks).toEqual([{ title: today, page: 1, level: 0 }]);

    // Cancelled or empty adds nothing.
    await page.mouse.click(px, py, { button: "right" });
    await page.locator("#ctx-menu button", { hasText: "Bookmark this page…" }).click();
    await page.keyboard.press("Escape");
    await page.mouse.click(px, py, { button: "right" });
    await page.locator("#ctx-menu button", { hasText: "Bookmark this page…" }).click();
    await page.fill("#dialog .dialog-input", "  ");
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    expect((await state(page)).bookmarks).toHaveLength(1);
  });
});
