import { test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRef, PDFString } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { readOutline } from "../../src/pdf/outline";
import type { Bookmark, PageModel } from "../../src/model";
import { FIXTURES, barMenu, expect, fakeClipboard, line, menuAction, menuLabels, openApp, penStroke, state, toClient, waitReady } from "./helpers";

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
  return Array.from({ length: n }, () => ({ width: 612, height: 792, strokes: [], images: [], links: [], texts: [] }));
}

/**
 * The bar's Bookmarks menu as text: each bookmark indented two spaces per
 * level, then Remove "…" when the page in view has one ("Bookmark this
 * page…", always there, is left out). Closes the menu again.
 */
async function bookmarkOptions(page: import("@playwright/test").Page): Promise<string[]> {
  await barMenu(page, "bookmarks");
  const rows = await page.locator("#ctx-menu > .menuitem").evaluateAll((els) =>
    els.map((e) => "  ".repeat(Number((e as HTMLElement).style.getPropertyValue("--indent") || 0)) + ((e.querySelector(".text") ?? e).textContent?.trim() ?? "")),
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#ctx-menu")).toBeHidden();
  return rows.filter((r) => r !== "Bookmark this page…");
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
    await menuAction(page, "Bookmark this page…");
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
    expect(await bookmarkOptions(page)).toEqual([]);

    const index = await page.evaluate(() => window.__pdfink.addBookmark(2, "Third"));
    expect(index).toBe(0);
    expect(await bookmarkOptions(page)).toContain("Third");
    expect((await state(page)).bookmarks).toEqual([{ title: "Third", page: 2, level: 0 }]);
    expect((await state(page)).dirty).toBe(true);

    await barMenu(page, "bookmarks", "Third");
    await page.waitForFunction(() => window.__pdfink.currentPage === 2);
    await expect(page.locator("#ctx-menu")).toBeHidden();
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
    expect(await bookmarkOptions(page)).toEqual(["Café first", "Third", "  Third, inside", 'Remove "Café first"']);
  });

  test("remove option removes the bookmark on the current page", async ({ page }) => {
    const name = unique("bm-remove");
    await putNotebook(name, await createBlankPdf(3));
    await openNotebookPage(page, name);
    await page.evaluate(() => {
      window.__pdfink.addBookmark(0, "First");
      window.__pdfink.addBookmark(2, "Third");
    });
    expect(await bookmarkOptions(page)).toEqual(["First", "Third", 'Remove "First"']);
    await barMenu(page, "bookmarks", 'Remove "First"');
    expect((await state(page)).bookmarks).toEqual([{ title: "Third", page: 2, level: 0 }]);
    expect(await bookmarkOptions(page)).toEqual(["Third"]);

    // The Remove entry follows the current page.
    await barMenu(page, "bookmarks", "Third");
    await page.waitForFunction(() => window.__pdfink.currentPage === 2);
    await expect.poll(() => bookmarkOptions(page)).toEqual(["Third", 'Remove "Third"']);
    await barMenu(page, "bookmarks", 'Remove "Third"');
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
    await expect(page.locator("#bar-bookmark")).toBeVisible();
    expect(await bookmarkOptions(page)).toEqual(["Part one", "  Chapter", "    Section", "Nowhere", 'Remove "Part one"']);
    await barMenu(page, "bookmarks");
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Nowhere" })).toBeDisabled();
    await page.keyboard.press("Escape");

    const [download] = await Promise.all([page.waitForEvent("download"), barMenu(page, "file", "Save as…")]);
    const doc = await PDFDocument.load(fs.readFileSync((await download.path())!), { updateMetadata: false });
    expect(readOutline(doc)).toEqual(outline);

    // An added bookmark goes into the downloaded file too.
    await page.evaluate(() => window.__pdfink.addBookmark(1, "Added"));
    const [again] = await Promise.all([page.waitForEvent("download"), barMenu(page, "file", "Save")]);
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
    const labels = await menuLabels(page);
    expect(labels[labels.indexOf("Add link…") + 1]).toBe("Bookmark this page…");
    await menuAction(page, "Bookmark this page…");
    const input = page.locator("#dialog .dialog-input");
    await expect(input).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    const today = await input.inputValue();
    await page.keyboard.press("Enter");
    await expect.poll(() => bookmarkOptions(page)).toContain(today);
    expect((await state(page)).bookmarks).toEqual([{ title: today, page: 1, level: 0 }]);

    // Cancelled or empty adds nothing.
    await page.mouse.click(px, py, { button: "right" });
    await menuAction(page, "Bookmark this page…");
    await page.keyboard.press("Escape");
    await page.mouse.click(px, py, { button: "right" });
    await menuAction(page, "Bookmark this page…");
    await page.fill("#dialog .dialog-input", "  ");
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);
    expect((await state(page)).bookmarks).toHaveLength(1);
  });
  test("the current bookmark follows where the pen last wrote, or the last pick; scrolling leaves it", async ({ page }) => {
    const name = unique("bm-current");
    await putNotebook(name, await createBlankPdf(4));
    await openNotebookPage(page, name);
    await page.evaluate(() => {
      const w = window as unknown as { __cb: unknown[] };
      w.__cb = [];
      window.__pdfink.on("currentBookmark", (i) => w.__cb.push(i));
    });
    const events = (): Promise<unknown[]> => page.evaluate(() => (window as unknown as { __cb: unknown[] }).__cb);
    const current = (): Promise<number | null> => page.evaluate(() => window.__pdfink.currentBookmarkIndex);

    // A notebook with no bookmarks has none; drawing doesn't change that.
    expect(await current()).toBeNull();
    await penStroke(page, 1, line(100, 100, 300, 200));
    expect(await page.evaluate(() => window.__pdfink.inkPage)).toBe(1);
    expect(await current()).toBeNull();
    expect(await events()).toEqual([]);

    // Bookmarks on pages 0 and 2: the ink on page 1 is under the page-0 one.
    // Every outline edit announces the current one, changed or not.
    await page.evaluate(() => {
      window.__pdfink.addBookmark(0, "A");
      window.__pdfink.addBookmark(2, "C");
    });
    expect(await current()).toBe(0);
    expect(await events()).toEqual([0, 0]);

    // Drawing on page 2 makes "C" current.
    await penStroke(page, 2, line(100, 100, 300, 200));
    expect(await page.evaluate(() => window.__pdfink.inkPage)).toBe(2);
    expect(await current()).toBe(1);
    expect(await events()).toEqual([0, 0, 1]);

    // Scrolling alone never changes it.
    await page.evaluate(() => window.__pdfink.views[0].el.scrollIntoView({ block: "start" }));
    await page.waitForFunction(() => window.__pdfink.currentPage === 0);
    expect(await current()).toBe(1);
    expect(await events()).toEqual([0, 0, 1]);

    // A pick scrolls to its page and shows until the next pen touch.
    await page.evaluate(() => window.__pdfink.pickBookmark(1));
    await page.waitForFunction(() => window.__pdfink.currentPage === 2);
    await page.evaluate(() => window.__pdfink.pickBookmark(0));
    await page.waitForFunction(() => window.__pdfink.currentPage === 0);
    expect(await page.evaluate(() => window.__pdfink.inkPage)).toBeNull();
    expect(await current()).toBe(0);
    expect(await events()).toEqual([0, 0, 1, 1, 0]);
    await expect(page.evaluate(() => window.__pdfink.pickBookmark(7))).rejects.toThrow(/No bookmark 7/);

    // Ink added by a command counts as the pen too.
    await page.evaluate(() => window.__pdfink.addStrokes(3, [{ points: [{ x: 10, y: 10, p: 0.5 }, { x: 50, y: 50, p: 0.5 }], color: "#000000", width: 1, opacity: 1 }]));
    expect(await page.evaluate(() => window.__pdfink.inkPage)).toBe(3);
    expect(await current()).toBe(1);

    // Adding a bookmark on the ink page updates it; removing it goes back.
    await page.evaluate(() => window.__pdfink.addBookmark(3, "D"));
    expect(await current()).toBe(2);
    await page.evaluate(() => window.__pdfink.removeBookmark(2));
    expect(await current()).toBe(1);
    // Removing the page-0 bookmark shifts the indices: "C" is now 0.
    await page.evaluate(() => window.__pdfink.removeBookmark(0));
    expect(await current()).toBe(0);
    expect(await events()).toEqual([0, 0, 1, 1, 0, 1, 2, 1, 0]);

    // A pick follows its entry as bookmarks are added or removed around it, and goes with it.
    await page.evaluate(() => {
      window.__pdfink.addBookmark(3, "D");
      window.__pdfink.pickBookmark(1);
      window.__pdfink.addBookmark(0, "Before");
    });
    expect(await current()).toBe(2);
    await page.evaluate(() => window.__pdfink.removeBookmark(0));
    expect(await current()).toBe(1);
    // Removing the picked one falls back to the page-1 rule: nothing covers page 1 now.
    await page.evaluate(() => window.__pdfink.removeBookmark(1));
    expect(await current()).toBeNull();

    // After a reload, before any pen touch: the one covering page 1, if any.
    await page.evaluate(() => window.__pdfink.addBookmark(0, "A again"));
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    await page.reload();
    await waitReady(page);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    expect(await page.evaluate(() => window.__pdfink.inkPage)).toBeNull();
    expect(await current()).toBe(0);
  });

  test("the current bookmark is null before ink when nothing covers page 1, and resets on reopen", async ({ page }) => {
    const name = unique("bm-current-none");
    const base = await createBlankPdf(3);
    await putNotebook(name, await exportPdf(base, blankPages(3), [{ title: "Second", page: 1, level: 0 }]));
    await openNotebookPage(page, name);
    expect(await page.evaluate(() => window.__pdfink.currentBookmarkIndex)).toBeNull();
    await penStroke(page, 2, line(100, 100, 300, 200));
    expect(await page.evaluate(() => window.__pdfink.currentBookmarkIndex)).toBe(0);
    await page.evaluate(() => window.__pdfink.pickBookmark(0));
    // Reopening forgets the ink and the pick.
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    await page.reload();
    await waitReady(page);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    expect(await page.evaluate(() => window.__pdfink.inkPage)).toBeNull();
    expect(await page.evaluate(() => window.__pdfink.currentBookmarkIndex)).toBeNull();
  });
});
