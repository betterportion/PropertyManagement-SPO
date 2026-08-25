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
    const firstCard = page.locator('[data-testid^="card-resident-"]').first();
    // The demo seed adds current residents; skip cleanly if the DB was not seeded.
    if ((await firstCard.count()) === 0) test.skip(true, "no seeded residents");
    await expect(firstCard).toBeVisible();
    await expect(page.locator('[data-testid^="headcount-"]').first()).toBeVisible();
  });
});
