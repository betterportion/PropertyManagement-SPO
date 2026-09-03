/**
 * Recurring, date-triggered reminder tasks that SPO runs on a calendar rather
 * than a fixed interval (unlike the per-house maintenance schedules).
 *
 * These are region-level (or, for a lease ending, one per rented house) and land
 * as ordinary `tasks` so a regional admin can check them off — which is how the
 * admin team sees a region is squared away. They carry a `sourceKey` so the
 * daily generator is idempotent: one task per cadence, region and cycle.
 *
 * The cadences, straight from SPO:
 *   - Household walkthroughs: a reminder each April 15 and July 15 (due ~2 weeks
 *     later), per region.
 *   - Turn off utilities for the summer: ~2 weeks before May 15, per region.
 *   - Turn off utilities when a lease ends: 2 weeks before a rented house's lease
 *     end date, per house (skipped when the house is renewing).
 *
 * `dueSeasonalTasks` is a pure function of the inputs plus `now`, so the whole
 * calendar is unit-testable without a database or a clock.
 */
import { storage } from "./storage";
import { logError } from "./errors";

export const SEASONAL_TASK_GENERATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * A reminder is only *created* while `now` sits within this many days after its
 * appear date. That stops a freshly-migrated instance from back-filling months
 * of long-past cadences, while still letting a genuinely late one linger (once
 * created, a task stays until it is checked off, regardless of this window).
 */
export const SEASONAL_CREATE_WINDOW_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How far ahead the renew-or-leave decision is raised — two months.
 *
 * The same horizon the dashboard's lease item uses, so the reminder and the
 * dashboard cannot tell an RA two different things about the same date.
 */
export const LEASE_RENEWAL_NOTICE_DAYS = 60;

export interface SeasonalLease {
  propertyId: string;
  name: string;
  region: string;
  leaseEndDate: Date;
  /** When the renew-or-leave decision is due. Null for a house with none. */
  leaseRenewalDate: Date | null;
  renewalDecision: string;
}

export interface SeasonalInputs {
  /** Regions that have at least one property — the ones worth reminding. */
  regions: string[];
  rentedLeases: SeasonalLease[];
}

export interface SeasonalTaskSpec {
  sourceKey: string;
  title: string;
  notes: string;
  region: string;
  dueDate: Date;
}

const utc = (year: number, month1: number, day: number) => new Date(Date.UTC(year, month1 - 1, day));
const daysBefore = (date: Date, n: number) => new Date(date.getTime() - n * DAY_MS);
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** True while `now` is on or after the appear date and still inside the window. */
function inCreateWindow(appear: Date, now: Date): boolean {
  return now >= appear && now.getTime() - appear.getTime() <= SEASONAL_CREATE_WINDOW_DAYS * DAY_MS;
}

/**
 * The reminder tasks that should exist as of `now`. The generator creates any of
 * these that are not already on file (matched by `sourceKey`).
 */
