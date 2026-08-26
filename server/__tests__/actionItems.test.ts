import { describe, it, expect } from "vitest";
import { buildActionItems, type ActionItemInputs } from "../actionItems";
import type { MaintenanceSchedule, RentPayment, SecurityDeposit, Resident, Task, Property } from "@shared/schema";

// buildActionItems only reads a handful of fields off each record, so the
// factories fill just those and cast; a full row would be noise.
const NOW = new Date("2026-08-15T00:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

function schedule(over: Partial<MaintenanceSchedule>): MaintenanceSchedule {
  return { id: "s1", title: "Furnace service", isActive: true, nextDueDate: days(5), buildingAddress: "1 Main St", region: "West Central", ...over } as MaintenanceSchedule;
}
function rent(over: Partial<RentPayment>): RentPayment {
  return { id: "r1", status: "unpaid", period: "2026-07", amount: "700", buildingAddress: "1 Main St", region: "West Central", ...over } as RentPayment;
}
function deposit(over: Partial<SecurityDeposit>): SecurityDeposit {
  return { id: "d1", status: "held", residentId: "res-gone", amountHeld: "700", buildingAddress: "1 Main St", region: "West Central", ...over } as SecurityDeposit;
}
function resident(over: Partial<Resident>): Resident {
  return { id: "res-gone", isActive: false, ...over } as Resident;
}
function task(over: Partial<Task>): Task {
  return { id: "t1", status: "open", dueDate: null, title: "Call plumber", notes: null, category: "general", region: "West Central", ...over } as Task;
}
function property(over: Partial<Property>): Property {
  return {
    id: "p1", name: "Cleveland House", address: "1 Main St", region: "West Central",
    ownership: "rented", leaseRenewalDate: days(20), renewalDecision: "undecided", ...over,
  } as Property;
}

const empty: ActionItemInputs = { schedules: [], rentPayments: [], deposits: [], residents: [], tasks: [], properties: [] };

describe("buildActionItems", () => {
  it("includes a schedule due within the 30-day window and marks overdue ones", () => {
    const items = buildActionItems({
      ...empty,
      schedules: [schedule({ id: "soon", nextDueDate: days(5) }), schedule({ id: "past", nextDueDate: days(-3) })],
    }, NOW);
    expect(items.map((i) => i.id).sort()).toEqual(["past", "soon"]);
    expect(items.find((i) => i.id === "past")!.overdue).toBe(true);
    expect(items.find((i) => i.id === "soon")!.overdue).toBe(false);
  });

  it("excludes schedules beyond the window and inactive ones", () => {
    const items = buildActionItems({
      ...empty,
      schedules: [schedule({ id: "far", nextDueDate: days(60) }), schedule({ id: "off", isActive: false, nextDueDate: days(1) })],
    }, NOW);
    expect(items).toHaveLength(0);
  });

  it("includes unpaid rent, dates it from the period, and skips paid/waived", () => {
    const items = buildActionItems({
      ...empty,
      rentPayments: [rent({ id: "u", status: "unpaid", period: "2026-07" }), rent({ id: "p", status: "paid" }), rent({ id: "w", status: "waived" })],
    }, NOW);
    expect(items.map((i) => i.id)).toEqual(["u"]);
    // End of 2026-07 is before NOW (2026-08-15), so it reads as overdue.
    expect(items[0].overdue).toBe(true);
    expect(items[0].amount).toBe("700");
  });

  it("surfaces a held deposit only when its resident has moved out", () => {
    const moved = buildActionItems({ ...empty, deposits: [deposit({})], residents: [resident({ isActive: false })] }, NOW);
    expect(moved).toHaveLength(1);
    expect(moved[0].source).toBe("deposit");

    const stillHere = buildActionItems({ ...empty, deposits: [deposit({})], residents: [resident({ isActive: true })] }, NOW);
    expect(stillHere).toHaveLength(0);

    const returned = buildActionItems({ ...empty, deposits: [deposit({ status: "returned" })], residents: [resident({ isActive: false })] }, NOW);
    expect(returned).toHaveLength(0);
  });

  it("surfaces a rented lease renewing within 60 days, and flags overdue ones", () => {
    const items = buildActionItems({
      ...empty,
      properties: [property({ id: "soon", leaseRenewalDate: days(30) }), property({ id: "past", leaseRenewalDate: days(-5) })],
    }, NOW);
    expect(items.map((i) => i.id).sort()).toEqual(["past", "soon"]);
    expect(items.every((i) => i.source === "lease" && i.category === "property")).toBe(true);
    expect(items.find((i) => i.id === "past")!.overdue).toBe(true);
  });

  it("excludes owned houses, ones with no renewal date, not-renewing, and far-off renewals", () => {
    const items = buildActionItems({
      ...empty,
      properties: [
        property({ id: "owned", ownership: "owned" }),
        property({ id: "nodate", leaseRenewalDate: null }),
        property({ id: "leaving", renewalDecision: "not_renewing" }),
        property({ id: "far", leaseRenewalDate: days(90) }),
      ],
    }, NOW);
    expect(items).toHaveLength(0);
  });

  it("includes only open manual tasks", () => {
    const items = buildActionItems({
      ...empty,
      tasks: [task({ id: "open" }), task({ id: "done", status: "done" })],
    }, NOW);
    expect(items.map((i) => i.id)).toEqual(["open"]);
  });

  it("ranks overdue first, then soonest due, then undated last", () => {
    const items = buildActionItems({
      ...empty,
      schedules: [schedule({ id: "dueSoon", nextDueDate: days(5) }), schedule({ id: "overdue", nextDueDate: days(-10) })],
      tasks: [task({ id: "noDate", dueDate: null })],
    }, NOW);
    expect(items.map((i) => i.id)).toEqual(["overdue", "dueSoon", "noDate"]);
  });

  it("breaks a due-date tie by category, finance ahead of property", () => {
    // Rent for 2026-07 is due the last day of July; give the schedule the exact
    // same due date so only the category tie-break can order them.
    const endOfJuly = new Date("2026-07-31T00:00:00Z");
    const items = buildActionItems({
      ...empty,
      schedules: [schedule({ id: "prop", nextDueDate: endOfJuly })],
      rentPayments: [rent({ id: "fin", period: "2026-07" })],
    }, NOW);
    expect(items.map((i) => i.category)).toEqual(["finance", "property"]);
  });
});
