/**
 * Dates as clients send them (#219).
 *
 * The old `z.coerce.date()` was `new Date(value)`: a required date sent as
 * null became 1 January 1970, and a day that does not exist rolled over
 * ("2026-02-30" was stored as March 2). Both are refused now. Tested through
 * the schemas that carry the rule, never a copy of it.
 */
import { describe, it, expect } from "vitest";
import { insertInvoiceSchema, insertResidentSchema, insertWalkthroughSchema } from "@shared/schema";

const required = insertInvoiceSchema.partial(); // dueDate: a required date
const allowsNull = insertResidentSchema.partial(); // moveInDate: nullish
const allowsMissing = insertWalkthroughSchema.partial(); // walkthroughDate: optional

describe("a date that is sent", () => {
  it("takes a calendar day", () => {
    const result = required.safeParse({ dueDate: "2026-02-28" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.dueDate?.toISOString()).toBe("2026-02-28T00:00:00.000Z");
  });

  it("takes an instant, and keeps its time", () => {
    const result = required.safeParse({ dueDate: "2026-02-28T15:30:00.000Z" });
    expect(result.success && result.data.dueDate?.toISOString()).toBe("2026-02-28T15:30:00.000Z");
  });

  it("takes a Date object", () => {
    const result = required.safeParse({ dueDate: new Date("2026-02-28T00:00:00.000Z") });
    expect(result.success).toBe(true);
  });

  it.each(["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-02-30T12:00:00.000Z"])(
    "refuses %s, a day that is not on the calendar, rather than rolling it over",
    (value) => {
      expect(required.safeParse({ dueDate: value }).success).toBe(false);
    },
  );

  it("still takes 29 February in a leap year", () => {
    expect(required.safeParse({ dueDate: "2028-02-29" }).success).toBe(true);
  });

  it("refuses an empty string", () => {
    expect(required.safeParse({ dueDate: "" }).success).toBe(false);
  });
});

describe("a required date sent as null", () => {
  it("is refused, never 1970", () => {
    const result = required.safeParse({ dueDate: null });
    expect(result.success).toBe(false);
  });
});

describe("where a blank is allowed", () => {
  it("null stays null on a nullable date", () => {
    const result = allowsNull.safeParse({ moveInDate: null });
    expect(result.success).toBe(true);
    expect(result.success && result.data.moveInDate).toBeNull();
  });

  it("a missing optional date stays missing", () => {
    const result = allowsMissing.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.walkthroughDate).toBeUndefined();
  });

  it("but an impossible day is refused there too", () => {
    expect(allowsNull.safeParse({ moveInDate: "2026-02-30" }).success).toBe(false);
  });
});
