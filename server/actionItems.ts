/**
 * Dashboard action items.
 *
 * The dashboard shows the handful of things that actually need someone's
 * attention, drawn from two sources:
 *
 *   - **Derived** items, computed live from the real records — a maintenance
 *     schedule coming due, rent still unpaid, a deposit still held for someone
 *     who has moved out. These are never stored; they simply reflect the current
 *     state of the data, so resolving one means acting on the underlying record.
 *
 *   - **Manual** tasks, the notes staff create themselves (the `tasks` table).
 *
 * `buildActionItems` is a pure function of the records plus `now`, so the whole
 * ranking is unit-testable without a database or a clock. The caller loads the
 * rows, filters each source to the caller's regions, and hands them in.
 */
import type {
  MaintenanceSchedule,
  RentPayment,
  SecurityDeposit,
  Resident,
  Task,
  Property,
  PropertySetupItem,
  Asset,
} from "@shared/schema";
import { summarizeSetup, setupRowsByProperty } from "@shared/propertySetup";
import { assetLifecycle } from "@shared/assetLifecycle";
import { depositReturnDeadline } from "@shared/depositLedger";
import type { ActionItemCategory, ActionItemSource } from "@shared/actionItems";

/** How far ahead a recurring schedule becomes an action item. */
export const SCHEDULE_LOOKAHEAD_DAYS = 30;

/** How far ahead a lease renewal becomes an action item — two months. */
export const LEASE_LOOKAHEAD_DAYS = 60;

/**
 * How far ahead a coming move-out raises its deposit.
 *
 * Before somebody has even left, so the money is ready rather than being
 * chased after the fact.
 */
export const DEPOSIT_LOOKAHEAD_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;

// One definition, shared with the client -- see shared/actionItems.ts for why.
export type { ActionItemSource, ActionItemCategory } from "@shared/actionItems";

export interface ActionItem {
  /** The underlying record's id — what the client resolves against. */
  id: string;
  source: ActionItemSource;
  category: ActionItemCategory;
  title: string;
  subtitle: string;
  /** Present for the finance items, as the numeric string the column stores. */
  amount?: string | null;
  /** ISO date the item is due, or null when it has no date. */
  dueDate: string | null;
  overdue: boolean;
  region: string | null;
}

export interface ActionItemInputs {
  schedules: MaintenanceSchedule[];
  rentPayments: RentPayment[];
  deposits: SecurityDeposit[];
  residents: Resident[];
  tasks: Task[];
  properties: Property[];
  setupItems: PropertySetupItem[];
  assets: Asset[];
}

/** The last calendar day of a "YYYY-MM" period, as a UTC-midnight date. */
function endOfPeriod(period: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]); // 1-12
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0));
}

function iso(date: Date | string | null | undefined): string | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Builds the ranked action-item list. The result is ordered so the most urgent
 * item is first; the dashboard shows the top few and the Tasks page shows all.
 *
 * Ordering: overdue items first (the most overdue first), then items due soonest,
 * then items with no due date last. Ties break by category (finance, then
 * property, then general) so money surfaces ahead of upkeep at the same date.
 */
