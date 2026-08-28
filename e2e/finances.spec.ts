import { test, expect } from "@playwright/test";

test.describe("resident finances", () => {
  test("the Finances nav item lands on Outstanding, and Rent has the month picker and record control", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("link-finances").click();
    await expect(page).toHaveURL(/\/finances$/);
    await expect(page.getByRole("heading", { name: "Finances" })).toBeVisible();
    // The chase list is the landing tab: the page opens on "who still owes us?".
    await expect(page.getByTestId("tab-outstanding")).toHaveAttribute("data-state", "active");
    // The bookkeeping controls live on the Rent tab.
    await page.getByTestId("tab-rent").click();
    await expect(page.getByTestId("input-rent-period")).toBeVisible();
    await expect(page.getByTestId("button-record-rent")).toBeVisible();
  });

  test("can switch to the Deposits tab and reach its add control", async ({ page }) => {
    await page.goto("/finances");
    await page.getByTestId("tab-deposits").click();
    await expect(page.getByTestId("button-add-deposit")).toBeVisible();
  });
});
