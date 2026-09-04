/**
 * The one folding rule two screens share.
 *
 * The recurring-issue rollups and the photo comparison both match "the same
 * room" on this, so what it does and does not merge is the contract, and it
 * is asserted here rather than once per caller.
 */
import { describe, it, expect } from "vitest";
import { foldName } from "@shared/schema";

describe("folding a name for comparison", () => {
  it("folds case, edges and runs of whitespace to one key", () => {
    // Three spellings a person types for one room.
    const keys = new Set(["Living room", "living  room ", "LIVING ROOM"].map(foldName));
    expect(keys.size).toBe(1);
    expect(keys.has("living room")).toBe(true);
  });

  it("keeps genuinely different names apart", () => {
    expect(foldName("Living room")).not.toBe(foldName("Dining room"));
  });

  it("folds nothing and blank to the empty string, so callers can treat both as no name", () => {
    expect(foldName(null)).toBe("");
    expect(foldName(undefined)).toBe("");
    expect(foldName("   ")).toBe("");
  });
});
