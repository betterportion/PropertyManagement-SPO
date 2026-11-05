import { test, expect } from "@playwright/test";

/**
 * SPO's deep cleaning instructions (JR, 2026-11-05): a household with the
 * hub opens them from Resources and reads them in the portal.
 */
test("a household opens the deep cleaning instructions from Resources", async ({ request, browser }) => {
  // The hub is its own grant; global-setup does not give it.
  const granted = await request.patch("/api/users/e2e-resident/permissions", { data: { canViewResourceHub: true } });
  expect(granted.ok()).toBeTruthy();

  const household = await browser.newContext({ storageState: "e2e/.auth/resident.json" });
  const page = await household.newPage();
  await page.goto("/resources");
  await page.getByTestId("link-hub-deep-clean").click();

  await expect(page).toHaveURL(/\/resources\/deep-clean$/);
  await expect(page.getByRole("heading", { name: "Deep cleaning instructions" })).toBeVisible();
  await expect(page.getByTestId("card-deep-clean-kitchen")).toContainText("Refrigerator");
  await expect(page.getByTestId("card-deep-clean-exterior")).toContainText("Complete any necessary yard work.");

  await page.getByTestId("link-deep-clean-back").click();
  await expect(page).toHaveURL(/\/resources$/);
  await household.close();
});
