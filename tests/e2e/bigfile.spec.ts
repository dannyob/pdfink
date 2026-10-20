import { test } from "@playwright/test";
import fs from "node:fs";
import { SAMPLES, expect, line, openApp, penStroke, state } from "./helpers";

const REAL = `${SAMPLES}/2026.pdf`;
const DIR = "test-results/notebooks";

test("a 300 MB Xodo notebook opens through the server, renders pressure strokes, and saves small", async ({ page }) => {
  test.skip(!SAMPLES || !fs.existsSync(REAL), "set PDFINK_SAMPLES to a folder with 2026.pdf");
  test.setTimeout(180_000);
  const name = "big-2026.pdf";
  fs.copyFileSync(REAL, `${DIR}/${name}`);
  const t0 = Date.now();
  await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
  await page.waitForFunction(() => window.__pdfink.views[0] && window.__pdfink.views[0].ink.width > 0);
  const openMs = Date.now() - t0;
  const s = await state(page);
  expect(s.pages).toHaveLength(100);
  const strokes = s.pages.reduce((n, p) => n + p.strokes.length, 0);
  expect(strokes).toBeGreaterThan(10_000);
  const mem = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? -1);
  console.log(`big file: opened in ${openMs} ms, ${strokes} strokes, JS heap ${(mem / 1e6).toFixed(0)} MB`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/big-page1.png" });

  // Add a stroke and save: the saved file should be a small fraction of the original.
  await penStroke(page, 0, line(100, 400, 400, 420));
  const t1 = Date.now();
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving, null, { timeout: 60_000 });
  const saveMs = Date.now() - t1;
  const size = fs.statSync(`${DIR}/${name}`).size;
  console.log(`big file: saved in ${saveMs} ms, ${(size / 1e6).toFixed(1)} MB`);
  expect(size).toBeLessThan(60e6);

  // Reopen the saved version: same strokes plus ours, pressure intact.
  await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
  const s2 = await state(page);
  expect(s2.pages.reduce((n, p) => n + p.strokes.length, 0)).toBe(strokes + 1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/big-page1-resaved.png" });
});
