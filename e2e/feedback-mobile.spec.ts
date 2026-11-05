import { test, expect } from "@playwright/test";

test.use({ storageState: "e2e/.auth/resident.json" });

/**
 * On a phone the sidebar is a sheet that closes as the report form opens.
 * The form once lived inside it and vanished with it; this keeps it open.
 */
test("a household opens and sends a report from the phone menu", async ({ page }) => {
  await page.goto("/my-requests");
  await page.getByTestId("button-sidebar-toggle").click();
  await page.getByTestId("button-report-problem").click();

  // Wait for the menu sheet to finish closing, then the form must still be open.
  await expect(page.locator('[data-mobile="true"]')).toHaveCount(0);
  const dialog = page.getByTestId("dialog-feedback");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("button-feedback-feature").click();
  await dialog.getByTestId("input-feedback-message").fill(`A calendar of upcoming visits ${Date.now()}`);
  await dialog.getByTestId("button-feedback-send").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Thanks, we got it", { exact: true })).toBeVisible();
});
