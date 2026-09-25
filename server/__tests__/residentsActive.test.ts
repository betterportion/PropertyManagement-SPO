import { describe, it, expect } from "vitest";
import { residentsActiveOn } from "@shared/residents";

const jane = { id: "jane", moveInDate: "2025-08-20", moveOutDate: null };
const gone = { id: "gone", moveInDate: "2024-08-20", moveOutDate: "2026-03-01" };
const later = { id: "later", moveInDate: "2026-08-20", moveOutDate: null };
const undated = { id: "undated", moveInDate: null, moveOutDate: null };

describe("residentsActiveOn", () => {
  it("keeps the people living there on the date, and drops the moved-out and not-yet-in", () => {
    const ids = residentsActiveOn([jane, gone, later, undated], "2026-05-20").map((r) => r.id);
    expect(ids).toEqual(["jane", "undated"]);
  });

  it("counts the move-out day itself as still there", () => {
    expect(residentsActiveOn([gone], "2026-03-01").map((r) => r.id)).toEqual(["gone"]);
  });

  it("returns everybody for an unreadable date, so the RA trims rather than starts from nobody", () => {
    expect(residentsActiveOn([jane, gone, later], "not a date")).toHaveLength(3);
    expect(residentsActiveOn([jane, gone, later], null)).toHaveLength(3);
  });
});
