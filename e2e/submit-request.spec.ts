import { test, expect } from "@playwright/test";

// Acts as the resident. global-setup puts this resident on a house roster, so
// the submit flow can attach their region/house.
test.use({ storageState: "e2e/.auth/resident.json" });

test.describe("resident submits a maintenance request", () => {
  test("a submitted request actually lands under My requests", async ({ page }) => {
    await page.goto("/submit-request");
    await expect(page.getByRole("heading", { name: "Submit a maintenance request" })).toBeVisible();

    // A unique title so the assertion can't collide with a prior run's row.
    const title = `E2E submitted ${Date.now()}`;
    await page.getByLabel("Issue title").fill(title);
    await page.getByLabel("Location").fill("Kitchen");
    await page.locator("#category").click();
    await page.getByRole("option", { name: "Plumbing" }).click();
    await page.locator("#priority").click();
    await page.getByRole("option", { name: "Medium" }).click();
    await page.getByLabel("Description").fill("The kitchen tap drips overnight.");

    await page.getByTestId("button-submit-request").click();

    // Redirects to My requests, and the new request is really there.
    await expect(page).toHaveURL(/\/my-requests$/);
    await expect(page.getByText(title)).toBeVisible();
  });

  test("blocks submission until a category and priority are chosen", async ({ page }) => {
    await page.goto("/submit-request");
    await page.getByLabel("Issue title").fill("Missing fields");
    await page.getByLabel("Location").fill("Hallway");
    await page.getByLabel("Description").fill("No category or priority picked.");

    await page.getByTestId("button-submit-request").click();

    // Stays on the page and explains what's missing instead of silently failing.
    await expect(page.getByTestId("text-form-error")).toBeVisible();
    await expect(page).toHaveURL(/\/submit-request$/);
  });
});
