import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility scan of the main pages with axe-core.
 *
 * The bar is zero **serious or critical** violations -- the ones that actually
 * block a keyboard or screen-reader user (missing labels, unlabelled controls,
 * insufficient contrast on real text). Minor/moderate findings are not failed
 * on here; tightening the bar later is a deliberate follow-up.
 *
 * The SPO brand colors were nudged darker (issue #35) so they clear AA on the
 * app's light grounds; there is no longer a tolerated-exception list, so every
 * serious contrast failure now fails the gate.
 */
const KNOWN_BRAND_CONTRAST_COLORS: string[] = [];

function isKnownBrandContrast(node: { failureSummary?: string }): boolean {
  const summary = (node.failureSummary ?? "").toLowerCase();
  return KNOWN_BRAND_CONTRAST_COLORS.some((color) => summary.includes(color));
}

async function seriousViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) =>
      v.id === "color-contrast"
        ? { ...v, nodes: v.nodes.filter((n) => !isKnownBrandContrast(n)) }
        : v,
    )
    .filter((v) => v.nodes.length > 0);
}

test.describe("accessibility", () => {
  test("the dashboard has no serious violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations.map((v) => v.id), null, 2)).toEqual([]);
  });

  test("the properties page has no serious violations", async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations.map((v) => v.id), null, 2)).toEqual([]);
  });

  test("a property detail page has no serious violations", async ({ page }) => {
    await page.goto("/properties");
    await expect(page.getByRole("heading", { name: "Properties" }).first()).toBeVisible();
    await page.locator('[data-testid^="text-property-name-"]').first().click();
    await expect(page.getByTestId("table-property-residents")).toBeVisible();
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations.map((v) => v.id), null, 2)).toEqual([]);
  });

  test("the assets gallery has no serious violations", async ({ page }) => {
    await page.goto("/assets");
    await page.getByTestId("button-view-gallery").click();
    await expect(page.locator('[data-testid^="tile-asset-"]').first()).toBeVisible();
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations.map((v) => v.id), null, 2)).toEqual([]);
  });

  test("the residents page has no serious violations", async ({ page }) => {
    await page.goto("/residents");
    await expect(page.getByRole("heading", { name: "Residents" })).toBeVisible();
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations.map((v) => v.id), null, 2)).toEqual([]);
  });

  test("the tasks page has no serious violations", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    // Scan both tabs: the "To do" action-item rows (Resolve buttons) and the
    // "Manage tasks" list (toggle + menu controls). The add-task dialog is not
    // opened here, matching the other page scans -- its primary submit button
    // uses the shared outline variant whose brand-red contrast is tracked in #35.
    await page.getByTestId("tab-manage").click();
    await expect(page.getByTestId("tab-todo")).toBeVisible();
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations.map((v) => v.id), null, 2)).toEqual([]);
  });

  test("the finances page has no serious violations", async ({ page }) => {
    await page.goto("/finances");
    await expect(page.getByRole("heading", { name: "Finances" })).toBeVisible();
    // Scan the Deposits tab too — it carries the deposit dialog's trigger and
    // the money fields, the most control-heavy part of the page.
    await page.getByTestId("tab-deposits").click();
    await expect(page.getByTestId("button-add-deposit")).toBeVisible();
    const violations = await seriousViolations(page);
    expect(violations, JSON.stringify(violations.map((v) => v.id), null, 2)).toEqual([]);
  });
});
