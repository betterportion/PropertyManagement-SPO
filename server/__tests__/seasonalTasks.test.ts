import { describe, it, expect, vi } from "vitest";

// dueSeasonalTasks is pure, but its module pulls in the storage layer (and thus
// the db) for the generator/job; stub the db so the import doesn't require a
// connection string, exactly as region.test.ts does.
vi.mock("../db", () => ({ db: {}, pool: {} }));

import { dueSeasonalTasks, type SeasonalInputs } from "../seasonalTasks";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

const regionsOnly: SeasonalInputs = { regions: ["Northwest", "East Central"], rentedLeases: [] };

describe("dueSeasonalTasks", () => {
  it("raises a walkthrough reminder per region on April 15", () => {
    const specs = dueSeasonalTasks(regionsOnly, utc(2026, 4, 15));
    const walk = specs.filter((s) => s.sourceKey.startsWith("walkthrough:apr:"));
    expect(walk.map((s) => s.region).sort()).toEqual(["East Central", "Northwest"]);
    expect(walk[0].dueDate).toEqual(utc(2026, 4, 29)); // ~2 weeks later
    expect(walk[0].title).toContain("Household walkthroughs due");
  });

  it("raises the July walkthrough on July 15 and the summer-utilities reminder ~May 1", () => {
    expect(dueSeasonalTasks(regionsOnly, utc(2026, 7, 15)).some((s) => s.sourceKey.startsWith("walkthrough:jul:"))).toBe(true);
    const may = dueSeasonalTasks(regionsOnly, utc(2026, 5, 1));
    const util = may.filter((s) => s.sourceKey.startsWith("utilities-summer:"));
    expect(util).toHaveLength(2);
    expect(util[0].dueDate).toEqual(utc(2026, 5, 15)); // two weeks after the reminder
  });

  it("does not raise a cadence before its appear date or long after it", () => {
    expect(dueSeasonalTasks(regionsOnly, utc(2026, 4, 14)).some((s) => s.sourceKey.startsWith("walkthrough:apr:"))).toBe(false);
    // 61 days after April 15 is outside the 60-day create window.
    expect(dueSeasonalTasks(regionsOnly, utc(2026, 6, 15)).some((s) => s.sourceKey.startsWith("walkthrough:apr:"))).toBe(false);
  });

  it("raises a per-house utilities reminder two weeks before a lease ends", () => {
    const inputs: SeasonalInputs = {
      regions: [],
      rentedLeases: [
        { propertyId: "p1", name: "Cleveland House", region: "Northwest", leaseEndDate: utc(2026, 9, 1), renewalDecision: "undecided" },
      ],
    };
    // Aug 18 is exactly 14 days before Sep 1.
    const specs = dueSeasonalTasks(inputs, utc(2026, 8, 18));
    expect(specs).toHaveLength(1);
    expect(specs[0].sourceKey).toBe("utilities-lease:p1:2026-09-01");
    expect(specs[0].title).toContain("Cleveland House");
    expect(specs[0].dueDate).toEqual(utc(2026, 9, 1));
  });

  it("skips the lease utilities reminder when the house is renewing", () => {
    const inputs: SeasonalInputs = {
      regions: [],
      rentedLeases: [
        { propertyId: "p1", name: "Cleveland House", region: "Northwest", leaseEndDate: utc(2026, 9, 1), renewalDecision: "renewing" },
      ],
    };
    expect(dueSeasonalTasks(inputs, utc(2026, 8, 18))).toHaveLength(0);
  });
});

describe("the lease renewal reminder", () => {
  const NOW = new Date("2026-08-15T00:00:00Z");
  const renewalOn = (iso: string, renewalDecision = "undecided") => ({
    regions: [],
    rentedLeases: [
      {
        propertyId: "p1",
        name: "Cleveland House",
        region: "West Central",
        leaseEndDate: new Date("2027-06-30T00:00:00Z"),
        leaseRenewalDate: new Date(iso),
        renewalDecision,
      },
    ],
  });

  const renewalSpecs = (inputs: Parameters<typeof dueSeasonalTasks>[0]) =>
    dueSeasonalTasks(inputs, NOW).filter((spec) => spec.sourceKey.startsWith("lease-renewal:"));

  it("appears two months before the decision is due", () => {
    // Off the Phase 3.3 date, alongside the lease-end utilities reminder.
    const specs = renewalSpecs(renewalOn("2026-09-15T00:00:00Z"));
    expect(specs).toHaveLength(1);
    expect(specs[0].title).toContain("Cleveland House");
    expect(specs[0].region).toBe("West Central");
  });

  it("stays quiet while the decision is still far off", () => {
    expect(renewalSpecs(renewalOn("2027-06-01T00:00:00Z"))).toHaveLength(0);
  });

  it("clears once the decision has been recorded, either way", () => {
    // properties.renewalDecision already exists, so the reminder can resolve
    // rather than nagging about something somebody has already decided.
    expect(renewalSpecs(renewalOn("2026-09-15T00:00:00Z", "renewing"))).toHaveLength(0);
    expect(renewalSpecs(renewalOn("2026-09-15T00:00:00Z", "not_renewing"))).toHaveLength(0);
  });

  it("says nothing about a house with no renewal date", () => {
    const specs = dueSeasonalTasks(
      {
        regions: [],
        rentedLeases: [
          {
            propertyId: "p1",
            name: "Cleveland House",
            region: "West Central",
            leaseEndDate: new Date("2027-06-30T00:00:00Z"),
            leaseRenewalDate: null,
            renewalDecision: "undecided",
          },
        ],
      },
      NOW,
    ).filter((spec) => spec.sourceKey.startsWith("lease-renewal:"));
    expect(specs).toHaveLength(0);
  });

  it("keys on the house and the date, so re-running never duplicates it", () => {
    const specs = renewalSpecs(renewalOn("2026-09-15T00:00:00Z"));
    expect(specs[0].sourceKey).toBe("lease-renewal:p1:2026-09-15");
  });
});
