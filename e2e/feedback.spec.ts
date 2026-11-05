import { test, expect } from "@playwright/test";

/**
 * Bug and feature reports, end to end (JR, 2026-11-04): a household sends one
 * from the sidebar, and an admin finds it in Settings, Activity. The route
 * tests pin who may read them and what the email says; email is off here.
 */
test.describe("bug and feature reports", () => {
  test("a household reports a problem from the sidebar and an admin reads it", async ({ page, browser }) => {
    const note = `The submit button spins forever ${Date.now()}`;

    const household = await browser.newContext({ storageState: "e2e/.auth/resident.json" });
    const resident = await household.newPage();
    await resident.goto("/my-requests");
    await resident.getByTestId("button-report-problem").click();

    const dialog = resident.getByTestId("dialog-feedback");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("button-feedback-send").click();
    await expect(dialog.getByTestId("text-feedback-error")).toContainText("Tell us");

    await dialog.getByTestId("input-feedback-message").fill(note);
    await dialog.getByTestId("button-feedback-send").click();
    await expect(dialog).toBeHidden();
    await household.close();

    await page.goto("/settings#feedback");
    const card = page.getByTestId("card-feedback-reports");
    await expect(card).toContainText(note);
    const row = card.locator("li", { hasText: note });
    await expect(row).toContainText("Household");
    await expect(row).toContainText("Page: /my-requests");
  });
});
