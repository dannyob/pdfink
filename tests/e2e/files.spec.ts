import { test } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { SAMPLES, barMenu, expect, exportedPdf, fakeClipboard, inkAnnots, inkPathCount, inkPixel, line, notebookFixture, openApp, openLocalApp, penStroke, state, waitReady } from "./helpers";

test.describe("files and pages", () => {
  test("opens a notebook-style PDF, imports its ink, and round-trips it", async ({ page }) => {
    const file = await notebookFixture();
    await fakeClipboard(page);
    await page.goto("/?nofs=1&storage=local");
    await page.waitForFunction(() => document.body.dataset.storage === "local");
    await page.setInputFiles("#file-input", file);
    await page.waitForFunction(() => window.__pdfink.pages.length === 2);
    await waitReady(page);
    let s = await state(page);
    expect(s.fileName).toBe("notebook.pdf");
    expect(s.pages[0].strokes).toHaveLength(5);
    expect(s.pages[1].strokes).toHaveLength(0);
    // imported ink is drawn on the ink layer at its original place
    expect((await inkPixel(page, 0, 60, 100))[3]).toBeGreaterThan(0);

    // erase one imported stroke, add one on page 2
    await penStroke(page, 0, line(120, 90, 120, 110), { buttons: 32 });
    await penStroke(page, 1, line(100, 100, 200, 100));
    s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(4);
    expect(s.pages[1].strokes).toHaveLength(1);

    const doc = await exportedPdf(page);
    expect(doc.getPageCount()).toBe(2);
    expect(inkPathCount(inkAnnots(doc, 0)[0])).toBe(4);
    expect(inkPathCount(inkAnnots(doc, 1)[0])).toBe(1);
  });

  test("add page appends a Letter page and keeps ink on earlier pages", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 200, 100));
    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 2);
    await waitReady(page);
    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 3);
    await waitReady(page);
    await expect(page.locator(".page")).toHaveCount(3);
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(1);
    expect(s.pages[2]).toMatchObject({ width: 612, height: 792 });
    const doc = await exportedPdf(page);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(2).getSize()).toEqual({ width: 612, height: 792 });
  });

  test("local mode: Save downloads a PDF containing the ink", async ({ page }) => {
    await openLocalApp(page);
    await penStroke(page, 0, line(100, 100, 200, 100));
    const [download] = await Promise.all([page.waitForEvent("download"), barMenu(page, "file", "Save")]);
    expect(download.suggestedFilename()).toBe("untitled.pdf");
    const p = await download.path();
    const doc = await PDFDocument.load(fs.readFileSync(p!), { updateMetadata: false });
    expect(inkAnnots(doc, 0)).toHaveLength(1);
    expect(doc.getProducer()).toBe("pdfink");
    expect((await state(page)).dirty).toBe(false);
  });

  test("new document replaces the current one", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 200, 100));
    await page.evaluate(() => {
      window.__pdfink.confirmFn = async () => true; // discard unsaved tab-only doc
      window.__pdfink.promptFn = async () => "fresh.pdf";
    });
    await barMenu(page, "file", "New notebook");
    await page.waitForFunction(() => window.__pdfink.pages[0].strokes.length === 0 && window.__pdfink.source.kind === "server");
    await waitReady(page);
    expect((await state(page)).undo).toBe(0);
  });

  test("zoom keeps strokes in page space", async ({ page }) => {
    await openApp(page);
    const before = (await state(page)).scale;
    await penStroke(page, 0, line(100, 100, 200, 100));
    await barMenu(page, "more", "Larger");
    await page.waitForTimeout(200);
    const s = await state(page);
    expect(s.scale).toBeCloseTo(before * 1.25, 3);
    expect(s.pages[0].strokes[0].bounds.x).toBeCloseTo(99.5, 1);
    expect((await inkPixel(page, 0, 150, 100))[3]).toBeGreaterThan(0);
    await barMenu(page, "more", "Fit width");
    await page.waitForTimeout(100);
    expect((await state(page)).scale).toBeCloseTo(before, 3);
  });
});

test("screenshot of a real notebook page with fresh ink", async ({ page }) => {
  const fs = await import("node:fs");
  const real = `${SAMPLES}/2026-postscarcity.pdf`;
  test.skip(!SAMPLES || !fs.existsSync(real), "set PDFINK_SAMPLES to a folder with 2026-postscarcity.pdf");
  await fakeClipboard(page);
  await page.goto("/?nofs=1&storage=local");
  await page.waitForFunction(() => document.body.dataset.storage === "local");
  await page.setInputFiles("#file-input", real);
  await page.waitForFunction(() => window.__pdfink.pages.length === 100);
  await waitReady(page);
  await page.waitForTimeout(500);
  const s = await state(page);
  expect(s.pages[0].strokes.length).toBeGreaterThan(100);
  await barMenu(page, "style", "Blue");
  await barMenu(page, "style", "Thick");
  await page.evaluate(() => {
    const v = window.__pdfink.views[0];
    const toC = (x: number, y: number) => {
      const c = v.toClient(x, y);
      return [c.clientX, c.clientY] as [number, number];
    };
    const sim = window.__stylusSim;
    sim.stroke(sim.scribble(60, 650, 400, 660, 80, 10).map(([x, y]) => toC(x, y)));
    sim.stroke(sim.scribble(60, 700, 300, 705, 60, 8).map(([x, y]) => toC(x, y)));
  });
  await page.click("#tool-select");
  await penStroke(page, 0, line(30, 160, 300, 200));
  await page.screenshot({ path: "test-results/notebook-page.png", fullPage: false });

  // Far-away pages release their canvases; nearby ones keep them.
  await page.evaluate(() => window.__pdfink.scrollToPage(60));
  await page.waitForFunction(() => window.__pdfink.views[0].ink.width === 0);
  expect(await page.evaluate(() => window.__pdfink.views[60].ink.width)).toBeGreaterThan(0);
  await page.evaluate(() => window.__pdfink.scrollToPage(0));
  await page.waitForFunction(() => window.__pdfink.views[0].ink.width > 0);
  await page.waitForTimeout(200);
  expect((await inkPixel(page, 0, 61, 650))[3]).toBeGreaterThan(0); // our blue scribble survived the release
});

test("a broken file leaves the current document alone and says why", async ({ page }) => {
  await openLocalApp(page);
  await penStroke(page, 0, line(100, 100, 200, 100));
  const fs = await import("node:fs");
  const bad = "test-results/fixtures/not-a.pdf";
  fs.mkdirSync("test-results/fixtures", { recursive: true });
  fs.writeFileSync(bad, "this is not a pdf");
  await page.evaluate(() => (window.__pdfink.confirmFn = async () => true)); // ok to leave the unsaved tab-only doc
  await page.setInputFiles("#file-input", bad);
  await expect(page.locator("#status")).toContainText("Could not open not-a.pdf");
  const s = await state(page);
  expect(s.pages[0].strokes).toHaveLength(1);
  expect(s.fileName).toBe("untitled.pdf");
  await penStroke(page, 0, line(100, 200, 200, 200));
  expect((await state(page)).pages[0].strokes).toHaveLength(2);
});
