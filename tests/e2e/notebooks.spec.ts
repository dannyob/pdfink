import { test } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import { expect, fakeClipboard, inkAnnots, inkPathCount, line, notebookFixture, openApp, penStroke, state, toClient, waitReady } from "./helpers";

const API = "http://127.0.0.1:5176";
const DIR = "test-results/notebooks";

async function putNotebook(name: string, bytes: Uint8Array, ifMtime: string | null = null): Promise<number> {
  const headers: Record<string, string> = {};
  if (ifMtime) headers["X-If-Mtime"] = ifMtime;
  const res = await fetch(`${API}/api/notebooks/${encodeURIComponent(name)}`, { method: "PUT", headers, body: bytes as BodyInit });
  if (!res.ok) throw new Error(`put ${name}: ${res.status}`);
  return ((await res.json()) as { mtime: number }).mtime;
}

async function readNotebook(name: string): Promise<PDFDocument> {
  return PDFDocument.load(fs.readFileSync(`${DIR}/${name}`), { updateMetadata: false });
}

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.pdf`;
}

test.describe("notebooks folder", () => {
  test("lists notebooks, opens one from the menu, saves ink back to it", async ({ page }) => {
    const name = unique("list");
    await putNotebook(name, await createBlankPdf(2));
    await fakeClipboard(page);
    await page.goto("/");
    await expect(page.locator("#notebook-select option")).toContainText([name]);
    await page.selectOption("#notebook-select", name);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    await waitReady(page);
    expect((await state(page)).pages).toHaveLength(2);

    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 1, line(100, 100, 300, 100));
    await expect(page.locator("#status")).toContainText("unsaved");
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    await expect(page.locator("#status")).toContainText("saved");

    const doc = await readNotebook(name);
    expect(doc.getPageCount()).toBe(2);
    expect(inkPathCount(inkAnnots(doc, 0)[0])).toBe(1);
    expect(inkPathCount(inkAnnots(doc, 1)[0])).toBe(1);
    expect(await page.evaluate(() => (document.getElementById("notebook-select") as HTMLSelectElement).value)).toBe(name);
  });

  test("?open= loads a notebook and the ink round-trips through the server", async ({ page }) => {
    const name = unique("open");
    const fixture = await notebookFixture();
    fs.copyFileSync(fixture, `${DIR}/${name}`);
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    expect((await state(page)).pages[0].strokes).toHaveLength(5);
    await penStroke(page, 0, line(120, 90, 120, 110), { buttons: 32 }); // erase one imported stroke
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    expect(inkPathCount(inkAnnots(await readNotebook(name), 0)[0])).toBe(4);
  });

  test("autosaves after a quiet period", async ({ page }) => {
    const name = unique("auto");
    await putNotebook(name, await createBlankPdf(1));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    await page.evaluate(() => (window.__pdfink.autosaveDelay = 300));
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.waitForFunction(() => !window.__pdfink.dirty && window.__pdfink.lastSaved !== null, null, { timeout: 10_000 });
    expect(inkAnnots(await readNotebook(name), 0)).toHaveLength(1);
  });

  test("New creates a notebook in the folder with the given name", async ({ page }) => {
    await fakeClipboard(page);
    await page.goto("/");
    const name = unique("new");
    await page.evaluate((n) => (window.__pdfink.promptFn = async () => n.replace(/\.pdf$/, "")), name);
    await page.click("#btn-new");
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    await waitReady(page);
    expect(fs.existsSync(`${DIR}/${name}`)).toBe(true);
    expect((await readNotebook(name)).getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    await expect(page.locator("#notebook-select option")).toContainText([name]);
  });

  test("refuses to overwrite a notebook that changed on disk unless confirmed", async ({ page }) => {
    const name = unique("conflict");
    await putNotebook(name, await createBlankPdf(1));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    await penStroke(page, 0, line(100, 100, 300, 100));

    // Something else (a file-sync client, say) rewrites the file with three pages.
    await new Promise((r) => setTimeout(r, 20));
    await putNotebook(name, await createBlankPdf(3));

    await page.evaluate(() => (window.__pdfink.confirmFn = async () => false));
    await page.click("#btn-save");
    await expect(page.locator("#status")).toContainText("changed on disk");
    expect((await readNotebook(name)).getPageCount()).toBe(3); // untouched
    expect((await state(page)).dirty).toBe(true);

    await page.evaluate(() => (window.__pdfink.confirmFn = async () => true));
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    const doc = await readNotebook(name);
    expect(doc.getPageCount()).toBe(1);
    expect(inkAnnots(doc, 0)).toHaveLength(1);
  });

  test("Import stores a local PDF in the folder; declining the name keeps it tab-only", async ({ page }) => {
    const fixture = await notebookFixture();
    await openApp(page);
    const name = unique("import");
    await page.evaluate((n) => (window.__pdfink.promptFn = async () => n), name);
    await page.setInputFiles("#file-input", fixture);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, name);
    expect(inkPathCount(inkAnnots(await readNotebook(name), 0)[0])).toBe(5);
    expect(await page.evaluate(() => (document.getElementById("notebook-select") as HTMLSelectElement).value)).toBe(name);

    await page.evaluate(() => (window.__pdfink.promptFn = async () => null));
    await page.setInputFiles("#file-input", fixture);
    await expect(page.locator("#status")).toContainText("not saved to notebooks");
    expect((await state(page)).source.kind).toBe("local");
  });

  test("Save on a tab-only document asks for a notebook name", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    const name = unique("saveas");
    await page.evaluate((n) => (window.__pdfink.promptFn = async () => n), name);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => window.__pdfink.source.kind === "server" && !window.__pdfink.dirty);
    expect(inkAnnots(await readNotebook(name), 0)).toHaveLength(1);
  });

  test("switching notebooks saves the current one first", async ({ page }) => {
    const a = unique("swa");
    const b = unique("swb");
    await putNotebook(a, await createBlankPdf(1));
    await putNotebook(b, await exportPdf(await createBlankPdf(1), [{ width: 612, height: 792, images: [], strokes: [], links: [] }]));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(a)}`);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.selectOption("#notebook-select", b);
    await page.waitForFunction((n) => window.__pdfink.source.kind === "server" && window.__pdfink.source.name === n, b);
    expect(inkAnnots(await readNotebook(a), 0)).toHaveLength(1);
  });
});

