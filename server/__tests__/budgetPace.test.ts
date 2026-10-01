/**
 * The pace rule behind the underspend alert and the dashboard's "behind pace"
 * count. Thresholds are constants; these tests pin what they mean in dates.
 */
import { describe, it, expect } from "vitest";
import { budgetPace, UNDERSPEND_PACE_RATIO, UNDERSPEND_QUIET_MONTHS } from "@shared/budgetPace";
import { repairBudgetItems, type RepairBudgetInputs } from "../actionItems";
import type { MaintenanceRequest, Property } from "@shared/schema";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("budgetPace", () => {
  it("calls nobody behind in June and July", () => {
    expect(budgetPace(11000, 0, 2027, at("2026-07-31")).status).toBe("early");
    expect(budgetPace(11000, 0, 2027, at("2026-08-01")).status).toBe("behind");
  });

  it("is behind when spend is under half the share of the year gone", () => {
    // Half way through (about Nov 30): behind below a quarter of the budget.
    expect(budgetPace(10000, 2400, 2027, at("2026-11-30")).status).toBe("behind");
    expect(budgetPace(10000, 2600, 2027, at("2026-11-30")).status).toBe("on_pace");
  });

  it("flags the spec's example: $1,000 of $11,000 with two months left, urgently", () => {
    const pace = budgetPace(11000, 1000, 2027, at("2027-03-31"));
    expect(pace.status).toBe("behind");
    expect(pace.lastQuarter).toBe(true);
  });

  it("is urgent only in March, April and May", () => {
    expect(budgetPace(11000, 0, 2027, at("2027-02-28")).lastQuarter).toBe(false);
    expect(budgetPace(11000, 0, 2027, at("2027-03-01")).lastQuarter).toBe(true);
    expect(budgetPace(11000, 0, 2027, at("2027-05-31")).lastQuarter).toBe(true);
  });

  it("calls spend above the budget over, at any point in the year", () => {
    expect(budgetPace(10000, 10000.01, 2027, at("2026-06-15")).status).toBe("over");
    expect(budgetPace(10000, 10000, 2027, at("2027-05-31")).status).toBe("on_pace");
  });

  it("keeps its thresholds where the alert copy assumes them", () => {
    expect(UNDERSPEND_PACE_RATIO).toBe(0.5);
    expect(UNDERSPEND_QUIET_MONTHS).toEqual([5, 6]);
  });
});

// ---------------------------------------------------------------------------
// The alert built on it
// ---------------------------------------------------------------------------


describe("repairBudgetItems", () => {
  const HOUSE = { id: "p1", name: "Como Men's House", address: "981 Como Ave", region: "Northwest", ownership: "owned" } as Property;
  const MARCH = at("2027-03-31");

  const inputs = (patch: Partial<RepairBudgetInputs> = {}, spent = "1000.00", syncedAt = MARCH): RepairBudgetInputs => ({
    budgets: [{ id: "b", propertyId: "p1", fiscalYear: 2027, amount: "11000.00", region: "Northwest", createdAt: null, updatedAt: null }],
    spend: [{ id: "s", propertyId: "p1", fiscalYear: 2027, amount: spent, region: "Northwest", syncedAt }],
    linkedPropertyIds: ["p1"],
    spendCurrent: true,
    ...patch,
  });
  const wish = (id: string, status = "pending") =>
    ({ id, buildingAddress: "981 Como Ave", priority: "wishlist", status, type: "request" }) as MaintenanceRequest;

  it("says how far behind, with how long left, and counts the open wishlist ideas", () => {
    const [item] = repairBudgetItems(inputs(), [HOUSE], [wish("w1"), wish("w2"), wish("w3", "completed")], MARCH);
    expect(item).toMatchObject({
      id: "p1",
      source: "budget",
      title: "$1,000 of $11,000 spent with 2 months left in FY2027 — Como Men's House",
      subtitle: "Behind the year's pace · 2 wishlist ideas for the rest of the budget",
      overdue: true,
    });
  });

  it("is quieter outside the last quarter: not overdue, no due date", () => {
    const [item] = repairBudgetItems(inputs({}, "500.00", at("2026-11-30")), [HOUSE], [], at("2026-11-30"));
    expect(item).toMatchObject({ overdue: false, dueDate: null });
  });

  it("notes overspending quietly", () => {
    const [item] = repairBudgetItems(inputs({}, "12000.00"), [HOUSE], [], MARCH);
    expect(item).toMatchObject({ title: "Over the FY2027 repair budget — Como Men's House", overdue: false, dueDate: null });
  });

  it("never alerts on a house that is not linked, has no current figure, or has no budget", () => {
    expect(repairBudgetItems(inputs({ linkedPropertyIds: [] }), [HOUSE], [], MARCH)).toEqual([]);
    expect(repairBudgetItems(inputs({ spendCurrent: false }), [HOUSE], [], MARCH)).toEqual([]);
    expect(repairBudgetItems(inputs({}, "1000.00", at("2027-03-01")), [HOUSE], [], MARCH)).toEqual([]); // that house's figure is weeks old
    expect(repairBudgetItems(inputs({ spend: [] }), [HOUSE], [], MARCH)).toEqual([]);
    expect(repairBudgetItems(inputs({ budgets: [] }), [HOUSE], [], MARCH)).toEqual([]);
    expect(repairBudgetItems(inputs(), [{ ...HOUSE, ownership: "rented" } as Property], [], MARCH)).toEqual([]);
  });

  it("does alert on the same house once everything is in place (positive control)", () => {
    expect(repairBudgetItems(inputs(), [HOUSE], [], MARCH)).toHaveLength(1);
  });
});
