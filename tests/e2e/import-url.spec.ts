import { test } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createBlankPdf } from "../../src/pdf/export";
import { barMenu, expect, fakeClipboard, openApp, openLocalApp, state, waitReady } from "./helpers";

// The notebooks folder of the test API server (see playwright.config.ts).
const NOTEBOOKS = path.resolve("test-results/notebooks");

// Another website, on a different origin from the app. /cors/ answers
// cross-origin requests, /nocors/ doesn't (like most sites).
let remote: http.Server;
let site: string;

test.beforeAll(async () => {
  const pdf = await createBlankPdf(3);
  remote = http.createServer((req, res) => {
    const cors = req.url?.startsWith("/cors/") ? { "Access-Control-Allow-Origin": "*" } : {};
    if (req.url?.endsWith("/paper.pdf")) res.writeHead(200, { "Content-Type": "application/pdf", ...cors }).end(pdf);
    else if (req.url?.endsWith("/page.html")) res.writeHead(200, { "Content-Type": "text/html", ...cors }).end("<html>log in</html>");
    else res.writeHead(404, cors).end("no");
  });
  await new Promise<void>((ok) => remote.listen(0, "127.0.0.1", () => ok()));
  site = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((ok) => remote.close(ok));
});

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`;
}

test.describe("browser-only mode", () => {
  test("?import= opens the PDF at the address, at the page in the hash", async ({ page }) => {
    await fakeClipboard(page);
    await page.goto(`/?nofs=1&storage=local&import=${site}/cors/paper.pdf#page=2`);
    await waitReady(page);
    const s = await state(page);
    expect(s.fileName).toBe("paper.pdf");
    expect(s.source).toEqual({ kind: "local", name: "paper.pdf" });
    expect(s.pages).toHaveLength(3);
    await expect.poll(async () => (await state(page)).currentPage).toBe(1);
    // The address still says where it came from, so a reload fetches it again.
    expect(await page.evaluate(() => location.search)).toContain("import=");
  });

  test("a site that refuses cross-origin fetches gets an explanation", async ({ page }) => {
    await fakeClipboard(page);
    await page.goto(`/?nofs=1&storage=local&import=${site}/nocors/paper.pdf`);
    await expect(page.locator(".empty .error")).toContainText("Download the PDF and open it");
  });

  test("a page that isn't a PDF is refused", async ({ page }) => {
    await fakeClipboard(page);
    await page.goto(`/?nofs=1&storage=local&import=${site}/cors/page.html`);
    await expect(page.locator(".empty .error")).toContainText("is not a PDF");
  });

  test("File › Open from URL… asks for the address", async ({ page }) => {
    await openLocalApp(page);
    await page.evaluate((u) => (window.__pdfink.promptFn = async () => u), `${site}/cors/paper.pdf`);
    await barMenu(page, "file", "Open from URL…");
    await expect.poll(async () => (await state(page)).fileName).toBe("paper.pdf");
    expect((await state(page)).pages).toHaveLength(3);
  });
});

test.describe("server mode", () => {
  test("File › Import from URL… has the server fetch it into the notebooks folder", async ({ page }) => {
    const name = unique("fromurl");
    await openApp(page);
    await page.evaluate(
      ([u, n]) => {
        const answers = [u, n];
        window.__pdfink.promptFn = async () => answers.shift() ?? null;
      },
      // No CORS: the server does the fetching.
      [`${site}/nocors/paper.pdf`, name],
    );
    await barMenu(page, "file", "Import from URL…");
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    expect((await state(page)).pages).toHaveLength(3);
    expect(fs.existsSync(path.join(NOTEBOOKS, name))).toBe(true);
    expect(new URL(page.url()).searchParams.get("f")).toBe(name);
  });

  test("?import= offers the name from the address, then becomes ?f=", async ({ page }) => {
    const name = unique("linked");
    await fakeClipboard(page);
    await page.goto(`/?nofs=1&storage=server&import=${encodeURIComponent(`${site}/nocors/paper.pdf`)}#page=3`);
    const input = page.locator("#dialog .dialog-input");
    await expect(input).toHaveValue("paper.pdf");
    await input.fill(name);
    await page.keyboard.press("Enter");
    await waitReady(page);
    await page.waitForFunction((n) => window.__pdfink.source.name === n, name);
    await expect.poll(async () => (await state(page)).currentPage).toBe(2);
    const u = new URL(page.url());
    expect(u.searchParams.get("f")).toBe(name);
    expect(u.searchParams.has("import")).toBe(false);
  });

  test("a failed fetch is reported on the status line", async ({ page }) => {
    await openApp(page);
    await page.evaluate(
      ([u, n]) => {
        const answers = [u, n];
        window.__pdfink.promptFn = async () => answers.shift() ?? null;
      },
      [`${site}/nocors/missing.pdf`, unique("missing")],
    );
    await barMenu(page, "file", "Import from URL…");
    await expect(page.locator("#status")).toContainText("HTTP 404");
  });
});
