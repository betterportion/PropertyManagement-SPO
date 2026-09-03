/**
 * The maintenance list's filters, as arithmetic.
 *
 * Pure — records plus `now` in, a decision out — so the list, the counts on
 * the status tabs and the per-house view all narrow the same way and can be
 * tested without rendering anything.
 */
import type { MaintenanceRequest } from "@shared/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back to show closed work. `all` is the escape hatch. */
export type ClosedRange = "7" | "30" | "60" | "90" | "180" | "all";

export const CLOSED_RANGES: readonly { value: ClosedRange; label: string }[] = [
  { value: "7", label: "Closed in the last week" },
  { value: "30", label: "Closed in the last 30 days" },
  { value: "60", label: "Closed in the last 60 days" },
  { value: "90", label: "Closed in the last 90 days" },
  { value: "180", label: "Closed in the last 6 months" },
  { value: "all", label: "All closed requests" },
];

/**
 * Whether a request is finished.
 *
 * Cancelled counts. `completedDate` is the *close* date and is stamped for a
 * cancelled request as well as a completed one, so a cancelled request is
 * finished work rather than open work.
 */
export function isClosed(request: Pick<MaintenanceRequest, "status">): boolean {
  return request.status === "completed" || request.status === "cancelled";
}

/**
 * Whether a request survives the range filter.
 *
 * Two deliberate leniencies, both because this is a *view* filter and not a
 * permission:
 *
 *   - an OPEN request always passes, whatever the range. The range is about
 *     history, and hiding current work would hide the thing an RA came to do.
 *   - a closed request with no usable close date passes too. Requests closed
 *     before close dates were recorded have none, and hiding them from staff
 *     would lose history nothing can rebuild. This is the opposite call from
 *     the resident visibility window in server/authz.ts, which fails *closed*
 *     on the same missing value — because that one decides access.
 */
export function closedWithinRange(
  request: Pick<MaintenanceRequest, "status" | "completedDate">,
  range: ClosedRange,
  now: Date = new Date(),
): boolean {
  if (range === "all") return true;
  if (!isClosed(request)) return true;
  if (!request.completedDate) return true;

  const closedAt =
    request.completedDate instanceof Date
      ? request.completedDate.getTime()
      : new Date(request.completedDate).getTime();
  if (Number.isNaN(closedAt)) return true;

  // Inclusive: "the last 30 days" that silently excludes day 30 is the kind of
  // off-by-one that makes somebody think a request vanished.
  return now.getTime() - closedAt <= Number(range) * DAY_MS;
}

/**
 * The rooms worth offering in the room filter.
 *
 * Built from the locations actually recorded rather than from a fixed list, so
 * a house whose walkthrough has no word for somewhere still filters by
 * whatever people typed.
 */
export function locationOptions(requests: readonly Pick<MaintenanceRequest, "location">[]): string[] {
  const seen = new Set<string>();
  for (const request of requests) {
    const location = request.location?.trim();
    if (location) seen.add(location);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}
