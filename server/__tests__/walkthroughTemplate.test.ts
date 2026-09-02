/**
 * Tests for what a new walkthrough starts out containing.
 *
 * Pure: rooms and items in, planned rooms out. No database, no HTTP.
 */
import { describe, it, expect } from "vitest";
import {
  planFromTemplate,
  planFromPreviousWalkthrough,
  templateRoomItems,
} from "../walkthroughTemplate";

const TEMPLATE_ROOMS = [
  { id: "t-kitchen", name: "Kitchen", includeByDefault: true, displayOrder: 0 },
  { id: "t-bath", name: "Bathroom", includeByDefault: true, displayOrder: 1 },
  { id: "t-garage", name: "Garage", includeByDefault: false, displayOrder: 9 },
];

const TEMPLATE_ITEMS = [
  { templateRoomId: "t-kitchen", label: "Sink", displayOrder: 0 },
  { templateRoomId: "t-kitchen", label: "Range", displayOrder: 1 },
  { templateRoomId: "t-bath", label: "Toilet", displayOrder: 1 },
  { templateRoomId: "t-bath", label: "Sink", displayOrder: 0 },
  { templateRoomId: "t-garage", label: "Door opener", displayOrder: 0 },
];

describe("planFromTemplate", () => {
  it("builds the standard rooms with their standard items", () => {
    const plan = planFromTemplate(TEMPLATE_ROOMS, TEMPLATE_ITEMS);
    expect(plan.map((r) => r.name)).toEqual(["Kitchen", "Bathroom"]);
    expect(plan[0].items.map((i) => i.label)).toEqual(["Sink", "Range"]);
    expect(plan[1].items.map((i) => i.label)).toEqual(["Sink", "Toilet"]);
  });

  it("leaves out a room type that is not standard", () => {
    // A garage is a known room type but most houses do not have one. It is
    // added by hand, which is what templateRoomItems exists for.
    const plan = planFromTemplate(TEMPLATE_ROOMS, TEMPLATE_ITEMS);
    expect(plan.map((r) => r.name)).not.toContain("Garage");
  });

  it("does not carry a non-standard room's items into any other room", () => {
    const plan = planFromTemplate(TEMPLATE_ROOMS, TEMPLATE_ITEMS);
    expect(plan.flatMap((r) => r.items.map((i) => i.label))).not.toContain("Door opener");
  });

  it("treats a missing includeByDefault as standard", () => {
    // Drizzle gives the column a default of true; a row read from somewhere
    // that omits it should not silently vanish from every new walkthrough.
    const plan = planFromTemplate([{ id: "t-1", name: "Hall", displayOrder: 0 }], []);
    expect(plan.map((r) => r.name)).toEqual(["Hall"]);
  });

  it("renumbers display order from zero rather than copying it", () => {
    // The template's own orders have gaps (the garage is 9). A copy that
    // inherited them would leave a walkthrough numbered 0, 1, 9.
    const plan = planFromTemplate(TEMPLATE_ROOMS, TEMPLATE_ITEMS);
    expect(plan.map((r) => r.displayOrder)).toEqual([0, 1]);
    expect(plan[1].items.map((i) => i.displayOrder)).toEqual([0, 1]);
  });

  it("orders deterministically when two rooms share a display order", () => {
    // Hand-editing produces this. Two loads must not render differently.
    const rooms = [
      { id: "b", name: "Bedroom", includeByDefault: true, displayOrder: 0 },
      { id: "a", name: "Attic", includeByDefault: true, displayOrder: 0 },
    ];
    expect(planFromTemplate(rooms, []).map((r) => r.name)).toEqual(["Attic", "Bedroom"]);
  });

  it("returns nothing for an empty template rather than throwing", () => {
    expect(planFromTemplate([], [])).toEqual([]);
  });

  it("builds a room with no items as an empty room", () => {
    const plan = planFromTemplate([{ id: "t-1", name: "Hall", includeByDefault: true, displayOrder: 0 }], []);
    expect(plan).toEqual([{ name: "Hall", displayOrder: 0, items: [] }]);
  });
});

describe("planFromPreviousWalkthrough", () => {
  const ROOMS = [
    { id: "r-kitchen", name: "Kitchen", displayOrder: 0 },
    { id: "r-porch", name: "Porch", displayOrder: 1 },
  ];
  const ITEMS = [
    { roomId: "r-kitchen", label: "Sink", displayOrder: 0 },
    { roomId: "r-porch", label: "Railing", displayOrder: 0 },
  ];

  it("carries last year's shape forward, including rooms the RA added", () => {
    // The template is a starting point, not a master. Once somebody has added
    // the porch this house has, it should come back next year.
    const plan = planFromPreviousWalkthrough(ROOMS, ITEMS);
    expect(plan.map((r) => r.name)).toEqual(["Kitchen", "Porch"]);
    expect(plan[1].items.map((i) => i.label)).toEqual(["Railing"]);
  });

  it("carries labels only -- never a condition or a note", () => {
    // A new walkthrough starts unassessed. Inheriting last year's "damaged"
    // would present a stale judgement as this year's finding, which is the
    // same mistake the 0017 backfill refused to make.
    const plan = planFromPreviousWalkthrough(ROOMS, [
      { roomId: "r-kitchen", label: "Sink", displayOrder: 0, condition: "damaged", notes: "Cracked" } as never,
    ]);
    expect(plan[0].items[0]).toEqual({ label: "Sink", displayOrder: 0 });
    expect(Object.keys(plan[0].items[0])).toEqual(["label", "displayOrder"]);
  });

  it("does not carry a deleted room back", () => {
    // Deleting the smoke detector this house does not have has to stick.
    const plan = planFromPreviousWalkthrough([ROOMS[0]], ITEMS);
    expect(plan.map((r) => r.name)).toEqual(["Kitchen"]);
    expect(plan[0].items.map((i) => i.label)).toEqual(["Sink"]);
  });

  it("returns nothing for a previous walkthrough that had no rooms", () => {
    expect(planFromPreviousWalkthrough([], [])).toEqual([]);
  });
});

describe("templateRoomItems", () => {
  it("prefills a known room type with its standard items, in order", () => {
    // The explicit request: add a bathroom, get its items, delete what is not
    // there. This is what makes editing fast enough to actually happen.
    expect(templateRoomItems("t-bath", TEMPLATE_ITEMS)).toEqual([
      { label: "Sink", displayOrder: 0 },
      { label: "Toilet", displayOrder: 1 },
    ]);
  });

  it("gives an empty room for a type nobody has defined items for", () => {
    // Adding a room must always work; an undefined type is an empty room, not
    // an error.
    expect(templateRoomItems("t-unknown", TEMPLATE_ITEMS)).toEqual([]);
  });

  it("never leaks another room type's items", () => {
    expect(templateRoomItems("t-kitchen", TEMPLATE_ITEMS).map((i) => i.label)).toEqual(["Sink", "Range"]);
  });
});
