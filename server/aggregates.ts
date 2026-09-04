/**
 * Rollups over maintenance history.
 *
 * The stated purpose is bringing evidence into a conversation with a mission
 * leader about whether to keep renting a house or keep using a contractor. The
 * Phase 5 filters get most of the way — an RA can already see one house's
 * requests — but a filter answers "what happened here?" and these answer "what
 * keeps happening here?", which is a different question and the one that
 * settles an argument.
 *
 * Pure: records in, counts out. The caller passes only the records it is
 * entitled to, so a rollup never widens what somebody can see — a link to a
 * request the caller cannot read contributes nothing, not even a count.
 */
import { foldName, type MaintenanceRequest } from "@shared/schema";

/**
 * Separates the parts of a grouping key.
 *
 * Deliberately not a NUL byte, which is the obvious choice and the wrong one:
 * a NUL anywhere in a source file makes git treat the whole file as binary, so
 * the module ships with no readable diff. This character cannot occur in an
 * address, a room name or a category either, and keeps the file text.
 */
const KEY_SEPARATOR = "\u0001";

/**
 * The key a repeat is judged on: one house, one room, one category.
 *
 * Case- and whitespace-folded by `foldName`, because "Living room" and
 * "  living ROOM " are the same room typed twice. That folding is a backstop,
 * not the fix — the location field suggests from the house's walkthrough
 * vocabulary precisely so that new requests do not need it. The photo
 * comparison matches rooms across years by the same helper.
 *
 * The house is part of the key and always will be: "these blinds have broken
 * every year" is a claim about *these* blinds.
 */
function issueKey(request: Pick<MaintenanceRequest, "buildingAddress" | "location" | "category">): string | null {
  const location = foldName(request.location);
  // No room recorded means no issue to group. Grouping on "" would invent an
  // issue called nothing, in every house.
  if (!location) return null;
  return [foldName(request.buildingAddress), location, foldName(request.category)].join(KEY_SEPARATOR);
}

export interface RecurringIssue {
  buildingAddress: string;
  /** As last typed, so it reads the way somebody wrote it. */
  location: string;
  category: string;
  count: number;
  /** The most recent time it was reported, or null if none carried a date. */
  lastSeen: Date | null;
}

/**
 * What keeps going wrong, by house, room and category.
 *
 * Only things that have happened **more than once**: a list of every request
 * ever filed is the maintenance page, and this is for what comes back.
 */
export function recurringIssues(requests: readonly MaintenanceRequest[]): RecurringIssue[] {
  const groups = new Map<string, RecurringIssue>();

  for (const request of requests) {
    const key = issueKey(request);
    if (!key) continue;

    const submitted = request.submittedDate
      ? request.submittedDate instanceof Date
        ? request.submittedDate
        : new Date(request.submittedDate)
      : null;
    const seen = submitted && !Number.isNaN(submitted.getTime()) ? submitted : null;

    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      // Keep the room name as most recently typed, and the latest date.
      if (seen && (!existing.lastSeen || seen > existing.lastSeen)) {
        existing.lastSeen = seen;
        existing.location = request.location;
      }
    } else {
      groups.set(key, {
        buildingAddress: request.buildingAddress,
        location: request.location,
        category: request.category,
        count: 1,
        lastSeen: seen,
      });
    }
  }

  return Array.from(groups.values())
    .filter((issue) => issue.count > 1)
    .sort((a, b) => b.count - a.count || (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
}

export interface ContractorLoad {
  contactId: string;
  /** Requests they were linked to, among those the caller can see. */
  total: number;
  /** How many of those are still open. */
  open: number;
  /**
   * Repeat visits to the same room and category in the same house.
   *
   * The number worth having: "called back to the same problem" is a different
   * claim from "did a lot of jobs", and it is the one that belongs in a
   * conversation about whether to keep using somebody.
   */
  callbacks: number;
}

/** How much work each contractor has been linked to, and how much of it repeated. */
export function contractorLoad(
  links: readonly { contactId: string; requestId: string }[],
  requests: readonly MaintenanceRequest[],
): ContractorLoad[] {
  // Only the requests the caller passed. A link to one they cannot read
  // contributes nothing, not even a count.
  const byId = new Map(requests.map((request) => [request.id, request]));

  const perContact = new Map<string, { requests: MaintenanceRequest[] }>();
  for (const link of links) {
    const request = byId.get(link.requestId);
    if (!request) continue;
    const existing = perContact.get(link.contactId);
    if (existing) existing.requests.push(request);
    else perContact.set(link.contactId, { requests: [request] });
  }

  const rows: ContractorLoad[] = [];
  for (const [contactId, { requests: theirs }] of Array.from(perContact.entries())) {
    const seen = new Map<string, number>();
    for (const request of theirs) {
      const key = issueKey(request);
      if (!key) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // Every visit past the first to the same problem is a callback.
    let callbacks = 0;
    for (const count of Array.from(seen.values())) callbacks += count - 1;

    rows.push({
      contactId,
      total: theirs.length,
      open: theirs.filter(
        (request) => request.status !== "completed" && request.status !== "cancelled",
      ).length,
      callbacks,
    });
  }

  return rows.sort((a, b) => b.callbacks - a.callbacks || b.total - a.total);
}
