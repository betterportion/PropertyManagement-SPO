import { test, expect } from "@playwright/test";

test.describe("residents roster", () => {
  test("the Residents nav item opens the page with its tabs and add control", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("link-residents").click();
    await expect(page).toHaveURL(/\/residents$/);
    await expect(page.getByRole("heading", { name: "Residents" })).toBeVisible();
    await expect(page.getByTestId("tab-current")).toBeVisible();
    await expect(page.getByTestId("tab-former")).toBeVisible();
    await expect(page.getByTestId("button-add-resident")).toBeVisible();
  });

  test("shows seeded residents grouped by house with a headcount", async ({ page }) => {
    await page.goto("/residents");
    await expect(page.getByRole("heading", { name: "Residents" })).toBeVisible();
    // The seed adds current residents; wait for the roster query to resolve
    // (auto-retrying) rather than checking count() before the fetch returns.
    await expect(page.locator('[data-testid^="card-resident-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="headcount-"]').first()).toBeVisible();
  });

  test("exports the former residents as a CSV", async ({ page }) => {
    await page.goto("/residents");
    await expect(page.getByRole("heading", { name: "Residents" })).toBeVisible();
    // The seed leaves several former residents, so the export button is enabled.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("button-export-former").click(),
    ]);
    expect(download.suggestedFilename()).toBe("former-residents.csv");
  });

  test("ticks two residents and gives both portal access at once, then skips one who already has it", async ({ page }) => {
    const stamp = Date.now();
    const house = await (
      await page.request.post("/api/properties", {
        data: { name: `E2E Invite house ${stamp}`, streetAddress: `${stamp} Invite Street`, city: "San Marcos", state: "TX", zipCode: "78666", region: "Southwest", chapter: "Texas State University", ownership: "owned" },
      })
    ).json();
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const row = await page.request.post("/api/residents", {
        data: { propertyId: house.id, firstName: `Invitee${n}`, lastName: `E2E${stamp}`, email: `e2e-invite-${stamp}-${n}@test.local` },
      });
      expect(row.ok()).toBeTruthy();
      ids.push((await row.json()).id);
    }

    await page.goto("/residents");
    await page.getByTestId(`checkbox-invite-${ids[0]}`).click();
    await page.getByTestId(`checkbox-invite-${ids[1]}`).click();
    await expect(page.getByTestId("bar-invite")).toContainText("2 selected");
    await page.getByTestId("button-invite-picked").click();
    await expect(page.getByRole("dialog")).toContainText(`Invitee1 E2E${stamp}`);
    await page.getByTestId("button-invite-confirm").click();
    for (const id of ids) await expect(page.getByTestId(`invite-result-${id}`)).toContainText("Access given");
    await page.getByTestId("button-invite-done").click();
    await expect(page.getByTestId("bar-invite")).not.toContainText("selected");

    // Ticking one again does not grant or email twice.
    await page.getByTestId(`checkbox-invite-${ids[0]}`).click();
    await page.getByTestId("button-invite-picked").click();
    await page.getByTestId("button-invite-confirm").click();
    await expect(page.getByTestId(`invite-result-${ids[0]}`)).toContainText("Already has access. No email sent.");
  });
});
