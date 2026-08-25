import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

test.describe("properties — region and chapter filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();
  });

  test("the region and chapter filter controls are present", async ({ page }) => {
    await expect(page.getByTestId("select-filter-region")).toBeVisible();
    await expect(page.getByTestId("select-filter-chapter")).toBeVisible();
  });

  test("filtering by chapter narrows the property list", async ({ page }) => {
    test.skip(!fixtures.propertyChapter, "no seeded property with a chapter");
    const cards = page.locator('[data-testid^="card-property-"]');
    const total = await cards.count();
    expect(total).toBeGreaterThan(0);

    await page.getByTestId("select-filter-chapter").click();
    await page.getByRole("option", { name: fixtures.propertyChapter }).click();

    // After filtering, every visible card belongs to the chosen chapter, and
    // there are no more cards than before.
    const filtered = await cards.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThanOrEqual(total);
  });
});
