import { test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createBlankPdf } from "../../src/pdf/export";
import { expect, line, openApp, penStroke, state, toClient } from "./helpers";

const API = "http://127.0.0.1:5176";

/**
 * Record the page's WebSockets in window.__sockets, and while
 * window.__holdSockets is true point new ones at a dead port, so a test can
 * keep the page offline as long as it likes.
 */
async function trackSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sockets: WebSocket[]; __holdSockets: boolean };
    w.__sockets = [];
    w.__holdSockets = false;
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(w.__holdSockets ? "ws://127.0.0.1:9/" : url, protocols);
        w.__sockets.push(this);
      }
    };
  });
}

/** Wait until the page has an open bridge socket. */
async function waitConnected(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const s = (window as unknown as { __sockets: WebSocket[] }).__sockets.at(-1);
    return !!s && s.readyState === WebSocket.OPEN && s.url.includes("/api/page");
  });
}

async function putNotebook(name: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`${API}/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", body: bytes as BodyInit });
  if (!res.ok) throw new Error(`put ${name}: ${res.status}`);
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`;
}

/** Open a fresh one-page server notebook with the commands loaded. */
async function openNotebook(page: Page, prefix: string): Promise<string> {
  const name = unique(prefix);
  await putNotebook(name, await createBlankPdf(1));
  await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
  await page.waitForFunction((n) => window.__pdfink.source.name === n && window.__pdfink.commands.some((c) => c.label === "Buttons"), name);
  return name;
}

/** Right-click page `idx` at page point (x, y) to open the pen menu. */
async function openMenuAt(page: Page, idx: number, x: number, y: number): Promise<void> {
  const [cx, cy] = await toClient(page, idx, x, y);
  await page.mouse.click(cx, cy, { button: "right" });
  await expect(page.locator("#ctx-menu")).toBeVisible();
}

async function runMenu(page: Page, label: string): Promise<void> {
  await page.locator("#ctx-menu button", { hasText: label }).click();
}

