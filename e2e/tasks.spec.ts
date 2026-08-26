import { test, expect } from "@playwright/test";

test.describe("tasks", () => {
  test("the Tasks nav item opens the page with its tabs and add control", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("link-tasks").click();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await expect(page.getByTestId("tab-todo")).toBeVisible();
    await expect(page.getByTestId("tab-manage")).toBeVisible();
    await expect(page.getByTestId("button-add-task")).toBeVisible();
  });

  test("the add-task dialog offers a scope and creates a personal task", async ({ page }) => {
    await page.goto("/tasks");
    await page.getByTestId("button-add-task").click();
    await page.getByTestId("input-task-title").fill("Playwright test task");
    // Scope defaults to "Just me"; leave it and submit.
    await page.getByTestId("select-task-scope").click();
    await page.getByRole("option", { name: "Just me" }).click();
    await page.getByTestId("button-submit-task").click();

    // The new task shows up under "Manage tasks". Use first() because the shared
    // demo DB is not reset between runs, so a prior run may have left one too.
    await page.getByTestId("tab-manage").click();
    await expect(page.getByText("Playwright test task").first()).toBeVisible();
  });

  test("the dashboard shows the action-items panel linking to Tasks", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Action items" })).toBeVisible();
    await page.getByTestId("button-view-tasks").click();
    await expect(page).toHaveURL(/\/tasks$/);
  });
});
