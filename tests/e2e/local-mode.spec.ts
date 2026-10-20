import { test } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { expect, fakeClipboard, inkAnnots, line, notebookFixture, openLocalApp, penStroke, state, waitReady } from "./helpers";

test.describe("browser-only (local) mode", () => {
  test("shows device file controls and hides the notebook controls", async ({ page }) => {
    await openLocalApp(page);
    expect((await state(page)).storage).toBe("local");
    await expect(page.locator("#btn-open")).toBeVisible();
    await expect(page.locator("#btn-saveas")).toBeVisible();
    await expect(page.locator("#notebook-select")).toBeHidden();
    await expect(page.locator("#btn-import")).toBeHidden();
    await expect(page.locator("#btn-export")).toBeHidden();
  });

  test("server mode shows the notebook controls instead", async ({ page }) => {
    await page.goto("/"); // auto-detected via /api/status
    await page.waitForFunction(() => document.body.dataset.storage === "server");
    await expect(page.locator("#notebook-select")).toBeVisible();
    await expect(page.locator("#btn-open")).toBeHidden();
    await expect(page.locator("#btn-saveas")).toBeHidden();
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
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btn-saveas")]);
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
    await page.click("#btn-new");
    await page.waitForFunction(() => window.__pdfink.pages[0].strokes.length === 0);
    expect((await state(page)).pages[0]).toMatchObject({ width: 612, height: 792 });
    expect(calls).toEqual([]);
  });
});
