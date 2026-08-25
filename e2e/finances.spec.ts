import { test, expect } from "@playwright/test";

test.describe("resident finances", () => {
  test("the Finances nav item opens the page with the rent month picker and record control", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("link-finances").click();
    await expect(page).toHaveURL(/\/finances$/);
    await expect(page.getByRole("heading", { name: "Finances" })).toBeVisible();
    await expect(page.getByTestId("tab-rent")).toBeVisible();
    await expect(page.getByTestId("input-rent-period")).toBeVisible();
    await expect(page.getByTestId("button-record-rent")).toBeVisible();
  });

  test("can switch to the Deposits tab and reach its add control", async ({ page }) => {
    await page.goto("/finances");
    await page.getByTestId("tab-deposits").click();
    await expect(page.getByTestId("button-add-deposit")).toBeVisible();
  });
});
