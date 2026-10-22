import { test } from "@playwright/test";
import { PDFArray, PDFName, PDFNumber } from "pdf-lib";
import { expect, exportedPdf, inkAnnots, inkPathCount, inkPixel, line, openApp, penStroke, state, toClient } from "./helpers";

test.describe("pen drawing", () => {
  test("new document shows one Letter page", async ({ page }) => {
    await openApp(page);
    const s = await state(page);
    expect(s.pages).toHaveLength(1);
    expect(s.pages[0]).toMatchObject({ width: 612, height: 792 });
    await expect(page.locator(".page")).toHaveCount(1);
  });

  test("pen strokes are recorded and drawn", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 120));
    await penStroke(page, 0, line(100, 200, 300, 220));
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    expect(s.pages[0].strokes[0].n).toBe(21);
    expect(s.pages[0].strokes[0].bounds.x).toBeCloseTo(99.5, 0);
    expect(s.dirty).toBe(true);
    const px = await inkPixel(page, 0, 200, 110);
    expect(px[3]).toBeGreaterThan(0); // something drawn there
    const blank = await inkPixel(page, 0, 200, 400);
    expect(blank[3]).toBe(0);
  });

  test("touch does not draw; mouse follows the tool", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 120), { pointerType: "touch" });
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
    await penStroke(page, 0, line(100, 100, 300, 120), { pointerType: "mouse" });
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
  });

  test("pen colour and width come from the toolbar", async ({ page }) => {
    await openApp(page);
    await page.locator("#pen-color").fill("#ff0000");
    await page.locator("#pen-width").selectOption("2");
    await penStroke(page, 0, line(100, 100, 300, 120));
    const s = await state(page);
    expect(s.pages[0].strokes[0]).toMatchObject({ color: "#ff0000", width: 2 });
  });

  test("pen eraser end removes strokes it crosses", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 200, 300, 200));
    await penStroke(page, 0, line(100, 300, 300, 300));
    // eraser end (buttons=32) vertically through the middle stroke only
    await penStroke(page, 0, line(200, 170, 200, 230), { buttons: 32 });
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    const ys = s.pages[0].strokes.map((x) => x.bounds.y);
    expect(ys[0]).toBeCloseTo(99.5, 3);
    expect(ys[1]).toBeCloseTo(299.5, 3);
    expect((await inkPixel(page, 0, 200, 200))[3]).toBe(0);
    expect((await inkPixel(page, 0, 200, 100))[3]).toBeGreaterThan(0);
  });

  test("barrel button while hovering erases; one sweep is one undo step", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 140, 300, 140));
    await penStroke(page, 0, line(100, 300, 300, 300));
    await page.evaluate(() => {
      const v = window.__pdfink.views[0];
      const pts = [] as [number, number][];
      for (let y = 80; y <= 160; y += 5) {
        const c = v.toClient(200, y);
        pts.push([c.clientX, c.clientY]);
      }
      window.__stylusSim.barrelHover(pts);
      // button released, pen still hovering
      window.__stylusSim.hover(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    });
    let s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(1);
    expect(s.undo).toBe(4); // 3 strokes + 1 sweep
    await page.keyboard.press("Control+z");
    s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(3);
  });

  test("a finger scrolls by hand when the pen had switched panning off", async ({ page }) => {
    await openApp(page);
    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 2);
    await penStroke(page, 0, line(100, 100, 300, 100)); // pen seen → pen-active
    await expect(page.locator("#pages")).toHaveClass(/pen-active/);
    const before = await page.evaluate(() => document.getElementById("pages")!.scrollTop);
    await page.evaluate(() => {
      const el = document.getElementById("pages")!;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const pts: [number, number][] = [];
      for (let y = r.top + 600; y >= r.top + 200; y -= 50) pts.push([x, y]);
      window.__stylusSim.stroke(pts, { pointerType: "touch" });
    });
    const after = await page.evaluate(() => document.getElementById("pages")!.scrollTop);
    expect(after - before).toBeCloseTo(400, 0);
    await expect(page.locator("#pages")).not.toHaveClass(/pen-active/);
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
  });

  test("eraser tool with the pen tip", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.click("#tool-eraser");
    await penStroke(page, 0, line(200, 80, 200, 120));
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });

  test("undo and redo", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 200, 300, 200));
    await page.keyboard.press("Control+z");
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
    await page.click("#btn-redo");
    expect((await state(page)).pages[0].strokes).toHaveLength(2);
    await page.click("#btn-undo");
    await page.click("#btn-undo");
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });

  test("strokes export as /Ink annotations in PDF space", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 200, 300, 200));
    const doc = await exportedPdf(page);
    expect(doc.getPageCount()).toBe(1);
    const annots = inkAnnots(doc, 0);
    expect(annots).toHaveLength(1);
    expect(inkPathCount(annots[0])).toBe(2);
    const rect = annots[0].lookup(PDFName.of("Rect"), PDFArray);
    const nums = [0, 1, 2, 3].map((i) => rect.lookup(i, PDFNumber).asNumber());
    // y is flipped: display y 100..200 → pdf y 592..692 (± half width)
    expect(nums[0]).toBeCloseTo(99.5, 1);
    expect(nums[1]).toBeCloseTo(591.5, 1);
    expect(nums[2]).toBeCloseTo(300.5, 1);
    expect(nums[3]).toBeCloseTo(692.5, 1);
  });
});

