/**
 * Tests for the close-date rules in server/maintenanceStatus.ts.
 *
 * Pure: no database, no HTTP, and no real clock -- `now` is passed in, so the
 * "closed 119 days ago vs 121 days ago" cases the resident visibility window
 * will need are arithmetic rather than timing.
 */
import { describe, it, expect } from "vitest";
import {
  closedDateChange,
  isClosedStatus,
  CLOSED_MAINTENANCE_STATUSES,
} from "../maintenanceStatus";

const NOW = new Date("2026-08-31T12:00:00.000Z");

describe("isClosedStatus", () => {
  it("counts completed and cancelled as closed", () => {
    expect(isClosedStatus("completed")).toBe(true);
    expect(isClosedStatus("cancelled")).toBe(true);
  });

  it("counts pending and in_progress as open", () => {
    expect(isClosedStatus("pending")).toBe(false);
    expect(isClosedStatus("in_progress")).toBe(false);
  });

  it("treats an absent status as open rather than throwing", () => {
    expect(isClosedStatus(null)).toBe(false);
    expect(isClosedStatus(undefined)).toBe(false);
  });

  it("names exactly the two closed statuses", () => {
    // A fifth status added to the enum without a decision here would silently
    // be treated as open by every caller.
    expect([...CLOSED_MAINTENANCE_STATUSES]).toEqual(["completed", "cancelled"]);
  });
});

describe("closedDateChange", () => {
  it("stamps the close date when an open request is completed", () => {
    expect(closedDateChange("pending", "completed", NOW)).toEqual({ completedDate: NOW });
    expect(closedDateChange("in_progress", "completed", NOW)).toEqual({ completedDate: NOW });
  });

  it("stamps the close date when an open request is cancelled", () => {
    // Cancelled is off the queue too. If this returned nothing, a cancelled
    // request would have no close date and would sit outside the visibility
    // window forever.
    expect(closedDateChange("pending", "cancelled", NOW)).toEqual({ completedDate: NOW });
  });

  it("clears the close date when a closed request is reopened", () => {
    expect(closedDateChange("completed", "in_progress", NOW)).toEqual({ completedDate: null });
    expect(closedDateChange("cancelled", "pending", NOW)).toEqual({ completedDate: null });
  });

  it("keeps the original date when a request moves between two closed statuses", () => {
    // Correcting "completed" to "cancelled" does not mean it closed today.
    // Restamping would silently restart the visibility window.
    expect(closedDateChange("completed", "cancelled", NOW)).toEqual({});
    expect(closedDateChange("cancelled", "completed", NOW)).toEqual({});
  });

  it("writes nothing when the status is unchanged", () => {
    expect(closedDateChange("completed", "completed", NOW)).toEqual({});
    expect(closedDateChange("pending", "pending", NOW)).toEqual({});
  });

  it("writes nothing when an edit carries no status at all", () => {
    // This is the case that protects rows closed before the column was ever
    // written: they are closed with completedDate null, and editing the title
    // of one must not backfill today's date and make it look freshly closed.
    expect(closedDateChange("completed", undefined, NOW)).toEqual({});
    expect(closedDateChange("completed", null, NOW)).toEqual({});
  });

  it("stamps a request created already closed", () => {
    // No previous status, because there was no previous row.
    expect(closedDateChange(undefined, "completed", NOW)).toEqual({ completedDate: NOW });
  });

  it("writes nothing for a request created open", () => {
    expect(closedDateChange(undefined, "pending", NOW)).toEqual({});
  });

  it("returns a patch that spreads to nothing when there is no change", () => {
    // Callers spread the result into an update. An empty object has to leave
    // the stored value alone rather than setting it to undefined.
    expect(Object.keys(closedDateChange("pending", "pending", NOW))).toEqual([]);
    expect("completedDate" in closedDateChange("pending", "pending", NOW)).toBe(false);
  });
});
