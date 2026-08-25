import { test, expect } from "@playwright/test";

test.describe("admin dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  const tiles = [
    { testid: "link-stat-properties", path: "/properties", heading: "Properties" },
    { testid: "link-stat-active-requests", path: "/maintenance", heading: "Maintenance" },
    { testid: "link-stat-open-invoices", path: "/contacts", heading: /Contacts|Invoices/ },
    { testid: "link-stat-tracked-assets", path: "/assets", heading: "Asset Tracking" },
  ];

  for (const tile of tiles) {
    test(`the ${tile.testid} tile navigates to ${tile.path}`, async ({ page }) => {
      await page.getByTestId(tile.testid).click();
      await expect(page).toHaveURL(new RegExp(`${tile.path}$`));
      await expect(page.getByRole("heading", { name: tile.heading }).first()).toBeVisible();
    });
  }

  test("the sidebar logo returns to the dashboard from another page", async ({ page }) => {
    await page.getByTestId("link-stat-properties").click();
    await expect(page).toHaveURL(/\/properties$/);
    await page.getByTestId("link-sidebar-home").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("stat tiles show numeric counts, not placeholders", async ({ page }) => {
    // The seeded database has 6 properties; the tile shows a real number.
    await expect(page.getByTestId("stat-properties")).toHaveText(/^\d+$/);
  });
});
