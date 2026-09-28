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

  test("a signed-out visitor can read the privacy notice without signing in", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    // Reached from the landing page's link, and directly.
    await page.goto("/");
    await page.getByTestId("link-privacy").click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "SPO Admin Portal Privacy Notice" })).toBeVisible();
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "SPO Admin Portal Privacy Notice" })).toBeVisible();
    await expect(page.getByTestId("text-privacy-notice")).toContainText("hr@spo.org");
    await expect(page.getByTestId("button-login")).toHaveCount(0);
    await context.close();
  });

  test("a deactivated account can still read the privacy notice", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/inactive.json" });
    const page = await context.newPage();
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "SPO Admin Portal Privacy Notice" })).toBeVisible();
    await expect(page.getByTestId("text-account-inactive")).toHaveCount(0);
    await context.close();
  });

  test("a deactivated account is told so, instead of seeing the staff screens", async ({ browser }) => {
    const context = await browser.newContext({ storageState: "e2e/.auth/inactive.json" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Your account has been deactivated" })).toBeVisible();
    await expect(page.getByTestId("button-inactive-logout")).toBeVisible();
    // No navigation, and no dashboard claiming there is nothing due.
    await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);
    await expect(page.getByTestId("button-sidebar-toggle")).toHaveCount(0);
    // A deep link lands on the same page, not on a staff screen's empty state.
    await page.goto("/maintenance");
    await expect(page.getByRole("heading", { name: "Your account has been deactivated" })).toBeVisible();
    await context.close();
  });
});
