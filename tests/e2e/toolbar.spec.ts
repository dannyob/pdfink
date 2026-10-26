import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { createBlankPdf } from "../../src/pdf/export";
import { barMenu, expect, inkAnnots, line, menuAction, menuOutline, openApp, openLocalApp, penStroke, state, waitReady } from "./helpers";

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
  await waitReady(page);
}

/** Visible labels of the bar's tiles, in order. */
async function tileLabels(page: Page): Promise<string[]> {
  return page.locator("#bar .tile.labelled .tl").evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.textContent?.trim() ?? ""));
}

test.describe("the bar", () => {
  test.use({ viewport: { width: 1267, height: 783 } });

  test("groups and ids in order, every tile labelled, on one row", async ({ page }) => {
    await openApp(page);
    const groups = await page.locator("#bar > .group").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group));
    expect(groups).toEqual(["file", "tools", "style", "clipboard", "history", "page", "more"]);
    const ids = await page.locator("#bar button[id]").evaluateAll((els) => els.map((e) => e.id));
    expect(ids).toEqual([
      "bar-file",
      "bar-bookmark",
      "tool-pen",
      "tool-eraser",
      "tool-select",
      "bar-style",
      "btn-copy",
      "btn-cut",
      "btn-paste",
      "btn-delete",
      "btn-undo",
      "btn-redo",
      "btn-addpage",
      "bar-commands",
      "bar-more",
    ]);
    expect(await tileLabels(page)).toEqual(["Pen", "Eraser", "Select", "Normal", "Copy", "Cut", "Paste", "Delete", "Undo", "Redo", "Add page", "Commands", "More"]);
    await expect(page.locator("#bar-file")).toContainText("untitled.pdf");
    await expect(page.locator("#bar-bookmark")).toContainText("Bookmarks");
    for (const id of ["bar-file", "bar-bookmark", "bar-style", "bar-commands", "bar-more"]) {
      await expect(page.locator(`#${id}`)).toHaveAttribute("aria-haspopup", "menu");
      await expect(page.locator(`#${id}`)).toHaveAttribute("aria-expanded", "false");
    }
    // One row: every tile's top is the same, and nothing is cut off.
    const tops = await page.locator("#bar .tile").evaluateAll((els) => [...new Set(els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(1);
    const fits = await page.locator("#bar").evaluate((b) => b.scrollWidth <= b.clientWidth);
    expect(fits).toBe(true);
    // The empty-state and status line mount points exist.
    await expect(page.locator("#status-line #status")).toHaveCount(1);
    await expect(page.locator("#status-line #progress")).toHaveCount(1);
    await expect(page.locator("#status-line #status-right")).toHaveCount(1);
  });

  test("copy, cut and delete wait for a selection; undo and redo for history", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#btn-copy")).toBeDisabled();
    await expect(page.locator("#btn-delete")).toBeDisabled();
    await expect(page.locator("#btn-paste")).toBeEnabled();
    await expect(page.locator("#btn-undo")).toBeDisabled();
    await penStroke(page, 0, line(100, 100, 300, 100));
    await expect(page.locator("#btn-undo")).toBeEnabled();
    await expect(page.locator("#btn-redo")).toBeDisabled();
    await page.click("#tool-select");
    await expect(page.locator("#tool-select")).toHaveClass(/active/);
    await penStroke(page, 0, line(50, 50, 350, 150));
    await expect(page.locator("#btn-copy")).toBeEnabled();
    await page.click("#btn-delete");
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });

  test("the empty-page hint names More ⋯ › Finger draws", async ({ page }) => {
    await page.goto("/?nofs=1&storage=server");
    await expect(page.locator(".empty")).toContainText("More ⋯ › Finger draws");
  });
});