test.describe("barrel-button heuristic", () => {
  // Observed on a Daylight DC-1: pens that never set the spec's barrel bit.

  test("no-eraser EMR pen: full pressure with the contact bit erases", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 200, 300, 200));
    await penStroke(page, 0, line(100, 300, 300, 300));
    await penStroke(page, 0, line(200, 170, 200, 230), { pressure: 1 });
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    expect(s.pages[0].strokes.map((x) => Math.round(x.bounds.y / 10) * 10)).toEqual([100, 300]);
    expect(s.undo).toBe(4);
  });

  test("King Write: contact bit with zero pressure while hovering erases", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await penStroke(page, 0, line(100, 140, 300, 140));
    await penStroke(page, 0, line(100, 300, 300, 300));
    await page.evaluate(() => {
      const v = window.__pdfink.views[0];
      const pts = [] as [number, number][];
      for (let y = 80; y <= 160; y += 5) {
        const c = v.toClient(200, y);
        pts.push([c.clientX, c.clientY]);
      }
      window.__stylusSim.barrelHover(pts, { buttons: 1 });
      window.__stylusSim.hover(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    });
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(1);
    expect(s.undo).toBe(4); // one undo step for the sweep
  });

  test("pressing the barrel mid-stroke erases, releasing it draws again", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 200, 300, 200));
    // Down the page through the existing stroke: light, then pinned to 1, then light.
    const path = line(200, 100, 200, 300, 40).map(([x, y]) => [x, y, y >= 170 && y <= 230 ? 1 : 0.6] as [number, number, number]);
    await penStroke(page, 0, path);
    const s = await state(page);
    const ys = s.pages[0].strokes.map((x) => Math.round(x.bounds.y / 5) * 5).sort((a, b) => a - b);
    expect(ys).toEqual([100, 235]); // two drawn segments; the crossed stroke is gone
    expect(s.undo).toBe(4); // original, first segment, erase, second segment
    expect((await inkPixel(page, 0, 150, 200))[3]).toBe(0);
  });

  test("a first sample with zero pressure does not erase under the tip", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    // Starts on the existing stroke with pressure 0, then writes normally.
    const path = line(200, 100, 300, 180, 20).map(([x, y], i) => [x, y, i === 0 ? 0 : 0.6] as [number, number, number]);
    await penStroke(page, 0, path);
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(2);
    expect(s.pages[0].strokes[1].n).toBe(20);
  });

  test("switched off, full pressure no longer erases, and the choice is remembered", async ({ page }) => {
    await openApp(page);
    await page.locator("#barrel-erase").uncheck();
    expect((await state(page)).barrelHeuristic).toBe(false);
    await penStroke(page, 0, line(100, 200, 300, 200));
    await penStroke(page, 0, line(200, 170, 200, 230), { pressure: 1 });
    expect((await state(page)).pages[0].strokes).toHaveLength(1); // untouched; the press opened the menu
    expect((await state(page)).menuOpen).toBe(true);
    await page.keyboard.press("Escape");
    // The choice survives a reload.
    await page.reload();
    await page.waitForFunction(() => window.__pdfink && window.__pdfink.views.length > 0);
    await expect(page.locator("#barrel-erase")).not.toBeChecked();
  });
});

