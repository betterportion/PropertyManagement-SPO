import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

test.describe("safety & upkeep", () => {
  test("the Safety nav item opens the page", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("link-safety").click();
    await expect(page).toHaveURL(/\/safety$/);
    await expect(page.getByRole("heading", { name: "Safety & Upkeep" })).toBeVisible();
  });

  test("applying the standard schedule populates safety checks with a compliance count", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto("/safety");
    await expect(page.getByRole("heading", { name: "Safety & Upkeep" })).toBeVisible();

    // Apply the standard set to a known house. Idempotent: the server skips
    // tasks that already exist, so re-running the suite does not pile up.
    await page.getByTestId("button-apply-template").click();
    await page.getByTestId(`apply-template-${fixtures.propertyId}`).click();

    // The safety tab is the default; its cards and the per-house compliance
    // count appear once the house has safety schedules.
    await expect(page.locator('[data-testid^="card-schedule-"]').first()).toBeVisible();
    await expect(page.getByTestId(`compliance-${fixtures.propertyId}`)).toBeVisible();
  });

  test("has both a safety and a preventive tab", async ({ page }) => {
    await page.goto("/safety");
    await expect(page.getByTestId("tab-safety")).toBeVisible();
    await expect(page.getByTestId("tab-preventive")).toBeVisible();
  });
});