export function dueSeasonalTasks(inputs: SeasonalInputs, now: Date): SeasonalTaskSpec[] {
  const specs: SeasonalTaskSpec[] = [];
  const year = now.getUTCFullYear();

  const walkthroughs = [
    { key: "apr", appear: utc(year, 4, 15), due: utc(year, 4, 29) },
    { key: "jul", appear: utc(year, 7, 15), due: utc(year, 7, 29) },
  ];
  const summerUtilitiesAppear = utc(year, 5, 1); // two weeks before May 15
  const summerUtilitiesDue = utc(year, 5, 15);

  for (const region of inputs.regions) {
    for (const w of walkthroughs) {
      if (inCreateWindow(w.appear, now)) {
        specs.push({
          sourceKey: `walkthrough:${w.key}:${region}:${year}`,
          title: `Household walkthroughs due — ${region}`,
          notes: "Time to plan and execute household walkthroughs. Check this off once your region's houses are done.",
          region,
          dueDate: w.due,
        });
      }
    }
    if (inCreateWindow(summerUtilitiesAppear, now)) {
      specs.push({
        sourceKey: `utilities-summer:${region}:${year}`,
        title: `Turn off utilities for summer — ${region}`,
        notes: "Shut off utilities at your region's houses ahead of the summer break.",
        region,
        dueDate: summerUtilitiesDue,
      });
    }
  }

  // The renew-or-leave decision, off the lease renewal date. It resolves when
  // the decision is recorded either way -- properties.renewalDecision already
  // exists, so the reminder can stop rather than nag about something somebody
  // has already settled.
  for (const lease of inputs.rentedLeases) {
    if (!lease.leaseRenewalDate) continue;
    if (lease.renewalDecision !== "undecided") continue;
    const appear = daysBefore(lease.leaseRenewalDate, LEASE_RENEWAL_NOTICE_DAYS);
    if (inCreateWindow(appear, now)) {
      specs.push({
        sourceKey: `lease-renewal:${lease.propertyId}:${isoDay(lease.leaseRenewalDate)}`,
        title: `Renew or leave? — ${lease.name}`,
        notes:
          "This house's lease renewal decision is due. Record the decision on the property so this reminder clears.",
        region: lease.region,
        dueDate: lease.leaseRenewalDate,
      });
    }
  }

  for (const lease of inputs.rentedLeases) {
    if (lease.renewalDecision === "renewing") continue; // staying put — no shut-off
    const appear = daysBefore(lease.leaseEndDate, 14);
    if (inCreateWindow(appear, now)) {
      specs.push({
        sourceKey: `utilities-lease:${lease.propertyId}:${isoDay(lease.leaseEndDate)}`,
        title: `Turn off utilities — ${lease.name} lease ending`,
        notes: "This house's lease is ending soon; arrange to shut off the utilities.",
        region: lease.region,
        dueDate: lease.leaseEndDate,
      });
    }
  }

  return specs;
}

/** Creates any due reminder that is not already on file. Returns how many. */
export async function generateSeasonalTasks(now: Date): Promise<number> {
  const properties = await storage.getAllProperties();
  const regions = Array.from(new Set(properties.map((p) => p.region).filter((r): r is string => !!r)));
  const rentedLeases: SeasonalLease[] = properties
    .filter((p) => p.ownership === "rented" && p.leaseEndDate)
    .map((p) => ({
      propertyId: p.id,
      name: p.name,
      region: p.region,
      leaseEndDate: new Date(p.leaseEndDate as Date),
      leaseRenewalDate: p.leaseRenewalDate ? new Date(p.leaseRenewalDate) : null,
      renewalDecision: p.renewalDecision,
    }));

  let created = 0;
  for (const spec of dueSeasonalTasks({ regions, rentedLeases }, now)) {
    if (await storage.getTaskBySourceKey(spec.sourceKey)) continue;
    await storage.createTask({
      title: spec.title,
      notes: spec.notes,
      category: "safety",
      status: "open",
      dueDate: spec.dueDate,
      region: spec.region,
      assignedToUserId: null,
      createdBy: null,
      sourceKey: spec.sourceKey,
    });
    created += 1;
  }
  return created;
}

function runSeasonalGeneration(): void {
  // Like the other background jobs: a database hiccup must never become an
  // unhandled rejection or take the server down.
  try {
    void generateSeasonalTasks(new Date())
      .then((created) => {
        if (created > 0) {
          console.info(`[seasonal] Created ${created} recurring reminder task(s)`);
        }
      })
      .catch((error) => {
        logError("Failed to generate seasonal reminder tasks", error);
      });
  } catch (error) {
    logError("Failed to start seasonal reminder generation", error);
  }
}

/** Starts the daily generator and runs it once immediately at boot. */
export function startSeasonalTaskJob(): NodeJS.Timeout {
  runSeasonalGeneration();
  const timer = setInterval(runSeasonalGeneration, SEASONAL_TASK_GENERATION_INTERVAL_MS);
  timer.unref();
  return timer;
}