export function buildActionItems(inputs: ActionItemInputs, now: Date = new Date()): ActionItem[] {
  const items: ActionItem[] = [];
  const lookahead = new Date(now.getTime() + SCHEDULE_LOOKAHEAD_DAYS * DAY_MS);

  // Property — schedules overdue or coming due within the lookahead window.
  for (const s of inputs.schedules) {
    if (!s.isActive) continue;
    const due = s.nextDueDate instanceof Date ? s.nextDueDate : new Date(s.nextDueDate);
    if (Number.isNaN(due.getTime()) || due > lookahead) continue;
    items.push({
      id: s.id,
      source: "schedule",
      category: "property",
      title: s.title,
      subtitle: s.buildingAddress,
      dueDate: iso(due),
      overdue: due < now,
      region: s.region,
    });
  }

  // Property — a lease renewal coming due on a rented house. Date-driven, so it
  // re-appears each term; a house marked "not renewing" drops off (it is ending,
  // not renewing).
  const leaseHorizon = new Date(now.getTime() + LEASE_LOOKAHEAD_DAYS * DAY_MS);
  for (const p of inputs.properties) {
    if (p.ownership !== "rented") continue;
    if (p.renewalDecision === "not_renewing") continue;
    if (!p.leaseRenewalDate) continue;
    const due = p.leaseRenewalDate instanceof Date ? p.leaseRenewalDate : new Date(p.leaseRenewalDate);
    if (Number.isNaN(due.getTime()) || due > leaseHorizon) continue;
    items.push({
      id: p.id,
      source: "lease",
      category: "property",
      title: `Lease renewal — ${p.name}`,
      subtitle: p.address,
      dueDate: iso(due),
      overdue: due < now,
      region: p.region,
    });
  }

  // Property — one aggregated item per house whose setup is unfinished.
  //
  // One entry, never one per open check: seven rows for a single house would
  // bury the maintenance triage this space actually belongs to. It clears the
  // moment the last item resolves.
  //
  // A house with no checklist rows says nothing at all. The checklist is
  // generated on property creation and deliberately not backfilled, so every
  // house SPO already has would otherwise light up on the day this ships --
  // summarizeSetup reports those as untracked rather than as everything open.
  const setupByProperty = setupRowsByProperty(inputs.setupItems);
  for (const p of inputs.properties) {
    const summary = summarizeSetup(setupByProperty.get(p.id) ?? [], p.ownership);
    if (!summary.tracked || summary.complete) continue;
    items.push({
      id: p.id,
      source: "setup",
      category: "property",
      title: `Setup incomplete — ${p.name}`,
      subtitle: `${summary.open} of ${summary.total} still to do · ${p.address}`,
      // No deadline: setting up a house has no date SPO has agreed, and
      // inventing one would put every new house at the top of the list.
      dueDate: null,
      overdue: false,
      region: p.region,
    });
  }

  // Property — an asset coming up for replacement.
  //
  // Three rules, all from assetLifecycle:
  //   - an UNRATED asset (nothing to reason from) says nothing at all. A guess
  //     here would be indistinguishable from a real warning, and people would
  //     stop reading both;
  //   - only the warning window and worse reach the dashboard. "Not due yet"
  //     is not something anybody needs to be told today;
  //   - a SNOOZED asset is hidden HERE ONLY. It stays visible, and visibly
  //     snoozed, on the asset screen -- hiding it everywhere is how a boiler
  //     gets forgotten for three years.
  for (const a of inputs.assets) {
    const lifecycle = assetLifecycle(a, now);
    if (lifecycle.status === "unrated" || lifecycle.status === "ok") continue;
    if (lifecycle.snoozed) continue;
    items.push({
      id: a.id,
      source: "asset",
      category: "property",
      title: `${lifecycle.label} — ${a.name}`,
      subtitle: a.buildingAddress,
      dueDate: iso(lifecycle.dueDate),
      overdue: lifecycle.status === "overdue",
      region: a.region,
    });
  }

  // Finance — rent still owed: never paid, or a payment that bounced. A
  // "failed" charge is still outstanding money; dropping it here would make
  // the dashboard look better the moment a check bounces.
  for (const p of inputs.rentPayments) {
    if (p.status !== "unpaid" && p.status !== "failed") continue;
    const due = endOfPeriod(p.period);
    items.push({
      id: p.id,
      source: "rent",
      category: "finance",
      title: p.status === "failed" ? `Failed rent payment — ${p.period}` : `Unpaid rent — ${p.period}`,
      subtitle: p.buildingAddress,
      amount: p.amount,
      dueDate: iso(due),
      overdue: due ? due < now : false,
      region: p.region,
    });
  }

  // Finance — deposits that have to go back.
  //
  // Raised for somebody who has already left, and for somebody leaving within
  // DEPOSIT_LOOKAHEAD_DAYS so the money is ready rather than chased after the
  // fact. It clears when the deposit is marked returned -- "statement sent" is
  // progress, not completion, and the money is still held.
  //
  // The deadline comes from the resident's MOVE-OUT DATE and the house's
  // admin-set depositReturnDays. No setting means no deadline rather than an
  // invented one: the states SPO operates in have materially different rules,
  // and a default standing in for a figure nobody chose would be the portal
  // making a legal determination it must not make. The item is still raised --
  // a deposit held for somebody who has gone is worth surfacing either way.
  const residentsById = new Map(inputs.residents.map((r) => [r.id, r]));
  const propertiesById = new Map(inputs.properties.map((p) => [p.id, p]));
  const depositHorizon = new Date(now.getTime() + DEPOSIT_LOOKAHEAD_DAYS * DAY_MS);

  // "held" and "statement_sent" are the outstanding states. Returned, withheld
  // and partially returned all mean somebody has dealt with it -- leaving a
  // withheld deposit on the dashboard forever is a permanent false alarm.
  const OUTSTANDING_DEPOSIT_STATUSES = new Set(["held", "statement_sent"]);

  for (const d of inputs.deposits) {
    if (!OUTSTANDING_DEPOSIT_STATUSES.has(d.status)) continue;

    const resident = residentsById.get(d.residentId);
    const movingOut = resident?.moveOutDate
      ? resident.moveOutDate instanceof Date
        ? resident.moveOutDate
        : new Date(resident.moveOutDate)
      : null;

    // Somebody still living there with no departure planned needs nothing.
    const hasLeft = resident ? !resident.isActive : false;
    const leavingSoon =
      movingOut !== null && !Number.isNaN(movingOut.getTime()) && movingOut <= depositHorizon;
    if (!hasLeft && !leavingSoon) continue;

    const deadline = depositReturnDeadline(
      movingOut,
      propertiesById.get(d.propertyId)?.depositReturnDays,
    );

    // No setting means no deadline -- but not "no urgency". Every house has
    // depositReturnDays null the day this ships, and an undated item sorts
    // BELOW every dated one, so a held deposit for somebody who has already
    // left would quietly fall off the dashboard's top few. For a resident who
    // has gone, the honest fallback is the one this had before deadlines
    // existed: it is due now.
    const dueDate = deadline ?? (hasLeft ? now : null);

    items.push({
      id: d.id,
      source: "deposit",
      category: "finance",
      title: leavingSoon && !hasLeft ? "Deposit to return soon" : "Deposit to return",
      subtitle: d.buildingAddress,
      amount: d.amountHeld,
      dueDate: iso(dueDate),
      overdue: deadline !== null ? deadline < now : hasLeft,
      region: d.region,
    });
  }

  // Manual — open tasks. (The caller has already limited these to the ones the
  // user may see.)
  for (const t of inputs.tasks) {
    if (t.status !== "open") continue;
    const due = t.dueDate ? (t.dueDate instanceof Date ? t.dueDate : new Date(t.dueDate)) : null;
    items.push({
      id: t.id,
      source: "task",
      category: t.category,
      title: t.title,
      subtitle: t.notes ?? "",
      dueDate: iso(due),
      overdue: due ? due < now : false,
      region: t.region,
    });
  }

  return items.sort(compareUrgency);
}

const CATEGORY_RANK: Record<ActionItemCategory, number> = { finance: 0, safety: 1, property: 2, general: 3 };

/** Orders two items so the more urgent one sorts first. */
function compareUrgency(a: ActionItem, b: ActionItem): number {
  const at = a.dueDate ? new Date(a.dueDate).getTime() : null;
  const bt = b.dueDate ? new Date(b.dueDate).getTime() : null;
  // Dated items always rank above undated ones.
  if (at === null && bt !== null) return 1;
  if (at !== null && bt === null) return -1;
  if (at !== null && bt !== null && at !== bt) return at - bt; // soonest / most overdue first
  return CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
}
