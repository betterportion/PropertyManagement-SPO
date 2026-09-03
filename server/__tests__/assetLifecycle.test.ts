/**
 * When an asset is due for replacement, and how loudly to say so.
 *
 * Pure — an asset plus `now` in, a status out — so the asset screen, the
 * detail page and the dashboard cannot disagree, and none of them needs a
 * database or a clock to be tested.
 *
 * Two rules here exist because SPO's own tracking is admittedly patchy, and a
 * warning system that guesses is worse than one that stays quiet:
 *
 *   - an asset with no acquisition date is UNRATED, never a warning and never
 *     a guess;
 *   - a snooze suppresses the asset on the dashboard only. It stays visible,
 *     and visibly snoozed, on the asset screen — hiding it everywhere is how a
 *     boiler gets forgotten for three years.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_LIFESPAN_YEARS,
  LIFECYCLE_URGENT_YEARS,
  LIFECYCLE_WARN_YEARS,
  assetLifecycle,
  replacementDueAt,
  type LifecycleAsset,
} from "@shared/assetLifecycle";

const NOW = new Date("2026-08-15T00:00:00Z");

/** Years from NOW, as a date. */
const inYears = (n: number) => new Date("2026-08-15T00:00:00Z").getTime() + n * 365.25 * 24 * 3600 * 1000;
const yearsAway = (n: number) => new Date(inYears(n));

function asset(over: Partial<LifecycleAsset> = {}): LifecycleAsset {
  return {
    category: "Water Heater",
    acquisitionDate: null,
    expectedLifespanYears: null,
    replacementDueDate: null,
    snoozedUntil: null,
    ...over,
  };
}

describe("working out when an asset is due for replacement", () => {
  it("has no answer for an asset with no acquisition date", () => {
    // Never a guess. SPO's tracking is patchy and an invented date would put a
    // fine boiler into next year's budget.
    expect(replacementDueAt(asset({ acquisitionDate: null }))).toBeNull();
  });

  it("adds the category's default lifespan to the acquisition date", () => {
    const acquired = new Date("2020-08-15T00:00:00Z");
    const due = replacementDueAt(asset({ category: "Water Heater", acquisitionDate: acquired }));
    expect(due).not.toBeNull();
    expect(due!.getUTCFullYear()).toBe(2020 + DEFAULT_LIFESPAN_YEARS["Water Heater"]);
  });

  it("prefers a per-asset lifespan over the category default", () => {
    // Tracking is inconsistent, so the category carries the default and the
    // asset carries the correction.
    const acquired = new Date("2020-08-15T00:00:00Z");
    const due = replacementDueAt(
      asset({ category: "Water Heater", acquisitionDate: acquired, expectedLifespanYears: 30 }),
    );
    expect(due!.getUTCFullYear()).toBe(2050);
  });

  it("prefers an explicit replacement date over anything computed", () => {
    // Editing the date is the permanent correction; snooze is the temporary one.
    const explicit = new Date("2031-01-01T00:00:00Z");
    const due = replacementDueAt(
      asset({
        acquisitionDate: new Date("2020-08-15T00:00:00Z"),
        expectedLifespanYears: 5,
        replacementDueDate: explicit,
      }),
    );
    expect(due!.toISOString()).toBe(explicit.toISOString());
  });

  it("gives an explicit replacement date to an asset with no acquisition date", () => {
    // "We don't know when we got it, but it needs doing in 2029" is a real
    // thing an RA knows, and refusing it would lose the only date there is.
    const explicit = new Date("2029-06-01T00:00:00Z");
    expect(replacementDueAt(asset({ replacementDueDate: explicit }))!.toISOString()).toBe(
      explicit.toISOString(),
    );
  });

  it("has no answer for a category nobody has given a lifespan", () => {
    // A new category must not silently inherit somebody else's number.
    expect(replacementDueAt(asset({ category: "Artwork", acquisitionDate: new Date("2020-01-01") }))).toBeNull();
  });
});

describe("how loudly to say an asset is due", () => {
  it("is unrated when there is no date to reason from", () => {
    const state = assetLifecycle(asset(), NOW);
    expect(state.status).toBe("unrated");
    // Never a warning, and the label says why rather than leaving a blank.
    expect(state.label).toMatch(/unrated|no acquisition date/i);
  });

  it("is fine when replacement is further out than the warning threshold", () => {
    const state = assetLifecycle(asset({ replacementDueDate: yearsAway(LIFECYCLE_WARN_YEARS + 1) }), NOW);
    expect(state.status).toBe("ok");
  });

  it("warns from three years out — the point it enters planning", () => {
    const state = assetLifecycle(asset({ replacementDueDate: yearsAway(LIFECYCLE_WARN_YEARS - 0.1) }), NOW);
    expect(state.status).toBe("due_soon");
  });

  it("is urgent at twelve months or less, because that is a budget year", () => {
    // The red threshold exists because it has to enter that year's budget.
    const state = assetLifecycle(asset({ replacementDueDate: yearsAway(LIFECYCLE_URGENT_YEARS - 0.1) }), NOW);
    expect(state.status).toBe("urgent");
  });

  it("is overdue once the date has passed", () => {
    const state = assetLifecycle(asset({ replacementDueDate: yearsAway(-0.5) }), NOW);
    expect(state.status).toBe("overdue");
  });

  it("carries a text label for every status, never colour alone", () => {
    const cases: LifecycleAsset[] = [
      asset(),
      asset({ replacementDueDate: yearsAway(10) }),
      asset({ replacementDueDate: yearsAway(2) }),
      asset({ replacementDueDate: yearsAway(0.5) }),
      asset({ replacementDueDate: yearsAway(-1) }),
    ];
    for (const each of cases) {
      expect(assetLifecycle(each, NOW).label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("snoozing an asset an RA is confident about", () => {
  it("reports the snooze without changing the underlying status", () => {
    // Snooze must not falsify the date. The asset is still overdue; somebody
    // has simply said "not this year, and here is why".
    const state = assetLifecycle(
      asset({ replacementDueDate: yearsAway(-1), snoozedUntil: yearsAway(1) }),
      NOW,
    );
    expect(state.status).toBe("overdue");
    expect(state.snoozed).toBe(true);
  });

  it("stops reporting a snooze once it has run out", () => {
    // It returns. That is the whole point of an end date rather than a flag.
    const state = assetLifecycle(
      asset({ replacementDueDate: yearsAway(-1), snoozedUntil: yearsAway(-0.1) }),
      NOW,
    );
    expect(state.snoozed).toBe(false);
  });

  it("treats a snooze ending exactly now as over", () => {
    const state = assetLifecycle(
      asset({ replacementDueDate: yearsAway(-1), snoozedUntil: NOW }),
      NOW,
    );
    expect(state.snoozed).toBe(false);
  });
});

describe("dates that arrive as strings across a JSON boundary", () => {
  it("reads an ISO string the same as a Date", () => {
    const asDate = assetLifecycle(asset({ replacementDueDate: yearsAway(-1) }), NOW);
    const asString = assetLifecycle(
      asset({ replacementDueDate: yearsAway(-1).toISOString() }),
      NOW,
    );
    expect(asString.status).toBe(asDate.status);
  });

  it("is unrated rather than epoch-zero for a malformed date", () => {
    // A malformed date parsing as 1970 would report every asset overdue.
    const state = assetLifecycle(asset({ replacementDueDate: "not-a-date" }), NOW);
    expect(state.status).toBe("unrated");
  });
});
