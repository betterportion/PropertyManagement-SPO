import { test, expect } from "@playwright/test";

test.describe("resident finances", () => {
  test("the Finances nav item opens the page", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("link-finances").click();
    await expect(page).toHaveURL(/\/finances$/);
    await expect(page.getByRole("heading", { name: "Finances" })).toBeVisible();
  });

  test("has a Rent and a Deposits tab with a month picker and record controls", async ({ page }) => {
    await page.goto("/finances");
    await expect(page.getByTestId("tab-rent")).toBeVisible();
    await expect(page.getByTestId("tab-deposits")).toBeVisible();
    await expect(page.getByTestId("input-rent-period")).toBeVisible();
    await expect(page.getByTestId("button-record-rent")).toBeVisible();
  });

  test("shows the Deposits tab and its add control", async ({ page }) => {
    await page.goto("/finances");
    await page.getByTestId("tab-deposits").click();
    await expect(page.getByTestId("button-add-deposit")).toBeVisible();
  });
});
