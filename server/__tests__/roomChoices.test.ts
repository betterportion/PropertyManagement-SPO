import { describe, expect, it } from "vitest";
import { roomChoices } from "../roomChoices";

const TEMPLATE = [
  { name: "Living Room", displayOrder: 1 },
  { name: "Kitchen", displayOrder: 0 },
];

describe("roomChoices", () => {
  it("offers the rooms of the latest walkthrough, in its order, each once", () => {
    const walkthroughs = [
      { id: "old", walkthroughDate: "2025-08-01" },
      { id: "new", walkthroughDate: "2026-08-01" },
    ];
    const rooms = [
      { walkthroughId: "old", name: "Den", displayOrder: 0 },
      { walkthroughId: "new", name: "Bedroom 2", displayOrder: 2 },
      { walkthroughId: "new", name: "Kitchen", displayOrder: 0 },
      { walkthroughId: "new", name: "Kitchen", displayOrder: 1 },
    ];
    expect(roomChoices(walkthroughs, rooms, TEMPLATE)).toEqual(["Kitchen", "Bedroom 2"]);
  });

  it("skips a newer walkthrough that has no rooms yet", () => {
    const walkthroughs = [
      { id: "old", walkthroughDate: "2025-08-01" },
      { id: "started", walkthroughDate: "2026-08-01" },
    ];
    expect(roomChoices(walkthroughs, [{ walkthroughId: "old", name: "Den" }], TEMPLATE)).toEqual(["Den"]);
  });

  it("falls back to the template for a house never walked", () => {
    expect(roomChoices([], [], TEMPLATE)).toEqual(["Kitchen", "Living Room"]);
  });

  it("sorts an undated walkthrough last", () => {
    const walkthroughs = [
      { id: "undated", walkthroughDate: null },
      { id: "dated", walkthroughDate: "2024-01-01" },
    ];
    const rooms = [
      { walkthroughId: "undated", name: "Attic" },
      { walkthroughId: "dated", name: "Porch" },
    ];
    expect(roomChoices(walkthroughs, rooms, TEMPLATE)).toEqual(["Porch"]);
  });
});
