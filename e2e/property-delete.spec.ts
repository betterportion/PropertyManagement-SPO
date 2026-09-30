import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Deleting a house, end to end.
 *
 * The route tests pin the rule: a house with anyone on its roster, or any HH
 * fees, deposits or deductions, answers 409 and nothing is deleted. What only
 * a browser can show is what a person sees: a dialog that says up front what
 * goes with the house, and the server's own reason when it refuses.
 */

async function propertyIds(request: APIRequestContext): Promise<string[]> {
  const properties = await (await request.get("/api/properties")).json();
  return properties.map((p: { id: string }) => p.id);
}

async function openDeleteDialog(page: Page, propertyId: string) {
  await page.goto("/properties");
  await page.getByTestId(`button-menu-${propertyId}`).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("can only be deleted once nobody is on its roster");
  await expect(dialog).toContainText("Its maintenance requests and assets are kept");
  return dialog;
}

test.describe("deleting a house", () => {
  test("a house with someone on its roster is refused with the reason, and stays", async ({ page, request }) => {
    // global-setup puts the e2e resident on a house's roster; that house is the one refused.
    const roster = await (await request.get("/api/residents")).json();
    const onRoster = roster.find((r: { email?: string }) => r.email === "e2e-resident@test.local");
    test.skip(!onRoster?.propertyId, "the e2e resident is on no house's roster");
    const propertyId: string = onRoster.propertyId;

    const dialog = await openDeleteDialog(page, propertyId);
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("The property was not deleted").first()).toBeVisible();
    await expect(page.getByText(/can't be deleted: it still has .* on its roster/).first()).toBeVisible();

    await page.reload();
    await expect(page.getByTestId(`card-property-${propertyId}`)).toBeVisible();
    expect(await propertyIds(request)).toContain(propertyId);
  });

  test("an empty house is deleted and the deletion is on the activity log", async ({ page, request }) => {
    const stamp = `${Date.now()}`;
    const name = `E2E empty house ${stamp}`;
    const created = await request.post("/api/properties", {
      data: {
        name,
        streetAddress: `${stamp} Delete Lane`,
        city: "San Marcos",
        state: "TX",
        zipCode: "78666",
        region: "Southwest",
        chapter: "Texas State University",
        ownership: "owned",
      },
    });
    expect(created.ok()).toBeTruthy();
    const { id: propertyId } = await created.json();

    const dialog = await openDeleteDialog(page, propertyId);
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByText("Property deleted successfully").first()).toBeVisible();
    await expect(page.getByTestId(`card-property-${propertyId}`)).toHaveCount(0);
    expect(await propertyIds(request)).not.toContain(propertyId);

    const log = await (await request.get("/api/audit-log?action=property.deleted")).json();
    expect(log.events.some((e: { entityId?: string }) => e.entityId === propertyId)).toBe(true);
  });
});
