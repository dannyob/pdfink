import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { createBlankPdf, exportPdf } from "../../src/pdf/export";
import type { PageModel } from "../../src/model";

export const FIXTURES = path.resolve("test-results/fixtures");

/** A two-page Letter PDF with a few strokes on page 1, in the notebook format. */
export async function notebookFixture(): Promise<string> {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const file = path.join(FIXTURES, "notebook.pdf");
  const base = await createBlankPdf(2);
  const pages: PageModel[] = [
    { width: 612, height: 792, strokes: [], images: [], links: [], texts: [] },
    { width: 612, height: 792, strokes: [], images: [], links: [], texts: [] },
  ];
  for (let i = 0; i < 5; i++) {
    const pts = [];
    for (let k = 0; k <= 30; k++) pts.push({ x: 60 + k * 6, y: 100 + i * 40 + Math.sin(k / 2) * 8, p: 0.5 });
    pages[0].strokes.push({ id: `f${i}`, color: "#000000", width: 1, opacity: 1, points: pts });
  }
  fs.writeFileSync(file, await exportPdf(base, pages));
  return file;
}

export interface State {
  fileName: string;
  storage: "server" | "local";
  source: { kind: "server"; name: string; mtime: number } | { kind: "local"; name: string };
  saving: boolean;
  lastSaved: number | null;
  tool: string;
  barrelHeuristic: boolean;
  fingerDraws: boolean;
  menuOpen: boolean;
  commands: string[];
  scale: number;
  dirty: boolean;
  currentPage: number;
  bookmarks: { title: string; page: number | null; level: number }[];
  pages: { width: number; height: number; strokes: { id: string; n: number; color: string; width: number; bounds: { x: number; y: number; w: number; h: number } }[]; images: { id: string; x: number; y: number; w: number; h: number }[]; links: { id: string; x: number; y: number; w: number; h: number; url: string; label: string | undefined }[]; texts: { id: string; x: number; y: number; w: number; h: number; text: string; sig?: string; note?: number }[] }[];
  selection: { page: number; rect: { x: number; y: number; w: number; h: number } | null; strokes: string[]; images: string[]; links: string[]; texts: string[] } | null;
  clip: { strokes: number; images: number; links: number; texts: number; width: number; height: number } | null;
  undo: number;
  redo: number;
  buttons: string[];
  progress: string | null;
}

export async function state(page: Page): Promise<State> {
  return page.evaluate(() => window.__pdfink.getState());
}

/**
 * Replace navigator.clipboard with an in-memory fake so tests never touch the
 * real OS clipboard and behave the same on every machine.
 */
export async function fakeClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let items: { type: string; blob: Blob }[] = [];
    const fake = {
      async write(list: { types: string[]; getType(t: string): Promise<Blob> }[]) {
        items = [];
        for (const it of list) for (const t of it.types) items.push({ type: t, blob: await it.getType(t) });
      },
      async read() {
        return items.map((i) => ({ types: [i.type], getType: async () => i.blob }));
      },
      async writeText(text: string) {
        items = [{ type: "text/plain", blob: new Blob([text], { type: "text/plain" }) }];
      },
      async readText() {
        const t = items.find((i) => i.type === "text/plain");
        return t ? t.blob.text() : "";
      },
    };
    Object.defineProperty(navigator, "clipboard", { value: fake, configurable: true });
    (window as unknown as { __fakeClipboard: unknown }).__fakeClipboard = fake;
  });
}

/** Fire a paste event the way the browser would for Ctrl+V (headless key presses don't). */
export async function pasteKey(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    const items = await navigator.clipboard.read();
    for (const it of items) {
      for (const t of it.types) {
        if (t.startsWith("image/")) dt.items.add(new File([await it.getType(t)], "clip", { type: t }));
      }
    }
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
}

/** Open the app with a fresh tab-only document. Server mode unless `query` says otherwise. */
export async function openApp(page: Page, query = "?nofs=1&new=1&storage=server"): Promise<void> {
  await fakeClipboard(page);
  await page.goto(`/${query}`);
  await waitReady(page);
}

