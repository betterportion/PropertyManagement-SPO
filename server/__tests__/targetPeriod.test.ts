import { describe, it, expect } from "vitest";
import { formatTargetPeriod, isProjectType } from "@shared/schema";

describe("isProjectType", () => {
  it("is true for a project and a capital project, false for a repair and for nothing", () => {
    expect(isProjectType("project")).toBe(true);
    expect(isProjectType("capex")).toBe(true);
    expect(isProjectType("request")).toBe(false);
    expect(isProjectType(null)).toBe(false);
  });
});

describe("formatTargetPeriod", () => {
  it("reads as a quarter of a year, a year, or nothing", () => {
    expect(formatTargetPeriod(2027, 2)).toBe("Q2 2027");
    expect(formatTargetPeriod(2027, null)).toBe("2027");
    expect(formatTargetPeriod(null, null)).toBeNull();
    // A quarter with no year is not a period; the route refuses it, so this
    // only has to not invent one.
    expect(formatTargetPeriod(null, 2)).toBeNull();
  });
});
