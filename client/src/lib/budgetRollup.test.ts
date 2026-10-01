/**
 * The dashboard's budget rollup. What matters is that a house without a
 * current figure is never counted as behind, and that "% used" compares the
 * spend only with the budgets of the houses that reported it.
 */
import { describe, it, expect } from "vitest";
import { budgetsByRegion, houseBudgets, type SpendResponse } from "./budgetRollup";
import type { Property, RepairBudget } from "@shared/schema";

const NOW = new Date("2027-03-15T12:00:00Z");
const house = (id: string, region = "Northwest", ownership = "owned") =>
  ({ id, name: `${id} House`, region, ownership }) as Property;
const budget = (propertyId: string, amount: string) =>
  ({ id: `b-${propertyId}`, propertyId, fiscalYear: 2027, amount, region: "Northwest" }) as RepairBudget;
const spendOf = (propertyId: string, amount: string, syncedAt = NOW) => ({
  id: `s-${propertyId}`,
  propertyId,
  fiscalYear: 2027,
  amount,
  region: "Northwest",
  syncedAt,
});

const connected = (patch: Partial<SpendResponse> = {}): SpendResponse => ({
  connected: true,
  lastSuccessAt: NOW.toISOString(),
  stale: false,
  linkedPropertyIds: ["a", "b"],
  spend: [spendOf("a", "1000.00"), spendOf("b", "9000.00")],
  ...patch,
});

describe("houseBudgets", () => {
  const properties = [house("a"), house("b"), house("c"), house("r", "Northwest", "rented")];
  const budgets = [budget("a", "11000.00"), budget("b", "10000.00"), budget("c", "10500.00")];

  it("lists owned houses only, each with why it has or lacks a figure", () => {
    const rows = houseBudgets(properties, budgets, connected(), 2027, NOW);
    expect(rows.map((r) => [r.property.id, r.spendState, r.pace?.status ?? null])).toEqual([
      ["a", "current", "behind"],
      ["b", "current", "on_pace"],
      ["c", "not_linked", null],
    ]);
  });

  it("gives no house a pace while QuickBooks is off or out of date", () => {
    expect(houseBudgets(properties, budgets, connected({ connected: false }), 2027, NOW).every((r) => r.pace === null)).toBe(true);
    expect(houseBudgets(properties, budgets, connected({ stale: true }), 2027, NOW).every((r) => r.pace === null)).toBe(true);
  });
});

describe("budgetsByRegion", () => {
  it("totals every budget, but compares spend only with the budgets that reported it", () => {
    const rows = houseBudgets([house("a"), house("b"), house("c")], [budget("a", "11000.00"), budget("b", "10000.00"), budget("c", "10500.00")], connected(), 2027, NOW);
    const [northwest] = budgetsByRegion(rows);
    expect(northwest).toMatchObject({ region: "Northwest", budget: 31500, budgeted: 3, spent: 10000, reportingBudget: 21000, reporting: 2, behind: 1, over: 0 });
  });
});
