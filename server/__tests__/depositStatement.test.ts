import { describe, it, expect } from "vitest";
import { MAILTO_MAX_LENGTH, shareOfSplit, statementMailto, statementText } from "@shared/depositStatement";

describe("statementText", () => {
  it("reads as a person would write it, with a split line saying whose share it is", () => {
    const text = statementText({
      residentName: "Jane Smith",
      house: "1 Main St",
      held: "$500.00",
      lines: [
        { when: "May 20, 2026", description: "Bedroom 2 — Carpet", amount: "$80.00" },
        { when: "May 20, 2026", description: "Living Room — Walls", amount: "$33.34", share: { total: "$100.00", people: 3 } },
      ],
      balance: "$386.66",
      returned: { amount: "$386.66", when: "Jun 1, 2026" },
    });
    expect(text).toBe(
      [
        "Deposit statement — Jane Smith",
        "1 Main St",
        "",
        "Deposit held: $500.00",
        "",
        "Deductions:",
        "  May 20, 2026  $80.00  Bedroom 2 — Carpet",
        "  May 20, 2026  $33.34  Living Room — Walls (your share of $100.00 across 3 people)",
        "",
        "Balance to return: $386.66",
        "Returned: $386.66 on Jun 1, 2026",
      ].join("\n"),
    );
  });

  it("says (none) rather than leaving an empty section", () => {
    const text = statementText({ residentName: "Jane Smith", house: "1 Main St", held: "$500.00", lines: [], balance: "$500.00" });
    expect(text).toContain("Deductions:\n  (none)");
    expect(text).not.toContain("Returned:");
  });
});

describe("shareOfSplit", () => {
  const house = [
    { id: "a", splitGroupId: "g1", amount: "33.34" },
    { id: "b", splitGroupId: "g1", amount: "33.33" },
    { id: "c", splitGroupId: "g1", amount: "33.33" },
    { id: "d", splitGroupId: null, amount: "80.00" },
  ];

  it("finds the whole charge and the headcount from the group", () => {
    expect(shareOfSplit(house[0], house)).toEqual({ totalCents: 10000, people: 3 });
  });

  it("is null for a charge that was never split", () => {
    expect(shareOfSplit(house[3], house)).toBeNull();
  });
});

describe("statementMailto", () => {
  it("prefills recipient, subject and body when it fits", () => {
    const link = statementMailto("jane@example.com", "Your deposit statement", "Balance to return: $386.66");
    expect(link.fits).toBe(true);
    expect(link.href).toBe("mailto:jane@example.com?subject=Your%20deposit%20statement&body=Balance%20to%20return%3A%20%24386.66");
  });

  it("fits a house of eight with a handful of deductions each", () => {
    // Eight people, each statement carrying five lines: the case the RAs
    // described. Every statement is one person's, so each has to fit alone.
    const lines = Array.from({ length: 5 }, (_, i) => ({
      when: "May 20, 2026",
      description: `Living Room — Walls and ceiling, hole by the window ${i + 1}`,
      amount: "$33.34",
      share: { total: "$266.72", people: 8 },
    }));
    const body = statementText({ residentName: "Jane Smith", house: "1234 Summit Avenue, Saint Paul, MN 55105", held: "$500.00", lines, balance: "$333.30" });
    expect(statementMailto("jane.smith@example.com", "Your deposit statement — 1234 Summit Avenue", body).fits).toBe(true);
  });

  it("falls back to recipient and subject only when the body would be cut off", () => {
    const link = statementMailto("jane@example.com", "Statement", "x".repeat(MAILTO_MAX_LENGTH));
    expect(link.fits).toBe(false);
    expect(link.href).toBe("mailto:jane@example.com?subject=Statement");
  });
});
