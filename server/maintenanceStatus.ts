/**
 * When a maintenance request was closed.
 *
 * `maintenance_requests.completedDate` has existed in the schema since the
 * baseline but was never written by anything: the column was declared, omitted
 * from the insert schema, and left null on every row. Nothing depended on it,
 * so nothing noticed.
 *
 * It matters now because the resident visibility window needs a clock. A
 * household leader is to keep seeing a closed request for a fixed number of
 * days after it closed, and neither of the nearby timestamps can answer that:
 * `submittedDate` is when the request was filed, and `updatedAt` moves on any
 * edit, so attaching a photo to a request closed a year ago would drag it back
 * into the window.
 *
 * The rules live here, as a pure function over the two statuses and `now`, for
 * the same reason `actionItems.ts` and `regionSummary.ts` are pure: the
 * interesting cases are transitions and clock arithmetic, and both are far
 * easier to get right when they can be tested without a database.
 */
import type { MaintenanceRequest } from "@shared/schema";

type MaintenanceStatus = MaintenanceRequest["status"];

/**
 * The statuses that count as closed.
 *
 * `cancelled` is closed as much as `completed` is: the request is off the
 * queue and nobody is working on it. The stored column is still named
 * `completedDate` because renaming it would orphan the history already under
 * that name, but "closed" is what it means.
 */
export const CLOSED_MAINTENANCE_STATUSES = ["completed", "cancelled"] as const;

export function isClosedStatus(status: MaintenanceStatus | null | undefined): boolean {
  return status != null && (CLOSED_MAINTENANCE_STATUSES as readonly string[]).includes(status);
}

/**
 * The change to `completedDate` implied by a status transition, as a patch to
 * spread into an update. An empty object means leave the stored value alone.
 *
 * Three decisions are baked in here, each of which could reasonably have gone
 * the other way:
 *
 *   - **Closing sets the date; reopening clears it.** A request that goes back
 *     to `in_progress` is open again, and an open request is always visible, so
 *     a stale close date on it would be misleading rather than merely unused.
 *   - **Moving between two closed statuses keeps the original date.** A request
 *     marked `completed` and later corrected to `cancelled` closed when it was
 *     first closed. Restamping it would silently restart the visibility window.
 *   - **An edit that does not change the status writes nothing.** This is the
 *     one that protects the rows that predate the column being written: they
 *     are closed with no date, and an unrelated edit must not backfill one.
 *     Doing so would make a request closed years ago look freshly closed and
 *     hand a resident back access the window exists to withdraw.
 */
export function closedDateChange(
  previousStatus: MaintenanceStatus | null | undefined,
  nextStatus: MaintenanceStatus | null | undefined,
  now: Date,
): { completedDate?: Date | null } {
  if (nextStatus == null || nextStatus === previousStatus) return {};

  const wasClosed = isClosedStatus(previousStatus);
  const isClosed = isClosedStatus(nextStatus);

  if (!wasClosed && isClosed) return { completedDate: now };
  if (wasClosed && !isClosed) return { completedDate: null };
  return {};
}
