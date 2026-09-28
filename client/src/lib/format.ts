/**
 * Shared display formatters — §8 of the SPO design system.
 *
 * Formatting happens at the render boundary only. Values are stored as they
 * come from the database (money is a decimal string or number); nothing here
 * changes what is stored.
 */

/** Nullish values render as an em-dash — never blank, "null", or "N/A". */
export const EM_DASH = "—";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const wholeCurrencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Format an amount for display.
 *
 * formatCurrency("1245.5")            // "$1,245.50"
 * formatCurrency(1245.5, { whole: true }) // "$1,246"
 * formatCurrency(null)                // "—"
 */
export function formatCurrency(
  amount: string | number | null | undefined,
  options: { whole?: boolean } = {},
): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return options.whole ? wholeCurrencyFormatter.format(value) : currencyFormatter.format(value);
}

/** Any value that might be missing. Returns the em-dash instead of an empty cell. */
export function formatValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  const text = String(value).trim();
  return text === "" ? EM_DASH : text;
}

/**
 * Format a date for display.
 *
 * A calendar day somebody picked (a move-in, a walkthrough, a signature) is
 * stored as UTC midnight of that day, so the API sends "2026-01-01T00:00:00.000Z".
 * Read in local time that is the evening before everywhere west of UTC, which
 * is every SPO house. So a value at exactly UTC midnight is shown as its UTC
 * calendar day, as is a bare "2026-02-01"; anything else is a real instant and
 * is shown in local time. The two share columns: a schedule's due date is
 * picked on create and stamped `now` on completion — which is why this is
 * decided per value rather than per field.
 *
 * Only a date display gets this. With a time in the options the value is an
 * instant whatever it is, and "12:00 AM" would be wrong for UTC midnight.
 */
export function formatDate(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  if (value === null || value === undefined || value === "") return EM_DASH;

  const date =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00.000Z`)
      : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  const showsTime = options.hour !== undefined || options.minute !== undefined;
  const calendarDay = !showsTime && isUtcMidnight(date);
  return new Intl.DateTimeFormat("en-US", calendarDay ? { ...options, timeZone: "UTC" } : options).format(date);
}

function isUtcMidnight(date: Date): boolean {
  return date.getTime() % 86_400_000 === 0;
}

/** A local calendar day as "YYYY-MM-DD", the shape a date input and the date columns take. */
export function localCalendarDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Today where the reader is, as "YYYY-MM-DD". Never `toISOString().slice(0, 10)`:
 * that is the UTC day, which is tomorrow after 7pm Central.
 */
export function localToday(now: Date = new Date()): string {
  return localCalendarDay(now);
}

/**
 * Local midnight at the start of a "YYYY-MM-DD" day, `plusDays` later. Built
 * from calendar parts rather than by adding 24 hours, so a day with a clock
 * change in it still ends at midnight.
 */
export function localDayStart(day: string, plusDays = 0): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date + plusDays);
}

/** Date plus time, for audit trails and activity feeds. */
export function formatDateTime(value: string | Date | null | undefined): string {
  return formatDate(value, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Percentage for display. Clamped so progress bars stay meaningful, while the
 * raw number is still available to callers that need to show an overrun.
 */
export function formatPercent(
  value: number | null | undefined,
  { max = 150, decimals = 0 }: { max?: number; decimals?: number } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${Math.min(value, max).toFixed(decimals)}%`;
}
