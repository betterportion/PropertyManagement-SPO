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
 *
 * A caller who lacks a source's permission must never read as "all clear" —
 * that is indistinguishable from a region with nothing outstanding. `visibility`
 * says which sources this caller may see, and every count derived from a hidden
 * source is gated to 0 *inside this function*, from the same value the response
 * uses, so a hidden source's real magnitude can never reach `attentionScore` or
 * any other field. `hidden` on the result names which sources were gated, so
 * the caller can tell "clear" from "some of this is not shown to you".
 */
import { isProjectType, type MaintenanceRequest, type MaintenanceSchedule, type Property, type RentPayment, type Task } from "@shared/schema";
import { SCHEDULE_LOOKAHEAD_DAYS, LEASE_LOOKAHEAD_DAYS } from "./actionItems";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RegionStaff {
  name: string;
  email: string | null;
  /** The regions this admin is assigned, already normalized (may contain "all"). */
  regions: string[];
}

/** The sources behind a region summary that a caller's permissions can hide. */
export type RegionSummarySource = "maintenance" | "schedule" | "lease" | "rent";

export interface RegionSummaryInputs {
  requests: MaintenanceRequest[];
  schedules: MaintenanceSchedule[];
  properties: Property[];
  rentPayments: RentPayment[];
  /** Open safety reminders (walkthroughs, utilities) count toward safety load. */
  tasks: Task[];
  staff: RegionStaff[];
  /**
   * Whether this caller may see each source, from `canSeeActionItemSource`.
   * A source marked false is gated to 0 regardless of what `requests` /
   * `schedules` / `properties` / `rentPayments` actually contain — the route
   * already avoids reading those tables when the caller cannot see them, but
   * this function does not trust that and gates again itself.
   */
  visibility: Record<RegionSummarySource, boolean>;
}

export interface RegionSummary {
  region: string;
  admins: { name: string; email: string | null }[];
  /** Every open request of any type; the sum of the two below plus anything untyped. */
  openRequests: number;
  /** Open repairs -- type `request`. */
  openRepairs: number;
  /** Open jobs -- projects and capital projects together. */
  openJobs: number;
  safetyPreventiveDue: number;
  leaseRenewalsDue: number;
  unpaidRent: { count: number; amount: string };
  /** openRequests + safetyPreventiveDue + leaseRenewalsDue — drives the sort. */
  attentionScore: number;
  /**
   * Sources this caller lacks permission to see, so their counts above are 0
   * whatever the region actually has. Non-empty means this region is not
   * certified clear — the client must not render "All clear" for it.
   */
  hidden: RegionSummarySource[];
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

  const hidden = (Object.keys(inputs.visibility) as RegionSummarySource[]).filter(
    (source) => !inputs.visibility[source],
  );

  const summaries = regions.map((region) => {
    const admins = inputs.staff
      .filter((s) => s.regions.includes("all") || s.regions.includes(region))
      .map((s) => ({ name: s.name, email: s.email }));

    // Every count below is gated on `inputs.visibility` first, so a source
    // this caller cannot see contributes exactly 0 -- to its own field and to
    // attentionScore, which is built from these same gated locals.
    const open = inputs.visibility.maintenance
      ? inputs.requests.filter((r) => inRegion(r.region, region) && (r.status === "pending" || r.status === "in_progress"))
      : [];
    const openRequests = open.length;
    // Repairs and jobs are reported as two numbers on the dashboard. Derived
    // from the type column and nothing else, so an untyped row -- which the
    // schema does not allow, but a rollup should not guess about -- counts
    // toward the total and toward neither kind.
    const openRepairs = open.filter((r) => r.type === "request").length;
    const openJobs = open.filter((r) => isProjectType(r.type)).length;

    const schedulesDue = inputs.visibility.schedule
      ? inputs.schedules.filter((s) => {
          if (!s.isActive || !inRegion(s.region, region)) return false;
          const due = asDate(s.nextDueDate);
          return !!due && due <= scheduleHorizon;
        }).length
      : 0;
    // Region-level safety reminders (walkthroughs, utilities) that are still
    // open. Tasks need only staff (no source to hide), so this half of the
    // safety count is never gated.
    const safetyTasksOpen = inputs.tasks.filter(
      (t) => t.category === "safety" && t.status === "open" && inRegion(t.region, region),
    ).length;
    const safetyPreventiveDue = schedulesDue + safetyTasksOpen;

    const leaseRenewalsDue = inputs.visibility.lease
      ? inputs.properties.filter((p) => {
          if (p.ownership !== "rented" || p.renewalDecision === "not_renewing") return false;
          if (!inRegion(p.region, region)) return false;
          const due = asDate(p.leaseRenewalDate);
          return !!due && due <= leaseHorizon;
        }).length
      : 0;

    // A "failed" (bounced) payment is still owed, so it counts as unpaid here.
    const unpaid = inputs.visibility.rent
      ? inputs.rentPayments.filter((p) => inRegion(p.region, region) && (p.status === "unpaid" || p.status === "failed"))
      : [];
    const unpaidAmount = unpaid.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);

    return {
      region,
      admins,
      openRequests,
      openRepairs,
      openJobs,
      safetyPreventiveDue,
      leaseRenewalsDue,
      unpaidRent: { count: unpaid.length, amount: unpaidAmount.toFixed(2) },
      attentionScore: openRequests + safetyPreventiveDue + leaseRenewalsDue,
      hidden,
    };
  });

  return summaries.sort(
    (a, b) => b.attentionScore - a.attentionScore || a.region.localeCompare(b.region),
  );
}
