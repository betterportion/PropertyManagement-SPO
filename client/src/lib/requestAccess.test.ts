/**
 * The request page's refusal message. A staff account without either
 * maintenance flag was refused for the flag, and telling it the request is
 * in another region sends the reader to their admin with the wrong question.
 */
import { describe, it, expect } from "vitest";
import { NO_MAINTENANCE_ACCESS, NOT_YOUR_HOUSE, OUTSIDE_YOUR_REGIONS, requestRefusalMessage } from "./requestAccess";

const ra = (permissions: Record<string, boolean> | null) => ({ role: "regional_administrator", permissions });

describe("requestRefusalMessage", () => {
  it("names the missing maintenance access for staff holding neither flag", () => {
    expect(requestRefusalMessage(ra({ canCompleteWalkthroughs: true }))).toBe(NO_MAINTENANCE_ACCESS);
    expect(requestRefusalMessage(ra(null))).toBe(NO_MAINTENANCE_ACCESS);
    expect(requestRefusalMessage(ra({ canViewMaintenance: false, canManageMaintenance: false }))).toBe(NO_MAINTENANCE_ACCESS);
  });

  it("names the region for staff holding either maintenance flag", () => {
    expect(requestRefusalMessage(ra({ canViewMaintenance: true }))).toBe(OUTSIDE_YOUR_REGIONS);
    expect(requestRefusalMessage(ra({ canManageMaintenance: true }))).toBe(OUTSIDE_YOUR_REGIONS);
  });

  it("never tells an admin they lack maintenance access", () => {
    expect(requestRefusalMessage({ role: "admin", permissions: null })).toBe(OUTSIDE_YOUR_REGIONS);
  });

  it("gives a household the house message, whatever flags the row carries", () => {
    expect(requestRefusalMessage({ role: "resident", permissions: { canViewMaintenance: true } })).toBe(NOT_YOUR_HOUSE);
    expect(requestRefusalMessage({ role: "resident", permissions: null })).toBe(NOT_YOUR_HOUSE);
    expect(requestRefusalMessage(null)).toBe(NOT_YOUR_HOUSE);
  });
});
