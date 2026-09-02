import { describe, it, expect } from "vitest";
import type { WalkthroughItem } from "@shared/schema";
import {
  CONDITION_LABEL,
  WALKTHROUGH_STATUS_BADGE,
  WALKTHROUGH_TYPE_LABEL,
  canManageWalkthroughs,
  conditionTone,
  isAssessed,
  itemsByRoom,
  progressOf,
  roomStatus,
} from "./walkthrough";

/** Only the fields the progress rules read; the rest of the row is irrelevant. */
const item = (
  id: string,
  roomId: string,
  condition: WalkthroughItem["condition"],
  displayOrder = 0,
): WalkthroughItem =>
  ({
    id,
    roomId,
    label: id,
    condition,
    notes: null,
    displayOrder,
    createdAt: null,
    updatedAt: null,
  }) as WalkthroughItem;

describe("condition presentation", () => {
  it("gives every condition in the vocabulary a plain-language label", () => {
    // Status is never carried by colour alone, so a missing label would leave
    // a chip that only a sighted user reading hue could tell apart.
    expect(CONDITION_LABEL.good).toBe("Good");
    expect(CONDITION_LABEL.fair).toBe("Fair");
    expect(CONDITION_LABEL.poor).toBe("Poor");
    expect(CONDITION_LABEL.damaged).toBe("Damaged");
    expect(CONDITION_LABEL.not_applicable).toBe("Not here");
    expect(CONDITION_LABEL.not_recorded).toBe("Not checked");
  });

  it("keeps not_applicable and not_recorded visibly different", () => {
    // One says the item does not exist in this house, the other says nobody
    // looked. Collapsing them would invent an assessment.
    expect(CONDITION_LABEL.not_applicable).not.toBe(CONDITION_LABEL.not_recorded);
    expect(conditionTone("not_applicable")).not.toBe(conditionTone("not_recorded"));
  });

  it("tones poor and damaged as the ones needing attention", () => {
    expect(conditionTone("poor")).toBe("warn");
    expect(conditionTone("damaged")).toBe("bad");
    expect(conditionTone("good")).toBe("good");
  });
});

describe("isAssessed", () => {
  it("counts an item somebody graded", () => {
    expect(isAssessed("good")).toBe(true);
    expect(isAssessed("damaged")).toBe(true);
  });

  it("counts 'not here' as a decision, because the RA made one", () => {
    expect(isAssessed("not_applicable")).toBe(true);
  });

  it("does not count an item nobody looked at", () => {
    expect(isAssessed("not_recorded")).toBe(false);
  });
});

describe("progressOf", () => {
  it("counts the assessed items against the total", () => {
    const progress = progressOf([
      item("a", "r1", "good"),
      item("b", "r1", "not_recorded"),
      item("c", "r1", "not_applicable"),
    ]);
    expect(progress).toMatchObject({ total: 3, assessed: 2, flagged: 0 });
  });

  it("reports the flagged items separately from the assessed ones", () => {
    const progress = progressOf([
      item("a", "r1", "poor"),
      item("b", "r1", "damaged"),
      item("c", "r1", "good"),
    ]);
    expect(progress).toMatchObject({ total: 3, assessed: 3, flagged: 2 });
  });

  it("reports nothing rather than everything for an empty room", () => {
    // A percent of 100 on zero items would read as "this room is finished",
    // which is the opposite of what an empty room means.
    expect(progressOf([])).toEqual({ total: 0, assessed: 0, flagged: 0, percent: 0 });
  });

  it("rounds the percent down, so 100 means genuinely finished", () => {
    const items = Array.from({ length: 3 }, (_, i) =>
      item(`i${i}`, "r1", i === 0 ? "not_recorded" : "good"),
    );
    expect(progressOf(items).percent).toBe(66);

    const done = [item("a", "r1", "good"), item("b", "r1", "fair")];
    expect(progressOf(done).percent).toBe(100);
  });
});

describe("roomStatus", () => {
  it("is 'empty' when the room has no items to assess", () => {
    expect(roomStatus([])).toBe("empty");
  });

  it("is 'todo' when nothing in the room has been assessed", () => {
    expect(roomStatus([item("a", "r1", "not_recorded")])).toBe("todo");
  });

  it("is 'partial' while some items are still unassessed", () => {
    expect(roomStatus([item("a", "r1", "good"), item("b", "r1", "not_recorded")])).toBe("partial");
  });

  it("is 'done' only when every item has been assessed", () => {
    expect(roomStatus([item("a", "r1", "good"), item("b", "r1", "not_applicable")])).toBe("done");
  });
});

describe("itemsByRoom", () => {
  it("groups by room and orders each room by displayOrder", () => {
    const grouped = itemsByRoom([
      item("second", "r1", "good", 2),
      item("first", "r1", "good", 1),
      item("other", "r2", "good", 0),
    ]);
    expect(grouped.get("r1")?.map((i) => i.id)).toEqual(["first", "second"]);
    expect(grouped.get("r2")?.map((i) => i.id)).toEqual(["other"]);
  });

  it("returns an empty list for a room with no items, never undefined behaviour", () => {
    expect(itemsByRoom([]).get("r1")).toBeUndefined();
  });
});

describe("walkthrough vocabulary", () => {
  it("names every kind of walkthrough", () => {
    expect(WALKTHROUGH_TYPE_LABEL.annual).toBe("Annual");
    expect(WALKTHROUGH_TYPE_LABEL.move_in).toBe("Move in");
    expect(WALKTHROUGH_TYPE_LABEL.move_out).toBe("Move out");
    expect(WALKTHROUGH_TYPE_LABEL.legacy).toBe("Legacy");
  });

  it("calls a draft what an RA would call it", () => {
    // "Draft" is the database's word. Nobody walking a house says it.
    expect(WALKTHROUGH_STATUS_BADGE.draft.label).toBe("In progress");
    expect(WALKTHROUGH_STATUS_BADGE.submitted.label).toBe("Submitted");
    expect(WALKTHROUGH_STATUS_BADGE.reviewed.label).toBe("Reviewed");
  });
});

describe("canManageWalkthroughs", () => {
  it("lets an admin through even with no permissions row", () => {
    // The admin bypass. Admins frequently have no user_permissions row, and a
    // check reading only the flag would hide every control from them.
    expect(canManageWalkthroughs({ role: "admin" })).toBe(true);
    expect(canManageWalkthroughs({ role: "admin", permissions: null })).toBe(true);
  });

  it("lets staff through only on the flag, not on the role", () => {
    // A regional administrator without the grant can look but not touch --
    // which is what the server enforces, so the UI must not offer more.
    expect(canManageWalkthroughs({ role: "regional_administrator" })).toBe(false);
    expect(
      canManageWalkthroughs({ role: "regional_administrator", permissions: { canManageWalkthroughs: true } }),
    ).toBe(true);
  });

  it("refuses a resident whatever their permissions row says", () => {
    // The server rejects residents before it reads a single flag, so a stray
    // grant on a resident account must not put an edit control on screen.
    expect(canManageWalkthroughs({ role: "resident", permissions: { canManageWalkthroughs: true } })).toBe(false);
  });

  it("refuses nobody at all", () => {
    expect(canManageWalkthroughs(null)).toBe(false);
    expect(canManageWalkthroughs(undefined)).toBe(false);
  });
});
