/**
 * Finance's chase list must agree with the dashboard: a sent statement is
 * still money held, and what is owed is the balance after deductions.
 */
import { describe, it, expect } from "vitest";
import { depositsToSettle } from "./depositsToSettle";
import type { SecurityDeposit } from "@shared/schema";

const deposit = (id: string, residentId: string, status: string) =>
  ({ id, residentId, status, amountHeld: "500.00", propertyId: "p1" }) as SecurityDeposit;

describe("depositsToSettle", () => {
  const moved = [{ id: "a", isActive: false }, { id: "b", isActive: false }, { id: "c", isActive: false }, { id: "here", isActive: true }];

  it("keeps a deposit whose statement was sent, alongside held ones", () => {
    const list = depositsToSettle([deposit("dA", "a", "held"), deposit("dB", "b", "statement_sent")], moved, []);
    expect(list.map((x) => x.deposit.id)).toEqual(["dA", "dB"]);
  });

  it("shows the balance after deductions, not the amount held", () => {
    const [entry] = depositsToSettle([deposit("dC", "c", "held")], moved, [{ residentId: "c", amount: "200.00" }]);
    expect(entry.owed).toBe("300.00");
  });

  it("shows a shortfall as negative when damage exceeded the deposit", () => {
    const [entry] = depositsToSettle([deposit("dC", "c", "held")], moved, [{ residentId: "c", amount: "520.00" }]);
    expect(entry.owed).toBe("-20.00");
  });

  it("leaves out settled deposits and anyone still living there", () => {
    const list = depositsToSettle(
      [deposit("ret", "a", "returned"), deposit("wh", "b", "withheld"), deposit("part", "c", "partially_returned"), deposit("cur", "here", "held")],
      moved,
      [],
    );
    expect(list).toEqual([]);
  });

  it("lists nothing while the residents list is unavailable, rather than calling everyone a former resident", () => {
    const held = [deposit("dA", "a", "held"), deposit("dHere", "here", "held")];
    expect(depositsToSettle(held, undefined, [])).toEqual([]);
    // Positive control: the same deposits do list once the residents are known.
    expect(depositsToSettle(held, moved, []).map((x) => x.deposit.id)).toEqual(["dA"]);
  });

  it("treats an active row whose stop date has passed as moved out (#260)", () => {
    const now = new Date("2026-08-15T12:00:00Z");
    const residents = [
      { id: "past", isActive: true, moveOutDate: new Date("2026-08-14T00:00:00Z") },
      { id: "today", isActive: true, moveOutDate: new Date("2026-08-15T00:00:00Z") },
      { id: "later", isActive: true, moveOutDate: new Date("2026-09-01T00:00:00Z") },
      { id: "none", isActive: true, moveOutDate: null },
    ];
    const held = ["past", "today", "later", "none"].map((id) => deposit(`d-${id}`, id, "held"));
    // Only the one whose stop date is before today; the stop day itself still counts as living there.
    expect(depositsToSettle(held, residents, [], now).map((x) => x.deposit.id)).toEqual(["d-past"]);
  });
});
