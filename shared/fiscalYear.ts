/**
 * SPO's fiscal year: June 1 to May 31, named for the year it ENDS.
 * FY2027 is June 1 2026 – May 31 2027.
 *
 * Every piece of fiscal-year date logic in the portal lives here -- budgets,
 * the QuickBooks spend sync and the underspend alert all ask this file rather
 * than doing their own month arithmetic, so a boundary can only be wrong in
 * one place.
 *
 * Dates are read as UTC calendar days, the same way the rest of the portal
 * stores a date-only value (midnight UTC). A moment is therefore in the fiscal
 * year whose UTC calendar day it falls on.
 */

/** June, as a 0-based month index. */
export const FISCAL_YEAR_START_MONTH = 5;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The fiscal year a moment falls in. */
export function fiscalYearOf(date: Date): number {
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= FISCAL_YEAR_START_MONTH ? year + 1 : year;
}

/** "FY2027". */
export function fiscalYearLabel(fiscalYear: number): string {
  return `FY${fiscalYear}`;
}

/**
 * The first and last day of a fiscal year as `YYYY-MM-DD` strings -- the form
 * a report query takes -- plus the matching UTC midnights.
 */
export function fiscalYearBounds(fiscalYear: number): {
  startDate: string;
  endDate: string;
  start: Date;
  /** Midnight at the START of the last day (May 31). */
  end: Date;
} {
  const start = new Date(Date.UTC(fiscalYear - 1, FISCAL_YEAR_START_MONTH, 1));
  const end = new Date(Date.UTC(fiscalYear, FISCAL_YEAR_START_MONTH - 1, 31));
  return { startDate: isoDay(start), endDate: isoDay(end), start, end };
}

/** Days in a fiscal year: 365, or 366 when it contains February 29. */
export function fiscalYearDays(fiscalYear: number): number {
  const { start } = fiscalYearBounds(fiscalYear);
  const nextStart = new Date(Date.UTC(fiscalYear, FISCAL_YEAR_START_MONTH, 1));
  return Math.round((nextStart.getTime() - start.getTime()) / DAY_MS);
}

/**
 * How much of a fiscal year has gone by at `now`, from 0 to 1, counting the
 * current day as elapsed: on June 1 one day of the year is used, on May 31 all
 * of it. Before the year starts it is 0; after it ends, 1.
 */
export function fiscalYearElapsed(fiscalYear: number, now: Date): number {
  const { start } = fiscalYearBounds(fiscalYear);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysElapsed = Math.round((today - start.getTime()) / DAY_MS) + 1;
  return Math.min(1, Math.max(0, daysElapsed / fiscalYearDays(fiscalYear)));
}

/**
 * Whole calendar months left in the fiscal year `now` falls in, not counting
 * the current month: 11 in June, 2 in March, 0 in May.
 */
export function monthsLeftInFiscalYear(now: Date): number {
  const month = now.getUTCMonth();
  const monthsIntoYear = (month - FISCAL_YEAR_START_MONTH + 12) % 12;
  return 11 - monthsIntoYear;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
