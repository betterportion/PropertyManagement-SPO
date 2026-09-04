import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

/**
 * House facts, end to end (ADR-0002).
 *
 * The route tests pin who may read and write and what the audit log holds.
 * What only a browser can show is the round trip the feature exists for: a
 * regional administrator types a door code on the property page, and the
 * household leader of that house finds it, dated, on their Resources page.
 *
 * Runs as the admin by default (playwright.config), and opens a second
 * context as the resident for the household half.
 */
test.describe("house facts", () => {
  test("staff sets a door code and the household sees it with the date on the hub", async ({
    page,
    request,
    browser,
  }) => {
    test.skip(!fixtures.propertyId, "no seeded property");

    // global-setup gives the resident an account and a roster row, but not a
    // house link on the account or the hub grant. Both are ordinary admin
    // actions, done here through the same routes the Settings screen uses.
    const linked = await request.patch("/api/users/e2e-resident/property", {
      data: { propertyId: fixtures.propertyId },
    });
    expect(linked.ok()).toBeTruthy();
    const granted = await request.patch("/api/users/e2e-resident/permissions", {
      data: { canViewResourceHub: true },
    });
    expect(granted.ok()).toBeTruthy();

    // A fresh code each run, so the assertion below cannot pass on a value
    // left behind by an earlier run.
    const code = String(Date.now() % 100_000).padStart(5, "0");

    await page.goto(`/properties/${fixtures.propertyId}`);
    await expect(page.getByTestId("card-house-facts")).toBeVisible();
    await page.getByTestId("input-house-facts-doorCode").fill(code);
    await page.getByTestId("button-save-house-facts").click();
    // The date comes back from the server on the re-read, never from the form.
    await expect(page.getByTestId("text-house-facts-doorCode-date")).toContainText("Last changed");

    const household = await browser.newContext({ storageState: "e2e/.auth/resident.json" });
    try {
      const hub = await household.newPage();
      await hub.goto("/resources");
      await expect(hub.getByTestId("card-hub-house-facts")).toBeVisible();
      await expect(hub.getByTestId("text-hub-doorCode")).toHaveText(code);
      await expect(hub.getByTestId("text-hub-doorCode-date")).toContainText("Last changed");
    } finally {
      await household.close();
    }
  });

  test("the household's card and the staff notes are different things on the property page", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto(`/properties/${fixtures.propertyId}`);

    // The card says on it who reads it, so nobody types a staff remark into
    // the household's block by mistake.
    const card = page.getByTestId("card-house-facts");
    await expect(card).toContainText("Resources page");
    await expect(card.getByTestId("input-house-facts-rubbishDay")).toBeVisible();
    // Staff notes, when present, are labelled as staff's and sit outside the card.
    await expect(card.getByTestId("text-property-notes")).toHaveCount(0);
  });
});
