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
 * Date-only strings such as "2026-02-01" must NOT go through `new Date()` —
 * they parse as UTC midnight and show as the previous day in US timezones.
 * This reads the calendar parts directly for those, and uses the local
 * timezone for full timestamps.
 */
export function formatDate(
  value: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" },
): string {
  if (value === null || value === undefined || value === "") return EM_DASH;

  let date: Date;
  if (typeof value === "string") {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      // Build in local time so the calendar day cannot shift.
      date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    } else {
      date = new Date(value);
    }
  } else {
    date = value;
  }

  if (Number.isNaN(date.getTime())) return EM_DASH;
  return new Intl.DateTimeFormat("en-US", options).format(date);
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
