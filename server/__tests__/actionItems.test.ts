import { describe, it, expect } from "vitest";
import { buildActionItems, type ActionItemInputs } from "../actionItems";
import type { MaintenanceSchedule, RentPayment, SecurityDeposit, Resident, Task, Property, PropertySetupItem, Asset } from "@shared/schema";

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

const empty: ActionItemInputs = { schedules: [], rentPayments: [], deposits: [], residents: [], tasks: [], properties: [], setupItems: [], assets: [] };

function asset(over: Partial<Asset>): Asset {
  return {
    id: "a1", name: "Water heater", category: "Water Heater", buildingAddress: "1 Main St",
    region: "West Central", acquisitionDate: null, expectedLifespanYears: null,
    replacementDueDate: null, snoozedUntil: null, ...over,
  } as Asset;
}

function setupItem(over: Partial<PropertySetupItem>): PropertySetupItem {
  return { id: "si1", propertyId: "p1", itemKey: "electric", status: "open", region: "West Central", ...over } as PropertySetupItem;
}

describe("when a deposit has to go back", () => {
  const HOUSE = property({ id: "p1", ownership: "owned", leaseRenewalDate: null, depositReturnDays: 21 });

  const leaving = (over: Partial<Resident> = {}) =>
    resident({ id: "res-gone", propertyId: "p1", isActive: false, moveOutDate: days(-1), ...over });

  it("gives the item a deadline counted from the move-out date", () => {
    // The clock starts when possession came back, not at lease end -- somebody
    // can leave in April on a lease running to July.
    const items = buildActionItems({
      ...empty,
      properties: [HOUSE],
      deposits: [deposit({ propertyId: "p1" })],
      residents: [leaving({ moveOutDate: days(-1) })],
    }, NOW);

    const item = items.find((i) => i.source === "deposit")!;
    // Moved out yesterday, 21 days to return it.
    expect(item.dueDate?.slice(0, 10)).toBe("2026-09-04");
    expect(item.overdue).toBe(false);
  });

  it("reads as overdue once the window has closed", () => {
    const items = buildActionItems({
      ...empty,
      properties: [HOUSE],
      deposits: [deposit({ propertyId: "p1" })],
      residents: [leaving({ moveOutDate: days(-60) })],
    }, NOW);
    expect(items.find((i) => i.source === "deposit")!.overdue).toBe(true);
  });

  it("warns before somebody has even left, so the money is ready", () => {
    const items = buildActionItems({
      ...empty,
      properties: [HOUSE],
      deposits: [deposit({ propertyId: "p1" })],
      residents: [resident({ id: "res-gone", propertyId: "p1", isActive: true, moveOutDate: days(20) })],
    }, NOW);
    expect(items.filter((i) => i.source === "deposit")).toHaveLength(1);
  });

  it("stays quiet about a move-out further out than the warning window", () => {
    const items = buildActionItems({
      ...empty,
      properties: [HOUSE],
      deposits: [deposit({ propertyId: "p1" })],
      residents: [resident({ id: "res-gone", propertyId: "p1", isActive: true, moveOutDate: days(120) })],
    }, NOW);
    expect(items.filter((i) => i.source === "deposit")).toHaveLength(0);
  });

  it("has no deadline when the house has no setting, but still raises the item", () => {
    // The number is SPO's own reminder setting, not a legal determination.
    // Without one there is nothing to count to -- but a deposit still held for
    // somebody who has left is still worth surfacing.
    const items = buildActionItems({
      ...empty,
      properties: [property({ id: "p1", ownership: "owned", leaseRenewalDate: null, depositReturnDays: null })],
      deposits: [deposit({ propertyId: "p1" })],
      residents: [leaving()],
    }, NOW);
    const item = items.find((i) => i.source === "deposit");
    expect(item).toBeTruthy();
    expect(item!.dueDate).toBeNull();
  });

  it("clears the moment the deposit is marked returned", () => {
    const items = buildActionItems({
      ...empty,
      properties: [HOUSE],
      deposits: [deposit({ propertyId: "p1", status: "returned" })],
      residents: [leaving()],
    }, NOW);
    expect(items.filter((i) => i.source === "deposit")).toHaveLength(0);
  });

  it("stays raised while a statement has been sent but the money has not gone back", () => {
    // "Statement sent" is progress, not completion. The deposit is still held.
    const items = buildActionItems({
      ...empty,
      properties: [HOUSE],
      deposits: [deposit({ propertyId: "p1", status: "statement_sent" })],
      residents: [leaving()],
    }, NOW);
    expect(items.filter((i) => i.source === "deposit")).toHaveLength(1);
  });
});

