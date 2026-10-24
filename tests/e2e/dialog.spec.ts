import { test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { expect, openApp } from "./helpers";

/** Call a method on the app's `dialog` singleton (the module Vite serves to the page). */
function callDialog(page: Page, method: "ask" | "confirm" | "choose", ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    async ([m, a]) => {
      const url = "/src/dialog.ts";
      const mod = await import(/* @vite-ignore */ url);
      return mod.dialog[m](...a);
    },
    [method, args] as const,
  );
}

test.describe("in-page dialogs", () => {
  test("ask shows an in-page dialog and resolves with the typed text", async ({ page }) => {
    await openApp(page);
    const p = page.evaluate(() => window.__pdfink.promptFn("Your name?", "Ada"));
    await expect(page.locator("#dialog")).toBeVisible();
    await expect(page.locator("#dialog .dialog-message")).toHaveText("Your name?");
    await expect(page.locator("#dialog .dialog-input")).toHaveValue("Ada");
    await expect(page.locator("#dialog .dialog-input")).toBeFocused();
    await page.fill("#dialog .dialog-input", "Danny");
    await page.keyboard.press("Enter");
    expect(await p).toBe("Danny");
    await expect(page.locator("#dialog")).toBeHidden();
  });

  test("Escape cancels an ask even with text typed", async ({ page }) => {
    await openApp(page);
    const p = page.evaluate(() => window.__pdfink.promptFn("Name?", ""));
    await page.fill("#dialog .dialog-input", "half typed");
    await page.keyboard.press("Escape");
    expect(await p).toBeNull();
    await expect(page.locator("#dialog")).toBeHidden();
  });

  test("confirm resolves false on Escape and choose returns the picked option", async ({ page }) => {
    await openApp(page);
    const c = page.evaluate(() => window.__pdfink.confirmFn("Really?"));
    await expect(page.locator("#dialog .dialog-message")).toHaveText("Really?");
    await expect(page.locator("#dialog .dialog-input")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await c).toBe(false);
    await expect(page.locator("#dialog")).toBeHidden();

    const ok = page.evaluate(() => window.__pdfink.confirmFn("Sure?"));
    await page.keyboard.press("Enter");
    expect(await ok).toBe(true);

    const ch = callDialog(page, "choose", "Pick one", ["red", "green", "blue"]);
    await expect(page.locator("#dialog .dialog-option")).toHaveText(["red", "green", "blue"]);
    const box = await page.locator("#dialog .dialog-option").first().boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.click("#dialog .dialog-option >> text=green");
    expect(await ch).toBe("green");
    await expect(page.locator("#dialog")).toBeHidden();
  });

  test("clicking outside the box does not dismiss it; choose with no options can be cancelled", async ({ page }) => {
    await openApp(page);
    const ch = callDialog(page, "choose", "Nothing here", []);
    await expect(page.locator("#dialog .dialog-option")).toHaveCount(0);
    await page.mouse.click(5, 600);
    await expect(page.locator("#dialog")).toBeVisible();
    await page.click("#dialog .dialog-cancel");
    expect(await ch).toBeNull();
    await expect(page.locator("#dialog")).toBeHidden();
  });

  test("a second dialog waits for the first", async ({ page }) => {
    await openApp(page);
    const results = page.evaluate(() => {
      const a = window.__pdfink.promptFn("First?", "one");
      const b = window.__pdfink.promptFn("Second?", "two");
      const c = window.__pdfink.confirmFn("Third?");
      return Promise.all([a, b, c]);
    });
    await expect(page.locator("#dialog .dialog-box")).toHaveCount(1);
    await expect(page.locator("#dialog .dialog-message")).toHaveText("First?");
    await page.keyboard.press("Escape");
    await expect(page.locator("#dialog .dialog-message")).toHaveText("Second?");
    await expect(page.locator("#dialog .dialog-input")).toHaveValue("two");
    await page.click("#dialog .dialog-ok");
    await expect(page.locator("#dialog .dialog-message")).toHaveText("Third?");
    await page.click("#dialog .dialog-ok");
    expect(await results).toEqual([null, "two", true]);
    await expect(page.locator("#dialog")).toBeHidden();
  });
});
