import { test } from "@playwright/test";
import { expect, line, openApp, penStroke, state, toClient } from "./helpers";

/**
 * The context menu component on its own: icon rows, a submenu level that
 * drills down in place, Back, Escape, clamping. Items are built inside the
 * page and record their actions into window.__hits.
 */
declare global {
  interface Window {
    __hits: string[];
  }
}

const ICON = '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>';

async function showMenu(page: import("@playwright/test").Page, x: number, y: number, trigger: number | null = null): Promise<void> {
  await page.evaluate(
    ([x, y, icon, trigger]) => {
      window.__hits = [];
      const hit = (s: string) => () => window.__hits.push(s);
      const tiles = (names: string[], disabled: string[] = []) =>
        names.map((n) => ({ label: n, icon, action: hit(n), disabled: disabled.includes(n), checked: n === "b" }));
      window.__pdfink.menu.show(
        x,
        y,
        [
          { kind: "row", items: tiles(["a", "b", "c"], ["c"]) },
          { separator: true },
          { label: "Plain", action: hit("plain") },
          {
            kind: "submenu",
            label: "More",
            heading: "More things",
            items: Array.from({ length: 10 }, (_, i) => ({ label: `Item ${i + 1}`, action: hit(`item${i + 1}`) })),
          },
        ],
        trigger,
      );
    },
    [x, y, ICON, trigger] as const,
  );
}

test.describe("context menu component", () => {
  test("icon tiles are 44 px with 8 px gaps and act once", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200);
    const tiles = page.locator("#ctx-menu .row .tile");
    await expect(tiles).toHaveCount(3);
    const boxes = await tiles.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(44);
    expect(boxes[1].left - boxes[0].right).toBeCloseTo(8, 0);
    await expect(page.locator("#ctx-menu .tile[aria-label='b']")).toHaveClass(/checked/);
    await expect(page.locator("#ctx-menu .tile[aria-label='b']")).toHaveAttribute("title", "b");
    await page.locator("#ctx-menu .tile[aria-label='b']").click();
    expect(await page.evaluate(() => window.__hits)).toEqual(["b"]);
    await expect(page.locator("#ctx-menu")).toBeHidden();
  });

  test("a disabled tile neither acts nor closes", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200);
    const c = page.locator("#ctx-menu .tile[aria-label='c']");
    await expect(c).toBeDisabled();
    await c.click({ force: true });
    expect(await page.evaluate(() => window.__hits)).toEqual([]);
    await expect(page.locator("#ctx-menu")).toBeVisible();
  });

  test("a submenu drills down in place with a Back row and keeps its position", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200);
    const before = await page.locator("#ctx-menu").boundingBox();
    await page.locator("#ctx-menu .submenu", { hasText: "More" }).click();
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await expect(page.locator("#ctx-menu .back")).toHaveText("‹ Back");
    await expect(page.locator("#ctx-menu .lbl")).toHaveText("More things");
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Item 10" })).toBeVisible();
    expect(await page.evaluate(() => window.__pdfink.menu.depth)).toBe(1);
    const after = await page.locator("#ctx-menu").boundingBox();
    expect(after!.x).toBeCloseTo(before!.x, 0);
    expect(after!.y).toBeCloseTo(before!.y, 0);
    await page.locator("#ctx-menu .back").click();
    expect(await page.evaluate(() => window.__pdfink.menu.depth)).toBe(0);
    await expect(page.locator("#ctx-menu .tile")).toHaveCount(3);
    await expect(page.locator("#ctx-menu")).toBeVisible();
    expect(await page.evaluate(() => window.__hits)).toEqual([]);
  });

  test("choosing an item in a submenu acts and closes", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200);
    await page.locator("#ctx-menu .submenu").click();
    await page.locator("#ctx-menu .menuitem", { hasText: "Item 3" }).click();
    expect(await page.evaluate(() => window.__hits)).toEqual(["item3"]);
    await expect(page.locator("#ctx-menu")).toBeHidden();
  });

  test("Escape steps back then closes", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200);
    await page.locator("#ctx-menu .submenu").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#ctx-menu")).toBeVisible();
    expect(await page.evaluate(() => window.__pdfink.menu.depth)).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("#ctx-menu")).toBeHidden();
  });

  test("a menu that grows near the bottom is re-clamped on screen", async ({ page }) => {
    await openApp(page);
    const { w, h } = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    await showMenu(page, w - 50, h - 50);
    await page.locator("#ctx-menu .submenu").click();
    const box = await page.locator("#ctx-menu").boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(h);
    expect(box!.x + box!.width).toBeLessThanOrEqual(w);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    await expect(page.locator("#ctx-menu .back")).toBeInViewport();
  });

  test("the opening pointer is still ignored after drilling down", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200, 7);
    await page.locator("#ctx-menu .submenu").click();
    await page.evaluate(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, pointerType: "pen", clientX: 5, clientY: 5 }));
    });
    await expect(page.locator("#ctx-menu")).toBeVisible();
    await page.evaluate(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 8, pointerType: "pen", clientX: 5, clientY: 5 }));
    });
    await expect(page.locator("#ctx-menu")).toBeHidden();
  });

  test("a hovered checked tile keeps its fill", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200);
    const tile = page.locator("#ctx-menu .tile[aria-label='b']");
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    await tile.hover();
    const bg = await tile.evaluate((el) => getComputedStyle(el).backgroundColor);
    const expected = await page.evaluate((c) => {
      const d = document.createElement("div");
      d.style.color = c;
      document.body.appendChild(d);
      const v = getComputedStyle(d).color;
      d.remove();
      return v;
    }, accent);
    expect(bg).toBe(expected);
  });

  test("an overflowing level can be scrolled with a finger", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 420 });
    await openApp(page);
    await page.evaluate(() => {
      window.__hits = [];
      window.__pdfink.menu.show(10, 10, [
        { kind: "submenu", label: "Many", items: Array.from({ length: 30 }, (_, i) => ({ label: `Row ${i + 1}`, action: () => window.__hits.push(String(i + 1)) })) },
      ]);
    });
    await page.locator("#ctx-menu .submenu").click();
    const m = page.locator("#ctx-menu");
    expect(await m.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await m.evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y");
    await m.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "Row 30" })).toBeInViewport();
  });

  test("Escape as Back keeps the selection", async ({ page }) => {
    await openApp(page);
    await penStroke(page, 0, line(100, 100, 300, 100));
    await page.evaluate(() => window.__pdfink.selectRect(0, { x: 90, y: 90, w: 220, h: 20 }));
    expect((await state(page)).selection).not.toBeNull();
    const [cx, cy] = await toClient(page, 0, 300, 300);
    await page.mouse.click(cx, cy, { button: "right" });
    await page.locator("#ctx-menu .submenu", { hasText: "Commands" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#ctx-menu")).toBeVisible();
    expect(await page.evaluate(() => window.__pdfink.menu.depth)).toBe(0);
    expect((await state(page)).selection).not.toBeNull();
  });
});

