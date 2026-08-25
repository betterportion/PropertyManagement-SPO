/**
 * Preventive & safety maintenance scheduling.
 *
 * A schedule is a recurring upkeep task on a house. When one comes due a daily
 * job turns it into an ordinary maintenance request, so scheduled work lands in
 * the same queue staff already use -- there is no second task system to watch.
 *
 * The job is idempotent: `lastGeneratedForDue` records the due date a request
 * was last generated for, so a task that stays overdue (nobody has done it yet)
 * does not spawn a fresh request every single day. Completing a task advances
 * its due date and clears that marker, so the next cycle generates again.
 */
import { storage } from "./storage";
import { logError } from "./errors";
import type { MaintenanceSchedule } from "@shared/schema";

export const SCHEDULE_GENERATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * The standard set of house schedules an admin can apply in one action.
 * Chosen for a residence full of young adults: heating and water heater looked
 * after, filters changed, and the safety checks a duty of care demands.
 */
export const STANDARD_SCHEDULE_TEMPLATES: ReadonlyArray<{
  title: string;
  category: "safety" | "preventive";
  intervalMonths: number;
}> = [
  { title: "Furnace / heating service", category: "preventive", intervalMonths: 12 },
  { title: "HVAC filter change", category: "preventive", intervalMonths: 3 },
  { title: "Water heater inspection", category: "preventive", intervalMonths: 12 },
  { title: "Gutter cleaning", category: "preventive", intervalMonths: 12 },
  { title: "Smoke & CO detector test", category: "safety", intervalMonths: 6 },
  { title: "Fire extinguisher check", category: "safety", intervalMonths: 12 },
  { title: "Dryer vent cleaning", category: "safety", intervalMonths: 12 },
];

/**
 * Adds whole months to a date, clamping the day so adding a month to Jan 31
 * lands on the last day of February rather than spilling into March.
 *
 * Operates in UTC: due dates are stored as UTC-midnight timestamps, and doing
 * the arithmetic in local time would shift the calendar day for anyone whose
 * server is not on UTC.
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const targetMonth = result.getUTCMonth() + months;
  result.setUTCMonth(targetMonth);
  // If the day overflowed (e.g. Jan 31 + 1mo tried to be Mar 3), step back to
  // the last day of the intended month.
  if (result.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) {
    result.setUTCDate(0);
  }
  return result;
}

/** A schedule needs a request generated when it is due and has not already had
 *  one generated for this due date. */
export function needsRequest(schedule: MaintenanceSchedule, now: Date): boolean {
  if (!schedule.isActive) return false;
  if (schedule.nextDueDate.getTime() > now.getTime()) return false;
  if (
    schedule.lastGeneratedForDue &&
    schedule.lastGeneratedForDue.getTime() >= schedule.nextDueDate.getTime()
  ) {
    return false;
  }
  return true;
}

/** Turns one due schedule into the maintenance request payload. Safety tasks
 *  come in a notch higher than routine upkeep. */
export function requestFromSchedule(schedule: MaintenanceSchedule) {
  const isSafety = schedule.category === "safety";
  return {
    title: schedule.title,
    description: `Scheduled ${isSafety ? "safety check" : "preventive maintenance"}, due ${schedule.nextDueDate.toISOString().slice(0, 10)}.`,
    category: isSafety ? "Safety Equipment" : "General Maintenance",
    priority: (isSafety ? "high" : "medium") as "high" | "medium",
    status: "pending" as const,
    location: "Whole house",
    region: schedule.region,
    buildingAddress: schedule.buildingAddress,
    submittedBy: "Preventive schedule",
  };
}

/**
 * Generates maintenance requests for every schedule that is due and has not
 * already produced one for this due date. Returns how many were created.
 */
export async function generateDueMaintenanceRequests(now: Date): Promise<number> {
  const due = await storage.getDueMaintenanceSchedules(now);
  let created = 0;
  for (const schedule of due) {
    if (!needsRequest(schedule, now)) continue;
    await storage.createMaintenanceRequest(requestFromSchedule(schedule));
    await storage.markMaintenanceScheduleGenerated(schedule.id, schedule.nextDueDate);
    created += 1;
  }
  return created;
}

function runScheduledGeneration(): void {
  // Like the audit job: a database hiccup must never become an unhandled
  // rejection or take the server down.
  try {
    void generateDueMaintenanceRequests(new Date())
      .then((created) => {
        if (created > 0) {
          console.info(`[schedules] Generated ${created} request(s) from due maintenance schedules`);
        }
      })
      .catch((error) => {
        logError("Failed to generate requests from maintenance schedules", error);
      });
  } catch (error) {
    logError("Failed to start maintenance-schedule generation", error);
  }
}

/**
 * Starts the daily generation job and runs it once immediately, so a freshly
 * restarted instance catches up without waiting a full day.
 */
export function startScheduleGenerationJob(): NodeJS.Timeout {
  runScheduledGeneration();
  const timer = setInterval(runScheduledGeneration, SCHEDULE_GENERATION_INTERVAL_MS);
  timer.unref();
  return timer;
}
