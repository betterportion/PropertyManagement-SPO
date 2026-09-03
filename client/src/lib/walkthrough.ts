/**
 * How a walkthrough reads on screen: what each condition is called, and how
 * much of an inspection is done.
 *
 * Pure — items in, counts and labels out — because the mobile screen shows the
 * same numbers in three places (the header bar, the room switcher, the finish
 * summary) and they must agree.
 *
 * Two rules here exist because of decisions made further down the stack:
 *
 *   - `not_applicable` and `not_recorded` are never shown the same way. One
 *     says the item does not exist in this house; the other says nobody
 *     looked. See WALKTHROUGH_CONDITIONS in shared/schema.ts.
 *   - Every condition carries a text label. Colour alone would leave the state
 *     of a room unreadable to anyone who cannot separate the hues.
 */
import {
  WALKTHROUGH_FLAGGED_CONDITIONS,
  type Walkthrough,
  type WalkthroughCondition,
  type WalkthroughItem,
} from "@shared/schema";

/** What each kind of inspection is called on screen. */
export const WALKTHROUGH_TYPE_LABEL: Record<Walkthrough["type"], string> = {
  move_in: "Move in",
  move_out: "Move out",
  annual: "Annual",
  legacy: "Legacy",
};

/**
 * How a walkthrough's status reads. "Draft" is the database's word, not a
 * word an RA uses -- on screen a draft is simply a walkthrough still being
 * filled in.
 */
export const WALKTHROUGH_STATUS_BADGE: Record<
  Walkthrough["status"],
  { label: string; variant: "warning" | "info" | "success" }
> = {
  draft: { label: "In progress", variant: "warning" },
  submitted: { label: "Submitted", variant: "info" },
  reviewed: { label: "Reviewed", variant: "success" },
};

/** The shape of `/api/auth/user` that the walkthrough screens actually read. */
export interface WalkthroughUser {
  role?: string | null;
  /** The house a resident login is linked to; null for staff. */
  propertyId?: string | null;
  permissions?: {
    canManageWalkthroughs?: boolean | null;
    canCompleteWalkthroughs?: boolean | null;
    canViewResourceHub?: boolean | null;
    canViewProperties?: boolean | null;
    canManageProperties?: boolean | null;
  } | null;
}

/** Whether this is a resident-tier account rather than a staff one. */
export function isResidentAccount(user: WalkthroughUser | null | undefined): boolean {
  return user?.role === "resident";
}

/**
 * Whether this account may fill in walkthroughs at all.
 *
 * Mirrors the *manage* half of `hasWalkthroughPermission` in server/authz.ts —
 * the client has no read-only walkthrough surface, so the view half has no
 * caller here. Named for what it decides rather than after any one permission
 * column, because two different columns answer it depending on the tier:
 *
 *   - an admin is in regardless of whether they have a permissions row at all
 *     (the admin bypass -- most do not, and a check reading only the flag
 *     would hide every control from the people who administer the app);
 *   - a resident is in only on `canCompleteWalkthroughs`, and a staff flag on
 *     a resident account buys nothing;
 *   - everyone else needs `canManageWalkthroughs`.
 *
 * What it does NOT say is *which* walkthrough. For a resident the server binds
 * that to the one house their login is linked to, and no client check stands
 * in for that.
 *
 * Pure, so both screens can compute it below their hooks rather than returning
 * early above them.
 */
export function canFillInWalkthroughs(user: WalkthroughUser | null | undefined): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (isResidentAccount(user)) return user.permissions?.canCompleteWalkthroughs === true;
  return user.permissions?.canManageWalkthroughs === true;
}

/**
 * Whether the room photos belong on screen for this account.
 *
 * Staff only, and deliberately narrower than `canManageWalkthroughs`: a
 * resident cannot upload a file anywhere in the portal except a maintenance
 * request, and `canReadUploadReference` does not give them a walkthrough
 * photo either. Showing the section to a household leader would offer a
 * control every request behind it would refuse.
 */
export function canSeeWalkthroughPhotos(user: WalkthroughUser | null | undefined): boolean {
  return !!user && !isResidentAccount(user);
}

/**
 * Whether this account may write to *this particular* walkthrough.
 *
 * `canFillInWalkthroughs` says whether the account holds the grant at all;
 * this says whether the walkthrough in front of them is one the grant reaches.
 * The two differ only for a resident, whose prior years are read-only — see
 * `isCurrentWalkthrough` in server/authz.ts, which this mirrors so the screen
 * never offers a control the PATCH behind it would refuse.
 *
 * `houseWalkthroughs` is every walkthrough of that house the caller can see.
 * For a staff account it is not consulted at all.
 */
export function canWriteWalkthrough(
  user: WalkthroughUser | null | undefined,
  walkthrough: { walkthroughDate?: Date | string | null } | null | undefined,
  houseWalkthroughs: readonly { walkthroughDate?: Date | string | null }[],
): boolean {
  if (!canFillInWalkthroughs(user)) return false;
  if (!isResidentAccount(user)) return true;
  return !!walkthrough && isCurrentWalkthrough(walkthrough, houseWalkthroughs);
}

