import { test, expect } from "@playwright/test";

// This whole file acts as the resident, not the admin.
test.use({ storageState: "e2e/.auth/resident.json" });

test.describe("resident experience", () => {
  test("lands on the resident dashboard with a submit-request action", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
    await expect(page.getByTestId("button-submit-maintenance").first()).toBeVisible();
  });

  test("sees only resident navigation, not the admin sections", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("link-dashboard")).toBeVisible();
    await expect(page.getByTestId("link-my-requests")).toBeVisible();
    // Admin-only sections must not appear in the resident's sidebar.
    await expect(page.getByTestId("link-assets")).toHaveCount(0);
    await expect(page.getByTestId("link-properties")).toHaveCount(0);
  });

  test("sees their own request under My Requests", async ({ page }) => {
    await page.goto("/my-requests");
    await expect(page.getByRole("heading", { name: "My requests" })).toBeVisible();
    // global-setup guarantees this resident owns a request.
    await expect(page.getByText("E2E resident request")).toBeVisible();
  });

  test("opens their own request on its page, without the staff controls", async ({ page }) => {
    await page.goto("/my-requests");
    await page.locator('[data-testid^="link-request-"]', { hasText: "E2E resident request" }).first().click();
    await expect(page).toHaveURL(/\/maintenance\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "E2E resident request" })).toBeVisible();
    await expect(page.getByTestId("badge-request-status")).toBeVisible();
    // Edit is a staff action; the server refuses it for a resident, so the page does not offer it.
    await expect(page.getByTestId("button-edit-request")).toHaveCount(0);
    await expect(page.getByTestId("link-back-to-requests")).toHaveAttribute("href", "/my-requests");
    // The thread is theirs to read; the composer is staff's until #120.
    await expect(page.getByTestId("request-thread")).toBeVisible();
    await expect(page.getByTestId("form-comment")).toHaveCount(0);
  });

  test("cannot reach an admin page by URL", async ({ page }) => {
    await page.goto("/assets");
    // The resident router has no /assets route, so it falls through to NotFound.
    await expect(page.getByRole("heading", { name: "This page is not available" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Asset Tracking" })).toHaveCount(0);
  });
});
