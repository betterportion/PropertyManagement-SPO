import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

test.describe("properties — region and chapter filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();
  });

  test("filtering by chapter narrows the property list to that chapter", async ({ page }) => {
    // The filter controls are always present.
    await expect(page.getByTestId("select-filter-region")).toBeVisible();
    await expect(page.getByTestId("select-filter-chapter")).toBeVisible();

    test.skip(!fixtures.propertyChapter, "no seeded property with a chapter");
    const cards = page.locator('[data-testid^="card-property-"]');
    const total = await cards.count();
    expect(total).toBeGreaterThan(0);

    await page.getByTestId("select-filter-chapter").click();
    // exact match: some chapters are substrings of others ("University of
    // St. Thomas" vs "... - Houston"), and the filter now lists all of them.
    await page.getByRole("option", { name: fixtures.propertyChapter, exact: true }).click();

    // There are no more cards than before, and every remaining card actually
    // shows the chosen chapter — so the filter really narrowed the list.
    const filtered = await cards.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThanOrEqual(total);
    await expect(cards.filter({ hasText: fixtures.propertyChapter })).toHaveCount(filtered);
  });

  test("the chapter field offers only the chosen region's chapters", async ({ page }) => {
    await page.getByTestId("button-add-property").click();

    await page.getByTestId("select-property-region").click();
    await page.getByRole("option", { name: "Southwest", exact: true }).click();

    await page.getByTestId("select-property-chapter").click();
    // A Southwest chapter is offered; a Northwest one is not.
    await expect(page.getByRole("option", { name: "Texas State University" })).toBeVisible();
    await expect(page.getByRole("option", { name: "University of Minnesota" })).toHaveCount(0);
  });
});
