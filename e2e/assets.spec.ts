import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

test.describe("assets — list and gallery views", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/assets");
    await expect(page.getByRole("heading", { name: "Asset Tracking" })).toBeVisible();
  });

  test("defaults to the list view and can switch to the gallery", async ({ page }) => {
    // The fixed/movable tabs are present, and list is the default; the gallery
    // grid is not shown yet.
    await expect(page.getByTestId("tab-fixed-assets")).toBeVisible();
    await expect(page.getByTestId("tab-movable-assets")).toBeVisible();
    await expect(page.getByTestId("button-view-gallery")).toBeVisible();
    await expect(page.locator('[data-testid^="tile-asset-"]').first()).toHaveCount(0);

    await page.getByTestId("button-view-gallery").click();
    // Gallery tiles appear (seeded data has assets), and the tabs remain.
    await expect(page.locator('[data-testid^="tile-asset-"]').first()).toBeVisible();
    await expect(page.getByTestId("tab-fixed-assets")).toBeVisible();
  });

  test("the chosen view persists across a reload", async ({ page }) => {
    await page.getByTestId("button-view-gallery").click();
    await expect(page.locator('[data-testid^="tile-asset-"]').first()).toBeVisible();

    await page.reload();
    // Still in gallery after reload (localStorage-backed).
    await expect(page.locator('[data-testid^="tile-asset-"]').first()).toBeVisible();
  });

  test("clicking a gallery tile opens the photo dialog", async ({ page }) => {
    test.skip(!fixtures.assetWithPhotoId, "no seeded asset with a photo");
    await page.getByTestId("button-view-gallery").click();
    await page.getByTestId(`tile-asset-${fixtures.assetWithPhotoId}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/photo/i).first()).toBeVisible();
  });
});
