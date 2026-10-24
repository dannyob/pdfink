import { test } from "@playwright/test";
import { expect, openApp, openLocalApp, state } from "./helpers";

test.describe("Add page button under the last page", () => {
  test("sits centred under the last page and adds a page when tapped", async ({ page }) => {
    await openApp(page);
    const btn = page.locator("#add-page-below");
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText("+ Add page");
    const b = (await btn.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    const last = (await page.locator("#pages .page").last().boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(last.y + last.height);
    expect(b.x + b.width / 2).toBeCloseTo(last.x + last.width / 2, 0);

    await btn.click();
    await expect.poll(async () => (await state(page)).pages.length).toBe(2);
    await expect(page.locator("#pages .page")).toHaveCount(2);
    // Still last, now under page 2.
    const b2 = (await btn.boundingBox())!;
    const last2 = (await page.locator("#pages .page").nth(1).boundingBox())!;
    expect(b2.y).toBeGreaterThanOrEqual(last2.y + last2.height);
    expect(await page.evaluate(() => document.querySelector("#pages")!.lastElementChild!.id)).toBe("add-page-below");
  });

  test("is there in local mode too", async ({ page }) => {
    await openLocalApp(page);
    await expect(page.locator("#add-page-below")).toBeVisible();
  });

  test("adding from the button keeps the view where it was", async ({ page }) => {
    await openApp(page);
    const btn = page.locator("#add-page-below");
    await btn.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => {
      const c = document.getElementById("pages")!;
      const first = c.querySelector(".page")!.getBoundingClientRect();
      return { scrollTop: c.scrollTop, firstTop: first.top, firstBottom: first.bottom };
    });
    expect(before.scrollTop).toBeGreaterThan(0);
    await btn.click();
    await expect.poll(async () => (await state(page)).pages.length).toBe(2);
    const after = await page.evaluate(() => {
      const c = document.getElementById("pages")!;
      const first = c.querySelector(".page")!.getBoundingClientRect();
      return { scrollTop: c.scrollTop, firstTop: first.top, firstBottom: first.bottom };
    });
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.firstTop - before.firstTop)).toBeLessThanOrEqual(1);
    // The new page starts where the button used to be, below the old last page.
    const second = (await page.locator("#pages .page").nth(1).boundingBox())!;
    expect(second.y).toBeGreaterThanOrEqual(before.firstBottom);
  });

  test("Add page from the toolbar still brings the new page into view", async ({ page }) => {
    await openApp(page);
    await page.click("#btn-addpage");
    await expect.poll(async () => (await state(page)).pages.length).toBe(2);
    await expect(page.locator("#pages .page").nth(1)).toBeInViewport();
  });
});
