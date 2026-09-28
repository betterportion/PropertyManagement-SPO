/**
 * When a calendar day has begun or ended, for every "Overdue" and every snooze.
 *
 * A picked date is stored as UTC midnight of that day, and comparing it with
 * `now` made it overdue at the start of the day in UTC -- 7pm Central the
 * evening before. The server does not know the reader's timezone, and SPO's
 * houses are in several, so the rule is the "Anywhere on Earth" one: a day has
 * begun once it has begun in the last timezone to reach it (UTC-12), and ended
 * once it has ended there. That is never early for any house; it is late by a
 * few hours overnight, which is the side to err on for a word like "Overdue".
 *
 * A due day itself is not overdue. The day after it is.
 *
 * Pure, and in `shared/` because the dashboard (server) and the asset pages
 * (client) must say the same thing about the same date.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

/** How far behind UTC the last timezone to reach any calendar day is. */
const LATEST_TIMEZONE_MS = 12 * 60 * 60 * 1_000;

/** UTC midnight starting the calendar day `value` falls on, or null. */
function utcDayStart(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor(time / DAY_MS) * DAY_MS;
}

/** Whether the day `day` falls on has begun everywhere. No date never begins. */
export function hasBegunEverywhere(day: Date | string | null | undefined, now: Date = new Date()): boolean {
  const start = utcDayStart(day);
  return start !== null && now.getTime() >= start + LATEST_TIMEZONE_MS;
}

/** Whether the due day has ended everywhere. No date is never overdue. */
export function isPastDue(due: Date | string | null | undefined, now: Date = new Date()): boolean {
  const start = utcDayStart(due);
  return start !== null && now.getTime() >= start + DAY_MS + LATEST_TIMEZONE_MS;
}
