/**
 * The admin's maintenance performance table (server/maintenancePerformance.ts):
 * per person, requests closed, the median days from filing to close, and how
 * many used a contractor. Counts and a median only, never a score.
 */
import { describe, it, expect } from "vitest";
import { maintenancePerformance, type CloseoutForPerformance } from "../maintenancePerformance";

const FILED = new Date("2026-11-01T09:00:00Z");
const daysLater = (days: number) => new Date(FILED.getTime() + days * 24 * 60 * 60 * 1000);

function row(email: string | null, name: string | null, days: number, usedContractor = false): CloseoutForPerformance {
  return {
    closeout: { completedByEmail: email, completedByName: name, completedAt: daysLater(days) },
    submittedDate: FILED,
    usedContractor,
  };
}

describe("maintenancePerformance", () => {
  it("counts each person's closes, their median days and their contractor jobs", () => {
    const table = maintenancePerformance([
      row("joe@spo.org", "Joe Fink", 1),
      row("JOE@spo.org", "Joe Fink", 3, true),
      row("joe@spo.org", "Joe Fink", 10),
      row("ra@spo.org", "Sarah Lee", 2, true),
      row("ra@spo.org", "Sarah Lee", 5),
    ]);
    expect(table).toEqual([
      { name: "Joe Fink", email: "joe@spo.org", closed: 3, medianDaysToClose: 3, usedContractor: 1 },
      { name: "Sarah Lee", email: "ra@spo.org", closed: 2, medianDaysToClose: 3.5, usedContractor: 1 },
    ]);
  });

  it("counts a close-out with no filing date but leaves it out of the median", () => {
    const [joe] = maintenancePerformance([{ ...row("joe@spo.org", "Joe", 0), submittedDate: null }]);
    expect(joe).toMatchObject({ closed: 1, medianDaysToClose: null });
  });

  it("names a close-out nobody signed as Unknown rather than dropping it", () => {
    expect(maintenancePerformance([row(null, null, 2)])).toEqual([
      { name: "Unknown", email: null, closed: 1, medianDaysToClose: 2, usedContractor: 0 },
    ]);
  });

  it("carries no rating or score of any kind", () => {
    const [joe] = maintenancePerformance([row("joe@spo.org", "Joe", 1)]);
    expect(Object.keys(joe).sort()).toEqual(["closed", "email", "medianDaysToClose", "name", "usedContractor"]);
  });
});