test.describe("File menu", () => {
  test("server mode: open, new, save, notebook pages, import, export", async ({ page }) => {
    await openApp(page);
    await barMenu(page, "file");
    expect(await menuOutline(page)).toEqual(["[untitled.pdf]", "Open notebook…", "New notebook", "—", "Save", "Notebook pages", "—", "Import a PDF…", "Export as PDF…"]);
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Save" }).locator(".detail")).toHaveText("Ctrl+S");
    await expect(page.locator("#ctx-menu .menuitem.checked")).toHaveText(/Notebook pages/);
  });

  test("browser-only: Open…, New, Save, Save as…, Notebook pages; no Commands and no empty group", async ({ page }) => {
    await openLocalApp(page);
    await barMenu(page, "file");
    expect(await menuOutline(page)).toEqual(["[untitled.pdf]", "Open…", "New", "—", "Save", "Save as…", "Notebook pages"]);
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Open…" }).locator(".detail")).toHaveText("Ctrl+O");
    await page.keyboard.press("Escape");
    await expect(page.locator("#bar-commands")).toBeHidden();
    await expect(page.locator("#cmd-buttons")).toBeHidden();
    // Every group still on the bar shows at least one tile, so no separator dangles.
    const empty = await page.locator("#bar > .group").evaluateAll((els) =>
      els.filter((g) => (g as HTMLElement).offsetParent !== null && ![...g.querySelectorAll(".tile")].some((t) => (t as HTMLElement).offsetParent !== null)).map((g) => (g as HTMLElement).dataset.group),
    );
    expect(empty).toEqual([]);
    // Save in browser-only mode writes a file.
    const [download] = await Promise.all([page.waitForEvent("download"), barMenu(page, "file", "Save")]);
    expect(download.suggestedFilename()).toBe("untitled.pdf");
  });

  test("Open notebook lists notebooks with sizes and opens one; Save saves it", async ({ page }) => {
    const name = unique("tb-open");
    await putNotebook(name, await createBlankPdf(2));
    await openApp(page);
    await barMenu(page, "file", "Open notebook…");
    const row = page.locator("#ctx-menu .menuitem", { hasText: name });
    await expect(row.locator(".detail")).toHaveText(/MB$/);
    await menuAction(page, name);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    await waitReady(page);
    await expect(page.locator("#bar-file")).toContainText(name);

    await penStroke(page, 0, line(100, 100, 300, 100));
    await barMenu(page, "file", "Save");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    const doc = await PDFDocument.load(fs.readFileSync(`${DIR}/${name}`), { updateMetadata: false });
    expect(inkAnnots(doc, 0)).toHaveLength(1);

    // The open notebook is the current entry in the list.
    await barMenu(page, "file", "Open notebook…");
    await expect(page.locator("#ctx-menu .menuitem.current")).toContainText(name);
  });
});

test.describe("Bookmarks menu", () => {
  test("the button follows the current bookmark; the menu lists, picks and removes", async ({ page }) => {
    const name = unique("tb-bm");
    await putNotebook(name, await createBlankPdf(3));
    await openNotebookPage(page, name);
    await expect(page.locator("#bar-bookmark")).toHaveText(/Bookmarks/);
    await expect(page.locator("#bar-bookmark")).toHaveClass(/none/);

    await page.evaluate(() => {
      window.__pdfink.addBookmark(0, "First");
      window.__pdfink.addBookmark(2, "Third");
      window.__pdfink.addBookmark(2, "Third, inside", 1);
    });
    await expect(page.locator("#bar-bookmark")).toHaveText(/First/);
    await expect(page.locator("#bar-bookmark")).not.toHaveClass(/none/);

    await barMenu(page, "bookmarks");
    expect(await menuOutline(page)).toEqual(["First", "Third", "Third, inside", "—", "Bookmark this page…", 'Remove "First"']);
    await expect(page.locator("#ctx-menu .menuitem.current")).toHaveText(/First/);
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Third" }).first().locator(".detail")).toHaveText("p. 3");
    expect(await page.locator("#ctx-menu .menuitem", { hasText: "Third, inside" }).evaluate((e) => (e as HTMLElement).style.getPropertyValue("--indent"))).toBe("1");

    await menuAction(page, "Third");
    await page.waitForFunction(() => window.__pdfink.currentPage === 2);
    await expect(page.locator("#bar-bookmark")).toHaveText(/Third/);

    // Remove follows the page in view.
    await barMenu(page, "bookmarks", 'Remove "Third"');
    expect((await state(page)).bookmarks).toEqual([{ title: "First", page: 0, level: 0 }]);
    await expect(page.locator("#bar-bookmark")).toHaveText(/First/);
  });

  test("a bookmark without a page is listed but cannot be picked; Bookmark this page… adds one", async ({ page }) => {
    const name = unique("tb-bm2");
    await putNotebook(name, await createBlankPdf(2));
    await openNotebookPage(page, name);
    await page.evaluate(() => {
      const app = window.__pdfink;
      app.bookmarks = [{ title: "Nowhere", page: null, level: 0 }];
      app.promptFn = async () => "Added";
    });
    await barMenu(page, "bookmarks");
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Nowhere" })).toBeDisabled();
    await menuAction(page, "Bookmark this page…");
    await page.waitForFunction(() => window.__pdfink.bookmarks.some((b) => b.title === "Added"));
    await expect(page.locator("#bar-bookmark")).toHaveText(/Added/);
  });
});

