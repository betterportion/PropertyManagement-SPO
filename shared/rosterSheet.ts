/**
 * The contract SPO builds the master resident sheet to: the exact column
 * headers the portal reads, and the backstop that refuses a sheet carrying
 * banking data.
 *
 * Shared because the settings screen shows the same list the sync reads
 * (docs/WORKFLOWS.md repeats it for SPO). Headers match ignoring case and
 * extra spaces; every other column is ignored -- never read at all, in the
 * Google Sheets case, since only these columns are requested.
 */

export const ROSTER_SHEET_COLUMNS = {
  fullName: "Full Name",
  email: "Email",
  house: "House",
  startDate: "Household Start Date",
  stopDate: "Household Stop Date",
  paymentPlan: "Payment Plan",
  active: "Active",
} as const;

export type RosterColumnKey = keyof typeof ROSTER_SHEET_COLUMNS;

export const ROSTER_REQUIRED_COLUMNS: readonly RosterColumnKey[] = ["fullName", "email", "house"];

/** "  Household   start date " -> "household start date". */
export function normalizeHeader(header: string): string {
  return header.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Which allowlisted column each header is, by position; null for one the portal ignores. */
export function mapRosterHeaders(headers: string[]): Array<RosterColumnKey | null> {
  const byName = new Map(Object.entries(ROSTER_SHEET_COLUMNS).map(([key, name]) => [normalizeHeader(name), key as RosterColumnKey]));
  return headers.map((header) => byName.get(normalizeHeader(header)) ?? null);
}

/**
 * Header words that mean banking or card data. Matched on the header NAME,
 * whatever is in the column, and deliberately broad: "Account" alone is
 * enough. A false alarm costs renaming a column; a miss would put donors'
 * and residents' bank details on a screen and in a log (CLAUDE.md,
 * "Financial data").
 */
const BANKING_HEADER =
  /(bank|routing|\baba\b|iban|swift|\bbic\b|acct|account|card|credit|debit|cvv|cvc|\bach\b|direct ?deposit|sort ?code)/i;

export function looksLikeBankingHeader(header: string): boolean {
  return BANKING_HEADER.test(header);
}

/** What the alerts and the settings screen know about the sheet sync. */
export interface RosterSyncHealth {
  /** All three sheet variables are set. Off is a normal state. */
  configured: boolean;
  /** The last real run against the sheet (not a preview, not a CSV). */
  lastRun: { ok: boolean; error: string | null; refusedColumns: string[]; skipped: number; createdAt: Date | string } | null;
  lastSuccessAt: string | null;
  openReviews: number;
}
