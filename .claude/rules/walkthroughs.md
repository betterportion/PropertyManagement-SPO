---
paths:
  - "**/*alkthrough*"
  - "client/src/components/walkthrough/**"
  - "client/src/pages/FlaggedItems.tsx"
  - "e2e/mobile.spec.ts"
---

# Walkthroughs

Moved verbatim from CLAUDE.md. Loads when you work with a file matching `paths`; the rest of the repo rules are in CLAUDE.md.

### The walkthrough template

One national template — `walkthrough_template_rooms` plus `walkthrough_template_items` — doing two jobs: the rooms marked `includeByDefault` seed a property's **first** walkthrough, and every room is a known room **type** whose items prefill when an RA adds one.

Three properties to preserve:

- **A walkthrough owns copies of these rows, never references.** That is what makes "editing the template never retroactively changes a property's copy" true by construction rather than by care. Do not replace the copy with a foreign key.
- **A repeat walkthrough copies that property's own last one, not the template.** Once an RA has deleted the smoke detector a house lacks and added the porch it has, that shape is what should come back next year.
- **Changing the template is `requireAdmin`, not `canManageWalkthroughs`.** `client/src/components/WalkthroughTemplateSettings.tsx` in Settings is where an admin does it — rooms, which of them a first walkthrough starts with, and the items in each. The screen says on it that editing the template never changes a walkthrough that already exists, because that is the question somebody has before they touch it. That flag is a grant over your own houses; the template is national, so an edit reaches every region. They are different things and need different grants. Reading the *rooms* is wider than reading the *items*: `GET /api/walkthrough-template/rooms` is what the add-a-room picker lists, so a household leader reaches it too — it names room types and no house.

Labels carry forward; **condition and notes never do**. A new walkthrough starts unassessed, for the same reason the `0017` backfill refused to turn "unchanged" into a condition. The seeded template content is **provisional** — SPO's own forms are still outstanding — which is why it is ordinary editable rows rather than constants.

### The walkthrough screen

`client/src/pages/WalkthroughRun.tsx` at `/walkthroughs/:id` is where a walkthrough is actually filled in. The people using it are students standing in a house holding a phone with one hand free, and everything about it follows from that:

- **One room fills the screen**, and rooms are reachable in any order through the room switcher. A house is not walked in list order, and a screen that insists on finishing one room before the next is a screen that gets abandoned halfway.
- **There is no save button and no client-side draft.** Every condition tap is its own `PATCH /api/walkthrough-items/:id`. The chips update optimistically so tapping feels like ticking a paper form; the cache is invalidated in `onSettled` behind that.
- **Two controls move a walkthrough on, and nothing else does.** "Mark submitted" (draft → submitted) is offered to whoever may write the walkthrough — a leader on their own current one, or staff — and "Mark reviewed" (submitted → reviewed) to staff who manage walkthroughs. `POST /api/walkthroughs/:id/submit` and `/review` are the only writers of `status`: the create and edit routes strip it from the body, and `routeAccess.test.ts` asserts that with a positive control. **Neither locks editing** — the date rule stays the only lock, so a leader can still fix a note after submitting and their RA can correct any year. Added in the 2026-09 RA review because the move-out damages worksheet needs a starting line; SPO's own definition of "finished" can tighten this later. No audit event.
- **A note is the half that is easy to lose,** because it is typed over seconds and the moments it can be lost are the moments nothing fires an event you would normally listen for. `ItemRow` writes one four ways — a moment after typing stops, on blur, on `visibilitychange`/`pagehide`, and on unmount. Removing any of the last three loses a note that a real RA would have typed; the reload assertion in `e2e/mobile.spec.ts` is what proves it, and it does fail when they are removed.
- **A standing note follows a room or an item from one visit to the next** (2026-09 RA review, item 6). `standingNote` on `walkthrough_rooms` and `walkthrough_items` is staff instruction to whoever does the capture — "crack by the window, photograph it each year" — so leaders read it and only staff write it: the room PATCH is staff-only already, and the item PATCH refuses a resident body carrying it (403, tested with a staff positive control). `planFromPreviousWalkthrough` copies it onto next year's copy; the template never seeds one; it stays until somebody clears it. This is what "the property's template copy" means in this codebase: the newest walkthrough is the copy, and the note rides on it.
- **On a move-out, each item shows what the last walkthrough said.** `WalkthroughRun` finds the newest earlier walkthrough of the house from the list it already has, reads its rooms and items, and `indexPreviousItems` (pure, in `client/src/lib/walkthrough.ts`) matches by folded room name and folded label — the photo comparison's rule. Collapsed by default so the screen stays one room at a time; read-only; "not on that walkthrough" when there is no match rather than a guess. Last time's photos of the room show for staff only, because the walkthrough photo list is staff-only.
- **`GET /api/walkthroughs/:id/items` returns the whole checklist in one request.** Progress across the house has to be readable before any room is opened, and a phone should not make one round trip per room to work that out.
- **Every condition carries its word** — "Good", "Damaged", "Not here". Colour is a second signal and never the only one. `client/src/lib/walkthrough.ts` owns the labels, the progress arithmetic and the manage rule so the header bar and the room switcher cannot disagree; it is pure and tested in `client/src/lib/walkthrough.test.ts`.
- **Adding a room requires a room type.** The type is what brings the standard items with it, and a room added by name alone would arrive empty with nothing to fill it in. Removing an item a house does not have is the editing this screen offers, **to staff** (a leader marks it "Not here"); adding one back, deleting a room and deleting a photo are deliberately absent until a ticket asks for them.
- **Empty is not finished.** A room with no items reports 0%, never 100% — the one lie this screen cannot afford.

