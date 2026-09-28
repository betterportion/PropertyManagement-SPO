import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDate, formatDateTime, localCalendarDay, localDayStart, localToday } from "./format";
import { walkthroughYearLabel } from "./walkthrough";

/**
 * Every SPO house is west of UTC, which is exactly where a calendar day stored
 * as UTC midnight used to render as the day before. These run in Chicago so
 * that failure is the one being tested; in UTC it would pass by accident.
 */
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  process.env.TZ = originalTz;
});

describe("formatDate in America/Chicago", () => {
  it("runs in the zone it claims to", () => {
    // Positive control: without this, a TZ switch that silently did nothing
    // would let every assertion below pass in UTC.
    expect(new Date(Date.UTC(2026, 0, 1)).getDate()).toBe(31);
  });

  it("shows a calendar day as that day, as the API sends it", () => {
    expect(formatDate("2026-01-01T00:00:00.000Z")).toBe("Jan 1, 2026");
    expect(formatDate(new Date("2026-08-20T00:00:00.000Z"))).toBe("Aug 20, 2026");
  });

  it("still shows a bare calendar day as that day", () => {
    expect(formatDate("2026-02-01")).toBe("Feb 1, 2026");
  });

  it("shows a real instant on its local day", () => {
    // 01:00 UTC on Jan 2 is the evening of Jan 1 in Chicago.
    expect(formatDate("2026-01-02T01:00:00.000Z")).toBe("Jan 1, 2026");
  });

  it("leaves date-and-time display in local time", () => {
    expect(formatDateTime("2026-09-28T01:17:00.000Z")).toBe("Sep 27, 2026, 8:17 PM");
  });

  it("renders missing and unreadable values as a dash", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("not a date")).toBe("—");
  });
});

describe("walkthroughYearLabel in America/Chicago", () => {
  it("heads a Jan 1 walkthrough with its own year", () => {
    expect(walkthroughYearLabel("2026-01-01T00:00:00.000Z")).toBe("2026");
    expect(walkthroughYearLabel(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026");
  });

  it("agrees with the date shown under it", () => {
    const value = "2026-01-01T00:00:00.000Z";
    expect(formatDate(value)).toContain(walkthroughYearLabel(value));
  });

  it("says Undated rather than guessing", () => {
    expect(walkthroughYearLabel(null)).toBe("Undated");
    expect(walkthroughYearLabel("garbage")).toBe("Undated");
  });
});

describe("localToday in America/Chicago", () => {
  it("is still today at 8:17pm, not tomorrow", () => {
    // 01:17 UTC on Sep 28 is 8:17pm on Sep 27 in Chicago.
    expect(localToday(new Date("2026-09-28T01:17:00.000Z"))).toBe("2026-09-27");
  });

  it("pads the month and day", () => {
    expect(localCalendarDay(new Date(2026, 2, 5))).toBe("2026-03-05");
  });
});

describe("localDayStart in America/Chicago", () => {
  it("is the reader's own midnight, not UTC's", () => {
    expect(localDayStart("2026-09-27").toISOString()).toBe("2026-09-27T05:00:00.000Z");
  });

  it("moves by calendar days across a clock change", () => {
    // Nov 1 2026 is 25 hours long in Chicago; the day after still starts at local midnight.
    expect(localDayStart("2026-11-01", 1).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });
});
