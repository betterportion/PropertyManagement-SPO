/**
 * How each kind of action item is resolved.
 *
 * The test that matters most here is the exhaustiveness one. `resolveRequest`
 * is a switch with no default, and the client used to keep its own copy of the
 * source union — so when the server grew `setup` and `asset` items, the switch
 * fell through and returned `undefined`, which the caller read `.actionLabel`
 * off. That crashed the Tasks page and the dashboard's list for any region
 * with an unfinished setup checklist. Iterating the shared union is what makes
 * the next added source fail here rather than in somebody's browser.
 */
import { describe, it, expect } from "vitest";
import { ACTION_ITEM_SOURCES } from "@shared/actionItems";
import { categoryLabel, resolveRequest, type ActionItem } from "./actionItems";

function item(over: Partial<ActionItem>): ActionItem {
  return {
    id: "x1",
    source: "task",
    category: "general",
    title: "Something",
    subtitle: "Somewhere",
    dueDate: null,
    overdue: false,
    region: "West Central",
    ...over,
  } as ActionItem;
}

describe("resolving every kind of action item", () => {
  it.each(ACTION_ITEM_SOURCES)("returns a usable resolution for a %s item", (source) => {
    const request = resolveRequest(item({ source }));

    expect(request).toBeDefined();
    // The row renders this; undefined here is the crash.
    expect(request.actionLabel.trim().length).toBeGreaterThan(0);
    // Every resolution is either a navigation or an API call, never neither --
    // a button that does nothing is worse than no button.
    expect(Boolean(request.href) || Boolean(request.method && request.path)).toBe(true);
  });

  it.each(ACTION_ITEM_SOURCES)("gives a %s item a category label", (source) => {
    expect(categoryLabel(item({ source })).trim().length).toBeGreaterThan(0);
  });

  it("does not crash on a source this client has never heard of", () => {
    // A newer server can send one. The page must degrade, not white-screen.
    const request = resolveRequest(item({ source: "something-new" as never }));
    expect(request).toBeDefined();
    expect(request.actionLabel.trim().length).toBeGreaterThan(0);
  });
});

describe("what each resolution actually does", () => {
  it("marks rent paid behind a confirmation, because it moves a real record", () => {
    const request = resolveRequest(item({ source: "rent", id: "rp-1" }));
    expect(request.method).toBe("PATCH");
    expect(request.path).toBe("/api/rent-payments/rp-1");
    expect(request.confirm).toBeDefined();
  });

  it("sends a setup item to that house rather than resolving in one click", () => {
    // Seven checks cannot be ticked by one button, and the id on a setup item
    // is the property's.
    const request = resolveRequest(item({ source: "setup", id: "prop-1" }));
    expect(request.href).toBe("/properties/prop-1");
    expect(request.method).toBeUndefined();
  });

  it("sends an asset item to that asset", () => {
    const request = resolveRequest(item({ source: "asset", id: "asset-1" }));
    expect(request.href).toBe("/assets/asset-1");
  });

  it("does not offer a one-click resolve for anything that needs a form", () => {
    for (const source of ["lease", "setup", "asset"] as const) {
      expect(resolveRequest(item({ source })).method).toBeUndefined();
    }
  });
});
