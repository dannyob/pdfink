import { test } from "@playwright/test";
import { createBlankPdf } from "../../src/pdf/export";
import { expect, line, openApp, penStroke, state } from "./helpers";

const API = "http://127.0.0.1:5176";

async function putNotebook(name: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`${API}/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", body: bytes as BodyInit });
  if (!res.ok) throw new Error(`put ${name}: ${res.status}`);
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`;
}

test.describe("deep links", () => {
  test("?f= opens the notebook and the hash follows the current page", async ({ page }) => {
    const name = unique("link");
    await putNotebook(name, await createBlankPdf(3));
    await openApp(page, `?nofs=1&f=${encodeURIComponent(name)}`);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#page=1");
    expect(await page.evaluate(() => new URL(location.href).searchParams.get("f"))).toBe(name);

    await page.evaluate(() => window.__pdfink.scrollToPage(2));
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#page=3");
  });

  test("a selection is written into the hash in PDF points and leaves with it", async ({ page }) => {
    const name = unique("sel");
    await putNotebook(name, await createBlankPdf(1));
    await openApp(page, `?nofs=1&f=${encodeURIComponent(name)}`);
    await page.waitForFunction((n) => window.__pdfink.source.name === n, name);
    await penStroke(page, 0, line(110, 150, 140, 150));
    // Display rect (100,92) 50×200 on a Letter page is PDF (100,500) 50×200.
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 100, y: 92, w: 50, h: 200 }));
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#page=1;x=100pdf;y=500pdf;w=50pdf;h=200pdf");

    await page.evaluate(() => window.__pdfink.clearSelection());
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#page=1");
  });

  test("loading a selection hash restores the selection on that page", async ({ page }) => {
    const name = unique("restore");
    await putNotebook(name, await createBlankPdf(3));
    await openApp(page, `?nofs=1&f=${encodeURIComponent(name)}#page=2;x=100pdf;y=500pdf;w=50pdf;h=200pdf`);
    await page.waitForFunction((n) => window.__pdfink.source.name === n, name);
    await expect.poll(async () => (await state(page)).selection?.page).toBe(1);
    const s = await state(page);
    expect(s.selection?.rect).toEqual({ x: 100, y: 92, w: 50, h: 200 });
    expect(s.tool).toBe("select");
    await expect.poll(async () => (await state(page)).currentPage).toBe(1);
    expect(await page.evaluate(() => location.hash)).toBe("#page=2;x=100pdf;y=500pdf;w=50pdf;h=200pdf");
  });
});
