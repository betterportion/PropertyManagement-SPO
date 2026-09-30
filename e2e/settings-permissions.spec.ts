import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * The permissions dialog in Settings, end to end.
 *
 * The route tests pin the rule: a resident account's permissions row holds
 * only the resident grants and no regions, and the server refuses anything
 * else. What only a browser can show is that the dialog offers an admin
 * nothing the server would refuse, and that saving it stores what was ticked.
 *
 * Each test makes its own account, so no other spec's resident is changed.
 */

const RESIDENT_FLAGS = ["canViewMaintenance", "canCompleteWalkthroughs", "canViewResourceHub"];

async function createAccount(request: APIRequestContext, role: "resident" | "regional_administrator") {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const id = `e2e-perm-${stamp}`;
  const created = await request.post("/api/users", {
    data: { id, email: `${id}@test.local`, firstName: "Perm", lastName: stamp, role },
  });
  expect(created.ok()).toBeTruthy();
  return { id, lastName: stamp };
}

test.describe("the permissions dialog", () => {
  test("a resident account is offered only the resident options, and saving stores only those", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, "resident");
    try {
      await page.goto("/settings");
      await page.getByTestId("input-search-users").fill(account.lastName);
      await page.getByTestId(`button-permissions-${account.id}`).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Resident accounts see only their own house");
      await expect(dialog.getByText("Region Access")).toHaveCount(0);
      await expect(dialog.locator('[data-testid^="checkbox-region-"]')).toHaveCount(0);
      // Exactly the resident grants, and a staff flag is not among them.
      await expect(dialog.locator('[data-testid^="checkbox-can"]')).toHaveCount(RESIDENT_FLAGS.length);
      for (const flag of RESIDENT_FLAGS) {
        await expect(dialog.getByTestId(`checkbox-${flag}`)).toBeVisible();
      }
      await expect(dialog.getByTestId("checkbox-canManageProperties")).toHaveCount(0);

      await dialog.getByTestId("checkbox-canViewResourceHub").click();
      await dialog.getByTestId("button-save-permissions").click();
      await expect(page.getByText("User permissions updated successfully").first()).toBeVisible();
      await expect(dialog).toHaveCount(0);

      // What the server stored, not what the form showed.
      const stored = await (await request.get(`/api/users/${account.id}/permissions`)).json();
      expect(stored.canViewResourceHub).toBe(true);
      expect(stored.canManageProperties).toBeFalsy();
      expect(stored.canViewProperties).toBeFalsy();
      expect(stored.allowedRegions ?? []).toEqual([]);
    } finally {
      await request.delete(`/api/users/${account.id}`);
    }
  });

  test("a staff account is still offered regions and every staff option -- the positive control", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, "regional_administrator");
    try {
      await page.goto("/settings");
      await page.getByTestId("input-search-users").fill(account.lastName);
      await page.getByTestId(`button-permissions-${account.id}`).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Region Access")).toBeVisible();
      expect(await dialog.locator('[data-testid^="checkbox-region-"]').count()).toBeGreaterThan(0);
      await expect(dialog.getByTestId("checkbox-canManageProperties")).toBeVisible();
      expect(await dialog.locator('[data-testid^="checkbox-can"]').count()).toBeGreaterThan(RESIDENT_FLAGS.length);
    } finally {
      await request.delete(`/api/users/${account.id}`);
    }
  });
});