test.describe("menu pieces for the bar", () => {
  test("a labelled row shows each tile's label under its icon", async ({ page }) => {
    await openApp(page);
    await page.evaluate((icon) => {
      window.__pdfink.menu.show(200, 200, [
        { kind: "row", labelled: true, items: [{ label: "Smaller", icon }, { label: "Fit width", icon }, { label: "Larger", icon }] },
      ]);
    }, ICON);
    const tiles = page.locator("#ctx-menu .row .tile.labelled");
    await expect(tiles).toHaveCount(3);
    expect(await tiles.allTextContents()).toEqual(["Smaller", "Fit width", "Larger"]);
    const geo = await tiles.first().evaluate((el) => {
      const svg = el.querySelector("svg")!.getBoundingClientRect();
      const lbl = el.querySelector(".tl")!;
      return { svgBottom: svg.bottom, lblTop: lbl.getBoundingClientRect().top, size: getComputedStyle(lbl).fontSize, h: el.getBoundingClientRect().height };
    });
    expect(geo.lblTop).toBeGreaterThanOrEqual(geo.svgBottom - 0.5);
    expect(geo.size).toBe("11px");
    expect(geo.h).toBeCloseTo(52, 0);
  });

  test("a text row shows its icon, right-aligned detail and indent", async ({ page }) => {
    await openApp(page);
    await page.evaluate((icon) => {
      window.__pdfink.menu.show(100, 100, [
        { label: "Save", icon, detail: "Ctrl+S" },
        { label: "Chapter", indent: 2, detail: "p. 4" },
      ]);
    }, ICON);
    const save = page.locator("#ctx-menu .menuitem", { hasText: "Save" });
    await expect(save.locator(".ico svg")).toHaveCount(1);
    await expect(save.locator(".detail")).toHaveText("Ctrl+S");
    const g = await save.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const d = el.querySelector(".detail")!.getBoundingClientRect();
      const t = el.querySelector(".text")!.getBoundingClientRect();
      const i = el.querySelector(".ico")!.getBoundingClientRect();
      return { right: b.right, pad: parseFloat(getComputedStyle(el).paddingRight), dRight: d.right, dLeft: d.left, tLeft: t.left, tRight: t.right, iRight: i.right };
    });
    expect(g.dRight).toBeCloseTo(g.right - g.pad, 0);
    expect(g.dLeft).toBeGreaterThan(g.tRight);
    expect(g.tLeft).toBeGreaterThanOrEqual(g.iRight);
    const pads = await page.locator("#ctx-menu .menuitem").evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).paddingLeft)));
    expect(pads[1] - pads[0]).toBeCloseTo(36, 0);
  });

  test("the current entry is ticked and marked aria-current", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      window.__pdfink.menu.show(100, 100, [{ label: "One" }, { label: "Two", current: true }]);
    });
    const two = page.locator("#ctx-menu .menuitem", { hasText: "Two" });
    await expect(two).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#ctx-menu .menuitem", { hasText: "One" })).not.toHaveAttribute("aria-current", /.*/);
    expect(await two.evaluate((el) => getComputedStyle(el, "::before").content)).toContain("✓");
  });

  test("showFor anchors under its button, and tapping that button again closes it", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "test-owner";
      b.textContent = "Owner";
      Object.assign(b.style, { position: "fixed", left: "120px", top: "60px", zIndex: "40" });
      document.body.appendChild(b);
      b.addEventListener("click", () => window.__pdfink.menu.showFor(b, [{ label: "Alpha" }, { label: "Beta" }]));
    });
    const btn = page.locator("#test-owner");
    await btn.click();
    const menu = page.locator("#ctx-menu");
    await expect(menu).toBeVisible();
    const bb = (await btn.boundingBox())!;
    const mb = (await menu.boundingBox())!;
    expect(mb.x).toBeCloseTo(bb.x, 0);
    expect(mb.y).toBeCloseTo(bb.y + bb.height + 4, 0);
    expect(await page.evaluate(() => window.__pdfink.menu.owner?.id)).toBe("test-owner");
    await btn.click();
    await expect(menu).toBeHidden();
    await page.waitForTimeout(300);
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => window.__pdfink.menu.owner)).toBeNull();
    // And it opens again on the next tap.
    await btn.click();
    await expect(menu).toBeVisible();
  });

  test("a pen tap that closes the pen menu leaves no ink", async ({ page }) => {
    await openApp(page);
    const [cx, cy] = await toClient(page, 0, 300, 300);
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(page.locator("#ctx-menu")).toBeVisible();
    const before = (await state(page)).pages[0].strokes.length;
    const [tx, ty] = await toClient(page, 0, 150, 500);
    await page.evaluate(([x, y]) => window.__stylusSim.tap(x, y), [tx, ty] as const);
    await expect(page.locator("#ctx-menu")).toBeHidden();
    expect((await state(page)).pages[0].strokes).toHaveLength(before);
  });

  test("a finger tap that closes the pen menu draws nothing, even with finger drawing on", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__pdfink.setFingerDraws(true));
    const [cx, cy] = await toClient(page, 0, 300, 300);
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(page.locator("#ctx-menu")).toBeVisible();
    const [tx, ty] = await toClient(page, 0, 150, 500);
    await page.evaluate(([x, y]) => window.__stylusSim.stroke([[x, y], [x + 30, y + 5]], { pointerType: "touch" }), [tx, ty] as const);
    await expect(page.locator("#ctx-menu")).toBeHidden();
    expect((await state(page)).pages[0].strokes).toHaveLength(0);
  });

  test("tiles: white with a grey edge at rest, no fill or edge when disabled, solid accent when checked", async ({ page }) => {
    await openApp(page);
    await showMenu(page, 200, 200);
    const style = (sel: string) =>
      page.locator(sel).evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderTopColor, width: s.borderTopWidth, color: s.color, opacity: s.opacity };
      });
    const rest = await style("#ctx-menu .tile[aria-label='a']");
    expect(rest).toMatchObject({ bg: "rgb(255, 255, 255)", border: "rgb(138, 144, 153)", width: "1px" });
    const off = await style("#ctx-menu .tile[aria-label='c']");
    expect(off).toMatchObject({ bg: "rgba(0, 0, 0, 0)", border: "rgba(0, 0, 0, 0)", opacity: "0.35" });
    const on = await style("#ctx-menu .tile[aria-label='b']");
    expect(on).toMatchObject({ bg: "rgb(47, 74, 122)", color: "rgb(255, 255, 255)" });
  });
});
