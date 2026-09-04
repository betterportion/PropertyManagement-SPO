import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixtures = JSON.parse(readFileSync("e2e/.auth/fixtures.json", "utf8"));

test.describe("property detail — everything about one house", () => {
  test("a property name in the list opens the house page", async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();

    const firstName = page.locator('[data-testid^="text-property-name-"]').first();
    const name = (await firstName.textContent())?.trim() ?? "";
    expect(name.length).toBeGreaterThan(0);

    await firstName.click();
    await expect(page).toHaveURL(/\/properties\/[^/]+$/);
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  });

  test("shows the three tabs and lands on the roster", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto(`/properties/${fixtures.propertyId}`);

    await expect(page.getByTestId("tab-residents")).toBeVisible();
    await expect(page.getByTestId("tab-maintenance")).toBeVisible();
    await expect(page.getByTestId("tab-assets")).toBeVisible();
    await expect(page.getByTestId("table-property-residents")).toBeVisible();
  });

  test("each tab shows its own table", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto(`/properties/${fixtures.propertyId}`);

    await page.getByTestId("tab-maintenance").click();
    await expect(page.getByTestId("table-property-requests")).toBeVisible();
    await expect(page.getByTestId("table-property-schedules")).toBeVisible();

    await page.getByTestId("tab-assets").click();
    await expect(page.getByTestId("table-property-assets")).toBeVisible();
  });

  // The seed puts repairs and a wishlist item on the house but no project,
  // so one is filed here through the same route the staff dialog uses, and
  // removed again so the seed does not gain a project a run.
  test("open work groups the house's requests once, with a project under Projects", async ({
    page,
    request,
  }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    const projectId = await fileProject(request, fixtures.propertyId);
    try {
      await page.goto(`/properties/${fixtures.propertyId}`);
      await page.getByTestId("tab-maintenance").click();

      for (const key of ["request", "project", "capex", "wishlist"]) {
        await expect(page.getByTestId(`open-work-group-${key}`)).toBeVisible();
        await expect(page.getByTestId(`open-work-count-${key}`)).toHaveText(/^\d+$/);
      }
      await expect(page.getByTestId(`open-work-count-project`)).not.toHaveText("0");

      const item = page.getByTestId(`open-work-item-${projectId}`);
      await expect(page.getByTestId("open-work-group-project").locator(item)).toBeVisible();
      await expect(page.getByTestId("open-work-group-request").locator(item)).toHaveCount(0);
      await expect(item).toHaveAttribute("href", `/maintenance/${projectId}`);
    } finally {
      await request.delete(`/api/maintenance-requests/${projectId}`);
    }
  });

  test("the back link returns to the property list", async ({ page }) => {
    test.skip(!fixtures.propertyId, "no seeded property");
    await page.goto(`/properties/${fixtures.propertyId}`);
    await page.getByTestId("link-back-to-properties").click();
    await expect(page).toHaveURL(/\/properties$/);
  });

  // A property id that is not in the user's list is the same shape as one in a
  // region they cannot reach, so this covers both: an explanation, not a crash.
  test("an unknown property explains itself instead of breaking", async ({ page }) => {
    await page.goto("/properties/not-a-real-property-id");
    await expect(page.getByText("That property is not here")).toBeVisible();
    await expect(page.getByTestId("state-error")).toHaveCount(0);
  });
});

/** File a project on the house as the admin; returns its id. */
async function fileProject(api: APIRequestContext, propertyId: string): Promise<string> {
  const properties = await api.get("/api/properties");
  expect(properties.ok()).toBeTruthy();
  const house = (await properties.json()).find((p: { id: string }) => p.id === propertyId);
  expect(house).toBeTruthy();

  const created = await api.post("/api/maintenance-requests", {
    data: {
      title: `E2E open-work project ${Date.now()}`,
      description: "Replace the back fence",
      category: "Other",
      priority: "medium",
      type: "project",
      status: "pending",
      location: "Yard",
      region: house.region,
      buildingAddress: house.address,
    },
  });
  expect(created.ok()).toBeTruthy();
  return (await created.json()).id;
}
