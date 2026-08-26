import { describe, it, expect } from "vitest";
import { buildRegionSummaries, type RegionSummaryInputs } from "../regionSummary";
import type { MaintenanceRequest, MaintenanceSchedule, Property, RentPayment, Task } from "@shared/schema";

const NOW = new Date("2026-08-15T00:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

function request(over: Partial<MaintenanceRequest>): MaintenanceRequest {
  return { id: "r1", region: "Northwest", status: "pending", ...over } as MaintenanceRequest;
}
function schedule(over: Partial<MaintenanceSchedule>): MaintenanceSchedule {
  return { id: "s1", region: "Northwest", isActive: true, nextDueDate: days(5) as any, ...over } as MaintenanceSchedule;
}
function property(over: Partial<Property>): Property {
  return { id: "p1", region: "Northwest", ownership: "rented", renewalDecision: "undecided", leaseRenewalDate: days(20) as any, ...over } as Property;
}
function rent(over: Partial<RentPayment>): RentPayment {
  return { id: "rp1", region: "Northwest", status: "unpaid", amount: "700", ...over } as RentPayment;
}

function safetyTask(over: Partial<Task>): Task {
  return { id: "t1", region: "Northwest", category: "safety", status: "open", ...over } as Task;
}

const empty: RegionSummaryInputs = { requests: [], schedules: [], properties: [], rentPayments: [], tasks: [], staff: [] };

describe("buildRegionSummaries", () => {
  it("counts each region's open requests, due schedules and renewals", () => {
    const [summary] = buildRegionSummaries(
      {
        ...empty,
        requests: [request({ status: "pending" }), request({ status: "completed" })],
        schedules: [schedule({ nextDueDate: days(5) as any }), schedule({ nextDueDate: days(90) as any })],
        properties: [property({ leaseRenewalDate: days(20) as any })],
      },
      ["Northwest"],
      NOW,
    );
    expect(summary.openRequests).toBe(1); // completed excluded
    expect(summary.safetyPreventiveDue).toBe(1); // far-future schedule excluded
    expect(summary.leaseRenewalsDue).toBe(1);
    expect(summary.attentionScore).toBe(3);
  });

  it("counts open safety reminders (walkthroughs, utilities) toward safety load", () => {
    const [summary] = buildRegionSummaries(
      {
        ...empty,
        tasks: [
          safetyTask({ id: "open" }),
          safetyTask({ id: "done", status: "done" }), // completed — excluded
          safetyTask({ id: "general", category: "general" }), // not safety — excluded
          safetyTask({ id: "other-region", region: "East Central" }), // wrong region
        ],
      },
      ["Northwest"],
      NOW,
    );
    expect(summary.safetyPreventiveDue).toBe(1);
    expect(summary.attentionScore).toBe(1);
  });

  it("tracks unpaid rent but keeps it out of the attention score", () => {
    const [summary] = buildRegionSummaries(
      { ...empty, rentPayments: [rent({ amount: "700" }), rent({ id: "rp2", amount: "550" }), rent({ id: "rp3", status: "paid" })] },
      ["Northwest"],
      NOW,
    );
    expect(summary.unpaidRent).toEqual({ count: 2, amount: "1250.00" });
    expect(summary.attentionScore).toBe(0); // rent is not health
  });

  it("names the region's regional admin, falling back to email", () => {
    const [summary] = buildRegionSummaries(
      {
        ...empty,
        staff: [
          { name: "Sarah Jenkins", email: "sarah@spo.org", regions: ["Northwest"] },
          { name: "lead@spo.org", email: "lead@spo.org", regions: ["East Central"] },
        ],
      },
      ["Northwest"],
      NOW,
    );
    expect(summary.admins).toEqual([{ name: "Sarah Jenkins", email: "sarah@spo.org" }]);
  });

  it("returns a region with no admin, and separates records by region", () => {
    const summaries = buildRegionSummaries(
      {
        ...empty,
        requests: [request({ region: "Northwest" }), request({ region: "East Central" }), request({ region: "East Central" })],
        staff: [{ name: "NW Lead", email: null, regions: ["Northwest"] }],
      },
      ["Northwest", "East Central"],
      NOW,
    );
    const east = summaries.find((s) => s.region === "East Central")!;
    const nw = summaries.find((s) => s.region === "Northwest")!;
    expect(east.openRequests).toBe(2);
    expect(east.admins).toEqual([]); // no lead assigned
    expect(nw.openRequests).toBe(1);
  });

  it("sorts regions worst-first by attention score", () => {
    const summaries = buildRegionSummaries(
      {
        ...empty,
        requests: [request({ region: "East Central" }), request({ region: "East Central" }), request({ region: "Northwest" })],
      },
      ["Northwest", "East Central", "Southwest"],
      NOW,
    );
    expect(summaries.map((s) => s.region)).toEqual(["East Central", "Northwest", "Southwest"]);
  });
});
