import { describe, it, expect } from "vitest";
import { normalizeRegion, normalizeRegions, KEBAB_TO_TITLE } from "../migrateRegions";

// ---------------------------------------------------------------------------
// Pure-function unit tests for region normalisation and authorization helpers.
// These guard against the format-mismatch regression (kebab-case stored in
// allowedRegions vs Title Case stored in data records).
// ---------------------------------------------------------------------------

describe("normalizeRegion", () => {
  it("converts every known kebab-case slug to Title Case", () => {
    for (const [kebab, title] of Object.entries(KEBAB_TO_TITLE)) {
      expect(normalizeRegion(kebab)).toBe(title);
    }
  });

  it("leaves already-canonical Title Case values unchanged", () => {
    expect(normalizeRegion("West Central")).toBe("West Central");
    expect(normalizeRegion("North East")).toBe("North East");
  });

  it("passes through unknown values unchanged", () => {
    expect(normalizeRegion("unknown-region")).toBe("unknown-region");
  });
});

describe("normalizeRegions", () => {
  it("normalises a mixed array of legacy and canonical values", () => {
    expect(normalizeRegions(["west-central", "East Central", "north-west"])).toEqual([
      "West Central",
      "East Central",
      "North West",
    ]);
  });

  it("returns an empty array unchanged", () => {
    expect(normalizeRegions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The authorization rules that consume these functions -- filterByRegion,
// canAccessRegion and the rest -- are tested in authz.test.ts, against the real
// module. They used to be re-implemented inline here, which meant these tests
// could keep passing while the rule that actually runs drifted away from them.
// ---------------------------------------------------------------------------
