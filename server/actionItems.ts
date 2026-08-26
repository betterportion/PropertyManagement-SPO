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
} from "@shared/schema";

/** How far ahead a recurring schedule becomes an action item. */
export const SCHEDULE_LOOKAHEAD_DAYS = 30;

/** How far ahead a lease renewal becomes an action item — two months. */
export const LEASE_LOOKAHEAD_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type ActionItemSource = "schedule" | "rent" | "deposit" | "task" | "lease";
export type ActionItemCategory = "property" | "safety" | "finance" | "general";

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

  // Finance — rent still unpaid. "Due" is the end of the billed month.
  for (const p of inputs.rentPayments) {
    if (p.status !== "unpaid") continue;
    const due = endOfPeriod(p.period);
    items.push({
      id: p.id,
      source: "rent",
      category: "finance",
      title: `Unpaid rent — ${p.period}`,
      subtitle: p.buildingAddress,
      amount: p.amount,
      dueDate: iso(due),
      overdue: due ? due < now : false,
      region: p.region,
    });
  }

  // Finance — deposits still held for a resident who has moved out.
  const movedOut = new Set(inputs.residents.filter((r) => !r.isActive).map((r) => r.id));
  for (const d of inputs.deposits) {
    if (d.status !== "held") continue;
    if (!movedOut.has(d.residentId)) continue;
    items.push({
      id: d.id,
      source: "deposit",
      category: "finance",
      title: "Deposit to return",
      subtitle: d.buildingAddress,
      amount: d.amountHeld,
      // A held deposit for someone who has left needs returning now; it has no
      // stored deadline yet (that model is still being reconciled with SPO), so
      // it always reads as due.
      dueDate: iso(now),
      overdue: true,
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