/** The timestamp a walkthrough records, or null when it has none. */
function walkthroughTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Whether this is the walkthrough of its house still being performed.
 *
 * The same rule as `isCurrentWalkthrough` in server/authz.ts, and for the same
 * reasons: dates rather than status, ties writable, undated read-only.
 */
export function isCurrentWalkthrough(
  walkthrough: { walkthroughDate?: Date | string | null },
  houseWalkthroughs: readonly { walkthroughDate?: Date | string | null }[],
): boolean {
  const at = walkthroughTime(walkthrough.walkthroughDate);
  if (at === null) return false;
  for (const other of houseWalkthroughs) {
    const time = walkthroughTime(other.walkthroughDate);
    if (time !== null && time > at) return false;
  }
  return true;
}

/** What an RA reads on the chip. Short, because these sit in a row on a phone. */
export const CONDITION_LABEL: Record<WalkthroughCondition, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  damaged: "Damaged",
  not_applicable: "Not here",
  not_recorded: "Not checked",
};

/**
 * The longer form, for the one place there is room to explain the difference
 * between "not here" and "not checked".
 */
export const CONDITION_HINT: Record<WalkthroughCondition, string> = {
  good: "No work needed.",
  fair: "Worn but working.",
  poor: "Needs attention.",
  damaged: "Broken or unsafe.",
  not_applicable: "This house does not have one.",
  not_recorded: "Nobody has checked this yet.",
};

export type ConditionTone = "good" | "neutral" | "warn" | "bad" | "muted";

/** The visual weight a condition carries. Always paired with its label. */
export function conditionTone(condition: WalkthroughCondition): ConditionTone {
  switch (condition) {
    case "good":
      return "good";
    case "fair":
      return "neutral";
    case "poor":
      return "warn";
    case "damaged":
      return "bad";
    case "not_applicable":
      return "muted";
    case "not_recorded":
      return "neutral";
  }
}

const FLAGGED = new Set<string>(WALKTHROUGH_FLAGGED_CONDITIONS);

/**
 * Whether somebody has made a call on this item.
 *
 * `not_applicable` counts: an RA saying "this house has no smoke detector
 * there" is an answer, and leaving it out of the total would mean a house
 * missing a fixture could never reach 100%.
 */
export function isAssessed(condition: WalkthroughCondition): boolean {
  return condition !== "not_recorded";
}

export interface WalkthroughProgress {
  total: number;
  assessed: number;
  /** Items whose condition needs attention — poor or damaged. */
  flagged: number;
  /** 0-100, rounded down so 100 only ever means finished. */
  percent: number;
}

/** Counts over any set of items: one room's, or the whole walkthrough's. */
export function progressOf(items: readonly WalkthroughItem[]): WalkthroughProgress {
  let assessed = 0;
  let flagged = 0;
  for (const item of items) {
    if (isAssessed(item.condition)) assessed += 1;
    if (FLAGGED.has(item.condition)) flagged += 1;
  }
  const total = items.length;
  // Zero items is zero progress, not a finished room. A bar reading 100% on a
  // room nobody has filled in would be the one lie this screen cannot afford.
  const percent = total === 0 ? 0 : Math.floor((assessed / total) * 100);
  return { total, assessed, flagged, percent };
}

export type RoomStatus = "empty" | "todo" | "partial" | "done";

/** Where a room stands, for the switcher list. */
export function roomStatus(items: readonly WalkthroughItem[]): RoomStatus {
  const { total, assessed } = progressOf(items);
  if (total === 0) return "empty";
  if (assessed === 0) return "todo";
  return assessed === total ? "done" : "partial";
}

/**
 * Items grouped by their room, each group in display order.
 *
 * The screen loads every item of a walkthrough in one request — a phone in a
 * house should not make one round trip per room — and then reads each room out
 * of this map as the RA moves through them.
 */
export function itemsByRoom(items: readonly WalkthroughItem[]): Map<string, WalkthroughItem[]> {
  const grouped = new Map<string, WalkthroughItem[]>();
  for (const item of items) {
    const existing = grouped.get(item.roomId);
    if (existing) existing.push(item);
    else grouped.set(item.roomId, [item]);
  }
  for (const group of Array.from(grouped.values())) {
    group.sort((a: WalkthroughItem, b: WalkthroughItem) => a.displayOrder - b.displayOrder);
  }
  return grouped;
}

/**
 * Whether this account reaches the resource hub.
 *
 * A resident-tier capability gated on its own flag, exactly as walkthrough
 * completion is — and deliberately NOT `canCompleteWalkthroughs`, because a
 * leader who fills in walkthroughs and a leader who has been given the hub are
 * two grants, and honouring one for the other means a later change to either
 * silently moves the other.
 *
 * Staff reach it under the property permission, so they can see what their
 * households are being told. Mirrors the server's rule on the three hub routes.
 *
 * Lives here rather than in a component because the page and the sidebar both
 * ask, and an answer computed twice is an answer that drifts.
 */
export function canSeeResourceHub(user: WalkthroughUser | null | undefined): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (isResidentAccount(user)) return user.permissions?.canViewResourceHub === true;
  return (
    user.permissions?.canViewProperties === true ||
    user.permissions?.canManageProperties === true
  );
}