test.describe("pages added in the browser", () => {
  test("a page added to a server notebook survives save and reopen, with its ink", async ({ page }) => {
    const name = unique("grow");
    await putNotebook(name, await createBlankPdf(1));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    expect((await state(page)).pages).toHaveLength(1);

    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 2 && window.__pdfink.views.length === 2);
    await penStroke(page, 1, line(100, 100, 300, 100));
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    await expect(page.locator("#status")).toContainText("saved");

    let doc = await readNotebook(name);
    expect(doc.getPageCount()).toBe(2);
    expect(inkPathCount(inkAnnots(doc, 1)[0])).toBe(1);

    // A later save without further page changes rebuilds from the server's copy and keeps both pages.
    await penStroke(page, 0, line(100, 200, 300, 200));
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    doc = await readNotebook(name);
    expect(doc.getPageCount()).toBe(2);
    expect(inkPathCount(inkAnnots(doc, 0)[0])).toBe(1);
    expect(inkPathCount(inkAnnots(doc, 1)[0])).toBe(1);

    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    const s = await state(page);
    expect(s.pages).toHaveLength(2);
    expect(s.pages[1].strokes).toHaveLength(1);
  });
});

test.describe("pen-menu commands", () => {
  test("commands from the file appear in the menu and run with the pen's point, after saving", async ({ page }) => {
    const name = unique("cmd");
    await putNotebook(name, await createBlankPdf(2));
    fs.writeFileSync(`${DIR}/two-pages.pdf`, await createBlankPdf(2));
    fs.rmSync(`${DIR}/where.txt`, { force: true });
    fs.rmSync(`${DIR}/snapshot.pdf`, { force: true });
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    await page.waitForFunction(() => window.__pdfink.commands.some((c) => c.label === "Replace with two pages"));

    // Draw, then open the menu with a right-click on page 2 at page point (100, 100), unsaved.
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.evaluate(() => window.__pdfink.views[1].el.scrollIntoView({ block: "start" }));
    const [cx, cy] = await toClient(page, 1, 100, 100);
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(page.locator("#ctx-menu button", { hasText: "Where am I" })).toBeVisible();
    await page.locator("#ctx-menu button", { hasText: "Where am I" }).click();
    await expect(page.locator("#status")).toContainText("Where am I done");
    const [whereName, whereP, whereX, whereY] = fs.readFileSync(`${DIR}/where.txt`, "utf8").split(" ");
    expect(whereName).toBe(name);
    expect(whereP).toBe("2");
    expect(Number(whereX)).toBeCloseTo(100, 0); // the click lands on whole pixels
    expect(Number(whereY)).toBeCloseTo(692, 0);

    // Snapshot proves the notebook was saved before the command ran.
    await page.mouse.click(cx, cy, { button: "right" });
    await page.locator("#ctx-menu button", { hasText: "Snapshot the file" }).click();
    await expect(page.locator("#status")).toContainText("Snapshot the file done");
    const snap = await PDFDocument.load(fs.readFileSync(`${DIR}/snapshot.pdf`), { updateMetadata: false });
    expect(inkPathCount(inkAnnots(snap, 0)[0])).toBe(1);
  });

  test("a reload waits for the pen to lift, keeping the stroke in progress", async ({ page }) => {
    const name = unique("lift");
    await putNotebook(name, await createBlankPdf(1));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    const [x0, y0] = await toClient(page, 0, 100, 100);
    const [x1, y1] = await toClient(page, 0, 300, 100);
    await page.evaluate(
      ([ax, ay, n]) => {
        const w = window as unknown as { __reloads: number; __reload: Promise<boolean>; __target: Element };
        w.__reloads = 0;
        window.__pdfink.on("notebook", () => w.__reloads++);
        const target = document.elementFromPoint(ax, ay)!;
        w.__target = target;
        const ev = (type: string, x: number, y: number, down: boolean) =>
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerType: "pen", pointerId: 2, isPrimary: true, pressure: down ? 0.6 : 0, buttons: down ? 1 : 0, button: type === "pointermove" ? -1 : 0 }));
        ev("pointermove", ax, ay, false);
        ev("pointerdown", ax, ay, true);
        // A command's exit asks for a reload while the pen is still down.
        w.__reload = window.__pdfink.reloadNotebook(n);
      },
      [x0, y0, name] as const,
    );
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as unknown as { __reloads: number }).__reloads)).toBe(0);
    await page.evaluate(
      ([ax, ay, bx, by]) => {
        const w = window as unknown as { __target: Element };
        const ev = (type: string, x: number, y: number, down: boolean) =>
          w.__target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerType: "pen", pointerId: 2, isPrimary: true, pressure: down ? 0.6 : 0, buttons: down ? 1 : 0, button: type === "pointermove" ? -1 : 0 }));
        for (let i = 1; i <= 10; i++) ev("pointermove", ax + ((bx - ax) * i) / 10, ay + ((by - ay) * i) / 10, true);
        ev("pointerup", bx, by, false);
      },
      [x0, y0, x1, y1] as const,
    );
    expect(await page.evaluate(() => (window as unknown as { __reload: Promise<boolean> }).__reload)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __reloads: number }).__reloads)).toBe(1);
    // The stroke was saved before the reload and came back with it.
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
  });

  test("a page added while a command touches the file still saves", async ({ page }) => {
    const name = unique("touch");
    await putNotebook(name, await createBlankPdf(1));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    await page.waitForFunction(() => window.__pdfink.commands.some((c) => c.label === "Touch the file"));
    const [cx, cy] = await toClient(page, 0, 200, 300);
    await page.mouse.click(cx, cy, { button: "right" });
    const ran = page.waitForResponse((r) => r.url().includes("/api/commands/") && r.request().method() === "POST", { timeout: 10_000 });
    await page.locator("#ctx-menu button", { hasText: "Touch the file" }).click();
    await expect(page.locator("#status")).toContainText("Running Touch the file");
    // The command is still running (it sleeps first): add a page meanwhile.
    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 2 && window.__pdfink.views.length === 2);
    expect(((await (await ran).json()) as { changed: boolean }).changed).toBe(true);
    // The new page's base has not been sent yet: the save must carry it.
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving, null, { timeout: 10_000 });
    expect((await readNotebook(name)).getPageCount()).toBe(2);
  });

  test("a command with reload reopens the notebook in place, keeping zoom and scroll", async ({ page }) => {
    const name = unique("reload");
    await putNotebook(name, await createBlankPdf(1));
    fs.writeFileSync(`${DIR}/two-pages.pdf`, await createBlankPdf(2));
    await openApp(page, `?nofs=1&open=${encodeURIComponent(name)}`);
    await page.waitForFunction(() => window.__pdfink.commands.some((c) => c.label === "Replace with two pages"));
    await page.click("#btn-zoom-out");
    const scale = (await state(page)).scale;
    await page.evaluate(() => (document.getElementById("pages")!.scrollTop = 120));

    const [cx, cy] = await toClient(page, 0, 200, 300);
    await page.mouse.click(cx, cy, { button: "right" });
    await page.locator("#ctx-menu button", { hasText: "Replace with two pages" }).click();
    await page.waitForFunction(() => window.__pdfink.pages.length === 2);
    const s = await state(page);
    expect(s.scale).toBeCloseTo(scale, 5);
    expect(s.dirty).toBe(false);
    expect(await page.evaluate(() => document.getElementById("pages")!.scrollTop)).toBe(120);
    // The reopened file's mtime is now ours: a further save goes through without a conflict.
    await penStroke(page, 1, line(100, 100, 300, 100));
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty && !window.__pdfink.saving);
    expect((await readNotebook(name)).getPageCount()).toBe(2);
  });
});
