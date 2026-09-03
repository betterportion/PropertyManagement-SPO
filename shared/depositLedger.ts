/**
 * Deposit arithmetic.
 *
 * The portal is a ledger and a reminder. **The money moves in QuickBooks and
 * Ramp** — nothing here initiates a payment, and nothing here stores anything
 * that could. Amounts, dates, statuses and references only.
 *
 * Everything is in **cents**, as integers. Splitting a charge in
 * floating-point dollars is how 33.333333333333336 ends up on a worksheet
 * somebody in finance acts on.
 *
 * Pure, and in `shared/` because the split has to be shown and edited on
 * screen *before* it is saved — which means the browser and the server must
 * compute it identically, and a second copy of the arithmetic is how they stop
 * doing that.
 */

/** Cents in a dollar. Named because it appears in every conversion below. */
const CENTS = 100;

/**
 * An amount as whole cents.
 *
 * Numeric columns round-trip as strings and forms send numbers, so both have
 * to be read. Anything unreadable is **zero**, not NaN: a NaN loose in a
 * balance turns every figure downstream of it into NaN, and a running balance
 * reading "NaN" on a deposit worksheet is worse than one reading a wrong
 * number, because nobody can tell which figure went bad.
 */
export function toCents(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === "") return 0;
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * CENTS);
}

/** Cents back to the numeric string the column stores. */
export function fromCents(cents: number): string {
  return (cents / CENTS).toFixed(2);
}

/**
 * Splits a charge evenly, to the cent.
 *
 * A hole in a common room has to be divided across the people living there,
 * and the division rarely comes out even. The remainder is spread one cent at
 * a time from the first person onward rather than dumped entirely on them:
 * $250 across 7 is 35.72, 35.72, 35.72, then four of 35.71 — not one person
 * paying three cents more than everybody else.
 *
 * The shares always add back to exactly the charge. That invariant is what
 * makes the result safe to store as individual per-person line items, which is
 * the important part of this feature: **a later edit must not silently
 * re-divide somebody's settled balance.** A group id may be kept for
 * provenance and display, never for recomputation.
 */
export function splitEvenly(chargeCents: number, people: number): number[] {
  if (chargeCents < 0) {
    throw new Error("A charge cannot be negative");
  }
  if (people <= 0) return [];

  const base = Math.floor(chargeCents / people);
  let remainder = chargeCents - base * people;

  const shares: number[] = [];
  for (let index = 0; index < people; index += 1) {
    // One extra cent each, from the first person onward, until the remainder
    // is gone. Never more than one cent apart.
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    shares.push(base + extra);
  }
  return shares;
}

/**
 * What is left of a resident's deposit, in cents.
 *
 * Allowed to go negative, and deliberately not clamped to zero: damage can
 * exceed a deposit, and clamping would hide the shortfall from the person who
 * has to decide what to do about it.
 */
export function runningBalance(
  amountHeld: string | number | null | undefined,
  deductions: readonly { amount: string | number | null | undefined }[],
): number {
  let balance = toCents(amountHeld);
  for (const deduction of deductions) {
    balance -= toCents(deduction.amount);
  }
  return balance;
}

/**
 * When a deposit has to be back with the resident, or null when nothing says.
 *
 * Two decisions worth keeping:
 *
 *   - **The clock starts at the move-out date**, when possession or keys came
 *     back — not at lease end. Somebody can leave in April on a lease running
 *     to July.
 *   - **The number of days is an admin-set value per property**, not a lookup.
 *     The states SPO operates in have materially different rules — Arizona
 *     counts business days, Florida and Kansas are two-stage — which is
 *     exactly why there is no state-to-deadline table here. One would bake
 *     legal advice into the repo and go stale silently. SPO's admin and
 *     finance teams are responsible for compliance; the portal reminds.
 *
 * No setting means no deadline, rather than a default standing in for one: an
 * invented figure would be a legal determination the portal must not make.
 */
export function depositReturnDeadline(
  moveOutDate: Date | string | null | undefined,
  depositReturnDays: number | null | undefined,
): Date | null {
  if (!moveOutDate) return null;
  if (!depositReturnDays || depositReturnDays <= 0) return null;

  const movedOut =
    moveOutDate instanceof Date ? moveOutDate.getTime() : new Date(moveOutDate).getTime();
  if (Number.isNaN(movedOut)) return null;

  return new Date(movedOut + depositReturnDays * 24 * 60 * 60 * 1000);
}
