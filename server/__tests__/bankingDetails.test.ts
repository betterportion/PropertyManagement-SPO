/**
 * The financial-data rule, enforced on the free text of finance records (#51).
 *
 * The portal must never hold a card number or a bank account or routing
 * number. Five free-text fields on HH fees and deposits are where one could
 * be typed, so the API refuses two narrow shapes there: a Luhn-valid card
 * number, and a banking word right next to a long number. Anything else --
 * a check number, a long QuickBooks or Ramp transaction number -- must still
 * pass, or people learn to work around the rule.
 *
 * The card numbers below are the standard published test PANs, not real ones.
 */
import { describe, it, expect } from "vitest";
import { BANKING_DETAILS_MESSAGE, containsBankingDetails } from "@shared/bankingDetails";
import {
  insertDepositDeductionSchema,
  insertRentPaymentSchema,
  insertSecurityDepositSchema,
} from "@shared/schema";

describe("a card number", () => {
  it.each([
    "4111111111111111",
    "4111 1111 1111 1111",
    "5500-0000-0000-0004",
    "paid by card 4111 1111 1111 1111 on the 3rd",
    "378282246310005", // 15-digit Amex test number
    "3782 822463 10005", // the same Amex number, grouped 4-6-5 as printed
  ])("is refused: %s", (text) => {
    expect(containsBankingDetails(text)).toBe(true);
  });

  it("is still found with a year typed after it", () => {
    expect(containsBankingDetails("card 4111 1111 1111 1111 2026")).toBe(true);
  });

  it("is still found with a year typed before it", () => {
    expect(containsBankingDetails("2026 4111 1111 1111 1111")).toBe(true);
  });

  it("passes when the 16 digits fail the Luhn check", () => {
    expect(containsBankingDetails("4111 1111 1111 1112")).toBe(false);
    expect(containsBankingDetails("1234567812345678")).toBe(false);
  });
});

describe("a processor or check reference", () => {
  it.each([
    "check #1234",
    "QB bill 4471",
    "Ramp txn 4829301756", // 10 digits
    "QuickBooks 482930175612", // 12 digits
    "check 1000234567",
    "Ramp 20260930123456789012", // 22 digits, longer than any card
    // Four check numbers in a row: 16 digits that pass the checksum, but no
    // card starts with a 1 and no card is typed as a list of short numbers.
    "checks 1041 1042 1043 1044",
    "checks 1004 1005 1006 1007",
    "411 1111 1111 1111 1", // a card's digits, but not grouped the way a card is
  ])("passes: %s", (text) => {
    expect(containsBankingDetails(text)).toBe(false);
  });
});

describe("a banking word next to a number", () => {
  it.each([
    "acct 123456789",
    "routing 021000021",
    "Account # 12345678",
    "ABA 021000021",
    "Routing number: 021000021",
    "acct no. 1234567",
    "account no 12345678",
  ])("is refused: %s", (text) => {
    expect(containsBankingDetails(text)).toBe(true);
  });

  it.each([
    "account balance 250",
    "routing the refund through Ramp",
    "acct ending 1234", // the last four identify nothing that moves money
    "returned to the account on file, Ramp 4829301756",
  ])("passes: %s", (text) => {
    expect(containsBankingDetails(text)).toBe(false);
  });
});

describe("the refusal", () => {
  it("says what to record instead", () => {
    expect(BANKING_DETAILS_MESSAGE).toContain("QuickBooks or Ramp reference");
  });

  it("never echoes the value that was typed", () => {
    const result = insertRentPaymentSchema.partial().safeParse({ reference: "routing 021000021" });
    expect(result.success).toBe(false);
    const issues = JSON.stringify(result.error?.issues);
    expect(issues).toContain(BANKING_DETAILS_MESSAGE);
    expect(issues).not.toContain("021000021");
  });
});

describe("the finance fields that carry the rule", () => {
  const CARD = "4111 1111 1111 1111";

  const fields: Array<[string, { safeParse: (v: unknown) => { success: boolean } }, Record<string, unknown>]> = [
    ["HH fee reference", insertRentPaymentSchema.partial(), { reference: CARD }],
    ["HH fee notes", insertRentPaymentSchema.partial(), { notes: CARD }],
    ["deposit close-out reference", insertSecurityDepositSchema.partial(), { closeoutReference: CARD }],
    ["deposit earlier notes", insertSecurityDepositSchema.partial(), { deductionsNotes: CARD }],
    ["deduction description", insertDepositDeductionSchema.partial(), { description: CARD }],
  ];

  it.each(fields)("refuses a card number in the %s", (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(false);
  });

  it.each(fields)("still takes a processor reference in the %s", (_name, schema, body) => {
    // The positive control: the same field with an honest value.
    const [field] = Object.keys(body);
    expect(schema.safeParse({ [field]: "QB bill 4471" }).success).toBe(true);
  });

  it("applies on create as well as on an edit", () => {
    const base = { residentId: "r", propertyId: "p", period: "2026-08", amount: 500, region: "West Central", buildingAddress: "1 Main St" };
    expect(insertRentPaymentSchema.safeParse({ ...base, reference: "check #1234" }).success).toBe(true);
    expect(insertRentPaymentSchema.safeParse({ ...base, reference: CARD }).success).toBe(false);
  });

  it("still takes a cleared field", () => {
    expect(insertSecurityDepositSchema.partial().safeParse({ closeoutReference: null, deductionsNotes: null }).success).toBe(true);
  });
});
