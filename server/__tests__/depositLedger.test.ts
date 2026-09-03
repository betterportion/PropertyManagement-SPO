/**
 * Deposit arithmetic.
 *
 * This is the one module in the portal whose output a person acts on with
 * money: the split lands on a worksheet an RA hands to finance, and a cent in
 * the wrong place is a deposit that comes back short. So the expected values
 * below are worked by hand from the spec, never recomputed the way the code
 * does — a test that recomputes the implementation can never disagree with it.
 *
 * Everything is in **cents**. Splitting in floating-point dollars is how
 * 33.333333333333336 ends up on a statement.
 */
import { describe, it, expect } from "vitest";
import {
  depositReturnDeadline,
  runningBalance,
  splitEvenly,
  toCents,
} from "@shared/depositLedger";

describe("reading an amount as cents", () => {
  it("reads the numeric strings the columns round-trip as", () => {
    expect(toCents("100.00")).toBe(10_000);
    expect(toCents("33.33")).toBe(3_333);
    expect(toCents("0.01")).toBe(1);
  });

  it("reads a number the same way", () => {
    expect(toCents(100)).toBe(10_000);
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004 in float
  });

  it("is zero for nothing, rather than NaN spreading through a balance", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
    expect(toCents("not a number")).toBe(0);
  });
});

describe("splitting a common-area charge", () => {
  it("splits $100 across 3 people as 33.34, 33.33, 33.33", () => {
    // The worked example from the spec. The remainder lands on the first
    // person, and the shares add back to exactly the charge.
    const shares = splitEvenly(10_000, 3);
    expect(shares).toEqual([3_334, 3_333, 3_333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it("splits $100 across 8 people as 12.50 each", () => {
    // Eight to a house is SPO's ordinary case, and it divides evenly.
    expect(splitEvenly(10_000, 8)).toEqual([
      1_250, 1_250, 1_250, 1_250, 1_250, 1_250, 1_250, 1_250,
    ]);
  });

  it("splits $250 across 7 people as 35.72 then six of 35.71", () => {
    // 25000 / 7 = 3571 remainder 3. Three cents to spread, and they go to the
    // first three people, not all to the first one.
    const shares = splitEvenly(25_000, 7);
    expect(shares).toEqual([3_572, 3_572, 3_572, 3_571, 3_571, 3_571, 3_571]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(25_000);
  });

  it("gives one person the whole charge", () => {
    expect(splitEvenly(10_000, 1)).toEqual([10_000]);
  });

  it("splits a single cent to one person and nothing to the rest", () => {
    expect(splitEvenly(1, 3)).toEqual([1, 0, 0]);
  });

  it("always adds back to the charge, for every size a house could be", () => {
    // Not a substitute for the worked examples above -- this is the invariant
    // that says no cent was invented or lost, whatever the numbers.
    for (let people = 1; people <= 12; people += 1) {
      for (const charge of [1, 7, 99, 100, 12_345, 100_000]) {
        const shares = splitEvenly(charge, people);
        expect(shares).toHaveLength(people);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(charge);
        expect(shares.every((share) => share >= 0)).toBe(true);
      }
    }
  });

  it("returns nothing for nobody, rather than dividing by zero", () => {
    expect(splitEvenly(10_000, 0)).toEqual([]);
  });

  it("refuses a negative charge", () => {
    // A negative deduction is a refund, and refunds are not what this is.
    expect(() => splitEvenly(-100, 3)).toThrow();
  });
});

describe("a resident's running balance", () => {
  it("is the deposit held less every deduction against them", () => {
    const balance = runningBalance("500.00", [
      { amount: "120.50" },
      { amount: "35.00" },
    ]);
    expect(balance).toBe(34_450); // 50000 - 12050 - 3500
  });

  it("is the whole deposit when nothing has been deducted", () => {
    expect(runningBalance("500.00", [])).toBe(50_000);
  });

  it("can go negative, and says so rather than clamping to zero", () => {
    // Damage can exceed the deposit. Clamping would hide the shortfall from
    // the person who has to decide what to do about it.
    expect(runningBalance("100.00", [{ amount: "150.00" }])).toBe(-5_000);
  });

  it("treats a missing deposit amount as nothing held", () => {
    expect(runningBalance(null, [{ amount: "10.00" }])).toBe(-1_000);
  });
});

describe("when a deposit has to go back", () => {
  const moveOut = new Date("2026-05-01T00:00:00Z");

  it("counts the admin-set days from the move-out date", () => {
    // The clock starts when possession came back, not at lease end. Somebody
    // can leave in April on a lease running to July.
    const deadline = depositReturnDeadline(moveOut, 21);
    expect(deadline?.toISOString().slice(0, 10)).toBe("2026-05-22");
  });

  it("has no deadline for somebody who has not moved out", () => {
    expect(depositReturnDeadline(null, 21)).toBeNull();
  });

  it("has no deadline when the property has no setting", () => {
    // The number is SPO's own reminder setting. Without one there is nothing
    // to remind against, and inventing a figure would be inventing a legal
    // determination the portal must not make.
    expect(depositReturnDeadline(moveOut, null)).toBeNull();
    expect(depositReturnDeadline(moveOut, 0)).toBeNull();
  });

  it("reads a move-out date that arrived as a string", () => {
    expect(depositReturnDeadline("2026-05-01T00:00:00Z", 21)?.toISOString().slice(0, 10)).toBe(
      "2026-05-22",
    );
  });

  it("has no deadline for an unparseable move-out date", () => {
    expect(depositReturnDeadline("not-a-date", 21)).toBeNull();
  });
});
