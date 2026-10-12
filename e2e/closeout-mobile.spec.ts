import { test, expect } from "@playwright/test";

/**
 * The close-out on a phone (launch readiness 2.4, Phase 3): completing a
 * request with a linked contractor takes four answers and a note in under
 * ten interactions, and the contractor's page then shows the counts.
 *
 * Runs only under the mobile-chrome project (the file name matches its
 * testMatch), as the admin (playwright.config). The request, the house and
 * the contractor are created through the API so the spec owns what it reads.
 */
test.describe("closing out a request on a phone", () => {
  test("four answers and a note in under ten interactions, then the counts on the contractor's page", async ({ page, request: api }) => {
    const stamp = `${Date.now()}`;
    const house = await (
      await api.post("/api/properties", {
        data: {
          name: `E2E Closeout house ${stamp}`,
          streetAddress: `${stamp} Closeout Street`,
          city: "San Marcos",
          state: "TX",
          zipCode: "78666",
          region: "Southwest",
          chapter: "Texas State University",
          ownership: "owned",
        },
      })
    ).json();
    const contact = await (
      await api.post("/api/contacts", {
        data: {
          name: "Dave",
          company: `Dave's Plumbing ${stamp}`,
          service: "Plumbing",
          phone: "512-555-0100",
          email: `dave-${stamp}@example.com`,
          region: house.region,
          buildingAddress: house.address,
        },
      })
    ).json();
    const filed = await api.post("/api/maintenance-requests", {
      data: {
        title: `E2E closeout repair ${stamp}`,
        description: "Dripping tap",
        category: "Plumbing",
        priority: "medium",
        type: "request",
        status: "in_progress",
        location: "Kitchen",
        region: house.region,
        buildingAddress: house.address,
      },
    });
    expect(filed.ok()).toBeTruthy();
    const requestId = (await filed.json()).id;
    expect((await api.post(`/api/maintenance-requests/${requestId}/contacts/${contact.id}`)).ok()).toBeTruthy();

    await page.goto(`/maintenance/${requestId}`);
    let interactions = 0;
    const tap = async (testId: string) => {
      interactions++;
      await page.getByTestId(testId).click();
    };

    await tap("button-edit-request");
    await tap("select-status");
    interactions++;
    await page.getByRole("option", { name: "Completed" }).click();
    await expect(page.getByTestId("section-closeout-questions")).toBeVisible();

    // Saving without the answers is refused with a sentence on screen, not a disabled button.
    await page.getByTestId("button-save").click();
    await expect(page.getByTestId("text-closeout-problem")).toHaveText(
      `Before this request is marked completed, answer the four questions about Dave's Plumbing ${stamp} and add a note on how it went.`,
    );

    await tap("button-closeout-firstVisit-yes");
    await tap("button-closeout-quoteMatched-yes");
    await tap("button-closeout-callback-no");
    await tap("button-closeout-wouldUseAgain-yes");
    interactions++;
    await page.getByTestId("textarea-closeout-note").fill("Came the same day and left the kitchen clean.");
    await tap("button-save");
    expect(interactions).toBeLessThan(10);

    await expect(page.getByTestId("section-closeout")).toHaveCount(0);
    await expect(page.getByTestId("card-request-closeout")).toBeVisible();
    await expect(page.getByTestId("text-closeout-note")).toHaveText("Came the same day and left the kitchen clean.");

    await page.goto(`/contacts/${contact.id}`);
    await expect(page.getByTestId("text-closeout-count-firstVisit")).toHaveText("Finished on first visit: 1 of 1");
    await expect(page.getByTestId("text-closeout-count-callback")).toHaveText("Needed a callback: 0 of 1");
    await expect(page.getByTestId(`row-closeout-${requestId}`)).toContainText("Came the same day and left the kitchen clean.");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
