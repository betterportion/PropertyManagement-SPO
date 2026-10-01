/**
 * SPO's fiscal year runs June 1 – May 31 and is named for the year it ends.
 * The boundary days are where an off-by-one would put a whole repair bill in
 * the wrong year's budget, so they are tested to the minute.
 */
import { describe, it, expect } from "vitest";
import {
  fiscalYearBounds,
  fiscalYearDays,
  fiscalYearElapsed,
  fiscalYearLabel,
  fiscalYearOf,
  monthsLeftInFiscalYear,
} from "@shared/fiscalYear";

describe("fiscalYearOf", () => {
  it("puts the last minute of May 31 in the year ending that day", () => {
    expect(fiscalYearOf(new Date("2027-05-31T23:59:59Z"))).toBe(2027);
  });

  it("puts the first minute of June 1 in the next year", () => {
    expect(fiscalYearOf(new Date("2026-06-01T00:00:00Z"))).toBe(2027);
    expect(fiscalYearOf(new Date("2026-05-31T23:59:59Z"))).toBe(2026);
  });

  it("names the year by the calendar year it ends in", () => {
    expect(fiscalYearOf(new Date("2026-12-31T12:00:00Z"))).toBe(2027);
    expect(fiscalYearOf(new Date("2027-01-01T12:00:00Z"))).toBe(2027);
  });
});

describe("fiscalYearBounds", () => {
  it("runs June 1 to May 31", () => {
    const { startDate, endDate } = fiscalYearBounds(2027);
    expect(startDate).toBe("2026-06-01");
    expect(endDate).toBe("2027-05-31");
  });

  it("agrees with fiscalYearOf on both of its own end days", () => {
    const { start, end } = fiscalYearBounds(2027);
    expect(fiscalYearOf(start)).toBe(2027);
    expect(fiscalYearOf(end)).toBe(2027);
  });
});

describe("fiscalYearDays", () => {
  it("is 366 when the year contains February 29, otherwise 365", () => {
    expect(fiscalYearDays(2028)).toBe(366); // Jun 2027 – May 2028
    expect(fiscalYearDays(2027)).toBe(365);
  });
});

describe("fiscalYearElapsed", () => {
  it("counts June 1 as the first day used", () => {
    expect(fiscalYearElapsed(2027, new Date("2026-06-01T08:00:00Z"))).toBeCloseTo(1 / 365);
  });

  it("is the whole year on May 31", () => {
    expect(fiscalYearElapsed(2027, new Date("2027-05-31T08:00:00Z"))).toBe(1);
  });

  it("is 0 before the year starts and 1 after it ends", () => {
    expect(fiscalYearElapsed(2027, new Date("2026-05-31T08:00:00Z"))).toBe(0);
    expect(fiscalYearElapsed(2027, new Date("2027-07-01T08:00:00Z"))).toBe(1);
  });
});

describe("monthsLeftInFiscalYear", () => {
  it("counts whole months after the current one", () => {
    expect(monthsLeftInFiscalYear(new Date("2026-06-15T12:00:00Z"))).toBe(11);
    expect(monthsLeftInFiscalYear(new Date("2027-03-15T12:00:00Z"))).toBe(2);
    expect(monthsLeftInFiscalYear(new Date("2027-05-31T12:00:00Z"))).toBe(0);
  });
});

describe("fiscalYearLabel", () => {
  it("reads FY and the ending year", () => {
    expect(fiscalYearLabel(2027)).toBe("FY2027");
  });
});
