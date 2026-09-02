/**
 * The per-property setup checklist rules.
 *
 * Pure — definitions and stored rows in, counts out — so the dashboard badge,
 * the property page and the action item all read the same numbers without a
 * database or a clock between them.
 *
 * The rule worth guarding hardest is the one about untracked properties. The
 * checklist is generated on property creation and deliberately not backfilled,
 * so every house that predates it has zero rows. If "no rows" counted as
 * "everything open", every existing property would light up the dashboard on
 * the day this ships, which is the opposite of surfacing what needs attention.
 */
import { describe, it, expect } from "vitest";
import {
  SETUP_ITEMS,
  setupItemsFor,
  summarizeSetup,
  type SetupItemStatus,
} from "@shared/propertySetup";

/** A stored completion row, reduced to what the summary actually reads. */
const row = (key: string, status: SetupItemStatus) => ({ itemKey: key, status });

describe("which items a house's checklist starts with", () => {
  it("gives every house the four utilities separately, never one combined entry", () => {
    // One "utilities" checkbox hides which one is missing, and that is exactly
    // what gets forgotten.
    for (const ownership of ["owned", "rented"] as const) {
      const keys = setupItemsFor(ownership).map((item) => item.key);
      expect(keys).toEqual(expect.arrayContaining(["electric", "gas", "water", "internet"]));
    }
  });

  it("gives every house insurance, a startup budget and the handover to the household", () => {
    for (const ownership of ["owned", "rented"] as const) {
      const keys = setupItemsFor(ownership).map((item) => item.key);
      expect(keys).toEqual(
        expect.arrayContaining(["insurance", "startup_budget", "communicated_to_household"]),
      );
    }
  });

  it("asks a rented house for its lease and maintenance portal, and an owned one for neither", () => {
    const rented = setupItemsFor("rented").map((item) => item.key);
    const owned = setupItemsFor("owned").map((item) => item.key);

    expect(rented).toEqual(expect.arrayContaining(["lease_on_file", "maintenance_portal"]));
    expect(owned).not.toContain("lease_on_file");
    expect(owned).not.toContain("maintenance_portal");
  });

  it("asks an owned house who maintains it, and a rented one not at all", () => {
    expect(setupItemsFor("owned").map((item) => item.key)).toContain("responsible_maintenance_person");
    expect(setupItemsFor("rented").map((item) => item.key)).not.toContain(
      "responsible_maintenance_person",
    );
  });

  it("keeps every key unique, so a completion row can only ever mean one thing", () => {
    const keys = SETUP_ITEMS.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every item a label a non-technical reader understands", () => {
    for (const item of SETUP_ITEMS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.label).not.toBe(item.key);
    }
  });
});

describe("summarising where a house's setup stands", () => {
  it("reports a house with no rows as untracked rather than as everything open", () => {
    const summary = summarizeSetup([], "owned");
    expect(summary.tracked).toBe(false);
    expect(summary.open).toBe(0);
    expect(summary.complete).toBe(false);
  });

  it("counts a missing row for a tracked house as still open", () => {
    // One row exists, so the house is tracked; the rest have never been set.
    const summary = summarizeSetup([row("electric", "done")], "owned");
    const total = setupItemsFor("owned").length;
    expect(summary.tracked).toBe(true);
    expect(summary.done).toBe(1);
    expect(summary.open).toBe(total - 1);
    expect(summary.total).toBe(total);
  });

  it("treats not-applicable as resolved, so a rented house without insurance can finish", () => {
    const rows = setupItemsFor("rented").map((item) =>
      row(item.key, item.key === "insurance" ? "not_applicable" : "done"),
    );
    const summary = summarizeSetup(rows, "rented");
    expect(summary.notApplicable).toBe(1);
    expect(summary.open).toBe(0);
    expect(summary.complete).toBe(true);
  });

  it("is not complete while one item is still open", () => {
    const rows = setupItemsFor("owned").map((item, index) =>
      row(item.key, index === 0 ? "open" : "done"),
    );
    const summary = summarizeSetup(rows, "owned");
    expect(summary.open).toBe(1);
    expect(summary.complete).toBe(false);
  });

  it("ignores a stored row whose item no longer exists in code", () => {
    // The list is fixed in code. Removing an entry later must not leave a
    // phantom in the counts, and must not make a finished house unfinishable.
    const rows = [
      ...setupItemsFor("owned").map((item) => row(item.key, "done" as const)),
      row("some_retired_item", "open"),
    ];
    const summary = summarizeSetup(rows, "owned");
    expect(summary.total).toBe(setupItemsFor("owned").length);
    expect(summary.open).toBe(0);
    expect(summary.complete).toBe(true);
  });

  it("ignores a row belonging to the other ownership type", () => {
    // A house switched from rented to owned keeps its old lease row. It is not
    // part of the owned checklist and must not hold the house open forever.
    const rows = [
      ...setupItemsFor("owned").map((item) => row(item.key, "done" as const)),
      row("lease_on_file", "open"),
    ];
    expect(summarizeSetup(rows, "owned").complete).toBe(true);
  });

  it("counts the last row of a duplicated key once", () => {
    // The table is unique on (property, item), so this should be unreachable —
    // but the summary must not double-count if it ever is.
    const rows = [row("electric", "open"), row("electric", "done")];
    const summary = summarizeSetup(rows, "owned");
    expect(summary.done).toBe(1);
    expect(summary.open).toBe(setupItemsFor("owned").length - 1);
  });
});
