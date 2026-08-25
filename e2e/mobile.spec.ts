import { test, expect } from "@playwright/test";

/**
 * Runs only under the mobile-chrome project (Pixel 5, 393px wide). At that
 * width the sidebar collapses behind a toggle, so navigation works
 * differently than on desktop.
 */
test.describe("mobile layout", () => {
  test("the dashboard renders without a horizontal scrollbar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // The page body must never be wider than the viewport -- a horizontal
    // scrollbar on a phone is the classic broken-responsive symptom.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("navigation is behind the toggle and works once opened", async ({ page }) => {
    await page.goto("/");
    // Collapsed: the nav links are not on screen until the sidebar is opened.
    await expect(page.getByTestId("link-assets")).toBeHidden();

    await page.getByTestId("button-sidebar-toggle").click();
    const assetsLink = page.getByTestId("link-assets");
    await expect(assetsLink).toBeVisible();

    await assetsLink.click();
    await expect(page).toHaveURL(/\/assets$/);
    await expect(page.getByRole("heading", { name: "Asset Tracking" })).toBeVisible();
  });

  test("the assets gallery is usable on a phone", async ({ page }) => {
    await page.goto("/assets");
    await page.getByTestId("button-view-gallery").click();
    await expect(page.locator('[data-testid^="tile-asset-"]').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
