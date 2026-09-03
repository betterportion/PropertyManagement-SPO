import { test, expect } from "@playwright/test";

/**
 * Asset lifecycle, snooze and assignment, end to end.
 *
 * The unit tests pin the thresholds and the route tests pin the guards. What
 * only a browser shows is that the two rules the plan cares most about
 * actually hold on screen:
 *
 *   - a status is never colour alone — every badge carries its word;
 *   - a snoozed asset stays on this page and says it is snoozed. It is the
 *     dashboard, and only the dashboard, that hides one.
 */

async function openFirstAsset(page: import("@playwright/test").Page) {
  await page.goto("/assets");
  const firstName = page.locator('[data-testid^="text-asset-name-"]').first();
  await expect(firstName).toBeVisible();
  await firstName.click();
  await expect(page).toHaveURL(/\/assets\/[^/]+$/);
}

test.describe("how an asset's life reads on screen", () => {
  test("every asset carries a lifecycle word, not just a colour", async ({ page }) => {
    await page.goto("/assets");
    const badges = page.locator('[data-testid^="badge-lifecycle-"]');
    await expect(badges.first()).toBeVisible();

    for (const badge of await badges.all()) {
      // Whatever the status, the badge has to say something a reader can read.
      await expect(badge).not.toHaveText("");
    }
  });

  test("an asset with no acquisition date reads as unrated, never as a warning", async ({ page }) => {
    // SPO's tracking is patchy. A guess here would be indistinguishable from a
    // real warning, and people would stop reading both.
    await page.goto("/assets");
    const unrated = page.locator('[data-testid^="badge-lifecycle-"]', { hasText: "Unrated" });
    if ((await unrated.count()) > 0) {
      await expect(unrated.first()).toContainText("no acquisition date");
    }
  });

  test("the asset name opens a detail page with its provenance", async ({ page }) => {
    await openFirstAsset(page);
    await expect(page.getByText("Life and replacement")).toBeVisible();
    await expect(page.getByText("Where it came from")).toBeVisible();
    // Both figures, never one instead of the other.
    await expect(page.getByText("Purchase price")).toBeVisible();
    await expect(page.getByText("Current value")).toBeVisible();
  });
});

test.describe("snoozing an asset", () => {
  test("will not submit without a reason", async ({ page }) => {
    // The reason is what next year's budget conversation runs on.
    await openFirstAsset(page);
    await page.getByTestId("button-open-snooze").click();

    const confirm = page.getByTestId("button-confirm-snooze");
    await expect(confirm).toBeDisabled();

    await page.getByTestId("textarea-snooze-reason").fill("Serviced in March, five years left");
    await expect(confirm).toBeEnabled();
  });

  test("a snoozed asset stays on the asset page and says so", async ({ page }) => {
    await openFirstAsset(page);
    const assetId = page.url().split("/").pop()!;

    await page.getByTestId("button-open-snooze").click();
    await page.getByTestId("textarea-snooze-reason").fill("Serviced in March, five years left");
    await page.getByTestId("button-confirm-snooze").click();

    await expect(page.getByTestId("text-snooze-reason-detail")).toContainText("Serviced in March");

    // Still listed, and visibly snoozed. Hiding it here is how a boiler gets
    // forgotten for three years.
    await page.goto("/assets");
    await expect(page.getByTestId(`badge-snoozed-${assetId}`)).toBeVisible();
    await expect(page.getByTestId(`badge-lifecycle-${assetId}`)).toBeVisible();
  });

  test("the snooze can be cleared and the reason is kept", async ({ page }) => {
    await openFirstAsset(page);

    await page.getByTestId("button-open-snooze").click();
    await page.getByTestId("textarea-snooze-reason").fill("Serviced in March");
    await page.getByTestId("button-confirm-snooze").click();
    await expect(page.getByTestId("text-snooze-reason-detail")).toBeVisible();

    await page.getByTestId("button-open-snooze").click();
    await expect(page.getByTestId("text-snooze-reason")).toContainText("Serviced in March");
    await page.getByTestId("button-clear-snooze").click();

    await expect(page.getByTestId("text-snooze-reason-detail")).toHaveCount(0);
  });
});

test.describe("who has what", () => {
  test("the assigned view is reachable and reads by person", async ({ page }) => {
    // The real use case is a staff departure: collect the iPad, the guitar and
    // the laptop before he leaves. That means grouping by person, not by thing.
    await page.goto("/assets");
    await page.getByTestId("button-who-has-what").click();
    await expect(page).toHaveURL(/\/assets\/assigned$/);
    await expect(page.getByRole("heading", { name: "Who has what" })).toBeVisible();
  });
});
