import { describe, expect, it } from "vitest";
import { insertPropertySchema } from "../../shared/schema";

/**
 * A house's men-or-women and its two capacities (launch doc question 3.7,
 * Oct 2026). Both capacities are kept because SPO keeps both: the legal one is
 * what the city allows, the mission one the most SPO puts in the house.
 */
const house = {
  name: "Hilltop",
  streetAddress: "1 Example St",
  city: "Atchison",
  state: "KS",
  zipCode: "66002",
  region: "West Central",
  chapter: "Benedictine College",
};

describe("a house's capacity", () => {
  it("keeps men or women and both capacities, which need not agree", () => {
    const parsed = insertPropertySchema.parse({ ...house, household: "women", capacityLegal: "8", capacityMission: 6 });
    expect(parsed).toMatchObject({ household: "women", capacityLegal: 8, capacityMission: 6 });
  });

  it("may leave all three unset", () => {
    const parsed = insertPropertySchema.parse({ ...house, household: null, capacityLegal: null, capacityMission: undefined });
    expect(parsed).toMatchObject({ household: null, capacityLegal: null });
    expect(parsed.capacityMission).toBeUndefined();
  });

  it("refuses a capacity below zero or not a whole number", () => {
    expect(insertPropertySchema.safeParse({ ...house, capacityLegal: -1 }).success).toBe(false);
    expect(insertPropertySchema.safeParse({ ...house, capacityMission: 6.5 }).success).toBe(false);
  });

  it("refuses a household that is neither men nor women", () => {
    expect(insertPropertySchema.safeParse({ ...house, household: "coed" }).success).toBe(false);
    expect(insertPropertySchema.partial().safeParse({ household: "Women" }).success).toBe(false);
  });
});