describe("assets coming up for replacement on the dashboard", () => {
  it("raises an asset whose replacement is inside the warning window", () => {
    const items = buildActionItems({
      ...empty,
      assets: [asset({ id: "boiler", replacementDueDate: days(200) })],
    }, NOW);
    const assetItems = items.filter((i) => i.source === "asset");
    expect(assetItems).toHaveLength(1);
    expect(assetItems[0].id).toBe("boiler");
  });

  it("says nothing about an asset that is years away", () => {
    const items = buildActionItems({
      ...empty,
      assets: [asset({ id: "roof", replacementDueDate: days(365 * 10) })],
    }, NOW);
    expect(items.filter((i) => i.source === "asset")).toHaveLength(0);
  });

  it("says nothing about an unrated asset, and never guesses at one", () => {
    // SPO's tracking is patchy on purpose-of-record. An asset with no date is
    // unrated, and a guess here would be indistinguishable from a real warning.
    const items = buildActionItems({
      ...empty,
      assets: [asset({ id: "mystery", acquisitionDate: null, replacementDueDate: null })],
    }, NOW);
    expect(items.filter((i) => i.source === "asset")).toHaveLength(0);
  });

  it("hides a snoozed asset from the dashboard", () => {
    // Only the dashboard. The asset screen still shows it, and shows that it
    // is snoozed -- hiding it everywhere is how a boiler gets forgotten.
    const items = buildActionItems({
      ...empty,
      assets: [asset({ id: "boiler", replacementDueDate: days(-30), snoozedUntil: days(300) })],
    }, NOW);
    expect(items.filter((i) => i.source === "asset")).toHaveLength(0);
  });

  it("brings a snoozed asset back once the snooze runs out", () => {
    const items = buildActionItems({
      ...empty,
      assets: [asset({ id: "boiler", replacementDueDate: days(-30), snoozedUntil: days(-1) })],
    }, NOW);
    expect(items.filter((i) => i.source === "asset")).toHaveLength(1);
  });

  it("marks an asset past its date as overdue and carries its region", () => {
    const items = buildActionItems({
      ...empty,
      assets: [asset({ id: "boiler", replacementDueDate: days(-30) })],
    }, NOW);
    const item = items.find((i) => i.source === "asset")!;
    expect(item.overdue).toBe(true);
    expect(item.region).toBe("West Central");
  });

  it("names the asset and the house, so the row is actionable without opening it", () => {
    const items = buildActionItems({
      ...empty,
      assets: [asset({ id: "boiler", name: "Rheem water heater", replacementDueDate: days(100) })],
    }, NOW);
    const item = items.find((i) => i.source === "asset")!;
    expect(item.title).toContain("Rheem water heater");
    expect(item.subtitle).toContain("1 Main St");
  });
});

describe("the setup checklist on the dashboard", () => {
  const owned = property({ id: "p1", ownership: "owned", leaseRenewalDate: null });

  it("raises one item per house, never one per open check", () => {
    // Seven separate entries for one house would bury the maintenance triage
    // this space actually belongs to.
    const items = buildActionItems({
      ...empty,
      properties: [owned],
      setupItems: [
        setupItem({ id: "a", itemKey: "electric", status: "open" }),
        setupItem({ id: "b", itemKey: "gas", status: "open" }),
        setupItem({ id: "c", itemKey: "water", status: "done" }),
      ],
    }, NOW);

    const setup = items.filter((i) => i.source === "setup");
    expect(setup).toHaveLength(1);
    expect(setup[0].id).toBe("p1");
    // Eight items on an owned house: two stored open, one done, and the five
    // never written yet also count as open.
    expect(setup[0].subtitle).toContain("7 of 8");
  });

  it("says nothing about a house that has no checklist at all", () => {
    // Existing houses are deliberately not backfilled. If "no rows" read as
    // "everything open", every house SPO already has would light up on the day
    // this ships.
    const items = buildActionItems({ ...empty, properties: [owned], setupItems: [] }, NOW);
    expect(items.filter((i) => i.source === "setup")).toHaveLength(0);
  });

  it("clears the moment the last item resolves", () => {
    const rows = [
      setupItem({ id: "a", itemKey: "electric", status: "done" }),
      setupItem({ id: "b", itemKey: "gas", status: "done" }),
      setupItem({ id: "c", itemKey: "water", status: "done" }),
      setupItem({ id: "d", itemKey: "internet", status: "done" }),
      setupItem({ id: "e", itemKey: "insurance", status: "not_applicable" }),
      setupItem({ id: "f", itemKey: "responsible_maintenance_person", status: "done" }),
      setupItem({ id: "g", itemKey: "startup_budget", status: "done" }),
      setupItem({ id: "h", itemKey: "communicated_to_household", status: "done" }),
    ];
    const items = buildActionItems({ ...empty, properties: [owned], setupItems: rows }, NOW);
    expect(items.filter((i) => i.source === "setup")).toHaveLength(0);
  });

  it("reads a rented house against the rented checklist", () => {
    // A rented house is asked for its lease; an owned one never is. Summarising
    // a rented house against the owned list would report it finished early.
    const rented = property({ id: "p2", ownership: "rented", leaseRenewalDate: null });
    const items = buildActionItems({
      ...empty,
      properties: [rented],
      setupItems: [setupItem({ id: "a", propertyId: "p2", itemKey: "electric", status: "done" })],
    }, NOW);
    const setup = items.filter((i) => i.source === "setup");
    expect(setup).toHaveLength(1);
    // Nine on a rented house — the two an owned house is never asked for.
    expect(setup[0].subtitle).toContain("8 of 9");
  });

  it("carries the house's region so it is filtered like everything else", () => {
    const items = buildActionItems({
      ...empty,
      properties: [owned],
      setupItems: [setupItem({ id: "a", status: "open" })],
    }, NOW);
    expect(items.find((i) => i.source === "setup")!.region).toBe("West Central");
  });

  it("ignores checklist rows belonging to a house that is not in the list", () => {
    const items = buildActionItems({
      ...empty,
      properties: [owned],
      setupItems: [setupItem({ id: "a", propertyId: "p-deleted", status: "open" })],
    }, NOW);
    expect(items.filter((i) => i.source === "setup")).toHaveLength(0);
  });
});

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

  it("keeps a bounced (failed) payment on the list — the money is still owed", () => {
    const items = buildActionItems({
      ...empty,
      rentPayments: [rent({ id: "f", status: "failed", period: "2026-07" })],
    }, NOW);
    expect(items.map((i) => i.id)).toEqual(["f"]);
    expect(items[0].title).toContain("Failed rent payment");
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
