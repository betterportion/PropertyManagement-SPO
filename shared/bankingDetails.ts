/**
 * The financial-data rule, checked on what people type (#51).
 *
 * The portal must never hold a card number or a bank account or routing
 * number (CLAUDE.md, "Financial data"). The free text on HH fees and deposits
 * is where one could be typed, so the API refuses two narrow shapes there:
 *
 *   1. A card number: typed the way a card is (one unbroken run of 13 to 19
 *      digits, four groups of four, or Amex's 4-6-5, with spaces, dashes,
 *      dots or slashes between the groups), starting with an issuer's digit
 *      (2 to 6), not four numbers counting up by one (a list of check
 *      numbers), and passing the Luhn check.
 *   2. A banking word -- routing, acct, a/c, account (number / no / # / is),
 *      checking, savings, ABA -- right next to a run of 6 or more digits
 *      that is not a date.
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

/**
 * What a card's groups are joined by as typed or pasted: spaces (a non-breaking
 * one is what copying from a PDF gives), dashes, dots or slashes, in any mix
 * and any number (#257).
 */
const SEP = "[ .\\/\\u00a0-]+";

/** Digit groups joined by those separators: "4111 1111-1111.1111". */
const DIGIT_RUN = new RegExp(`\\d+(?:${SEP}\\d+)*`, "g");

/** The negative lookahead skips a date typed after the word ("acct 2026-09-29"). */
const BANKING_WORD_NEXT_TO_NUMBER =
  /\b(?:routing|acct|aba|account|a\/c|checking|savings)(?:\s*(?:#|no\b|number\b))?(?:\s*is\b)?[\s:#.-]*(?!(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b)\d(?:[ .\u00a0-]?\d){5,}/i;

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
 * The ways a card number is typed: one unbroken run, four groups of four
 * (with a short fifth group on a 17-19 digit card), or Amex's 4-6-5.
 */
const CARD_SHAPES = [
  /^\d{13,19}$/,
  new RegExp(`^\\d{4}(?:${SEP}\\d{4}){3}(?:${SEP}\\d{1,3})?$`),
  new RegExp(`^\\d{4}${SEP}\\d{6}${SEP}\\d{5}$`),
];

/** "2036 2037 2038 2039": check numbers written in a row, which no card is. */
function countsUpByOne(candidate: string): boolean {
  const groups = candidate.split(new RegExp(SEP)).map(Number);
  return groups.length >= 4 && groups.every((group, i) => i === 0 || group === groups[i - 1] + 1);
}

function looksLikeCard(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  return (
    CARD_SHAPES.some((shape) => shape.test(candidate)) &&
    /^[2-6]/.test(digits) &&
    !countsUpByOne(candidate) &&
    passesLuhn(digits)
  );
}

/**
 * True when some whole groups of a digit run are a card number. Whole groups
 * only, so "4111 1111 1111 1111 2026" is still a card, while one unbroken
 * 22-digit processor number is never cut into windows that pass the checksum
 * by chance. The shape, the issuer's digit and the counting-up check are what
 * keep a list of check numbers ("checks 2036 2037 2038 2039") from counting as one.
 */
function runHoldsCardNumber(run: string): boolean {
  const groups = run.match(new RegExp(`(?:${SEP})?\\d+`, "g")) ?? [];
  for (let start = 0; start < groups.length; start++) {
    for (let end = start + 1; end <= groups.length; end++) {
      const candidate = groups.slice(start, end).join("").replace(new RegExp(`^${SEP}`), "");
      if (candidate.replace(/\D/g, "").length > 19) break;
      if (looksLikeCard(candidate)) return true;
    }
  }
  return false;
}

/** True when the text carries a card number or a labelled bank number. */
export function containsBankingDetails(text: string): boolean {
  if (BANKING_WORD_NEXT_TO_NUMBER.test(text)) return true;
  return (text.match(DIGIT_RUN) ?? []).some(runHoldsCardNumber);
}
