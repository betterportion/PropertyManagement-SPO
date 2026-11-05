import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

test.describe("properties — region and chapter filters", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();
  });

  test("filtering by chapter narrows the property list to that chapter", async ({ page }) => {
    // The filter controls are always present.
    await expect(page.getByTestId("select-filter-region")).toBeVisible();
    await expect(page.getByTestId("select-filter-chapter")).toBeVisible();

    test.skip(!fixtures.propertyChapter, "no seeded property with a chapter");
    const cards = page.locator('[data-testid^="card-property-"]');
    const total = await cards.count();
    expect(total).toBeGreaterThan(0);

    await page.getByTestId("select-filter-chapter").click();
    // exact match: some chapters are substrings of others ("University of
    // St. Thomas" vs "... - Houston"), and the filter now lists all of them.
    await page.getByRole("option", { name: fixtures.propertyChapter, exact: true }).click();

    // There are no more cards than before, and every remaining card actually
    // shows the chosen chapter — so the filter really narrowed the list.
    const filtered = await cards.count();
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThanOrEqual(total);
    await expect(cards.filter({ hasText: fixtures.propertyChapter })).toHaveCount(filtered);
  });

  test("the chapter field offers only the chosen region's chapters", async ({ page }) => {
    await page.getByTestId("button-add-property").click();

    await page.getByTestId("select-property-region").click();
    await page.getByRole("option", { name: "Southwest", exact: true }).click();

    await page.getByTestId("select-property-chapter").click();
    // A Southwest chapter is offered; a Northwest one is not.
    await expect(page.getByRole("option", { name: "Texas State University" })).toBeVisible();
    await expect(page.getByRole("option", { name: "University of Minnesota" })).toHaveCount(0);
  });

  test("a new house needs its size, men or women and both capacities, and asks no deposit or manager", async ({ page }) => {
    let created = false;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/properties") created = true;
    });
    await page.getByTestId("button-add-property").click();
    await expect(page.getByTestId("input-property-manager")).toHaveCount(0);
    await expect(page.getByTestId("input-property-deposit-amount")).toHaveCount(0);
    await expect(page.getByTestId("input-property-deposit-notes")).toHaveCount(0);
    await expect(page.getByText("Leave blank to use the state's deadline set in Settings.")).toBeVisible();

    await page.getByTestId("button-submit-property").click();
    for (const message of [
      "How many bedrooms?",
      "How many bathrooms?",
      "How many square feet?",
      "Is this a men's or a women's house?",
      "What does the city or lease allow?",
      "How many does SPO put in this house?",
    ]) {
      await expect(page.getByText(message)).toBeVisible();
    }
    expect(created).toBe(false);
  });
});

test.describe("properties — leases", () => {
  test("a seeded rented house shows its lease info on the card", async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();
    // The seed marks a couple of houses as rented with an upcoming renewal.
    await expect(page.locator('[data-testid^="badge-property-rented-"]').first()).toBeVisible();
    await expect(page.locator('[data-testid^="text-property-renewal-"]').first()).toBeVisible();
  });

  test("marking a house rented with a renewal date persists to its card", async ({ page }) => {
    await page.goto("/properties");
    const card = page.locator('[data-testid^="card-property-"]').filter({ hasText: "Dinkytown" });
    await expect(card).toBeVisible();

    await card.locator('[data-testid^="button-menu-"]').click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    await page.getByTestId("select-property-ownership").click();
    await page.getByRole("option", { name: "Rented (has a lease)" }).click();
    await page.getByTestId("input-property-lease-renewal").fill("2027-01-15");
    await page.getByRole("button", { name: "Update Property" }).click();

    // The card now shows the rented badge and the renewal it just recorded.
    await expect(card.getByText("Rented")).toBeVisible();
    await expect(card.getByText(/Lease renewal:/)).toBeVisible();
  });
});

test.describe("properties — a long chapter name", () => {
  test("is cut short, and the card's actions menu stays on the card", async ({ page, request }) => {
    const stamp = Date.now();
    const created = await request.post("/api/properties", {
      data: {
        name: `Long Chapter ${stamp}`,
        streetAddress: `${stamp} Wingate Ct`,
        city: "College Station",
        state: "TX",
        zipCode: "77845",
        region: "Southwest",
        chapter: "Bryan College Station Young Adults and Graduate Students",
        ownership: "owned",
      },
    });
    expect(created.ok()).toBeTruthy();
    const { id } = await created.json();
    try {
      await page.goto("/properties");
      const card = page.getByTestId(`card-property-${id}`);
      await card.scrollIntoViewIfNeeded();
      const cardBox = (await card.boundingBox())!;
      const menuBox = (await page.getByTestId(`button-menu-${id}`).boundingBox())!;
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      await expect(page.getByTestId(`badge-property-chapter-${id}`)).toHaveAttribute("title", /Graduate Students$/);
    } finally {
      await request.delete(`/api/properties/${id}`);
    }
  });
});