/** Open the app in browser-only (local storage) mode with a fresh document. */
export async function openLocalApp(page: Page, query = "?nofs=1&new=1&storage=local"): Promise<void> {
  await openApp(page, query);
}

/** Directory with real sample notebooks for opt-in tests (PDFINK_SAMPLES=/path npm run test:e2e). */
export const SAMPLES = process.env.PDFINK_SAMPLES ?? "";

/** Wait until the storage mode is known, the document is loaded and every page has a view. */
export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.body.dataset.storage !== undefined &&
      window.__pdfink &&
      window.__pdfink.pages.length > 0 &&
      window.__pdfink.views.length === window.__pdfink.pages.length,
  );
  await page.waitForTimeout(200);
}

/** Convert page-space (points) to client coords for page `idx`. */
export async function toClient(page: Page, idx: number, x: number, y: number): Promise<[number, number]> {
  const r = await page.evaluate(
    ([i, px, py]) => {
      const c = window.__pdfink.views[i].toClient(px, py);
      return [c.clientX, c.clientY];
    },
    [idx, x, y] as const,
  );
  return r as [number, number];
}

/** Simulate a pen stroke through page-space points on page `idx`. */
export async function penStroke(page: Page, idx: number, pts: ([number, number] | [number, number, number])[], opts: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(
    ([i, points, o]) => {
      const v = window.__pdfink.views[i];
      // Off-screen points can't be hit-tested by elementFromPoint; bring the page in.
      const first = v.toClient(points[0][0], points[0][1]);
      if (first.clientY < 0 || first.clientY > window.innerHeight || first.clientX < 0 || first.clientX > window.innerWidth) {
        v.el.scrollIntoView({ block: "start" });
      }
      const client = points.map(([x, y, p]) => {
        const c = v.toClient(x, y);
        return (p === undefined ? [c.clientX, c.clientY] : [c.clientX, c.clientY, p]) as [number, number] | [number, number, number];
      });
      window.__stylusSim.stroke(client, o);
    },
    [idx, pts, opts] as const,
  );
}

export function line(x0: number, y0: number, x1: number, y1: number, n = 20): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) out.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  return out;
}

