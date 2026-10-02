/**
 * A household login ends with the stay (JR, 2026-10-01): once no current
 * roster row at its house speaks for it, it is switched off and unlinked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));
const { createAuditEvent } = vi.hoisted(() => ({ createAuditEvent: vi.fn() }));
vi.mock("../storage", () => ({ storage: { createAuditEvent } }));

import { closeDepartedHouseholdLogins, departedHouseholdLogins } from "../householdLogins";
import type { Resident, User } from "@shared/schema";

const NOW = new Date("2027-05-21T15:00:00Z");
const login = (patch: Partial<User> = {}) =>
  ({ id: "u-jane", email: "jane@example.com", role: "resident", isActive: true, propertyId: "p1", ...patch }) as User;
const row = (patch: Partial<Resident> = {}) =>
  ({ id: "r1", email: "Jane@Example.com", propertyId: "p1", isActive: true, moveOutDate: null, ...patch }) as Resident;
const roster = (...rows: Resident[]) => new Map([["p1", rows]]);

describe("departedHouseholdLogins", () => {
  it("keeps a login a current roster row speaks for, through the stop day itself (positive control)", () => {
    expect(departedHouseholdLogins([login()], roster(row()), NOW)).toEqual([]);
    expect(departedHouseholdLogins([login()], roster(row({ moveOutDate: new Date("2027-05-21T00:00:00Z") })), NOW)).toEqual([]);
  });

  it("finds one whose row is moved out, past its stop date, or gone", () => {
    for (const rows of [[row({ isActive: false })], [row({ moveOutDate: new Date("2027-05-20T00:00:00Z") })], []]) {
      expect(departedHouseholdLogins([login()], roster(...rows), NOW).map((u) => u.id)).toEqual(["u-jane"]);
    }
  });

  it("leaves staff, switched-off and unlinked logins alone", () => {
    const logins = [login({ role: "regional_administrator" }), login({ isActive: false }), login({ propertyId: null })];
    expect(departedHouseholdLogins(logins, roster(), NOW)).toEqual([]);
  });
});

describe("closeDepartedHouseholdLogins", () => {
  beforeEach(() => createAuditEvent.mockReset());

  const storage = (rows: Resident[]) => ({
    getActiveResidentAccountsByProperty: vi.fn(async () => [login()]),
    getResidentsByProperty: vi.fn(async () => rows),
    getAllUsers: vi.fn(async () => [login()]),
    getAllResidents: vi.fn(async () => rows),
    deactivateAndUnlinkUser: vi.fn(async () => ({})),
  });

  it("switches the login off and unlinks it, recording both as access history", async () => {
    const s = storage([row({ isActive: false })]);
    expect(await closeDepartedHouseholdLogins({ propertyId: "p1" }, NOW, s as never)).toBe(1);
    expect(s.deactivateAndUnlinkUser).toHaveBeenCalledWith("u-jane");
    expect(createAuditEvent.mock.calls.map(([e]) => e.action)).toEqual(["user.status_changed", "user.property_changed"]);
  });

  it("names a login with no email by its name, never by its id (#239)", async () => {
    const s = storage([row()]);
    const noEmail = login({ id: "117857551505584404776", email: null, firstName: "Jane", lastName: "Roe" });
    s.getActiveResidentAccountsByProperty.mockResolvedValue([noEmail]);
    expect(await closeDepartedHouseholdLogins({ propertyId: "p1" }, NOW, s as never)).toBe(1);
    const summaries = createAuditEvent.mock.calls.map(([e]) => e.summary as string);
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary).toContain("Jane Roe");
      expect(summary).not.toContain(noEmail.id);
    }
  });

  it("does nothing to a current member, for one house or all of them", async () => {
    const s = storage([row()]);
    expect(await closeDepartedHouseholdLogins({ propertyId: "p1" }, NOW, s as never)).toBe(0);
    expect(await closeDepartedHouseholdLogins("all", NOW, s as never)).toBe(0);
    expect(s.deactivateAndUnlinkUser).not.toHaveBeenCalled();
  });

  it("never throws: a storage failure is logged and the caller carries on", async () => {
    const s = { ...storage([]), getResidentsByProperty: vi.fn(async () => { throw new Error("db down"); }) };
    await expect(closeDepartedHouseholdLogins({ propertyId: "p1" }, NOW, s as never)).resolves.toBe(0);
  });
});
