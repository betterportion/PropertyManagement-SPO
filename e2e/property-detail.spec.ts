import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

test.describe("property detail — everything about one house", () => {
  test("a property name in the list opens the house page", async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();

    const firstName = page.locator('[data-testid^="text-property-name-"]').first();
    const name = (await firstName.textContent())?.trim() ?? "";
    expect(name.length).toBeGreaterThan(0);

    await firstName.click();
    await expect(page).toHaveURL(/\/properties\/[^/]+$/);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  });

  test("shows the three tabs and lands on the roster", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto(`/properties/${fixtures.propertyId}`);

    await expect(page.getByTestId("tab-residents")).toBeVisible();
    await expect(page.getByTestId("tab-maintenance")).toBeVisible();
    await expect(page.getByTestId("tab-assets")).toBeVisible();
    await expect(page.getByTestId("table-property-residents")).toBeVisible();
  });

  test("each tab shows its own table", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto(`/properties/${fixtures.propertyId}`);

    await page.getByTestId("tab-maintenance").click();
    await expect(page.getByTestId("table-property-requests")).toBeVisible();
    await expect(page.getByTestId("table-property-schedules")).toBeVisible();

    await page.getByTestId("tab-assets").click();
    await expect(page.getByTestId("table-property-assets")).toBeVisible();
  });

  test("the back link returns to the property list", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto(`/properties/${fixtures.propertyId}`);
    await page.getByTestId("link-back-to-properties").click();
    await expect(page).toHaveURL(/\/properties$/);
  });

  // A property id that is not in the user's list is the same shape as one in a
  // region they cannot reach, so this covers both: an explanation, not a crash.
  test("an unknown property explains itself instead of breaking", async ({ page }) => {
    await page.goto("/properties/not-a-real-property-id");
    await expect(page.getByText("That property is not here")).toBeVisible();
    await expect(page.getByTestId("state-error")).toHaveCount(0);
  });
});
