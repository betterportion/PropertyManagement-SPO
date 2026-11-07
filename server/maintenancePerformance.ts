/**
 * The admin's view of who closes maintenance work (JR, 2026-11-06): per
 * person, how many requests they closed, the median days from filing to
 * close, and how many of those used a contractor.
 *
 * Counts and a median, never a rating or a score, for the same reason the
 * contractor page has none (contractorSummary.ts). Pure: the rows in, the
 * table out. A person is whoever recorded the close-out, keyed on their
 * email, so the row outlives the account.
 */
import type { RequestCloseout } from "@shared/schema";

export interface CloseoutForPerformance {
  closeout: Pick<RequestCloseout, "completedAt" | "completedByEmail" | "completedByName">;
  submittedDate: Date | null;
  usedContractor: boolean;
}

export interface PersonPerformance {
  name: string;
  email: string | null;
  closed: number;
  /** Days, to one decimal; null when no close-out had a filing date. */
  medianDaysToClose: number | null;
  usedContractor: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function maintenancePerformance(rows: readonly CloseoutForPerformance[]): PersonPerformance[] {
  const people = new Map<string, { name: string; email: string | null; days: number[]; closed: number; usedContractor: number }>();
  for (const { closeout, submittedDate, usedContractor } of rows) {
    const email = closeout.completedByEmail?.trim() || null;
    const name = closeout.completedByName?.trim() || email || "Unknown";
    const key = email?.toLowerCase() ?? `name:${name}`;
    const person = people.get(key) ?? { name, email, days: [], closed: 0, usedContractor: 0 };
    person.closed += 1;
    if (usedContractor) person.usedContractor += 1;
    if (submittedDate) person.days.push((new Date(closeout.completedAt).getTime() - new Date(submittedDate).getTime()) / DAY_MS);
    people.set(key, person);
  }
  return Array.from(people.values())
    .map(({ name, email, days, closed, usedContractor }) => {
      const m = median(days);
      return { name, email, closed, usedContractor, medianDaysToClose: m === null ? null : Math.round(m * 10) / 10 };
    })
    .sort((a, b) => b.closed - a.closed || a.name.localeCompare(b.name));
}