test.describe("Pen style", () => {
  test("a swatch sets the colour, a width tile the width, and the tile shows both", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#bar-style .tl")).toHaveText("Normal");
    await barMenu(page, "style");
    expect(await menuOutline(page)).toEqual(["(Black Grey Blue Red Green Yellow)", "Custom colour…", "(Thin Normal Thick Marker)"]);
    await expect(page.locator('#ctx-menu .tile[aria-label="Black"]')).toHaveClass(/checked/);
    await expect(page.locator('#ctx-menu .tile[aria-label="Normal"]')).toHaveClass(/checked/);
    // All six swatches fit inside the menu.
    const outside = await page.locator("#ctx-menu").evaluate((m) => {
      const r = m.getBoundingClientRect();
      return [...m.querySelectorAll(".row:first-of-type .tile")].filter((t) => t.getBoundingClientRect().right > r.right - 4).length;
    });
    expect(outside).toBe(0);
    await menuAction(page, "Red");
    expect(await page.evaluate(() => window.__pdfink.penColor)).toBe("#b3261e");
    await barMenu(page, "style", "Thick");
    expect(await page.evaluate(() => window.__pdfink.penWidth)).toBe(2);
    await expect(page.locator("#bar-style .tl")).toHaveText("Thick");
    await expect(page.locator("#bar-style svg path")).toHaveAttribute("stroke", "#b3261e");

    await barMenu(page, "style");
    await expect(page.locator('#ctx-menu .tile[aria-label="Red"]')).toHaveClass(/checked/);
    await expect(page.locator('#ctx-menu .tile[aria-label="Thick"]')).toHaveClass(/checked/);
    await expect(page.locator('#ctx-menu .tile[aria-label="Black"]')).not.toHaveClass(/checked/);
    await page.keyboard.press("Escape");

    await penStroke(page, 0, line(100, 100, 300, 100));
    const s = (await state(page)).pages[0].strokes[0];
    expect(s.color).toBe("#b3261e");
    expect(s.width).toBe(2);
  });

  test("Custom colour… opens the colour input, whose choice becomes the pen colour", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      const input = document.getElementById("pen-color") as HTMLInputElement;
      (window as unknown as { __picked: number }).__picked = 0;
      input.addEventListener("click", (e) => {
        e.preventDefault();
        (window as unknown as { __picked: number }).__picked++;
      });
    });
    await barMenu(page, "style", "Custom colour…");
    expect(await page.evaluate(() => (window as unknown as { __picked: number }).__picked)).toBe(1);
    await page.evaluate(() => {
      const input = document.getElementById("pen-color") as HTMLInputElement;
      input.value = "#123456";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await page.evaluate(() => window.__pdfink.penColor)).toBe("#123456");
    await expect(page.locator("#bar-style svg path")).toHaveAttribute("stroke", "#123456");
  });
});

