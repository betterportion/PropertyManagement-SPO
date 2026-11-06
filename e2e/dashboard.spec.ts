import { test, expect, type Locator } from "@playwright/test";

test.describe("admin dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  const tiles = [
    { testid: "link-stat-properties", path: "/properties", heading: "Properties" },
    { testid: "link-stat-open-repairs", path: "/maintenance?type=request", heading: "Maintenance" },
    { testid: "link-stat-open-jobs", path: "/maintenance?view=open", heading: "Maintenance" },
    { testid: "link-stat-unpaid-hh-fees", path: "/finances", heading: "Finances" },
  ];

  for (const tile of tiles) {
    test(`the ${tile.testid} tile navigates to ${tile.path}`, async ({ page }) => {
      await page.getByTestId(tile.testid).click();
      await expect(page).toHaveURL(new RegExp(`${tile.path.replace(/[?]/g, "\\?")}$`));
      await expect(page.getByRole("heading", { name: tile.heading }).first()).toBeVisible();
    });
  }

  test("the sidebar logo returns to the dashboard from another page", async ({ page }) => {
    await page.getByTestId("link-stat-properties").click();
    await expect(page).toHaveURL(/\/properties$/);
    await page.getByTestId("link-sidebar-home").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("stat tiles show numeric counts, not placeholders", async ({ page }) => {
    // The seeded database has properties; the tile shows a real number.
    await expect(page.getByTestId("stat-properties")).toHaveText(/^\d+$/);
  });

  test("shows the per-region overview and drills into a region", async ({ page }) => {
    // The admin sees a card per region; clicking one focuses that region.
    const firstRegion = page.locator('[data-testid^="card-region-"]').first();
    await expect(firstRegion).toBeVisible();
    await firstRegion.click();
    // Focused view offers a way back to all regions.
    await expect(page.getByTestId("button-all-regions")).toBeVisible();
  });

  test("has no National card while the campus regions keep theirs", async ({ page }) => {
    // The national view is deferred to v2 (docs/WORKFLOWS.md); the seed has a
    // summary for every region, National included.
    await expect(page.getByTestId("card-region-Northwest")).toBeVisible();
    await expect(page.getByTestId("card-region-National")).toHaveCount(0);
  });

  test("shows a seasonal safety reminder in the Safety & preventive stream", async ({ page }) => {
    // The seed adds an (overdue) household-walkthrough reminder for Northwest.
    await expect(page.getByText(/Household walkthroughs due/).first()).toBeVisible();
  });
});

// Audit 2026-11-05, finding 9: the dashboard keeps what it loaded until told
// otherwise, so closing a repair has to tell it. Moving between pages here
// never reloads the page, which is how an RA uses it.
test("closing a repair lowers the dashboard's open repairs without a page reload", async ({ page, request: api }) => {
  const house = (await (await api.get("/api/properties")).json())[0];
  const filed = await api.post("/api/maintenance-requests", {
    data: {
      title: `E2E dashboard count ${Date.now()}`,
      description: "Loose cabinet hinge",
      category: "Other",
      priority: "medium",
      type: "request",
      status: "pending",
      location: "Kitchen",
      region: house.region,
      buildingAddress: house.address,
    },
  });
  expect(filed.ok()).toBeTruthy();
  const { id } = await filed.json();

  await page.goto("/");
  const tile = page.getByTestId("stat-open-repairs");
  const before = await settled(tile);

  // Wouter follows pushState plus popstate, so this is in-app navigation.
  await page.evaluate((path) => {
    history.pushState(null, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/maintenance/${id}`);
  await page.getByTestId("button-edit-request").click();
  await page.getByTestId("select-status").click();
  await page.getByRole("option", { name: "Completed" }).click();
  await page.getByTestId("button-save").click();
  await expect(page.getByTestId("select-status")).toHaveCount(0);

  await page.getByTestId("link-sidebar-home").click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // Read once settled: the tile counts up from zero each time it appears, so
  // a bare toHaveText would pass on the way up past the right number.
  expect(await settled(tile)).toBe(before - 1);
});

/** The tile's number once its count-up animation has stopped. */
async function settled(tile: Locator): Promise<number> {
  let value = NaN;
  await expect
    .poll(async () => {
      const first = await tile.textContent();
      await tile.page().waitForTimeout(800);
      const again = await tile.textContent();
      value = Number(again);
      return first === again && /^\d+$/.test(again ?? "");
    })
    .toBe(true);
  return value;
}
