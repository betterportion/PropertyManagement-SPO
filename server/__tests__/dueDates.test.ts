import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasBegunEverywhere, isPastDue } from "@shared/dueDates";

/**
 * The rule is meant not to depend on where it runs, so it runs in Chicago:
 * every SPO house is west of UTC, which is where the old `due < now` went
 * overdue the evening before. Hand-computed instants throughout.
 */
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  // Assigning undefined would store the string "undefined", not unset it.
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

// A due date as the API stores a picked day: UTC midnight of Sep 28.
const SEP_28 = new Date("2026-09-28T00:00:00.000Z");

describe("isPastDue", () => {
  it("runs in the zone it claims to", () => {
    // Positive control for the TZ switch.
    expect(new Date("2026-09-28T01:17:00.000Z").getDate()).toBe(27);
  });

  it("is not overdue at 8:17pm Central the evening before", () => {
    expect(isPastDue(SEP_28, new Date("2026-09-28T01:17:00.000Z"))).toBe(false);
  });

  it("is not overdue on the due day itself", () => {
    expect(isPastDue(SEP_28, new Date("2026-09-28T20:00:00.000Z"))).toBe(false);
  });

  it("is not overdue until the day has ended in the last timezone to finish it", () => {
    // Sep 28 ends at UTC-12 at 12:00Z on Sep 29 (7am Central).
    expect(isPastDue(SEP_28, new Date("2026-09-29T11:59:59.999Z"))).toBe(false);
    expect(isPastDue(SEP_28, new Date("2026-09-29T12:00:00.000Z"))).toBe(true);
  });

  it("reads the calendar day of an instant, as the API sends one", () => {
    // A schedule stamped at completion: 01:17Z on Sep 28 is Sep 28 in UTC.
    expect(isPastDue("2026-09-28T01:17:00.000Z", new Date("2026-09-29T11:59:00.000Z"))).toBe(false);
    expect(isPastDue("2026-09-28T01:17:00.000Z", new Date("2026-09-29T12:00:00.000Z"))).toBe(true);
  });

  it("is never overdue with no date or an unreadable one", () => {
    const later = new Date("2030-01-01T00:00:00.000Z");
    expect(isPastDue(null, later)).toBe(false);
    expect(isPastDue(undefined, later)).toBe(false);
    expect(isPastDue("not a date", later)).toBe(false);
  });
});

describe("hasBegunEverywhere", () => {
  it("has not begun at 8:17pm Central the evening before", () => {
    expect(hasBegunEverywhere(SEP_28, new Date("2026-09-28T01:17:00.000Z"))).toBe(false);
  });

  it("begins once the last timezone reaches the day", () => {
    // Sep 28 begins at UTC-12 at 12:00Z on Sep 28 (7am Central).
    expect(hasBegunEverywhere(SEP_28, new Date("2026-09-28T11:59:59.999Z"))).toBe(false);
    expect(hasBegunEverywhere(SEP_28, new Date("2026-09-28T12:00:00.000Z"))).toBe(true);
  });

  it("reads the calendar day of an instant", () => {
    // 01:17Z on Sep 28 is Sep 28 in UTC, which begins everywhere at 12:00Z.
    expect(hasBegunEverywhere("2026-09-28T01:17:00.000Z", new Date("2026-09-28T11:59:00.000Z"))).toBe(false);
    expect(hasBegunEverywhere("2026-09-28T01:17:00.000Z", new Date("2026-09-28T12:00:00.000Z"))).toBe(true);
  });

  it("treats no date as never beginning", () => {
    expect(hasBegunEverywhere(null, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});