test.describe("More menu", () => {
  test("view tiles zoom; pen toggles persist across a reload", async ({ page }) => {
    await openApp(page);
    await barMenu(page, "more");
    expect(await menuOutline(page)).toEqual(["[View]", "(Smaller Fit width Larger)", "[Pen]", "Barrel button erases", "Finger draws", "—", "Source code on GitHub"]);
    const s0 = (await state(page)).scale;
    await menuAction(page, "Larger");
    expect((await state(page)).scale).toBeCloseTo(s0 * 1.25, 5);
    await barMenu(page, "more", "Smaller");
    expect((await state(page)).scale).toBeCloseTo(s0, 5);
    await barMenu(page, "more", "Larger");
    await barMenu(page, "more", "Fit width");
    expect((await state(page)).scale).toBeCloseTo(s0, 5);

    await barMenu(page, "more");
    await expect(page.locator("#ctx-menu .menuitem.checked")).toHaveText(["Barrel button erases"]);
    await menuAction(page, "Barrel button erases");
    expect((await state(page)).barrelHeuristic).toBe(false);
    await barMenu(page, "more", "Finger draws");
    expect((await state(page)).fingerDraws).toBe(true);

    await page.reload();
    await waitReady(page);
    expect((await state(page)).barrelHeuristic).toBe(false);
    expect((await state(page)).fingerDraws).toBe(true);
    await barMenu(page, "more");
    await expect(page.locator("#ctx-menu .menuitem.checked")).toHaveText(["Finger draws"]);
  });

  test("Source code on GitHub opens the repository", async ({ page }) => {
    await openApp(page);
    const [popup] = await Promise.all([page.waitForEvent("popup"), barMenu(page, "more", "Source code on GitHub")]);
    expect(popup.url()).toContain("github.com/dannyob/pdfink");
  });
});

test.describe("Commands tile", () => {
  test("opens the pen menu's Commands list; command buttons sit beside it", async ({ page }) => {
    await openApp(page);
    await barMenu(page, "commands");
    const labels = await menuOutline(page);
    expect(labels).toContain("Where am I");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.__pdfink.addButton("t1", "Toolbar cmd", "toolbar"));
    const group = await page.locator("#cmd-buttons").evaluate((e) => (e.closest(".group") as HTMLElement).dataset.group);
    expect(group).toBe("page");
  });
});

test.describe("status line", () => {
  test("save state, page count and writing on", async ({ page }) => {
    const name = unique("tb-status");
    await putNotebook(name, await createBlankPdf(2));
    await openNotebookPage(page, name);
    const right = page.locator("#status-right");
    await expect(right).toHaveText("page 1 of 2");
    await penStroke(page, 0, line(100, 100, 300, 100));
    await expect(right).toContainText("Unsaved");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    await expect(right).toHaveText(/^Saved \d{1,2}:\d{2}.* · page 1 of 2$/);
    await page.evaluate(() => window.__pdfink.scrollToPage(1));
    await page.waitForFunction(() => window.__pdfink.currentPage === 1);
    await expect(right).toContainText("page 2 of 2 · writing on 1");
    await page.evaluate(() => window.__pdfink.scrollToPage(0));
    await page.waitForFunction(() => window.__pdfink.currentPage === 0);
    await expect(right).not.toContainText("writing on");
    // Messages go on the left; clearing them leaves the right alone.
    await page.evaluate(() => window.__pdfink.setStatus("Hello"));
    await expect(page.locator("#status")).toHaveText("Hello");
    await expect(right).toContainText("page 1 of 2");
    await page.evaluate(() => window.__pdfink.setStatus());
    await expect(page.locator("#status")).toHaveText("");
  });

  test("a tab-only document in server mode is not in notebooks; a selection is counted", async ({ page }) => {
    await openApp(page);
    await expect(page.locator("#status-right")).toContainText("Not in notebooks");
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.click("#tool-select");
    await penStroke(page, 0, line(50, 50, 350, 150));
    await expect(page.locator("#status-right")).toContainText("1 selected");
  });
});

test.describe("bar menus open and close", () => {
  test("tapping the open menu's button closes it; another button switches menus", async ({ page }) => {
    await openApp(page);
    await page.click("#bar-file");
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await expect(page.locator("#bar-file")).toHaveAttribute("aria-expanded", "true");
    await page.click("#bar-file");
    await expect(page.locator("#ctx-menu")).toBeHidden();
    await expect(page.locator("#bar-file")).toHaveAttribute("aria-expanded", "false");

    await page.click("#bar-file");
    await page.click("#bar-more");
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await expect(page.locator("#bar-more")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#bar-file")).toHaveAttribute("aria-expanded", "false");
    expect(await menuOutline(page)).toContain("Finger draws");
  });

  test("a pen tap on the page that closes a bar menu leaves no ink", async ({ page }) => {
    await openApp(page);
    await page.click("#bar-style");
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await penStroke(page, 0, line(100, 300, 300, 300));
    await expect(page.locator("#ctx-menu")).toBeHidden();
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });
});
