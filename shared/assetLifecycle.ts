/**
 * When an asset is due for replacement, and how loudly to say so.
 *
 * SPO's asset tracking is admittedly inconsistent, and that shapes everything
 * here. A warning system that guesses at missing data is worse than one that
 * stays quiet, because the guesses are indistinguishable from the real
 * warnings and people stop reading all of them.
 *
 * So:
 *   - the CATEGORY carries a default lifespan and the ASSET carries the
 *     correction. Per-asset entry alone would be mostly blank;
 *   - an asset with no date to reason from is UNRATED — never a warning, never
 *     a guess;
 *   - a snooze suppresses an asset on the dashboard only. It stays visible,
 *     and visibly snoozed, on the asset screen. Hiding it everywhere is how a
 *     boiler gets forgotten for three years.
 *
 * Pure: an asset plus `now` in, a status out. It lives in `shared/` because
 * the asset screen, the detail page and the dashboard all read it, and a
 * second copy on the client is how they come to disagree.
 */

/**
 * The categories an asset can be filed under.
 *
 * Here rather than in the Assets page because the lifespan table below is
 * keyed on them: two lists in two files is how a category ends up with no
 * lifespan and nobody notices.
 */
export const ASSET_CATEGORIES = [
  "Appliances - Large",
  "Appliances - Small",
  "Artwork",
  "A/V Equipment",
  "Computer - Accessories",
  "Computer - Desktop",
  "Computer - Laptop",
  "Computer - Monitor",
  "Furniture - Household",
  "Furniture - Office",
  "HVAC",
  "Internet Equipment",
  "Musical Instruments",
  "Office Equipment",
  "Office Supplies",
  "Outdoor Equipment",
  "Printers",
  "Roof",
  "Security System",
  "Tablets",
  "Tools",
  "Water Heater",
] as const;

/** Categories that belong to the building rather than to a person. */
export const FIXED_CATEGORIES: readonly string[] = [
  "Appliances - Large",
  "HVAC",
  "Roof",
  "Security System",
  "Water Heater",
];

export const MOVABLE_CATEGORIES: readonly string[] = ASSET_CATEGORIES.filter(
  (category) => !FIXED_CATEGORIES.includes(category),
);

/**
 * How long each category is expected to last, in years.
 *
 * **Provisional.** These are ordinary industry service lives, not figures SPO
 * has confirmed — confirming the list is an open item with them. They are the
 * starting point for a house nobody has assessed, and the per-asset
 * `expectedLifespanYears` is the correction an RA makes when they know better.
 *
 * A category deliberately absent from this table has NO default: an asset in
 * it stays unrated rather than silently inheriting somebody else's number.
 * Artwork and musical instruments do not wear out on a schedule, and putting a
 * guess against a piano would be a warning nobody should act on.
 */
export const DEFAULT_LIFESPAN_YEARS: Readonly<Record<string, number>> = {
  "Appliances - Large": 12,
  "Appliances - Small": 6,
  "A/V Equipment": 7,
  "Computer - Desktop": 6,
  "Computer - Laptop": 5,
  "Computer - Monitor": 8,
  "Computer - Accessories": 4,
  "Furniture - Household": 15,
  "Furniture - Office": 12,
  HVAC: 18,
  "Internet Equipment": 6,
  "Office Equipment": 8,
  "Outdoor Equipment": 8,
  Printers: 6,
  Roof: 25,
  "Security System": 10,
  Tablets: 5,
  Tools: 12,
  "Water Heater": 12,
};

/**
 * When an asset starts showing amber: three years out, which is when a
 * replacement enters planning rather than a budget.
 */
export const LIFECYCLE_WARN_YEARS = 3;

/**
 * When it goes red: twelve months or less.
 *
 * This threshold is not arbitrary — it exists because at that point the
 * replacement has to enter that year's budget.
 */
export const LIFECYCLE_URGENT_YEARS = 1;

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** The fields the lifecycle rules actually read off an asset. */
export interface LifecycleAsset {
  category: string;
  acquisitionDate?: Date | string | null;
  /** Per-asset override of the category default. */
  expectedLifespanYears?: number | null;
  /** An explicit date, which beats anything computed. */
  replacementDueDate?: Date | string | null;
  snoozedUntil?: Date | string | null;
}

/**
 * A stored date as a number of milliseconds, or null.
 *
 * Null for anything that is not a real date, including a malformed string
 * arriving across a JSON boundary. Parsing one as epoch zero would report
 * every asset in the portfolio as decades overdue, which is exactly the kind
 * of loud-and-wrong this module exists to avoid.
 */
function time(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(at) ? null : at;
}

/**
 * When this asset is due for replacement, or null when nothing says.
 *
 * Precedence, most authoritative first:
 *   1. an explicit `replacementDueDate` — the permanent correction an RA makes;
 *   2. the acquisition date plus the per-asset lifespan;
 *   3. the acquisition date plus the category default.
 *
 * Null whenever none of those resolves, which is the honest answer for an
 * asset nobody recorded a date for.
 */
export function replacementDueAt(asset: LifecycleAsset): Date | null {
  const explicit = time(asset.replacementDueDate);
  if (explicit !== null) return new Date(explicit);

  const acquired = time(asset.acquisitionDate);
  if (acquired === null) return null;

  const lifespan =
    asset.expectedLifespanYears ?? DEFAULT_LIFESPAN_YEARS[asset.category] ?? null;
  if (lifespan === null) return null;

  const due = new Date(acquired);
  due.setUTCFullYear(due.getUTCFullYear() + lifespan);
  return due;
}

export type LifecycleStatus = "unrated" | "ok" | "due_soon" | "urgent" | "overdue";

export interface LifecycleState {
  status: LifecycleStatus;
  /**
   * What the status is called on screen.
   *
   * Always present, and always shown: status is never conveyed by colour
   * alone, per the design conventions. "Unrated" says why it is unrated rather
   * than leaving a blank somebody reads as "fine".
   */
  label: string;
  /** The date the status was worked out from, or null when unrated. */
  dueDate: Date | null;
  /**
   * Whether an RA has deliberately parked this one.
   *
   * Reported alongside the status rather than replacing it: a snoozed boiler
   * is still overdue, somebody has simply said "not this year, and here is
   * why". Only the dashboard acts on this.
   */
  snoozed: boolean;
}

/** Where an asset stands, as of `now`. */
export function assetLifecycle(asset: LifecycleAsset, now: Date = new Date()): LifecycleState {
  const due = replacementDueAt(asset);
  const snoozedUntil = time(asset.snoozedUntil);
  const snoozed = snoozedUntil !== null && snoozedUntil > now.getTime();

  if (due === null) {
    return {
      status: "unrated",
      label: "Unrated — no acquisition date",
      dueDate: null,
      snoozed,
    };
  }

  const yearsAway = (due.getTime() - now.getTime()) / YEAR_MS;

  if (yearsAway < 0) {
    return { status: "overdue", label: "Replacement overdue", dueDate: due, snoozed };
  }
  if (yearsAway <= LIFECYCLE_URGENT_YEARS) {
    return { status: "urgent", label: "Due within a year", dueDate: due, snoozed };
  }
  if (yearsAway <= LIFECYCLE_WARN_YEARS) {
    return { status: "due_soon", label: "Due in a few years", dueDate: due, snoozed };
  }
  return { status: "ok", label: "Not due yet", dueDate: due, snoozed };
}