test.describe("erase feedback", () => {
  test("the Eraser button lights up during a pen erase and Pen comes back after", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    const [cx, cy] = await toClient(page, 0, 200, 150);
    const fire = (type: string, o: Record<string, unknown>) =>
      page.evaluate(
        ([t, x, y, init]) => {
          const el = document.elementFromPoint(x, y)!;
          el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 9, isPrimary: true, clientX: x, clientY: y, ...init }));
        },
        [type, cx, cy, o] as const,
      );
    await fire("pointerdown", { button: 5, buttons: 32, pressure: 0.5 });
    await expect(page.locator("#tool-eraser")).toHaveClass(/active/);
    await expect(page.locator("#tool-pen")).not.toHaveClass(/active/);
    await fire("pointerup", { button: 5, buttons: 0, pressure: 0 });
    await expect(page.locator("#tool-pen")).toHaveClass(/active/);
    await expect(page.locator("#tool-eraser")).not.toHaveClass(/active/);
    expect((await state(page)).tool).toBe("pen");
  });

  test("hover erase lights the Eraser button until the button is released", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.evaluate(() => {
      const c = window.__pdfink.views[0].toClient(200, 150);
      window.__stylusSim.barrelHover([[c.clientX, c.clientY]]);
    });
    await expect(page.locator("#tool-eraser")).toHaveClass(/active/);
    await page.evaluate(() => {
      const c = window.__pdfink.views[0].toClient(200, 150);
      window.__stylusSim.hover(c.clientX, c.clientY);
    });
    await expect(page.locator("#tool-pen")).toHaveClass(/active/);
  });

  test("the segment written before a barrel press is spared only briefly", async ({ page }) => {
    await openApp(page);
    // One gesture, driven by hand so we can wait mid-way: write left to right,
    // then press the barrel (pressure 1) and sweep back over what was just written.
    const result = await page.evaluate(async () => {
      const v = window.__pdfink.views[0];
      const el = v.ink;
      const ev = (type: string, x: number, y: number, pressure: number, buttons = 1) => {
        const c = v.toClient(x, y);
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 4, isPrimary: true, clientX: c.clientX, clientY: c.clientY, pressure, buttons, button: type === "pointermove" ? -1 : 0 }));
      };
      ev("pointerdown", 100, 200, 0.6);
      for (let x = 110; x <= 300; x += 10) ev("pointermove", x, 200, 0.6);
      // barrel pressed: sweep back immediately over the fresh segment
      for (let x = 300; x >= 200; x -= 10) ev("pointermove", x, 200, 1);
      const afterImmediate = window.__pdfink.pages[0].strokes.length;
      await new Promise((r) => setTimeout(r, 400));
      for (let x = 200; x >= 100; x -= 10) ev("pointermove", x, 200, 1);
      const afterWait = window.__pdfink.pages[0].strokes.length;
      ev("pointerup", 100, 200, 0, 0);
      return { afterImmediate, afterWait };
    });
    expect(result.afterImmediate).toBe(1); // spared while fresh
    expect(result.afterWait).toBe(0); // erasable after the grace period
  });
});

test.describe("finger drawing", () => {
  test("off by default where a fine pointer exists; on, a finger draws", async ({ page }) => {
    await openApp(page);
    expect((await state(page)).fingerDraws).toBe(false);
    await page.locator("#finger-draws").check();
    await expect(page.locator("#pages")).toHaveClass(/finger-draws/);
    await penStroke(page, 0, line(100, 100, 300, 120), { pointerType: "touch" });
    const s = await state(page);
    expect(s.pages[0].strokes).toHaveLength(1);
    expect(s.pages[0].strokes[0].n).toBe(21);
  });

  test("a second finger cancels the stroke and pans", async ({ page }) => {
    await openApp(page);
    await page.click("#btn-addpage");
    await page.waitForFunction(() => window.__pdfink.pages.length === 2);
    await page.locator("#finger-draws").check();
    const before = await page.evaluate(() => document.getElementById("pages")!.scrollTop);
    const moved = await page.evaluate(() => {
      const v = window.__pdfink.views[0];
      const el = v.ink;
      const ev = (type: string, id: number, x: number, y: number, down: boolean) =>
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "touch", pointerId: id, isPrimary: id === 11, clientX: x, clientY: y, pressure: down ? 0.5 : 0, buttons: down ? 1 : 0, button: type === "pointermove" ? -1 : 0, width: 20, height: 20 }));
      const a = v.toClient(100, 100);
      ev("pointerdown", 11, a.clientX, a.clientY, true);
      ev("pointermove", 11, a.clientX + 40, a.clientY, true);
      // second finger lands and drags upward by 150px
      const b = v.toClient(300, 400);
      ev("pointerdown", 12, b.clientX, b.clientY, true);
      ev("pointermove", 12, b.clientX, b.clientY - 150, true);
      ev("pointerup", 12, b.clientX, b.clientY - 150, false);
      ev("pointerup", 11, a.clientX + 40, a.clientY, false);
      return document.getElementById("pages")!.scrollTop;
    });
    expect(moved - before).toBe(150);
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });

  test("a pen appearing hands scrolling back to fingers", async ({ page }) => {
    await openApp(page);
    await page.locator("#finger-draws").check();
    await page.evaluate(() => {
      const c = window.__pdfink.views[0].toClient(200, 200);
      window.__stylusSim.hover(c.clientX, c.clientY);
    });
    // User ticked it themselves, so it stays.
    expect((await state(page)).fingerDraws).toBe(true);
    await page.evaluate(() => {
      window.__pdfink.fingerDrawsPinned = false;
      const c = window.__pdfink.views[0].toClient(220, 200);
      window.__stylusSim.hover(c.clientX, c.clientY);
    });
    expect((await state(page)).fingerDraws).toBe(false);
    await expect(page.locator("#finger-draws")).not.toBeChecked();
    await penStroke(page, 0, line(100, 100, 300, 120), { pointerType: "touch" });
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });
});