`Walkthroughs.tsx` is the staff index: pick a house, see its dated inspections, start a new one. Both indexes start one through `useStartWalkthrough` rather than each holding their own copy of the mutation, so the request, the cache invalidation and the "the checklist came back empty" warning cannot drift apart. `MyWalkthroughs.tsx` is the resident one, and is a separate file rather than a role branch — staff pick out of every house they cover, a leader has exactly one, and the resident page has no house picker and no `/api/properties` call behind it (a resident account cannot read that list). It shows what `GET /api/walkthroughs` returns and never filters again, so the server's house rule and the screen cannot drift. The old room-per-property shape it used to render — along with `RoomCard.tsx` and `RoomDetailDrawer.tsx` — is gone, because two live shapes is how drift starts. The phone-width acceptance criteria live in `e2e/mobile.spec.ts`.

### The flagged-items list

`GET /api/walkthrough-flagged-items` and `client/src/pages/FlaggedItems.tsx` at `/walkthroughs/flagged` answer one stated pain point: a deep hole in a wall should surface without somebody opening every walkthrough one at a time. It lists every item recorded `poor` or `damaged` across the walkthroughs the caller can see, newest first, each row linking to `/walkthroughs/:id?room=<roomId>` so the item opens in the room it came from.

Three things to preserve:

