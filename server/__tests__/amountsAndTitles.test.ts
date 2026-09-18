import { describe, it, expect } from "vitest";
import {
  insertDepositDeductionSchema,
  insertMaintenanceRequestSchema,
  isWholeCents,
} from "@shared/schema";

/**
 * Input the database would otherwise quietly change or store as noise: a
 * request titled with nothing but spaces, and an amount finer than a cent,
 * which a two-decimal column rounds without telling anybody.
 */

const request = {
  title: "Dripping tap",
  description: "Kitchen",
  category: "Plumbing",
  priority: "low",
  status: "pending",
  location: "Kitchen",
  region: "Northwest",
  buildingAddress: "1 Main St",
  submittedBy: "a@example.com",
};

describe("a request's title", () => {
  it("is refused when blank or only spaces", () => {
    expect(insertMaintenanceRequestSchema.safeParse({ ...request, title: "" }).success).toBe(false);
    expect(insertMaintenanceRequestSchema.safeParse({ ...request, title: "   " }).success).toBe(false);
  });

  it("is refused blank on an edit too", () => {
    expect(insertMaintenanceRequestSchema.partial().safeParse({ title: "  " }).success).toBe(false);
    expect(insertMaintenanceRequestSchema.partial().safeParse({ status: "completed" }).success).toBe(true);
  });

  it("is stored trimmed", () => {
    expect(insertMaintenanceRequestSchema.parse({ ...request, title: "  Dripping tap " }).title).toBe("Dripping tap");
  });
});

describe("an amount", () => {
  const deduction = (amount: unknown) =>
    insertDepositDeductionSchema.safeParse({ residentId: "r1", description: "Paint", amount, chargeDate: "2026-09-01" });

  it("accepts whole cents, including ones floating point cannot represent exactly", () => {
    for (const amount of ["0", "12", "12.3", "12.35", "19.99", "0.07", 1998.99]) {
      expect(deduction(amount).success, String(amount)).toBe(true);
    }
  });

  it("refuses fractions of a cent rather than letting the column round them", () => {
    for (const amount of ["12.345", "0.005", "0.001"]) {
      const result = deduction(amount);
      expect(result.success, amount).toBe(false);
      expect(result.error?.issues[0].message).toBe("Use at most 2 decimal places");
    }
  });

  it("is judged by one rule the split route shares", () => {
    expect(isWholeCents(100.1)).toBe(true);
    expect(isWholeCents(33.333)).toBe(false);
  });
});
