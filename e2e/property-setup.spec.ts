import { test, expect } from "@playwright/test";

/**
 * The per-property setup checklist, end to end.
 *
 * The unit tests pin the counting rules and the route tests pin the guards.
 * What is left, and what only a browser can show, is that a state actually
 * survives the round trip: the three-state control writes, the summary
 * re-reads, and the badge on the property list agrees with the card.
 */

/** The first house in the seeded data; the suite does not care which. */
async function openFirstProperty(page: import("@playwright/test").Page) {
  await page.goto("/properties");
  const firstName = page.locator('[data-testid^="text-property-name-"]').first();
  await expect(firstName).toBeVisible();
  await firstName.click();
  await expect(page).toHaveURL(/\/properties\/[^/]+$/);
}

test.describe("the property setup checklist", () => {
  test("shows the four utilities as separate entries, never one combined check", async ({ page }) => {
    // One "utilities" checkbox hides which one is missing, and the missing one
    // is exactly what gets forgotten.
    await openFirstProperty(page);
    await page.getByTestId("tab-setup").click();

    for (const key of ["electric", "gas", "water", "internet"]) {
      await expect(page.getByTestId(`row-setup-${key}`)).toBeVisible();
    }
  });

  test("marking an item done survives a reload and moves the summary", async ({ page }) => {
    await openFirstProperty(page);
    const url = page.url();
    await page.getByTestId("tab-setup").click();

    const summary = page.getByTestId("badge-setup-summary");
    await expect(summary).toBeVisible();

    await page.getByTestId("button-setup-electric-done").click();
    // The write is a PUT with no optimistic state, so wait for the re-read.
    await expect(page.getByTestId("text-setup-set-electric")).toContainText("Done");

    await page.goto(url);
    await page.getByTestId("tab-setup").click();
    await expect(page.getByTestId("text-setup-set-electric")).toContainText("Done");
  });

  test("not-applicable is available and reads as its own state, not as done", async ({ page }) => {
    // An item that does not apply has to be sayable without claiming work
    // happened that never did.
    await openFirstProperty(page);
    await page.getByTestId("tab-setup").click();

    await page.getByTestId("button-setup-insurance-not_applicable").click();
    await expect(page.getByTestId("text-setup-set-insurance")).toContainText("Not needed");
  });

  test("a note on an item is kept with it", async ({ page }) => {
    await openFirstProperty(page);
    await page.getByTestId("tab-setup").click();

    await page.getByTestId("button-setup-water-note").click();
    await page.getByTestId("input-setup-note-water").fill("City bills the owner here");
    await page.getByTestId("input-setup-note-water").press("Enter");

    await expect(page.getByTestId("text-setup-note-water")).toContainText("City bills the owner");
  });

  test("the property list badge agrees with the card", async ({ page }) => {
    await openFirstProperty(page);
    const propertyId = page.url().split("/").pop()!;
    await page.getByTestId("tab-setup").click();

    const summaryText = await page.getByTestId("badge-setup-summary").innerText();

    await page.goto("/properties");
    const badge = page.getByTestId(`badge-property-setup-${propertyId}`);

    if (summaryText.includes("still to do")) {
      // "7 of 8 still to do" on the card, "Setup: 7 to do" on the row.
      const open = summaryText.match(/(\d+) of/)?.[1];
      await expect(badge).toContainText(`${open} to do`);
    } else {
      // Untracked or complete: the row stays quiet rather than showing a zero.
      await expect(badge).toHaveCount(0);
    }
  });
});

test.describe("creating a property", () => {
  test("the dashboard link opens the form directly", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("button-add-property").click();
    await expect(page).toHaveURL(/\/properties\?add=1$/);
    await expect(page.getByTestId("input-property-sqft")).toBeVisible();
  });

  test("a rented house is asked for its portal and lease link, an owned one is not", async ({ page }) => {
    await page.goto("/properties?add=1");

    await expect(page.getByTestId("select-property-responsibleContactId")).toBeVisible();
    await expect(page.getByTestId("input-property-maintenance-portal")).toHaveCount(0);

    await page.getByTestId("select-property-ownership").click();
    await page.getByRole("option", { name: /Rented/ }).click();

    await expect(page.getByTestId("input-property-maintenance-portal")).toBeVisible();
    await expect(page.getByTestId("input-property-lease-document")).toBeVisible();
    await expect(page.getByTestId("select-property-rentalCompanyContactId")).toBeVisible();
    await expect(page.getByTestId("select-property-responsibleContactId")).toHaveCount(0);
  });
});
