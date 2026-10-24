import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PDFDocument, PDFName } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { readOutline } from "../../src/pdf/outline";
import type { Bookmark, PageModel } from "../../src/model";
import { FIXTURES, expect, fakeClipboard, openApp, state, waitReady } from "./helpers";

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

test.describe("bookmarks", () => {
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
});
