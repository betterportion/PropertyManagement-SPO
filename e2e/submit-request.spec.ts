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

  test("a resident can attach a photo when reporting an issue", async ({ page }) => {
    await page.goto("/submit-request");
    const title = `E2E photo request ${Date.now()}`;
    await page.getByLabel("Issue title").fill(title);
    await page.getByLabel("Location").fill("Bathroom");
    await page.locator("#category").click();
    await page.getByRole("option", { name: "Plumbing" }).click();
    await page.locator("#priority").click();
    await page.getByRole("option", { name: "Medium" }).click();
    await page.getByLabel("Description").fill("Leak under the sink; photo attached.");

    // Attach an image via the hidden file input inside the dropzone (a 1×1 PNG).
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.getByTestId("input-file-upload").setInputFiles({ name: "leak.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("request-photo-thumbs")).toBeVisible();

    await page.getByTestId("button-submit-request").click();
    await expect(page).toHaveURL(/\/my-requests$/);

    // The request lands with its photo gallery under My requests.
    await expect(page.getByText(title)).toBeVisible();
    await expect(page.locator('[data-testid^="request-photos-"]').first()).toBeVisible();
  });
});
