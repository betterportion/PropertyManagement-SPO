/**
 * Whether an owned house is spending its repair & maintenance budget at the
 * pace the year calls for.
 *
 * The point is stewardship: steady, incremental improvement to every owned
 * house, rather than a budget left unspent at year end. So the louder signal
 * is UNDERspending, and it grows louder as the year runs out; overspending is
 * noted, quietly.
 *
 * One definition, shared: the dashboard's "behind pace" count and the Needs
 * attention alert read the same rule, so they cannot disagree about a house.
 * Pure -- figures and `now` in, a verdict out.
 */
import { fiscalYearElapsed } from "./fiscalYear";

/**
 * Behind pace: spent less than this share of what the elapsed part of the
 * year would suggest. At 0.5, a house half way through the year is behind
 * once it has spent under a quarter of its budget.
 */
export const UNDERSPEND_PACE_RATIO = 0.5;

/**
 * No verdict in June and July (0-based months): a house that has spent
 * nothing yet in the first two months is simply early.
 */
export const UNDERSPEND_QUIET_MONTHS: readonly number[] = [5, 6];

/** March, April and May: the alert becomes urgent. 0-based months. */
export const LAST_QUARTER_MONTHS: readonly number[] = [2, 3, 4];

export type PaceStatus = "on_pace" | "behind" | "over" | "early";

export interface BudgetPace {
  status: PaceStatus;
  /** Spent as a share of the budget, 0..∞. */
  usedShare: number;
  /** How much of the fiscal year has gone, 0..1. */
  elapsed: number;
  /** In the last quarter, when being behind is urgent. */
  lastQuarter: boolean;
}

/**
 * The verdict for one house. Only call this with a real spend figure from a
 * current sync and a budget above zero: a house with no figure, a stale one,
 * or no budget has no pace at all, and must never be called behind.
 */
export function budgetPace(budget: number, spent: number, fiscalYear: number, now: Date): BudgetPace {
  const elapsed = fiscalYearElapsed(fiscalYear, now);
  const usedShare = budget > 0 ? spent / budget : 0;
  const lastQuarter = LAST_QUARTER_MONTHS.includes(now.getUTCMonth());
  let status: PaceStatus;
  if (spent > budget) status = "over";
  else if (UNDERSPEND_QUIET_MONTHS.includes(now.getUTCMonth())) status = "early";
  else if (usedShare < elapsed * UNDERSPEND_PACE_RATIO) status = "behind";
  else status = "on_pace";
  return { status, usedShare, elapsed, lastQuarter };
}
