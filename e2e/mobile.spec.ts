import { test, expect } from "@playwright/test";

/**
 * Runs only under the mobile-chrome project (Pixel 5, 393px wide). At that
 * width the sidebar collapses behind a toggle, so navigation works
 * differently than on desktop.
 */
test.describe("mobile layout", () => {
  test("the dashboard renders without a horizontal scrollbar", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    // The page body must never be wider than the viewport -- a horizontal
    // scrollbar on a phone is the classic broken-responsive symptom.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("navigation is behind the toggle and works once opened", async ({ page }) => {
    await page.goto("/");
    // Collapsed: the nav links are not on screen until the sidebar is opened.
    await expect(page.getByTestId("link-assets")).toBeHidden();

    await page.getByTestId("button-sidebar-toggle").click();
    const assetsLink = page.getByTestId("link-assets");
    await expect(assetsLink).toBeVisible();

    await assetsLink.click();
    await expect(page).toHaveURL(/\/assets$/);
    await expect(page.getByRole("heading", { name: "Asset Tracking" })).toBeVisible();
  });

  test("the assets gallery is usable on a phone", async ({ page }) => {
    await page.goto("/assets");
    await page.getByTestId("button-view-gallery").click();
    await expect(page.locator('[data-testid^="tile-asset-"]').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

/**
 * The walkthrough screen, at the width it was designed for.
 *
 * This is the one surface in the portal whose primary user is holding a phone
 * in a house with one hand free, so the phone viewport is where its acceptance
 * criteria belong rather than in the desktop suite.
 */
test.describe("filling in a walkthrough on a phone", () => {
  /**
   * Starts a fresh walkthrough and lands on its screen.
   *
   * Prefers a house nobody has walked yet, so the walkthrough is seeded from
   * the national template rather than copied from that house's last one --
   * which is the path the first test below is actually about. Falls back to
   * any house once the never-walked ones are used up.
   */
  async function startWalkthrough(page: import("@playwright/test").Page) {
    await page.goto("/walkthroughs");
    const neverWalked = page
      .locator('[data-testid^="card-property-"]')
      .filter({ hasText: "Never walked" });
    const card = (await neverWalked.count()) > 0
      ? neverWalked.first()
      : page.locator('[data-testid^="card-property-"]').first();
    await card.click();
    // The header control, not the empty-state one. Both are on screen for a
    // house with no walkthroughs yet, so `.or()` matches two elements and
    // fails strict mode -- which is what a database with no walkthroughs in it
    // looks like, and exactly what CI starts from.
    await page.getByTestId("button-start-walkthrough").click();
    await page.getByTestId("button-confirm-start-walkthrough").click();
    await expect(page).toHaveURL(/\/walkthroughs\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("text-current-room")).toBeVisible();
  }

  test("starts from the standard checklist and records a condition that survives a reload", async ({ page }) => {
    await startWalkthrough(page);
    const url = page.url();

    // The first walkthrough of a house is seeded from the national template,
    // so there is something to check without anyone typing it in.
    const firstItem = page.locator('[data-testid^="card-item-"]').first();
    await expect(firstItem).toBeVisible();
    const itemId = (await firstItem.getAttribute("data-testid"))!.replace("card-item-", "");

    await expect(page.getByTestId("text-overall-progress")).toContainText("0 of");
    await page.getByTestId(`button-condition-damaged-${itemId}`).click();
    await expect(page.getByTestId("text-overall-progress")).toContainText("1 of");
    await expect(page.getByTestId("text-flagged-count")).toContainText("needs attention");

    // A note is the half that is easy to lose: it is typed over seconds and
    // nothing fires when a phone locks. Type it and navigate straight away,
    // without blurring the field first.
    const note = `Playwright note ${Date.now()}`;
    await page.getByTestId(`input-item-notes-${itemId}`).fill(note);

    // Leaving and coming back loses nothing: every tap is already on the
    // server and the walkthrough stays a draft.
    await page.goto("/");
    await page.goto(url);
    await expect(page.getByTestId(`button-condition-damaged-${itemId}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId(`input-item-notes-${itemId}`)).toHaveValue(note);
    await expect(page.getByTestId("badge-walkthrough-status")).toHaveText("In progress");
  });

  test("rooms can be visited in any order", async ({ page }) => {
    await startWalkthrough(page);
    const firstRoom = await page.getByTestId("text-current-room").textContent();

    await page.getByTestId("button-open-rooms").click();
    // Jump straight to the last room without finishing the first.
    const roomButtons = page.locator('[data-testid^="button-goto-room-"]');
    await roomButtons.last().click();

    const lastRoom = await page.getByTestId("text-current-room").textContent();
    expect(lastRoom).not.toBe(firstRoom);

    // And back again, still without having completed anything.
    await page.getByTestId("button-open-rooms").click();
    await roomButtons.first().click();
    await expect(page.getByTestId("text-current-room")).toHaveText(firstRoom!);
  });

  test("adding a bathroom prefills its standard items", async ({ page }) => {
    await startWalkthrough(page);

    await page.getByTestId("button-open-rooms").click();
    await page.getByTestId("button-open-add-room").click();
    await page.getByTestId("select-room-type").click();
    await page.getByRole("option", { name: "Bathroom", exact: true }).click();
    await page.getByTestId("input-room-name").fill("Playwright bathroom");
    await page.getByTestId("button-submit-room").click();

    await expect(page.getByTestId("text-current-room")).toHaveText("Playwright bathroom");
    // The prefill is the point: a room type arrives with its usual items.
    await expect(page.locator('[data-testid^="card-item-"]').first()).toBeVisible();
    await expect(page.getByTestId("text-room-progress")).not.toContainText("of 0");
  });

  test("the walkthrough screen never scrolls sideways", async ({ page }) => {
    await startWalkthrough(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
