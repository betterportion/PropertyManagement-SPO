/**
 * The three named links on the resource hub (amendment to 8.1).
 *
 * A slot is a fixed place on the page with a fixed name; a link is bound to
 * it by `slotKey`, never by title, so renaming a link cannot silently unhook
 * it. An unbound slot is still rendered -- visibly waiting on content rather
 * than silently missing, which is what "SPO has not written the fire
 * extinguisher guidance yet" should look like.
 */
import { describe, it, expect } from "vitest";
import { RESOURCE_HUB_SLOTS, isResourceHubSlotKey, resolveHubSlots } from "@shared/resourceHubSlots";
import type { ResourceLink } from "@shared/schema";

function link(over: Partial<ResourceLink>): ResourceLink {
  return {
    id: "l1", title: "A link", url: "https://drive.google.com/x", description: null,
    category: "General", region: null, displayOrder: 0, isActive: true, slotKey: null,
    ...over,
  } as ResourceLink;
}

describe("the named hub slots", () => {
  it("names exactly the three documents SPO asked for, in that order", () => {
    expect(RESOURCE_HUB_SLOTS.map((slot) => slot.key)).toEqual(["code_of_conduct", "fire_extinguisher", "active_shooter"]);
    expect(RESOURCE_HUB_SLOTS.map((slot) => slot.label)).toEqual([
      "Household Code of Conduct",
      "Fire Extinguisher guidelines",
      "Active Shooter Policy",
    ]);
  });

  it("recognises its own keys and nothing else", () => {
    expect(isResourceHubSlotKey("fire_extinguisher")).toBe(true);
    expect(isResourceHubSlotKey("Fire Extinguisher guidelines")).toBe(false);
    expect(isResourceHubSlotKey("")).toBe(false);
  });
});

describe("resolving the slots against the published links", () => {
  it("returns every slot, bound or not, so an empty one is visibly waiting", () => {
    const conduct = link({ id: "l-conduct", slotKey: "code_of_conduct" });
    const slots = resolveHubSlots([conduct]);
    expect(slots.map((s) => s.slot.key)).toEqual(["code_of_conduct", "fire_extinguisher", "active_shooter"]);
    expect(slots[0].link?.id).toBe("l-conduct");
    expect(slots[1].link).toBeNull();
    expect(slots[2].link).toBeNull();
  });

  it("binds by key, never by title", () => {
    const named = link({ id: "l-named", title: "Fire Extinguisher guidelines", slotKey: null });
    const slots = resolveHubSlots([named]);
    expect(slots.find((s) => s.slot.key === "fire_extinguisher")?.link).toBeNull();
  });

  it("leaves a slot empty when its link has been hidden", () => {
    const hidden = link({ id: "l-hidden", slotKey: "active_shooter", isActive: false });
    const slots = resolveHubSlots([hidden]);
    expect(slots.find((s) => s.slot.key === "active_shooter")?.link).toBeNull();
  });

  it("tells the slotted links from the rest, so nothing is listed twice", () => {
    const conduct = link({ id: "l-conduct", slotKey: "code_of_conduct" });
    const other = link({ id: "l-other" });
    const slots = resolveHubSlots([conduct, other]);
    expect(slots.some((s) => s.link?.id === "l-other")).toBe(false);
  });
});
