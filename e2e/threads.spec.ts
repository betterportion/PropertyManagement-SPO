import { test, expect, request as apiRequest, type Page } from "@playwright/test";

/**
 * Request threads, end to end.
 *
 * The route tests pin who may read and post what. What only a browser can
 * show is the round trip the feature exists for: staff post into a thread
 * with the composer starting on Internal, the household sees the shared
 * half and nothing else, and what the household posts comes back to staff
 * attributed to the person who wrote it.
 *
 * Runs as the admin by default (playwright.config), and opens a second
 * context as the resident for the household half. The resident already
 * owns "E2E resident request" on their house (global-setup), so no grants
 * are needed. The three tests are one story and run in order.
 */
test.describe.configure({ mode: "serial" });

const REQUEST_TITLE = "E2E resident request";
// Fresh bodies each run, so no assertion can pass on a comment left behind
// by an earlier one.
const RUN = Date.now();
const INTERNAL_BODY = `Internal ${RUN}: he quoted $4,200 for the lot.`;
const SHARED_BODY = `Shared ${RUN}: the plumber is coming Thursday at 9.`;
const RESIDENT_BODY = `Household ${RUN}: it is dripping faster than last week.`;

/** Opens the seeded request from whichever list this account has. */
async function openSeededRequest(page: Page, listPath: string) {
  await page.goto(listPath);
  await page.locator('[data-testid^="link-request-"]', { hasText: REQUEST_TITLE }).first().click();
  await expect(page).toHaveURL(/\/maintenance\/[^/]+$/);
  await expect(page.getByRole("heading", { name: REQUEST_TITLE })).toBeVisible();
}

/** The comment row carrying this body. */
function commentWith(page: Page, body: string) {
  return page.locator('li[data-testid^="comment-"]', { hasText: body });
}

test.describe("request threads", () => {
  test.afterAll(async () => {
    // Tidy the run's comments so the thread does not grow by three a run.
    // Best effort, as the admin: a failure here is not a failure of the
    // feature. (The per-test `request` fixture is not available in afterAll.)
    const api = await apiRequest.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: "e2e/.auth/admin.json",
    });
    try {
      const list = await api.get("/api/maintenance-requests");
      if (!list.ok()) return;
      const seeded = (await list.json()).find((r: { title: string }) => r.title === REQUEST_TITLE);
      if (!seeded) return;
      const thread = await api.get(`/api/maintenance-requests/${seeded.id}/comments`);
      if (!thread.ok()) return;
      for (const comment of await thread.json()) {
        if (String(comment.body).includes(String(RUN))) {
          await api.delete(`/api/maintenance-request-comments/${comment.id}`);
        }
      }
    } finally {
      await api.dispose();
    }
  });

  test("staff's composer starts on Internal, and posts an internal then a shared comment", async ({ page }) => {
    await openSeededRequest(page, "/maintenance");

    // Internal is the default every time, readable at a glance.
    await expect(page.getByTestId("button-visibility-internal")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("button-visibility-shared")).toHaveAttribute("aria-pressed", "false");
    // A file can go with the comment; the route tests pin who may store one.
    await expect(page.getByTestId("button-attach-file")).toBeVisible();
    // A repair carries no project fields and no bids, so neither card is on
    // the page -- for staff included, not only for the household.
    await expect(page.getByTestId("request-project-card")).toHaveCount(0);
    await expect(page.getByTestId("request-bids")).toHaveCount(0);

    await page.getByTestId("input-comment-body").fill(INTERNAL_BODY);
    await page.getByTestId("button-post-comment").click();
    await expect(commentWith(page, INTERNAL_BODY)).toBeVisible();
    await expect(commentWith(page, INTERNAL_BODY).locator('[data-testid^="comment-visibility-"]')).toHaveText("Internal");

    // Posting put the control back on Internal; the shared one is a choice.
    await expect(page.getByTestId("button-visibility-internal")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("button-visibility-shared").click();
    await expect(page.getByTestId("button-visibility-shared")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("input-comment-body").fill(SHARED_BODY);
    await page.getByTestId("button-post-comment").click();
    await expect(commentWith(page, SHARED_BODY)).toBeVisible();
    await expect(commentWith(page, SHARED_BODY).locator('[data-testid^="comment-visibility-"]')).toHaveText("Shared");
  });

  test("the household sees the shared comment and nothing of the internal one", async ({ browser }) => {
    const household = await browser.newContext({ storageState: "e2e/.auth/resident.json" });
    try {
      const page = await household.newPage();
      await openSeededRequest(page, "/my-requests");

      await expect(commentWith(page, SHARED_BODY)).toBeVisible();
      // Not hidden -- absent. The server never sent it.
      await expect(page.getByText(INTERNAL_BODY)).toHaveCount(0);
      await expect(page.getByText("$4,200")).toHaveCount(0);
      // No visibility badges either: to a household every comment is shared.
      await expect(page.locator('[data-testid^="comment-visibility-"]')).toHaveCount(0);
    } finally {
      await household.close();
    }
  });

  test("the household posts, and staff see it attributed to them", async ({ page, browser }) => {
    const household = await browser.newContext({ storageState: "e2e/.auth/resident.json" });
    try {
      const residentPage = await household.newPage();
      await openSeededRequest(residentPage, "/my-requests");

      // One box and one button; nothing to get wrong.
      await expect(residentPage.getByTestId("form-comment")).toBeVisible();
      await expect(residentPage.getByTestId("button-visibility-internal")).toHaveCount(0);
      await expect(residentPage.getByTestId("text-resident-composer-explainer")).toContainText("property team");
      // A household may attach a photo to what it posts, through the
      // request's own attachment route rather than the staff document one.
      await expect(residentPage.getByTestId("button-attach-file")).toBeVisible();

      await residentPage.getByTestId("input-comment-body").fill(RESIDENT_BODY);
      await residentPage.getByTestId("button-post-comment").click();
      const posted = commentWith(residentPage, RESIDENT_BODY);
      await expect(posted).toBeVisible();
      await expect(posted.locator('[data-testid^="comment-author-"]')).toContainText("e2e-resident@test.local");
      // Their own comment is theirs to take down; staff's is not.
      await expect(posted.locator('[data-testid^="button-delete-comment-"]')).toBeVisible();
      await expect(commentWith(residentPage, SHARED_BODY).locator('[data-testid^="button-delete-comment-"]')).toHaveCount(0);
    } finally {
      await household.close();
    }

    // Staff, on a fresh load: the household's comment, shared, and who wrote it.
    await openSeededRequest(page, "/maintenance");
    const seen = commentWith(page, RESIDENT_BODY);
    await expect(seen).toBeVisible();
    await expect(seen.locator('[data-testid^="comment-author-"]')).toContainText("e2e-resident@test.local");
    await expect(seen.locator('[data-testid^="comment-visibility-"]')).toHaveText("Shared");
  });
});
