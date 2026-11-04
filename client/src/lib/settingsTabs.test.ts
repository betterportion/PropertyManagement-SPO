import { describe, expect, it } from "vitest";
import { isSettingsTab, settingsTabForHash } from "./settingsTabs";
import { resolveRequest, type ActionItem } from "./actionItems";

describe("settingsTabForHash", () => {
  it("opens the tab holding the section a link names", () => {
    expect(settingsTabForHash("#quickbooks")).toBe("setup");
    expect(settingsTabForHash("#roster")).toBe("setup");
    expect(settingsTabForHash("#email-health")).toBe("activity");
  });

  it("opens People for no hash or one it does not know", () => {
    expect(settingsTabForHash("")).toBe("people");
    expect(settingsTabForHash("#nothing-here")).toBe("people");
  });

  it("knows its own tabs and nothing else", () => {
    expect(isSettingsTab("guide")).toBe(true);
    expect(isSettingsTab("billing")).toBe(false);
  });
});

describe("the dashboard's Settings links", () => {
  // Every integration item links to a card that sits off the People tab; if a
  // new link's hash is not mapped, it would open on People without its card.
  it.each(["roster:sync-failed", "email:failing", "quickbooks:expired"])("%s opens the tab holding its card", (id) => {
    const item = { id, source: "integration" } as ActionItem;
    const href = resolveRequest(item).href!;
    const hash = href.slice(href.indexOf("#"));
    expect(settingsTabForHash(hash)).not.toBe("people");
  });
});
