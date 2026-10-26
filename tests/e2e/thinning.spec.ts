import { test } from "@playwright/test";
import { expect, line, openApp, penStroke } from "./helpers";

test("a straight pen stroke keeps only the points it needs", async ({ page }) => {
  await openApp(page);
  await penStroke(page, 0, line(100, 100, 300, 100, 40));
  const pts = await page.evaluate(() => window.pdfink.strokes(0)[0].points);
  expect(pts.length).toBeLessThan(5);
  expect(pts[0].x).toBeCloseTo(100, 0);
  expect(pts[pts.length - 1].x).toBeCloseTo(300, 0);
});

test("strokes added by a command are thinned too", async ({ page }) => {
  await openApp(page);
  const ids = await page.evaluate(() =>
    window.pdfink.addStrokes(0, [{ points: Array.from({ length: 50 }, (_, i) => ({ x: 50 + i, y: 80, p: 0.6 })), color: "#000000", width: 2, opacity: 1 }]),
  );
  expect(ids).toHaveLength(1);
  expect(await page.evaluate(() => window.pdfink.strokes(0)[0].points.length)).toBe(2);
});
