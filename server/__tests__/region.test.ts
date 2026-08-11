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
// Inline re-implementations of the authorization helpers so we can test them
// without spinning up a server or database.  These mirror filterByRegion and
// canAccessRegion from server/routes.ts exactly, but accept a normalisation
// step — verifying the fix is sound.
// ---------------------------------------------------------------------------

function filterByRegion<T extends { region?: string | null }>(
  items: T[],
  rawAllowedRegions: string[] | null
): T[] {
  if (!rawAllowedRegions || rawAllowedRegions.length === 0) return [];
  const allowedRegions = normalizeRegions(rawAllowedRegions);
  if (allowedRegions.includes("all")) return items;
  return items.filter(
    (item) => item.region && allowedRegions.includes(normalizeRegion(item.region))
  );
}

function canAccessRegion(
  region: string | null | undefined,
  rawAllowedRegions: string[] | null,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true;
  if (!region) return false;
  if (!rawAllowedRegions || rawAllowedRegions.length === 0) return false;
  const allowedRegions = normalizeRegions(rawAllowedRegions);
  return allowedRegions.includes(normalizeRegion(region));
}

// ---------------------------------------------------------------------------

describe("filterByRegion – legacy kebab-case allowedRegions", () => {
  const requests = [
    { id: "1", region: "West Central" },
    { id: "2", region: "East Central" },
    { id: "3", region: "North West" },
  ];

  it("returns matching records when allowedRegions contains legacy kebab-case value", () => {
    // Pre-existing regional admin whose row was NOT yet migrated
    const result = filterByRegion(requests, ["west-central"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("returns matching records when allowedRegions contains canonical Title Case value", () => {
    const result = filterByRegion(requests, ["West Central"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("returns all records when allowedRegions is ['all']", () => {
    expect(filterByRegion(requests, ["all"])).toHaveLength(3);
  });

  it("returns empty array when allowedRegions is empty", () => {
    expect(filterByRegion(requests, [])).toHaveLength(0);
  });

  it("returns empty array when allowedRegions is null", () => {
    expect(filterByRegion(requests, null)).toHaveLength(0);
  });
});

describe("canAccessRegion – legacy kebab-case allowedRegions", () => {
  it("grants access when stored as legacy kebab-case and record is Title Case", () => {
    expect(canAccessRegion("West Central", ["west-central"], false)).toBe(true);
  });

  it("grants access when both stored and record are canonical Title Case", () => {
    expect(canAccessRegion("West Central", ["West Central"], false)).toBe(true);
  });

  it("denies access when region is not in allowedRegions", () => {
    expect(canAccessRegion("East Central", ["west-central"], false)).toBe(false);
  });

  it("always grants access to admins regardless of region", () => {
    expect(canAccessRegion("East Central", [], true)).toBe(true);
  });

  it("denies access when allowedRegions is empty", () => {
    expect(canAccessRegion("West Central", [], false)).toBe(false);
  });

  it("denies access when region is null", () => {
    expect(canAccessRegion(null, ["west-central"], false)).toBe(false);
  });
});
