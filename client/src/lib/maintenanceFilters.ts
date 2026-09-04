/**
 * The maintenance list's filters, as arithmetic.
 *
 * Pure — records plus `now` in, a decision out — so the list, the counts on
 * the status tabs and the per-house view all narrow the same way and can be
 * tested without rendering anything.
 */
import { MAINTENANCE_REQUEST_TYPES, isClosedMaintenanceStatus, type MaintenanceRequest } from "@shared/schema";
import { REQUEST_PRIORITY, REQUEST_TYPE } from "./requestLabels";

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
 * Delegates to the shared predicate rather than repeating the two statuses.
 * The resident visibility window in server/authz.ts asks the same question,
 * and a fifth status with two copies of the answer would silently widen or
 * narrow what a household leader can read.
 */
export function isClosed(request: Pick<MaintenanceRequest, "status">): boolean {
  return isClosedMaintenanceStatus(request.status);
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

/** Which kind of work to show. `all` is the default, not an escape hatch. */
export type RequestTypeFilter = "all" | MaintenanceRequest["type"];

/**
 * The type filter's options: all types first, then each type in the order
 * the schema lists them, labelled from the one shared map so the filter and
 * the badges cannot disagree about what a `capex` is called.
 */
export const REQUEST_TYPE_FILTERS: readonly { value: RequestTypeFilter; label: string }[] = [
  { value: "all", label: "All types" },
  ...MAINTENANCE_REQUEST_TYPES.map((type) => ({ value: type, label: REQUEST_TYPE[type].label })),
];

/**
 * Whether a request survives the type filter. A type filter and nothing
 * more: a wishlist repair is still a repair, because wishlist is a priority.
 */
export function matchesType(request: Pick<MaintenanceRequest, "type">, filter: RequestTypeFilter): boolean {
  // A value the vocabulary does not know -- a stale bookmark, a hand-edited
  // link -- reads as "all" rather than as "nothing": a misspelt filter that
  // empties the whole list looks like there is no work, which is the lie a
  // triage screen cannot afford.
  if (!(MAINTENANCE_REQUEST_TYPES as readonly string[]).includes(filter)) return true;
  return request.type === filter;
}

/** The four groups of open work on a house. Three are types; wishlist is a priority. */
export type OpenWorkKey = MaintenanceRequest["type"] | "wishlist";

export interface OpenWorkGroup<T> {
  key: OpenWorkKey;
  label: string;
  items: T[];
}

/**
 * The groups in the order the property page shows them: the three types as
 * the schema lists them, then the wishlist last -- "eventually" reads below
 * what is due now, not ahead of it. Labels come from the one label map so a
 * group and the badge on its items cannot call a `capex` two different things.
 */
export const OPEN_WORK_GROUPS: readonly { key: OpenWorkKey; label: string }[] = [
  ...MAINTENANCE_REQUEST_TYPES.map((type) => ({ key: type, label: REQUEST_TYPE[type].plural })),
  { key: "wishlist", label: REQUEST_PRIORITY.wishlist.label },
];

/**
 * Open work on one house, grouped once.
 *
 * The wishlist is pulled out FIRST -- anything at wishlist priority, whatever
 * its type -- and the rest fall into their type group, so every open item
 * lands in exactly one group and the four counts add up to the open total. A
 * wishlist capital project is therefore under Wishlist and nowhere else.
 * Closed items are not here at all: this is what is still to do, not history.
 */
export function groupOpenWork<T extends Pick<MaintenanceRequest, "status" | "type" | "priority">>(
  requests: readonly T[],
): OpenWorkGroup<T>[] {
  const open = requests.filter((request) => !isClosed(request));
  const groupOf = (request: T): OpenWorkKey =>
    request.priority === "wishlist" ? "wishlist" : request.type;
  return OPEN_WORK_GROUPS.map((group) => ({
    ...group,
    items: open.filter((request) => groupOf(request) === group.key),
  }));
}