test.describe("barrel-button menu", () => {
  const penEvent = (page: import("@playwright/test").Page, type: string, x: number, y: number, init: Record<string, unknown>) =>
    page.evaluate(
      ([t, px, py, o]) => {
        const c = window.__pdfink.views[0].toClient(px, py);
        const el = document.elementFromPoint(c.clientX, c.clientY)!;
        el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerType: "pen", pointerId: 21, isPrimary: true, clientX: c.clientX, clientY: c.clientY, ...o }));
      },
      [type, x, y, init] as const,
    );

  test("with barrel erase off, a barrel press opens the menu instead of erasing", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 200, 300, 200));
    await page.locator("#barrel-erase").uncheck();
    // No-brand pen: barrel while touching pins pressure to 1.
    await penEvent(page, "pointerdown", 200, 200, { button: 0, buttons: 1, pressure: 1 });
    await expect(page.locator("#ctx-menu")).toBeVisible();
    expect((await state(page)).pages[0].strokes).toHaveLength(1); // nothing erased
    await expect(page.locator("#ctx-menu button.checked")).toHaveText("Pen");
    await penEvent(page, "pointerup", 200, 200, { button: 0, buttons: 0, pressure: 0 });
    await page.locator("#ctx-menu button", { hasText: "Eraser" }).click();
    await expect(page.locator("#ctx-menu")).toBeHidden();
    expect((await state(page)).tool).toBe("eraser");
  });

  test("King Write: barrel held while hovering opens the menu once; Escape closes it", async ({ page }) => {
    await openApp(page);
    await page.locator("#barrel-erase").uncheck();
    await penEvent(page, "pointermove", 200, 200, { buttons: 1, pressure: 0, button: -1 });
    await penEvent(page, "pointermove", 210, 200, { buttons: 1, pressure: 0, button: -1 });
    await expect(page.locator("#ctx-menu")).toBeVisible();
    expect((await state(page)).menuOpen).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#ctx-menu")).toBeHidden();
    // Still held: does not pop straight back up.
    await penEvent(page, "pointermove", 220, 200, { buttons: 1, pressure: 0, button: -1 });
    await expect(page.locator("#ctx-menu")).toBeHidden();
    // Released and pressed again: it does.
    await penEvent(page, "pointermove", 220, 200, { buttons: 0, pressure: 0, button: -1 });
    await penEvent(page, "pointermove", 230, 200, { buttons: 1, pressure: 0, button: -1 });
    await expect(page.locator("#ctx-menu")).toBeVisible();
  });

  test("mouse right-click opens the menu; a pen stroke elsewhere closes it", async ({ page }) => {
    await openApp(page);
    const [cx, cy] = await toClient(page, 0, 300, 300);
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await expect(page.locator("#ctx-menu button", { hasText: "Copy" })).toBeDisabled();
    await penStroke(page, 0, line(100, 100, 200, 100));
    await expect(page.locator("#ctx-menu")).toBeHidden();
    expect((await state(page)).pages[0].strokes).toHaveLength(1);
  });

  test("with barrel erase on, a barrel press still erases and no menu appears", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 200, 300, 200));
    await penStroke(page, 0, line(200, 170, 200, 230), { pressure: 1 });
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
    await expect(page.locator("#ctx-menu")).toBeHidden();
  });
});
