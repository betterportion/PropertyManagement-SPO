/**
 * The region card's "All clear" is a claim about the attention score. A
 * caller who cannot see one of the score's sources must not be told the
 * region is clear (#171), and a caller who cannot see rent, which is never
 * part of the score, must not lose "All clear" over it.
 */
import { describe, it, expect } from "vitest";
import { isAllClear, overviewCards, scoreCountsHidden } from "./regionCard";

describe("isAllClear", () => {
  it("is clear when the score is zero and nothing is hidden", () => {
    expect(isAllClear({ attentionScore: 0, hidden: [] })).toBe(true);
  });

  it("is not clear when the score is above zero", () => {
    expect(isAllClear({ attentionScore: 2, hidden: [] })).toBe(false);
  });

  it.each(["maintenance", "schedule", "lease"])("is not clear when %s is hidden, even at a zero score", (source) => {
    expect(isAllClear({ attentionScore: 0, hidden: [source] })).toBe(false);
  });

  it("stays clear when only rent is hidden, because rent is not part of the score", () => {
    expect(isAllClear({ attentionScore: 0, hidden: ["rent"] })).toBe(true);
  });

  it("is not clear when rent and a score source are both hidden", () => {
    expect(isAllClear({ attentionScore: 0, hidden: ["rent", "lease"] })).toBe(false);
  });
});

describe("scoreCountsHidden", () => {
  it("ignores rent and flags any score source", () => {
    expect(scoreCountsHidden(["rent"])).toBe(false);
    expect(scoreCountsHidden(["maintenance"])).toBe(true);
  });
});

describe("overviewCards", () => {
  it("hides the National card and keeps every other region, in order", () => {
    const summaries = [{ region: "Northwest" }, { region: "National" }, { region: "East Central" }];
    expect(overviewCards(summaries).map((s) => s.region)).toEqual(["Northwest", "East Central"]);
  });

  it("leaves a list with no National summary untouched", () => {
    const summaries = [{ region: "Southwest" }];
    expect(overviewCards(summaries)).toEqual(summaries);
  });
});
