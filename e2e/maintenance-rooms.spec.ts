import { test, expect } from "@playwright/test";

// Joseph's notes (2026-11-04): staff pick "Where in the house" from the house's
// rooms too, with "Somewhere else" for anywhere the walkthrough has no room for.
test("staff pick the room from the chosen house's rooms, or somewhere else", async ({ page }) => {
  await page.goto("/maintenance");
  await page.getByTestId("button-create-maintenance-request").click();

  await page.getByTestId("select-location").click();
  await page.getByRole("option").first().click();

  await page.getByTestId("select-staff-request-location").click();
  const options = page.getByRole("option");
  await expect(options.last()).toHaveText("Somewhere else");
  expect(await options.count()).toBeGreaterThan(1);

  await options.last().click();
  await expect(page.getByTestId("select-staff-request-location-other")).toBeVisible();

  // A different house starts over: its rooms, no leftover text box.
  await page.getByTestId("select-location").click();
  await page.getByRole("option").nth(1).click();
  await expect(page.getByTestId("select-staff-request-location-other")).toHaveCount(0);
});
