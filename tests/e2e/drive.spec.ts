import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { expect, inkAnnots, inkPathCount, line, notebookFixture, openLocalApp, penStroke, state, waitReady } from "./helpers";

/**
 * Google Drive with a fake in the page instead of Google: an in-memory set of
 * files with Drive's id/name/version shape. The real sign-in and Picker can't
 * run in a test browser; the REST calls are covered in tests/unit/gdrive.test.ts.
 */
async function fakeDrive(page: Page, files: Record<string, { name: string; bytes: number[] }>): Promise<void> {
  await page.evaluate((files) => {
    const store = new Map(Object.entries(files).map(([id, f]) => [id, { name: f.name, bytes: new Uint8Array(f.bytes), version: 1 }]));
    let next = 1;
    const meta = (id: string) => ({ id, name: store.get(id)!.name, version: String(store.get(id)!.version) });
    const fake = {
      store,
      pickId: Object.keys(files)[0] ?? null,
      async pick() {
        return fake.pickId ? { ...meta(fake.pickId), version: "" } : null;
      },
      async download(id: string) {
        return { file: meta(id), bytes: store.get(id)!.bytes.slice() };
      },
      async version(id: string) {
        return store.has(id) ? String(store.get(id)!.version) : null;
      },
      async update(id: string, bytes: Uint8Array) {
        const f = store.get(id)!;
        f.bytes = bytes.slice();
        f.version += 1;
        return meta(id);
      },
      async create(name: string, bytes: Uint8Array) {
        const id = `new${next++}`;
        store.set(id, { name, bytes: bytes.slice(), version: 1 });
        return meta(id);
      },
    };
    (window as unknown as { __fakeDrive: typeof fake }).__fakeDrive = fake;
    window.__pdfink.drive = fake;
    document.body.dataset.drive = "on";
  }, files);
}

async function driveBytes(page: Page, id: string): Promise<Buffer> {
  const arr = await page.evaluate((id) => [...(window as unknown as { __fakeDrive: { store: Map<string, { bytes: Uint8Array }> } }).__fakeDrive.store.get(id)!.bytes], id);
  return Buffer.from(arr);
}

test.describe("Google Drive (fake)", () => {
  test("Drive buttons stay hidden in a build without Drive settings", async ({ page }) => {
    await openLocalApp(page);
    await expect(page.locator("#btn-drive-open")).toBeHidden();
    await expect(page.locator("#btn-drive-saveas")).toBeHidden();
  });

  test("open from Drive, write, and Save puts the ink back in the same file", async ({ page }) => {
    await openLocalApp(page);
    await fakeDrive(page, { f1: { name: "lecture.pdf", bytes: [...fs.readFileSync(await notebookFixture())] } });
    await page.click("#btn-drive-open");
    await page.waitForFunction(() => window.__pdfink.source.kind === "drive");
    await waitReady(page);
    let s = await state(page);
    expect(s.fileName).toBe("lecture.pdf");
    expect(s.source).toEqual({ kind: "drive", id: "f1", name: "lecture.pdf", version: "1" });
    expect(s.pages[0].strokes).toHaveLength(5);

    await penStroke(page, 1, line(100, 100, 200, 100));
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty);
    s = await state(page);
    expect(s.source).toMatchObject({ kind: "drive", id: "f1", version: "2" });
    await expect(page.locator("#status")).toContainText("saved to Drive");
    const doc = await PDFDocument.load(await driveBytes(page, "f1"), { updateMetadata: false });
    // One /Ink annotation per page, holding every stroke on it.
    expect(inkPathCount(inkAnnots(doc, 0)[0])).toBe(5);
    expect(inkPathCount(inkAnnots(doc, 1)[0])).toBe(1);
  });

  test("asks before overwriting a file changed elsewhere", async ({ page }) => {
    await openLocalApp(page);
    await fakeDrive(page, { f1: { name: "lecture.pdf", bytes: [...fs.readFileSync(await notebookFixture())] } });
    await page.click("#btn-drive-open");
    await page.waitForFunction(() => window.__pdfink.source.kind === "drive");
    await waitReady(page);
    await penStroke(page, 0, line(100, 500, 200, 500));
    // Another device saves meanwhile.
    await page.evaluate(() => {
      (window as unknown as { __fakeDrive: { store: Map<string, { version: number }> } }).__fakeDrive.store.get("f1")!.version += 1;
    });

    await page.evaluate(() => {
      (window as unknown as { asked: string[] }).asked = [];
      window.__pdfink.confirmFn = async (m) => {
        (window as unknown as { asked: string[] }).asked.push(m);
        return false;
      };
    });
    expect(await page.evaluate(() => window.__pdfink.saveToDrive())).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked)).toEqual([expect.stringContaining("changed in Google Drive")]);
    expect((await state(page)).dirty).toBe(true);

    await page.evaluate(() => (window.__pdfink.confirmFn = async () => true));
    expect(await page.evaluate(() => window.__pdfink.saveToDrive())).toBe(true);
    const s = await state(page);
    expect(s.dirty).toBe(false);
    expect(s.source).toMatchObject({ kind: "drive", version: "3" });
  });

  test("Save to Drive puts a new document in Drive, and Save then updates it", async ({ page }) => {
    await openLocalApp(page);
    await fakeDrive(page, {});
    await page.evaluate(() => (window.__pdfink.promptFn = async () => "my notes"));
    await penStroke(page, 0, line(100, 100, 200, 100));
    await page.click("#btn-drive-saveas");
    await page.waitForFunction(() => window.__pdfink.source.kind === "drive");
    let s = await state(page);
    expect(s.source).toEqual({ kind: "drive", id: "new1", name: "my notes.pdf", version: "1" });
    expect(s.fileName).toBe("my notes.pdf");
    expect(s.dirty).toBe(false);

    await penStroke(page, 0, line(100, 200, 200, 200));
    await page.click("#btn-save");
    await page.waitForFunction(() => !window.__pdfink.dirty);
    s = await state(page);
    expect(s.source).toMatchObject({ id: "new1", version: "2" });
    const doc = await PDFDocument.load(await driveBytes(page, "new1"), { updateMetadata: false });
    expect(inkPathCount(inkAnnots(doc, 0)[0])).toBe(2);
  });

  test("a Drive file autosaves after a quiet spell", async ({ page }) => {
    await openLocalApp(page);
    await fakeDrive(page, { f1: { name: "lecture.pdf", bytes: [...fs.readFileSync(await notebookFixture())] } });
    await page.evaluate(() => (window.__pdfink.driveAutosaveDelay = 300));
    await page.click("#btn-drive-open");
    await page.waitForFunction(() => window.__pdfink.source.kind === "drive");
    await waitReady(page);
    await penStroke(page, 0, line(100, 500, 200, 500));
    await page.waitForFunction(() => !window.__pdfink.dirty);
    expect((await state(page)).source).toMatchObject({ version: "2" });
  });
});
