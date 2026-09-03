/**
 * The maintenance list's filters, as arithmetic rather than as a component.
 *
 * The range filter is the one worth pinning: it decides which *closed*
 * requests an RA sees, and getting it wrong either hides work somebody is
 * looking for or floods the list with years of history.
 */
import { describe, it, expect } from "vitest";
import {
  CLOSED_RANGES,
  closedWithinRange,
  isClosed,
  locationOptions,
} from "./maintenanceFilters";
import type { MaintenanceRequest } from "@shared/schema";

const NOW = new Date("2026-08-15T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function request(over: Partial<MaintenanceRequest>): MaintenanceRequest {
  return {
    id: "r1",
    status: "completed",
    completedDate: daysAgo(1),
    location: "Kitchen",
    ...over,
  } as MaintenanceRequest;
}

describe("which requests count as closed", () => {
  it("counts completed and cancelled, and nothing else", () => {
    // completedDate is the CLOSE date and is stamped for cancelled too, so a
    // cancelled request is finished work, not open work.
    expect(isClosed(request({ status: "completed" }))).toBe(true);
    expect(isClosed(request({ status: "cancelled" }))).toBe(true);
    expect(isClosed(request({ status: "pending" }))).toBe(false);
    expect(isClosed(request({ status: "in_progress" }))).toBe(false);
  });
});

describe("the closed-request range filter", () => {
  it("offers every range the plan asks for, ending in all", () => {
    expect(CLOSED_RANGES.map((range) => range.value)).toEqual([
      "7",
      "30",
      "60",
      "90",
      "180",
      "all",
    ]);
  });

  it("lets everything through on 'all'", () => {
    expect(closedWithinRange(request({ completedDate: daysAgo(5000) }), "all", NOW)).toBe(true);
  });

  it("keeps a request closed inside the range", () => {
    expect(closedWithinRange(request({ completedDate: daysAgo(20) }), "30", NOW)).toBe(true);
  });

  it("drops a request closed outside the range", () => {
    expect(closedWithinRange(request({ completedDate: daysAgo(40) }), "30", NOW)).toBe(false);
  });

  it("includes one closed exactly on the boundary", () => {
    // "Last 30 days" that silently excludes day 30 is the kind of off-by-one
    // that makes somebody think a request vanished.
    expect(closedWithinRange(request({ completedDate: daysAgo(30) }), "30", NOW)).toBe(true);
  });

  it("never filters out an open request, whatever the range", () => {
    // The range is about history. Open work is always current work, and a
    // range filter that hid it would hide the thing an RA came to do.
    for (const range of CLOSED_RANGES) {
      expect(
        closedWithinRange(request({ status: "pending", completedDate: null }), range.value, NOW),
      ).toBe(true);
    }
  });

  it("keeps a closed request with no close date, rather than hiding it", () => {
    // Requests closed before close dates were recorded have none. Hiding them
    // from staff would lose history nothing can rebuild -- the opposite call
    // from the resident window, which fails closed because it is a permission.
    expect(closedWithinRange(request({ completedDate: null }), "30", NOW)).toBe(true);
  });

  it("keeps one whose close date is unparseable, for the same reason", () => {
    expect(closedWithinRange(request({ completedDate: "not-a-date" as never }), "30", NOW)).toBe(true);
  });
});

describe("the room filter's options", () => {
  it("lists each location once, in alphabetical order", () => {
    const options = locationOptions([
      request({ id: "a", location: "Kitchen" }),
      request({ id: "b", location: "Basement" }),
      request({ id: "c", location: "Kitchen" }),
    ]);
    expect(options).toEqual(["Basement", "Kitchen"]);
  });

  it("skips blanks rather than offering an empty option", () => {
    const options = locationOptions([
      request({ id: "a", location: "" }),
      request({ id: "b", location: "   " }),
      request({ id: "c", location: "Kitchen" }),
    ]);
    expect(options).toEqual(["Kitchen"]);
  });
});
