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
});
