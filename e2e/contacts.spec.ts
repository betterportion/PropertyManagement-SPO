import { test, expect } from "@playwright/test";

// Joseph's notes (2026-11-04): a contact serves cities, an invoice record names
// its house, the filters narrow both tabs, and an invoice record can be edited.
test.describe("contacts and invoice records", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/contacts");
    await expect(page.getByRole("heading", { name: "Maintenance Contacts & Invoices" })).toBeVisible();
  });

  test("a city narrows both the contacts and the invoices", async ({ page }) => {
    const contacts = page.locator('[data-testid^="card-contact-"]');
    const invoices = page.locator('[data-testid^="card-invoice-"]');
    await expect(contacts.first()).toBeVisible();
    const allContacts = await contacts.count();

    await page.getByTestId("select-filter-city").click();
    await page.getByRole("option", { name: "Minneapolis, MN", exact: true }).click();

    await expect(contacts).toHaveCount(1);
    await expect(contacts.first()).toContainText("Dave Kowalski");
    expect(allContacts).toBeGreaterThan(1);

    await page.getByTestId("tab-invoices").click();
    await expect(invoices).toHaveCount(1);
    await expect(invoices.first()).toContainText("Kowalski Electric");
  });

  test("a new contact needs a city it serves, from its region's houses", async ({ page }) => {
    let created = false;
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/contacts") created = true; });
    await page.getByTestId("button-add-contact").click();
    await page.getByTestId("select-contact-region").click();
    await page.getByRole("option", { name: "Northwest", exact: true }).click();
    await expect(page.getByTestId("checkboxes-contact-cities-Minneapolis, MN")).toBeVisible();
    await expect(page.getByTestId("checkboxes-contact-cities-Columbus, OH")).toHaveCount(0);
    await page.getByTestId("button-submit-contact").click();
    await expect(page.getByText("Pick at least one city this contact serves.")).toBeVisible();
    expect(created).toBe(false);
  });

  test("a new invoice record asks which house it is for", async ({ page }) => {
    let created = false;
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/billing") created = true; });
    await page.getByTestId("button-add-invoice").click();
    await page.getByTestId("button-submit-invoice").click();
    await expect(page.getByText("Which house is this invoice for?")).toBeVisible();
    expect(created).toBe(false);
  });

  test("an invoice record's house can be changed, and the card shows it", async ({ page }) => {
    await page.getByTestId("tab-invoices").click();
    const card = page.locator('[data-testid^="card-invoice-"]').filter({ hasText: "TwinCities HVAC" });
    await expect(card).toContainText("Como Men's House");

    await card.locator('[data-testid^="button-edit-invoice-"]').click();
    await expect(page.getByRole("heading", { name: "Edit Invoice Record" })).toBeVisible();
    await page.getByTestId("select-invoice-house").click();
    await page.getByRole("option", { name: /^Cleveland House/ }).click();
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect(card).toContainText("Cleveland House");
    await page.reload();
    await page.getByTestId("tab-invoices").click();
    await expect(page.locator('[data-testid^="card-invoice-"]').filter({ hasText: "TwinCities HVAC" })).toContainText("Cleveland House");
  });
});