- **Scoped by `visibleWalkthroughs`, never `filterByRegion`.** It is a second read path over walkthrough data, which is the shape of both historic authorization gaps here. A household leader has no regions and must not acquire any on this route: theirs narrows to their own house, and no house claim means an empty list.
- **One query, not N+1.** `storage.getFlaggedWalkthroughItems()` joins item → room → walkthrough and returns the flattened `FlaggedWalkthroughItem` read shape, carrying the house and room so a row reads without a follow-up request. The room's photo count is a correlated subquery, not a join, so a room with three photos still yields one row per item.
- **No summarising and no scoring.** The server sends the items; the screen groups them by house and sorts damage first. AI summaries are deferred deliberately — this list is what that idea was actually for.
- **Dismissing is the asset-snooze shape** (2026-09 RA review): `POST`/`DELETE /api/walkthrough-items/:id/dismiss`, staff with `canManageWalkthroughs` in the walkthrough's region, a required reason, who and when from the session. The three columns are omitted from `insertWalkthroughItemSchema` so the item PATCH cannot set them. A dismissed item leaves this list (`dismissedAt IS NULL` in the query) and **stays on its walkthrough saying it was dismissed**; the recorded condition is never rewritten. Clearing keeps the reason. No audit event.
- **"Send to maintenance"** — `POST /api/walkthrough-items/:id/maintenance-request`, staff with `canManageMaintenance` and walkthrough view, region-checked through the house — raises an ordinary type `request` (title from the item and room, `location` from the room name, description from the condition word and the item's notes, `submittedBy` the RA's **email**, `walkthroughItemId` the loose link back). The room's photos are **referenced, never re-uploaded**: one `maintenance_request_photos` row per existing upload, which is what makes them readable to the household through the request rule — a deliberate widening, confirmed 2026-09-25, and the confirm dialog says so. Nothing staff-only is copied because the item carries nothing staff-only. A second call answers 409 with the existing request's id. `GET /api/walkthrough-items/:id` exists so the request page can link back; it applies the walkthrough read rule.

### Photo comparison

"Compare photos across years" on the staff walkthrough index (`client/src/components/walkthrough/PhotoComparison.tsx`) is the reason the photos are worth taking: pick a room on a house with two or more walkthroughs and see that room's photos from each dated visit side by side, oldest to newest. **A view over existing data, not a table** — `comparePhotosByRoom` in `client/src/lib/walkthrough.ts` is pure and reads the routes that already exist (`/api/walkthroughs/:id/rooms` per visit, and the staff photo list), so there is no new route and nothing to keep in sync.

- **Rooms are matched across years by `foldName`** in `shared/schema.ts` — trimmed, lower-cased, whitespace collapsed — the same helper the recurring-issue rollups in `server/aggregates.ts` group a request's room by. One helper, so "the same room" cannot mean two different things on two screens. The label keeps the spelling from the oldest walkthrough.
- **One column per dated walkthrough, labelled by year, and a gap is a gap.** The column heading is the year, derived by `walkthroughYearLabel` from the walkthrough's own date (parsed the way `formatDate` parses, so the heading and the full date under it cannot name different years); nobody tags a photo with a year and nobody can type one wrong. The full date and the walkthrough type sit under the year so a move-in and a move-out in the same year still read apart; an undated walkthrough is headed "Undated". A room absent from one year is an empty column in its place saying so, never a shifted column: the columns are the years.
- **Staff only.** The walkthrough photo list and upload are staff-only, so the section sits on the staff index and the resident index is untouched (the one way a household sees a room photo is when staff send a flagged item to maintenance, which references the photo on the repair and serves it through the request rule — see "The flagged-items list"); `routeAccess.test.ts` asserts a leader holding the completion grant for that very house gets nothing from the photo list, before the query runs.
- **The copy on screen is part of the feature.** "This only answers 'has that crack grown' if somebody photographs the same wall each year." The feature is easy; the discipline is not, and no software fixes a photo taken from the other corner.

### Walkthrough conditions

`WALKTHROUGH_CONDITIONS` in `shared/schema.ts` is the vocabulary — `excellent`, `good`, `fair`, `poor`, `damaged`, and the two below. The column is plain text in Postgres, so adding a grade is a TypeScript change with no migration. Two of its values look alike and are not:

- **`not_applicable`** — the item does not exist in this house (no smoke detector in that room).
- **`not_recorded`** — the item exists and nobody assessed it. Every item the `0017` backfill created is this.

The reason matters. The old `walkthrough_photos.condition` recorded *change* (`same_as_last_walkthrough` / `additional_damage`), not *state* — and "nothing changed" says nothing about whether a room is good or poor. Mapping it onto a condition scale would invent an assessment nobody made, and the flagged-items view would then under-report the damage it exists to surface. So the backfill mapped `additional_damage` → `damaged` (a real claim about state) and everything else → `not_recorded`, and left `walkthrough_photos.condition` untouched. **Do not reinterpret that column.**
