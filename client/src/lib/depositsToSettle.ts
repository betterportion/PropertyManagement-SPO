/**
 * The Finances page's "Deposits to settle": every deposit still outstanding
 * for somebody who has moved out, with what is actually owed back.
 *
 * The same rule as the dashboard's "Deposit to return" item
 * (server/actionItems.ts): "held" AND "statement_sent" are outstanding --
 * a statement sent is progress, not the money going back
 * (.claude/rules/deposits.md) -- and the amount is the balance after
 * deductions, never the amount held. Negative means damage exceeded the
 * deposit: a shortfall for finance to decide, not a refund.
 */
import { fromCents, runningBalance } from "@shared/depositLedger";
import type { DepositDeduction, Resident, SecurityDeposit } from "@shared/schema";

const OUTSTANDING = new Set(["held", "statement_sent"]);

export interface DepositToSettle {
  deposit: SecurityDeposit;
  /** Held less every deduction, as a numeric string ("300.00", or "-20.00"). */
  owed: string;
}

export function depositsToSettle(
  deposits: SecurityDeposit[],
  residents: Pick<Resident, "id" | "isActive">[] | undefined,
  deductions: Pick<DepositDeduction, "residentId" | "amount">[],
): DepositToSettle[] {
  // "Not in the list" means moved out, so with no list (refused, failed or
  // still loading) show nothing rather than every deposit as a former resident.
  if (!residents) return [];
  const stillHere = new Set(residents.filter((r) => r.isActive).map((r) => r.id));
  return deposits
    .filter((d) => OUTSTANDING.has(d.status) && !stillHere.has(d.residentId))
    .map((deposit) => ({
      deposit,
      owed: fromCents(runningBalance(deposit.amountHeld, deductions.filter((x) => x.residentId === deposit.residentId))),
    }));
}
