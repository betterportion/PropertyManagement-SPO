/**
 * Per-region rollup for the leadership dashboard.
 *
 * A national admin needs to see, at a glance, how each region (and the regional
 * admin who runs it) is doing across all the properties — which regions are
 * behind and on what. `buildRegionSummaries` is a pure function of the records
 * plus `now`, so the whole rollup is unit-testable without a database.
 *
 * "Health" is deliberately the operational load — open maintenance requests,
 * safety/preventive checks coming due, and lease renewals to decide. Unpaid rent
 * is reported alongside but is NOT part of the health score: it is chased on its
 * own track (a KPI, a flag, and eventually an automated resident email).
 */
import type { MaintenanceRequest, MaintenanceSchedule, Property, RentPayment, Task } from "@shared/schema";
import { SCHEDULE_LOOKAHEAD_DAYS, LEASE_LOOKAHEAD_DAYS } from "./actionItems";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RegionStaff {
  name: string;
  email: string | null;
  /** The regions this admin is assigned, already normalized (may contain "all"). */
  regions: string[];
}

export interface RegionSummaryInputs {
  requests: MaintenanceRequest[];
  schedules: MaintenanceSchedule[];
  properties: Property[];
  rentPayments: RentPayment[];
  /** Open safety reminders (walkthroughs, utilities) count toward safety load. */
  tasks: Task[];
  staff: RegionStaff[];
}

export interface RegionSummary {
  region: string;
  admins: { name: string; email: string | null }[];
  openRequests: number;
  safetyPreventiveDue: number;
  leaseRenewalsDue: number;
  unpaidRent: { count: number; amount: string };
  /** openRequests + safetyPreventiveDue + leaseRenewalsDue — drives the sort. */
  attentionScore: number;
}

// Region values are canonical by the time they reach here (records store the
// canonical name; the route normalizes the caller's regions and each admin's
// assigned regions before passing them in), so an exact compare is correct.
function inRegion(recordRegion: string | null | undefined, region: string): boolean {
  return recordRegion === region;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One summary per region in `regions`, sorted worst-first (highest attention
 * score). A region with nothing outstanding still appears, so leadership can see
 * it is genuinely clear rather than merely missing.
 */
export function buildRegionSummaries(
  inputs: RegionSummaryInputs,
  regions: string[],
  now: Date = new Date(),
): RegionSummary[] {
  const scheduleHorizon = new Date(now.getTime() + SCHEDULE_LOOKAHEAD_DAYS * DAY_MS);
  const leaseHorizon = new Date(now.getTime() + LEASE_LOOKAHEAD_DAYS * DAY_MS);

  const summaries = regions.map((region) => {
    const admins = inputs.staff
      .filter((s) => s.regions.includes("all") || s.regions.includes(region))
      .map((s) => ({ name: s.name, email: s.email }));

    const openRequests = inputs.requests.filter(
      (r) => inRegion(r.region, region) && (r.status === "pending" || r.status === "in_progress"),
    ).length;

    const schedulesDue = inputs.schedules.filter((s) => {
      if (!s.isActive || !inRegion(s.region, region)) return false;
      const due = asDate(s.nextDueDate);
      return !!due && due <= scheduleHorizon;
    }).length;
    // Region-level safety reminders (walkthroughs, utilities) that are still open.
    const safetyTasksOpen = inputs.tasks.filter(
      (t) => t.category === "safety" && t.status === "open" && inRegion(t.region, region),
    ).length;
    const safetyPreventiveDue = schedulesDue + safetyTasksOpen;

    const leaseRenewalsDue = inputs.properties.filter((p) => {
      if (p.ownership !== "rented" || p.renewalDecision === "not_renewing") return false;
      if (!inRegion(p.region, region)) return false;
      const due = asDate(p.leaseRenewalDate);
      return !!due && due <= leaseHorizon;
    }).length;

    const unpaid = inputs.rentPayments.filter((p) => inRegion(p.region, region) && p.status === "unpaid");
    const unpaidAmount = unpaid.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);

    return {
      region,
      admins,
      openRequests,
      safetyPreventiveDue,
      leaseRenewalsDue,
      unpaidRent: { count: unpaid.length, amount: unpaidAmount.toFixed(2) },
      attentionScore: openRequests + safetyPreventiveDue + leaseRenewalsDue,
    };
  });

  return summaries.sort(
    (a, b) => b.attentionScore - a.attentionScore || a.region.localeCompare(b.region),
  );
}