test.describe("page bridge", () => {
  test("a command reads the selection and shows a toast", async ({ page }) => {
    await openNotebook(page, "sel");
    await penStroke(page, 0, line(100, 100, 200, 100));
    await penStroke(page, 0, line(100, 140, 200, 140));
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 90, y: 90, w: 120, h: 60 }));
    expect((await state(page)).selection?.strokes).toHaveLength(2);
    await openMenuAt(page, 0, 300, 400);
    await runMenu(page, "Describe selection");
    await expect(page.locator("#status")).toContainText("2 strokes", { timeout: 10_000 });
    await expect(page.locator("#status")).toContainText("png ");
  });

  test("a command asks a question through the in-page dialog", async ({ page }) => {
    await openNotebook(page, "ask");
    await openMenuAt(page, 0, 300, 400);
    await runMenu(page, "Ask my name");
    await expect(page.locator("#dialog")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#dialog .dialog-input")).toHaveValue("Ada");
    await page.fill("#dialog .dialog-input", "Danny");
    await page.keyboard.press("Enter");
    await expect(page.locator("#status")).toContainText("hello Danny", { timeout: 10_000 });
  });

  test("a command draws through the bridge, undoable", async ({ page }) => {
    await openNotebook(page, "draw");
    const before = await state(page);
    await openMenuAt(page, 0, 300, 400);
    await runMenu(page, "Draw via bridge");
    await expect(page.locator("#status")).toHaveText("Draw via bridge: drew", { timeout: 10_000 });
    const after = await state(page);
    expect(after.pages[0].strokes).toHaveLength(before.pages[0].strokes.length + 1);
    expect(after.undo).toBe(before.undo + 1);
    const s = after.pages[0].strokes.at(-1)!;
    expect(s.color).toBe("#ff0000");
    expect(s.bounds.x).toBeCloseTo(260, -1);
    expect(s.bounds.y).toBeCloseTo(400, -1);
    await page.click("#btn-undo");
    expect((await state(page)).pages[0].strokes).toHaveLength(before.pages[0].strokes.length);
  });

  test("a detached command shows a chip, its buttons work, dismiss removes everything", async ({ page }) => {
    await openNotebook(page, "chip");
    await openMenuAt(page, 0, 300, 400);
    await runMenu(page, "Buttons");
    await expect(page.locator("#runs .run")).toHaveText(/Buttons/, { timeout: 10_000 });
    await expect(page.locator("#status")).toHaveText("Buttons attached");
    await expect(page.locator("#cmd-buttons button", { hasText: "Finish" })).toBeVisible({ timeout: 10_000 });
    await openMenuAt(page, 0, 300, 400);
    await expect(page.locator("#ctx-menu button", { hasText: "Say hello" })).toBeVisible();
    await runMenu(page, "Say hello");
    await expect(page.locator("#status")).toHaveText("hello pressed", { timeout: 10_000 });

    await page.click("#runs .run .dismiss");
    await expect(page.locator("#runs .run")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator("#cmd-buttons button")).toHaveCount(0);
    await openMenuAt(page, 0, 300, 400);
    await expect(page.locator("#ctx-menu button", { hasText: "Say hello" })).toHaveCount(0);
    expect((await state(page)).buttons).toEqual([]);
  });

  test("a detached command that finishes by itself clears its chip", async ({ page }) => {
    await openNotebook(page, "finish");
    await openMenuAt(page, 0, 300, 400);
    await runMenu(page, "Buttons");
    await expect(page.locator("#runs .run")).toHaveCount(1, { timeout: 10_000 });
    await page.locator("#cmd-buttons button", { hasText: "Finish" }).click({ timeout: 10_000 });
    await expect(page.locator("#runs .run")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator("#cmd-buttons button")).toHaveCount(0);
  });

  test("a browser refresh keeps the session id", async ({ page }) => {
    await openNotebook(page, "session");
    const before = await page.evaluate(() => sessionStorage.getItem("pdfink.session"));
    expect(before).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(await page.evaluate(() => window.__pdfink.session)).toBe(before);
    await page.reload();
    await page.waitForFunction(() => window.__pdfink?.session !== null && window.__pdfink?.session !== undefined);
    expect(await page.evaluate(() => sessionStorage.getItem("pdfink.session"))).toBe(before);
    expect(await page.evaluate(() => window.__pdfink.session)).toBe(before);
  });

  test("a refresh keeps a detached run: its chip comes back", async ({ page }) => {
    await openNotebook(page, "refresh");
    await openMenuAt(page, 0, 300, 400);
    await runMenu(page, "Buttons");
    const chip = page.locator("#runs .run");
    await expect(chip).toHaveCount(1, { timeout: 10_000 });
    // Its calls are answered: from here it only waits for button events.
    await expect(page.locator("#cmd-buttons button", { hasText: "Finish" })).toBeVisible({ timeout: 10_000 });
    const run = await chip.getAttribute("data-run");
    await page.reload();
    await expect(page.locator(`#runs .run[data-run="${run}"]`)).toHaveText(/Buttons/, { timeout: 10_000 });
    await page.click("#runs .run .dismiss");
    await expect(page.locator("#runs .run")).toHaveCount(0, { timeout: 10_000 });
  });

  test("a run that ends while the page is offline loses its chip on reconnect", async ({ page }) => {
    await trackSockets(page);
    await openNotebook(page, "offline");
    await waitConnected(page);
    await openMenuAt(page, 0, 300, 400);
    await runMenu(page, "Buttons");
    const chip = page.locator("#runs .run");
    await expect(chip).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator("#cmd-buttons button", { hasText: "Finish" })).toBeVisible({ timeout: 10_000 });
    const session = await page.evaluate(() => window.__pdfink.session);

    // Take the page offline, then end the run behind its back.
    await page.evaluate(() => {
      const w = window as unknown as { __sockets: WebSocket[]; __holdSockets: boolean };
      w.__holdSockets = true;
      w.__sockets.at(-1)!.close();
    });
    const alive = () => spawnSync("pgrep", ["-f", "bridge-tool.cjs buttons"]).status === 0;
    expect(alive()).toBe(true);
    spawnSync("pkill", ["-f", "bridge-tool.cjs buttons"]);
    await expect.poll(alive, { timeout: 10_000 }).toBe(false);
    await expect(chip).toHaveCount(1); // the page has not heard yet

    await page.evaluate(() => ((window as unknown as { __holdSockets: boolean }).__holdSockets = false));
    await expect(chip).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator("#cmd-buttons button")).toHaveCount(0);
    expect(await page.evaluate(() => window.__pdfink.session)).toBe(session);
  });

  test("a duplicated tab gets its own session and both tabs keep working", async ({ page, context }) => {
    const name = await openNotebook(page, "dup");
    const session = await page.evaluate(() => window.__pdfink.session);
    const second = await context.newPage();
    await second.addInitScript((id) => sessionStorage.setItem("pdfink.session", id), session!);
    await openApp(second, `?nofs=1&open=${encodeURIComponent(name)}`);
    await second.waitForFunction(() => window.__pdfink.commands.some((c) => c.label === "Draw via bridge"));
    // The newer tab keeps the id; the older one moves to a fresh one.
    await expect.poll(() => page.evaluate(() => window.__pdfink.session), { timeout: 10_000 }).not.toBe(session);
    expect(await second.evaluate(() => window.__pdfink.session)).toBe(session);
    expect(await page.evaluate(() => sessionStorage.getItem("pdfink.session"))).toBe(await page.evaluate(() => window.__pdfink.session));
    for (const p of [page, second, page]) {
      await openMenuAt(p, 0, 300, 400);
      await runMenu(p, "Draw via bridge");
      await expect(p.locator("#status")).toHaveText("Draw via bridge: drew", { timeout: 10_000 });
      await p.evaluate(() => window.__pdfink.setStatus("idle"));
    }
    await second.close();
  });
});
