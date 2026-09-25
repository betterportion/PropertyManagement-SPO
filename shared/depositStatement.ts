import { fromCents, toCents } from "./depositLedger";

/**
 * The per-resident deposit statement, as text.
 *
 * Pure and in `shared/` so the wording is testable with hand-written
 * literals, and so the copy button, the print view and the mail button all
 * carry the same words. Dates and amounts arrive already formatted: this
 * module knows nothing about locales.
 *
 * **The portal does not send this.** `statementMailto` builds a `mailto:`
 * link that opens the RA's own mail client with everything prefilled; the RA
 * reads it and sends from their own account. There is no server-side send
 * path for a financial document to a resident, by product decision.
 */

export interface StatementLine {
  when: string;
  description: string;
  amount: string;
  /** Set when this line is one person's share of a charge split across the house. */
  share?: { total: string; people: number };
}

export interface StatementInput {
  residentName: string;
  house: string;
  held: string;
  lines: readonly StatementLine[];
  balance: string;
  /** Set once the money has gone back. */
  returned?: { amount: string; when: string } | null;
}

export function statementText(input: StatementInput): string {
  const lines = [
    `Deposit statement — ${input.residentName}`,
    input.house,
    "",
    `Deposit held: ${input.held}`,
    "",
    "Deductions:",
    ...(input.lines.length === 0
      ? ["  (none)"]
      : input.lines.map((line) =>
          line.share
            ? `  ${line.when}  ${line.amount}  ${line.description} (your share of ${line.share.total} across ${line.share.people} people)`
            : `  ${line.when}  ${line.amount}  ${line.description}`,
        )),
    "",
    `Balance to return: ${input.balance}`,
  ];
  if (input.returned) lines.push(`Returned: ${input.returned.amount} on ${input.returned.when}`);
  return lines.join("\n");
}

/**
 * The whole of a split this deduction belongs to: its total and headcount,
 * from the house's other rows sharing its group id. Null for a charge that
 * was never split. Display only -- nothing recomputes a share from it.
 */
export function shareOfSplit(
  deduction: { splitGroupId?: string | null },
  houseDeductions: readonly { splitGroupId?: string | null; amount: string | number | null }[],
): { totalCents: number; people: number } | null {
  if (!deduction.splitGroupId) return null;
  const rows = houseDeductions.filter((row) => row.splitGroupId === deduction.splitGroupId);
  if (rows.length < 2) return null;
  return { totalCents: rows.reduce((sum, row) => sum + toCents(row.amount), 0), people: rows.length };
}

/**
 * The longest `mailto:` link that opens reliably across mail clients.
 * Outlook for Windows truncates around 2,000 characters; 1,800 leaves room.
 */
export const MAILTO_MAX_LENGTH = 1800;

export interface StatementMailto {
  href: string;
  /** False when the body would be cut off; the caller then copies the body instead. */
  fits: boolean;
}

export function statementMailto(email: string, subject: string, body: string): StatementMailto {
  const full = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  if (full.length <= MAILTO_MAX_LENGTH) return { href: full, fits: true };
  return { href: `mailto:${email}?subject=${encodeURIComponent(subject)}`, fits: false };
}

export { fromCents };
