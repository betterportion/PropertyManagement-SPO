import { test, expect } from "@playwright/test";

test.describe("authentication", () => {
  test("an admin session lands on the dashboard, not the sign-in page", async ({ page }) => {
    await page.goto("/");
    // The dashboard header is admin-only; the landing page shows "Sign In to Continue".
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByTestId("button-login")).toHaveCount(0);
  });

  test("a signed-out visitor sees the landing page and a sign-in button", async ({ browser }) => {
    // A fresh context with no stored cookie is the signed-out case.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("button-login")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Property Management Portal" })).toBeVisible();
    await context.close();
  });
});