export async function exportedPdf(page: Page): Promise<PDFDocument> {
  const b64 = await page.evaluate(async () => {
    const bytes = await window.__pdfink.exportBytes();
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return PDFDocument.load(Buffer.from(b64, "base64"));
}

export function inkAnnots(doc: PDFDocument, pageIndex: number): PDFDict[] {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const d = annots.lookup(i);
    if (d instanceof PDFDict && d.get(PDFName.of("Subtype")) === PDFName.of("Ink")) out.push(d);
  }
  return out;
}

export function inkPathCount(a: PDFDict): number {
  return a.lookup(PDFName.of("InkList"), PDFArray).size();
}

/** Sample the ink canvas of page `idx` at page-space (x, y); returns [r,g,b,a]. */
export async function inkPixel(page: Page, idx: number, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([i, px, py]) => {
      const v = window.__pdfink.views[i];
      const k = v.ink.width / v.ink.clientWidth; // device pixels per CSS pixel actually in use
      const ctx = v.ink.getContext("2d")!;
      const d = ctx.getImageData(Math.round(px * v.scale * k), Math.round(py * v.scale * k), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    [idx, x, y] as const,
  );
}

export { expect };

/**
 * Activate a pen-menu entry by name: an icon tile (by aria-label), a text
 * row, or a command/button inside the "Commands" level (drilling in first).
 */
export async function menuAction(page: Page, label: string): Promise<void> {
  const menu = page.locator("#ctx-menu");
  await expect(menu).toBeVisible();
  const tile = menu.locator(`.tile[aria-label="${label}"]`);
  if ((await tile.count()) > 0) return tile.click();
  const row = menu.locator(".menuitem:not(.submenu)", { hasText: label });
  if ((await row.count()) > 0) return row.first().click();
  await menu.locator(".submenu", { hasText: "Commands" }).click();
  await menu.locator(".menuitem:not(.submenu)", { hasText: label }).first().click();
}

/** Text rows of the current menu level, in order: labels only, no detail (tiles are not included). */
export async function menuLabels(page: Page): Promise<string[]> {
  const texts = await page
    .locator("#ctx-menu .menuitem:not(.submenu)")
    .evaluateAll((els) => els.map((e) => (e.querySelector(".text") ?? e).textContent ?? ""));
  return texts.map((t) => t.trim());
}

/** True when `label` is reachable in the open menu, drilling into Commands if present (leaves the menu at the top level). */
export async function menuHas(page: Page, label: string): Promise<boolean> {
  const menu = page.locator("#ctx-menu");
  if ((await menu.locator(`.tile[aria-label="${label}"]`).count()) > 0) return true;
  if ((await menu.locator(".menuitem:not(.submenu)", { hasText: label }).count()) > 0) return true;
  const sub = menu.locator(".submenu", { hasText: "Commands" });
  if ((await sub.count()) === 0) return false;
  await sub.click();
  const found = (await menu.locator(".menuitem:not(.submenu)", { hasText: label }).count()) > 0;
  await menu.locator(".back").click();
  return found;
}

const BAR_BUTTONS = { file: "#bar-file", bookmarks: "#bar-bookmark", style: "#bar-style", commands: "#bar-commands", more: "#bar-more" } as const;

/**
 * Open one of the bar's menus (unless it is already open) and, given a
 * label, activate that entry: a tile by its label, or a text row or submenu
 * whose label is exactly `label`.
 */
export async function barMenu(page: Page, which: keyof typeof BAR_BUTTONS, label?: string): Promise<void> {
  const menu = page.locator("#ctx-menu");
  const button = page.locator(BAR_BUTTONS[which]);
  if (!(await menu.isVisible()) || (await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(menu).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  if (label === undefined) return;
  const tile = menu.locator(`.tile[aria-label=${JSON.stringify(label)}]`);
  if ((await tile.count()) > 0) return tile.first().click();
  const index = await menu.locator(".menuitem").evaluateAll(
    (els, want) =>
      els.findIndex((e) => {
        const text = e.querySelector(".text");
        if (text) return text.textContent?.trim() === want;
        const copy = e.cloneNode(true) as HTMLElement;
        copy.querySelector(".chev")?.remove();
        return copy.textContent?.trim() === want;
      }),
    label,
  );
  if (index < 0) throw new Error(`No "${label}" in the ${which} menu`);
  await menu.locator(".menuitem").nth(index).click();
}

/** The open menu's level as text: rows and submenus by label, "—" for a separator, "[label]" for a caption. */
export async function menuOutline(page: Page): Promise<string[]> {
  return page.locator("#ctx-menu > *").evaluateAll((els) =>
    els.flatMap((e) => {
      if (e.classList.contains("sep")) return ["—"];
      if (e.classList.contains("lbl")) return [`[${e.textContent?.trim()}]`];
      if (e.classList.contains("row")) return [`(${[...e.querySelectorAll(".tile")].map((t) => t.getAttribute("aria-label")).join(" ")})`];
      if (e.classList.contains("back")) return [];
      const text = e.querySelector(".text");
      if (text) return [text.textContent?.trim() ?? ""];
      const copy = e.cloneNode(true) as HTMLElement;
      copy.querySelector(".chev")?.remove();
      return [copy.textContent?.trim() ?? ""];
    }),
  );
}

/** Whether More's toggle row `label` ("Barrel button erases", "Finger draws") is ticked; leaves the menu closed. */
export async function moreChecked(page: Page, label: string): Promise<boolean> {
  await barMenu(page, "more");
  const row = page.locator("#ctx-menu .menuitem", { hasText: label });
  const on = await row.evaluate((e) => e.classList.contains("checked"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#ctx-menu")).toBeHidden();
  return on;
}

/** Turn More's toggle row `label` on or off (a no-op when it already is). */
export async function setMoreToggle(page: Page, label: string, on: boolean): Promise<void> {
  if ((await moreChecked(page, label)) === on) return;
  await barMenu(page, "more", label);
  await expect(page.locator("#ctx-menu")).toBeHidden();
}
