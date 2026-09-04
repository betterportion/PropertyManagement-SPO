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
  REQUEST_TYPE_FILTERS,
  closedWithinRange,
  isClosed,
  locationOptions,
  matchesType,
  type RequestTypeFilter,
} from "./maintenanceFilters";
import { MAINTENANCE_REQUEST_TYPES, type MaintenanceRequest } from "@shared/schema";

const NOW = new Date("2026-08-15T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function request(over: Partial<MaintenanceRequest>): MaintenanceRequest {
  return {
    id: "r1",
    status: "completed",
    completedDate: daysAgo(1),
    location: "Kitchen",
    type: "request",
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

describe("the type filter", () => {
  it("offers all types first, then every type the schema defines", () => {
    // Defaults to all: an RA opening the list should see repairs, projects
    // and capital projects together, and narrow when they want to.
    expect(REQUEST_TYPE_FILTERS[0].value).toBe("all");
    expect(REQUEST_TYPE_FILTERS.slice(1).map((option) => option.value)).toEqual([...MAINTENANCE_REQUEST_TYPES]);
  });

  it("lets everything through on 'all'", () => {
    for (const type of MAINTENANCE_REQUEST_TYPES) {
      expect(matchesType(request({ type }), "all")).toBe(true);
    }
  });

  it("keeps only the chosen type", () => {
    expect(matchesType(request({ type: "capex" }), "capex")).toBe(true);
    expect(matchesType(request({ type: "project" }), "capex")).toBe(false);
    expect(matchesType(request({ type: "request" }), "capex")).toBe(false);
  });

  it("matches every type against every filter, not just the one worked example", () => {
    // The pairwise case above only proves capex works. A filter that
    // accidentally matched everything, or matched nothing, would still pass
    // it -- this checks every (type, filter) pair agrees with equality.
    for (const filterType of MAINTENANCE_REQUEST_TYPES) {
      for (const requestType of MAINTENANCE_REQUEST_TYPES) {
        expect(matchesType(request({ type: requestType }), filterType)).toBe(requestType === filterType);
      }
    }
  });

  it("is a type filter, not a priority one: a wishlist repair is still a repair", () => {
    expect(matchesType(request({ type: "request", priority: "wishlist" }), "request")).toBe(true);
    expect(matchesType(request({ type: "capex", priority: "wishlist" }), "request")).toBe(false);
  });

  it("falls back to showing everything on a filter value the schema doesn't know, rather than hiding everything", () => {
    // The type filter round-trips through the URL (?type=...) with no
    // runtime validation before it reaches matchesType -- see
    // client/src/pages/Maintenance.tsx, `filters.type as RequestTypeFilter`.
    // A stale bookmark or a hand-edited link naming a retired or misspelled
    // type must not read as "match nothing": that would empty the list for
    // every kind of work, not just narrow it.
    const unknownFilter = "banana" as RequestTypeFilter;
    for (const type of MAINTENANCE_REQUEST_TYPES) {
      expect(matchesType(request({ type }), unknownFilter)).toBe(true);
    }
  });
});
