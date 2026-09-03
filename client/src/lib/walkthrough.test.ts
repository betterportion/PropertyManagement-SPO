import { describe, it, expect } from "vitest";
import type { WalkthroughItem } from "@shared/schema";
import {
  CONDITION_LABEL,
  WALKTHROUGH_STATUS_BADGE,
  WALKTHROUGH_TYPE_LABEL,
  canFillInWalkthroughs,
  canSeeResourceHub,
  canSeeWalkthroughPhotos,
  canWriteWalkthrough,
  conditionTone,
  isCurrentWalkthrough,
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

describe("canFillInWalkthroughs", () => {
  it("lets an admin through even with no permissions row", () => {
    // The admin bypass. Admins frequently have no user_permissions row, and a
    // check reading only the flag would hide every control from them.
    expect(canFillInWalkthroughs({ role: "admin" })).toBe(true);
    expect(canFillInWalkthroughs({ role: "admin", permissions: null })).toBe(true);
  });

  it("lets staff through only on the flag, not on the role", () => {
    // A regional administrator without the grant can look but not touch --
    // which is what the server enforces, so the UI must not offer more.
    expect(canFillInWalkthroughs({ role: "regional_administrator" })).toBe(false);
    expect(
      canFillInWalkthroughs({ role: "regional_administrator", permissions: { canManageWalkthroughs: true } }),
    ).toBe(true);
  });

  it("lets a household leader through on canCompleteWalkthroughs", () => {
    // Their own house only -- which the server binds them to and no client
    // check stands in for. What this decides is whether the controls appear.
    expect(
      canFillInWalkthroughs({ role: "resident", permissions: { canCompleteWalkthroughs: true } }),
    ).toBe(true);
  });

  it("refuses a resident holding only the staff flag", () => {
    // hasWalkthroughPermission will not read a staff grant off a resident
    // account, so an edit control offered on one would be refused by every
    // request behind it.
    expect(canFillInWalkthroughs({ role: "resident", permissions: { canManageWalkthroughs: true } })).toBe(false);
    expect(canFillInWalkthroughs({ role: "resident" })).toBe(false);
    expect(canFillInWalkthroughs({ role: "resident", permissions: {} })).toBe(false);
  });

  it("refuses staff holding only the resident flag", () => {
    expect(
      canFillInWalkthroughs({
        role: "regional_administrator",
        permissions: { canCompleteWalkthroughs: true },
      }),
    ).toBe(false);
  });

  it("refuses nobody at all", () => {
    expect(canFillInWalkthroughs(null)).toBe(false);
    expect(canFillInWalkthroughs(undefined)).toBe(false);
  });
});

describe("canSeeWalkthroughPhotos", () => {
  it("keeps the room photos to staff, even for a leader who may fill the checklist in", () => {
    // A resident cannot upload a file outside a maintenance request, and
    // canReadUploadReference does not hand them a walkthrough photo either.
    // The section is hidden rather than shown and refused.
    expect(
      canSeeWalkthroughPhotos({ role: "resident", permissions: { canCompleteWalkthroughs: true } }),
    ).toBe(false);
    expect(canSeeWalkthroughPhotos({ role: "regional_administrator" })).toBe(true);
    expect(canSeeWalkthroughPhotos({ role: "admin" })).toBe(true);
    expect(canSeeWalkthroughPhotos(null)).toBe(false);
  });
});

describe("isCurrentWalkthrough and canWriteWalkthrough", () => {
  const dated = (walkthroughDate: string) => ({ walkthroughDate });
  const THIS_YEAR = dated("2026-09-01T00:00:00.000Z");
  const LAST_YEAR = dated("2025-09-01T00:00:00.000Z");
  const HISTORY = [THIS_YEAR, LAST_YEAR];

  const leader = { role: "resident", permissions: { canCompleteWalkthroughs: true } };
  const staff = { role: "regional_administrator", permissions: { canManageWalkthroughs: true } };

  it("picks out the inspection still being performed", () => {
    expect(isCurrentWalkthrough(THIS_YEAR, HISTORY)).toBe(true);
    expect(isCurrentWalkthrough(LAST_YEAR, HISTORY)).toBe(false);
  });

  it("keeps a leader's prior years read-only, matching the server", () => {
    // The screen must not offer a chip the PATCH behind it would refuse.
    expect(canWriteWalkthrough(leader, THIS_YEAR, HISTORY)).toBe(true);
    expect(canWriteWalkthrough(leader, LAST_YEAR, HISTORY)).toBe(false);
  });

  it("lets staff write any year, without consulting the history", () => {
    expect(canWriteWalkthrough(staff, LAST_YEAR, [])).toBe(true);
    expect(canWriteWalkthrough({ role: "admin" }, LAST_YEAR, [])).toBe(true);
  });

  it("refuses anyone without the grant, current year or not", () => {
    expect(canWriteWalkthrough({ role: "resident" }, THIS_YEAR, HISTORY)).toBe(false);
    expect(canWriteWalkthrough({ role: "regional_administrator" }, THIS_YEAR, HISTORY)).toBe(false);
    expect(canWriteWalkthrough(null, THIS_YEAR, HISTORY)).toBe(false);
  });

  it("refuses a leader before the walkthrough has loaded", () => {
    // Undefined must not read as writable during the first render.
    expect(canWriteWalkthrough(leader, undefined, HISTORY)).toBe(false);
    expect(canWriteWalkthrough(leader, null, HISTORY)).toBe(false);
  });

  it("treats an undated walkthrough as read-only", () => {
    expect(isCurrentWalkthrough({ walkthroughDate: null }, [])).toBe(false);
    expect(canWriteWalkthrough(leader, { walkthroughDate: null }, [])).toBe(false);
  });

  it("lets a tie through, so a same-day move-in and move-out both work", () => {
    const sameDay = dated("2026-09-01T00:00:00.000Z");
    expect(canWriteWalkthrough(leader, sameDay, [THIS_YEAR, sameDay])).toBe(true);
  });
});

describe("who reaches the resource hub", () => {
  it("lets in a resident granted the hub", () => {
    expect(
      canSeeResourceHub({ role: "resident", permissions: { canViewResourceHub: true } }),
    ).toBe(true);
  });

  it("keeps out a resident who has not been granted it", () => {
    expect(canSeeResourceHub({ role: "resident", permissions: {} })).toBe(false);
    expect(canSeeResourceHub({ role: "resident", permissions: null })).toBe(false);
  });

  it("does not let the walkthrough grant stand in for it", () => {
    // Filling in a walkthrough and being given the hub are two grants. Reading
    // one for the other means a later change to either silently moves the
    // other -- the same reason canCompleteWalkthroughs is separate from
    // canManageWalkthroughs in the first place.
    expect(
      canSeeResourceHub({ role: "resident", permissions: { canCompleteWalkthroughs: true } }),
    ).toBe(false);
  });

  it("does not let a staff flag on a resident account stand in either", () => {
    expect(
      canSeeResourceHub({ role: "resident", permissions: { canViewProperties: true } }),
    ).toBe(false);
  });

  it("lets staff in on the property permission, so they see what households are told", () => {
    expect(
      canSeeResourceHub({ role: "regional_administrator", permissions: { canViewProperties: true } }),
    ).toBe(true);
    expect(
      canSeeResourceHub({ role: "regional_administrator", permissions: { canManageProperties: true } }),
    ).toBe(true);
  });

  it("keeps out staff holding neither property permission", () => {
    expect(
      canSeeResourceHub({ role: "regional_administrator", permissions: { canViewMaintenance: true } as never }),
    ).toBe(false);
  });

  it("lets an admin in with no permissions row at all", () => {
    // The admin bypass. Most admins have no row, and a check reading only the
    // flag would hide the page from the people who administer it.
    expect(canSeeResourceHub({ role: "admin" })).toBe(true);
  });

  it("keeps out nobody signed in", () => {
    expect(canSeeResourceHub(null)).toBe(false);
    expect(canSeeResourceHub(undefined)).toBe(false);
  });
});
