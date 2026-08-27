import { test, expect } from "@playwright/test";

test.describe("residents roster", () => {
  test("the Residents nav item opens the page with its tabs and add control", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("link-residents").click();
    await expect(page).toHaveURL(/\/residents$/);
    await expect(page.getByRole("heading", { name: "Residents" })).toBeVisible();
    await expect(page.getByTestId("tab-current")).toBeVisible();
    await expect(page.getByTestId("tab-former")).toBeVisible();
    await expect(page.getByTestId("button-add-resident")).toBeVisible();
  });

  test("shows seeded residents grouped by house with a headcount", async ({ page }) => {
    await page.goto("/residents");
    await expect(page.getByRole("heading", { name: "Residents" })).toBeVisible();
    // The seed adds current residents; wait for the roster query to resolve
    // (auto-retrying) rather than checking count() before the fetch returns.
    await expect(page.locator('[data-testid^="card-resident-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="headcount-"]').first()).toBeVisible();
  });

  test("exports the former residents as a CSV", async ({ page }) => {
    await page.goto("/residents");
    await expect(page.getByRole("heading", { name: "Residents" })).toBeVisible();
    // The seed leaves several former residents, so the export button is enabled.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("button-export-former").click(),
    ]);
    expect(download.suggestedFilename()).toBe("former-residents.csv");
  });
});
