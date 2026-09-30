/**
 * The financial-data rule, checked on what people type (#51).
 *
 * The portal must never hold a card number or a bank account or routing
 * number (CLAUDE.md, "Financial data"). The free text on HH fees and deposits
 * is where one could be typed, so the API refuses two narrow shapes there:
 *
 *   1. A card number: 13 to 19 digits, spaces or dashes allowed between them,
 *      that passes the Luhn check.
 *   2. A banking word -- routing, acct, account # / account no, ABA -- right
 *      next to a run of 6 or more digits.
 *
 * Deliberately NOT "any long run of digits": QuickBooks and Ramp transaction
 * numbers and check numbers can be that long, and a rule that refuses real
 * references teaches people to work around it. A bare account number with no
 * banking word beside it still gets through; the helper text on each field
 * and training cover that gap (the decision on #51).
 *
 * In `shared/` because the Zod schemas in `schema.ts` apply it, and those are
 * what both the create and the edit routes parse with.
 */

/** Plain language, says what to record instead, and never repeats the value. */
export const BANKING_DETAILS_MESSAGE =
  "That looks like a card or bank account number, and the portal never stores those. Record the QuickBooks or Ramp reference instead, not the account number.";

/** What the finance forms show under each of these fields. */
export const BANKING_DETAILS_HELP = "Amounts, dates and processor references only. Never account, routing or card numbers.";

/** Digit groups joined by single spaces or dashes: "4111 1111-1111 1111". */
const DIGIT_RUN = /\d+(?:[ -]\d+)*/g;

const BANKING_WORD_NEXT_TO_NUMBER =
  /\b(?:routing|acct|aba|account\s*(?:#|no\b|number\b))(?:\s*(?:#|no\b|number\b))?[\s:#.-]*\d(?:[ -]?\d){5,}/i;

/** The Luhn checksum every card number carries. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * True when some whole groups of a digit run make a 13-19 digit, Luhn-valid
 * number. Whole groups only, so "4111 1111 1111 1111 2026" is still a card,
 * while one unbroken 22-digit processor number is never cut into windows
 * that pass the checksum by chance.
 */
function runHoldsCardNumber(run: string): boolean {
  const groups = run.split(/[ -]/);
  for (let start = 0; start < groups.length; start++) {
    let digits = "";
    for (let end = start; end < groups.length; end++) {
      digits += groups[end];
      if (digits.length > 19) break;
      if (digits.length >= 13 && passesLuhn(digits)) return true;
    }
  }
  return false;
}

/** True when the text carries a card number or a labelled bank number. */
export function containsBankingDetails(text: string): boolean {
  if (BANKING_WORD_NEXT_TO_NUMBER.test(text)) return true;
  return (text.match(DIGIT_RUN) ?? []).some(runHoldsCardNumber);
}
