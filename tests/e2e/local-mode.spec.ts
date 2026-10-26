import { test } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { barMenu, expect, fakeClipboard, inkAnnots, line, menuOutline, notebookFixture, openLocalApp, penStroke, state, waitReady } from "./helpers";

test.describe("browser-only (local) mode", () => {
  test("shows device file controls and hides the notebook controls", async ({ page }) => {
    await openLocalApp(page);
    expect((await state(page)).storage).toBe("local");
    await barMenu(page, "file");
    const items = await menuOutline(page);
    expect(items).toContain("Open…");
    expect(items).toContain("Save as…");
    expect(items).not.toContain("Open notebook…");
    expect(items).not.toContain("Import a PDF…");
    expect(items).not.toContain("Export as PDF…");
    await expect(page.locator("#bar-commands")).toBeHidden();
  });

  test("server mode shows the notebook controls instead", async ({ page }) => {
    await page.goto("/"); // auto-detected via /api/status
    await page.waitForFunction(() => document.body.dataset.storage === "server");
    await barMenu(page, "file");
    const items = await menuOutline(page);
    expect(items).toContain("Open notebook…");
    expect(items).toContain("Import a PDF…");
    expect(items).not.toContain("Open…");
    expect(items).not.toContain("Save as…");
    await expect(page.locator("#bar-commands")).toBeVisible();
  });

  test("Open loads a PDF from the device with its ink, Save as downloads it", async ({ page }) => {
    const file = await notebookFixture();
    await fakeClipboard(page);
    await page.goto("/?nofs=1&storage=local");
    await page.waitForFunction(() => document.body.dataset.storage === "local");
    await page.setInputFiles("#file-input", file);
    await waitReady(page);
    let s = await state(page);
    expect(s.fileName).toBe("notebook.pdf");
    expect(s.pages[0].strokes).toHaveLength(5);
    await penStroke(page, 1, line(100, 100, 200, 100));
    const [download] = await Promise.all([page.waitForEvent("download"), barMenu(page, "file", "Save as…")]);
    expect(download.suggestedFilename()).toBe("notebook.pdf");
    const doc = await PDFDocument.load(fs.readFileSync((await download.path())!), { updateMetadata: false });
    expect(inkAnnots(doc, 0)).toHaveLength(1);
    expect(inkAnnots(doc, 1)).toHaveLength(1);
    s = await state(page);
    expect(s.dirty).toBe(false);
    expect(s.source.kind).toBe("local");
  });

  test("New gives a blank Letter page without touching any server", async ({ page }) => {
    const calls: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/")) calls.push(r.url());
    });
    await openLocalApp(page);
    await penStroke(page, 0, line(100, 100, 200, 100));
    await page.evaluate(() => (window.__pdfink.confirmFn = async () => true));
    await barMenu(page, "file", "New");
    await page.waitForFunction(() => window.__pdfink.pages[0].strokes.length === 0);
    expect((await state(page)).pages[0]).toMatchObject({ width: 612, height: 792 });
    expect(calls).toEqual([]);
  });
});
