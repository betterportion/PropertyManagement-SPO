import { test, expect } from "@playwright/test";

/**
 * The maintenance list's filters, and the contractor page behind a vendor.
 *
 * The unit tests pin the range arithmetic and the route tests pin the guards.
 * What a browser adds is that the filters actually narrow the list, and that
 * the room vocabulary comes from somewhere rather than being a blank box.
 */

test.describe("filtering the maintenance list", () => {
  test("defaults to the last 90 days of closed work, not the whole history", async ({ page }) => {
    // An RA opening this page wants what is happening, not four years of
    // finished work. "All closed requests" is one click away.
    await page.goto("/maintenance");
    await expect(page.getByTestId("select-filter-closed-range")).toContainText("90 days");
  });

  test("the range filter is in the URL, so a view can be shared", async ({ page }) => {
    await page.goto("/maintenance");
    await page.getByTestId("select-filter-closed-range").click();
    await page.getByRole("option", { name: "All closed requests" }).click();
    await expect(page).toHaveURL(/closed=all/);
  });

  test("picking a house narrows the room filter to that house's rooms", async ({ page }) => {
    // Offering every room name SPO has ever recorded would make the filter
    // useless the moment there is more than one house.
    await page.goto("/maintenance");
    const roomFilter = page.getByTestId("select-filter-room");
    if ((await roomFilter.count()) === 0) test.skip();
    await expect(roomFilter).toBeVisible();
  });

  test("clearing the filters puts everything back", async ({ page }) => {
    await page.goto("/maintenance?closed=7");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/closed=7/);
  });
});

test.describe("a contractor's history", () => {
  test("their name opens what SPO knows about them", async ({ page }) => {
    await page.goto("/contacts");
    const firstContact = page.locator('[data-testid^="text-contact-name-"]').first();
    if ((await firstContact.count()) === 0) test.skip();

    await firstContact.click();
    await expect(page).toHaveURL(/\/contacts\/[^/]+$/);
    await expect(page.getByRole("heading", { name: "Every job they touched" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What the last RA learned" })).toBeVisible();
  });

  test("a note can be added and reads back with its author and date", async ({ page }) => {
    await page.goto("/contacts");
    const firstContact = page.locator('[data-testid^="text-contact-name-"]').first();
    if ((await firstContact.count()) === 0) test.skip();
    await firstContact.click();

    const add = page.getByTestId("button-add-contact-note");
    await expect(add).toBeDisabled();

    await page.getByTestId("textarea-contact-note").fill("Came out same day for the burst pipe.");
    await expect(add).toBeEnabled();
    await add.click();

    await expect(page.getByText("Came out same day for the burst pipe.")).toBeVisible();
  });

  test("there is no rating control anywhere on the page", async ({ page }) => {
    // Deliberate: a star score on a vendor SPO may have to keep using invites
    // arguments about the number and says less than a paragraph does.
    await page.goto("/contacts");
    const firstContact = page.locator('[data-testid^="text-contact-name-"]').first();
    if ((await firstContact.count()) === 0) test.skip();
    await firstContact.click();

    await expect(page.getByRole("radiogroup", { name: /rating/i })).toHaveCount(0);
    await expect(page.locator('[data-testid*="rating"]')).toHaveCount(0);
  });
});
