---
paths:
  - "**/*sset*"
  - "**/*ropertySetup*"
  - "e2e/property-setup.spec.ts"
---

# Assets and the property setup checklist

Moved verbatim from CLAUDE.md. Loads when you work with a file matching `paths`; the rest of the repo rules are in CLAUDE.md.

### Asset lifecycle and snooze

`shared/assetLifecycle.ts` owns the category list, the default lifespans, the two thresholds and `assetLifecycle` — pure, an asset plus `now` in, a status out. Everything about it follows from SPO's tracking being admittedly patchy, because a warning system that guesses is worse than one that stays quiet:

- **The category carries the default, the asset carries the correction.** Per-asset entry alone would be mostly blank. Precedence is explicit `replacementDueDate` → acquisition + per-asset lifespan → acquisition + category default.
- **No date means `unrated`.** Never a warning, never a guess, and the badge says *why* rather than leaving a blank somebody reads as "fine". There are two whys and the badge names the right one: "no acquisition date", or — for a dated asset in a category with no default lifespan — "no standard lifespan for this category". `insertAssetSchema` refuses a category outside `ASSET_CATEGORIES` (the column is plain varchar), because an off-list category has no lifespan and would read as unrated forever. A category deliberately absent from `DEFAULT_LIFESPAN_YEARS` (artwork, instruments) has no default and its assets stay unrated — they do not wear out on a schedule.
- **The lifespan figures are provisional.** Ordinary industry service lives, not figures SPO has confirmed; confirming them is an open item. The per-asset override is the escape hatch, which is why they are ordinary constants rather than a lookup nobody can correct.
- **Amber at `LIFECYCLE_WARN_YEARS` (3), red at `LIFECYCLE_URGENT_YEARS` (1).** The red threshold is not arbitrary: at twelve months a replacement has to enter that year's budget. **Status is never colour alone** — every badge carries its word.
- **A malformed date is `unrated`, not epoch zero.** Parsing one as 1970 would report the whole portfolio decades overdue.

**The snooze routes are the only writers.** `snoozedUntil` and `snoozeReason` are omitted from `insertAssetSchema` alongside the attribution columns, so the ordinary asset PATCH cannot set them. Omitting only the actor and the timestamp was not enough: `assetLifecycle` reads the snooze off `snoozedUntil` alone, so a PATCH could clear an asset from the action-item feed with no reason, no actor and no date — every guarantee the dedicated route makes is only worth as much as the sibling paths that cannot make it. A snooze is also **bounded to 24 months**: "it returns" is the whole distinction from editing the replacement date, and an unbounded end date erases it.

**Snooze suppresses an asset in the action-item feed only.** It stays on the asset screen and says it is snoozed; hiding it everywhere is how a boiler gets forgotten for three years. `POST /api/assets/:id/snooze` **requires a reason** — an unexplained snooze is just an asset quietly disappearing, and the reason is what makes next year's budget conversation possible — and requires an end date, so a snooze can never be permanent by omission. It writes only the four snooze columns and **never touches `replacementDueDate`**: editing that date is the permanent correction, and conflating the two would let a date be falsified silently. `DELETE` clears the snooze and keeps the reason. Who snoozed it and when come from the session, which is why `updateAsset`'s signature widens past `InsertAsset` exactly as `updateMaintenanceRequest` does for `completedDate`.

`currentValue` sits **alongside** `purchasePrice`, never replacing it: used equipment can be worth more than it cost, insurance cares about value rather than purchase price, and the purchase price is history nothing can rebuild once dropped.

Assignment prefers a real reference — `assignedResidentId` or `assignedUserId` — with `assignedToName` only as the fallback for somebody who is neither. `GET /api/assets` sends each row as an `AssetListRow` carrying `assignedUserName` — the staff holder's first and last name and nothing else about the account — because `/api/users` is admin-only and a regional administrator reading "who has what" before a departure needs the name (#164). `/assets/assigned` groups by person rather than by thing, because the situation it is for is a staff departure: collect the iPad, the guitar and the laptop before he leaves.

### The property setup checklist

What has to happen when SPO takes on a house. `shared/propertySetup.ts` owns the item list, the three states and `summarizeSetup`; `property_setup_items` holds the per-house state. Four things decided here, recorded so they are not relitigated:

- **A dedicated table, not `tasks`.** `tasks` has no property link, so a house would live as an address inside a title string, and it has no not-applicable state, so insurance on a rented house would have to be marked done when it never happened. `tasks` is recurring calendar work with an owner and a due date; this is one-time per-property state.
- **The four utilities are separate items.** One "utilities" checkbox hides which one is missing, and the missing one is exactly what gets forgotten.
- **Three states, and the third is the point.** `not_applicable` lets an RA say an item does not apply without the record claiming work that never happened.
- **A house with no rows is untracked, not incomplete.** Rows are generated on property creation and deliberately never backfilled. `summarizeSetup` reports zero rows as `tracked: false` **and zeroes the counts**, so a caller reading `open` without checking the flag still cannot put every pre-existing house in the action-item feed.

The module lives in `shared/` rather than `server/` because four surfaces read it — the property card, the badge on the property list row, the setup action item and the route that validates a write. A second copy on the client is how the screen and the server come to disagree about what a house is asked for.

The action-item feed raises **one aggregated item per house** ("Setup incomplete — 3 of 8 still to do"), never one per open check; that space belongs to maintenance triage. It carries no due date, because setting up a house has no deadline SPO has agreed and inventing one would put every new house at the top of the list.

`PUT /api/properties/:propertyId/setup/:itemKey` takes the status and note from the body and **the actor, the timestamp and the region from the server** — "who said the gas was on" is worth nothing if the client is the one saying. An unknown item key, or one belonging to the other kind of house, is a 400 rather than a new row.
