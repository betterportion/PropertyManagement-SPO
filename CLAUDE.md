# CLAUDE.md

Standing context for Claude Code working in this repository. Read this before making changes.

---

## What this project is

The **SPO Admin Portal** — a property management system for Saint Paul's Outreach, Inc. Staff manage properties, maintenance requests, walkthrough inspections, assets, vendor contacts and invoices. Residents submit maintenance requests and track their own.

It is a single Express server that serves both the REST API and the React frontend on one port.

**The people using this are not developers.** Prefer plain language in anything user-facing, and explain the consequences of a change before making it.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server with hot reload. Loads `.env` via Node's `--env-file-if-exists`, so no `dotenv` package and no sourcing by hand; a clone without a `.env` still starts. **Development only** — `npm run start` reads real environment variables, and a variable already in the environment always beats the file |
| `npm run build` | Vite builds the client, esbuild bundles the server into `dist/` |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint. **Must stay at zero errors**; warnings are allowed |
| `npm run check` | TypeScript check. **Must stay at zero errors** |
| `npm test` | Vitest. Needs no database, no bucket, no secrets. `auditRetention.integration.test.ts` is the one test that uses a real database, and skips unless `TEST_DATABASE_URL` or `DATABASE_URL` is set |
| `npm run test:e2e` | Playwright, in a real browser. Unlike `npm test` these need a database and a browser: `npx playwright install chromium` once, then `npm run db:migrate && npm run db:seed` against a throwaway Postgres |
| `npm run db:generate` | Write a migration from a `shared/schema.ts` change |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:baseline -- <tag>` | Record existing tables as already migrated, through `<tag>` (a database that predates `migrations/`). Bare, it records only `0000` |
| `npm run db:seed` | Demo data for an **empty** database, written through the real storage layer. Refuses to run if any properties exist. Optional `SEED_ADMIN_EMAIL` pre-creates an admin account that re-links on first sign-in |
| `npm run db:push` | Push the schema directly, without a migration. Development only |

**The gate is `npm run lint && npm run check && npm test && npm run build`.** Run all four before finishing. `.github/workflows/ci.yml` runs the same four on every push and pull request. `.github/workflows/e2e.yml` is a second workflow, running `npm run test:e2e` against a throwaway Postgres and a headless Chromium. It is deliberately outside the gate: it needs a database and a browser, which is exactly what the four checks above are built not to need.

The linter catches mistakes, not style — formatting rules are off on purpose, so nothing here should ever produce a large reformatting diff. The 8 remaining warnings are React Compiler advice; one is in the generated `components/ui/` files, the rest in our own components and pages. Clearing them is issue #37.

The tests are weighted towards authorization. If you change anything in `server/authz.ts`, in a route's guards, or in who may read an upload, add a test for it in `server/__tests__/authz.test.ts` (the rule on its own) or `server/__tests__/routeAccess.test.ts` (the rule over real HTTP, through the real login guard).

Three conventions in that suite, all of which exist because of a real miss:
- **Never re-implement the code under test inside the test.** `region.test.ts` used to hold its own copy of the region rules; it passed while the real rule drifted.
- **Assert the refused work never happened.** A 403 alone does not prove the check ran before the write — `expect(putUpload).not.toHaveBeenCalled()` does.
- **Instrument the stage whose ordering matters, and add a positive control.** Proving an upload is refused *before the body is read* means spying on the multipart parser itself, not on what was stored. Always pair a "was not called" assertion with one accepted request proving the spy fires, or a typo makes every negative vacuous.

---

## Architecture

### Backend (`server/`)

| File | Responsibility |
|---|---|
| `index.ts` | Entry point. Validates configuration before anything else loads, sets `trust proxy`, security headers, JSON body parsing, API request logging, graceful shutdown, listens on `PORT`. |
| `config.ts` | Every environment variable the server cannot run without, checked once at boot and reported together. Also owns the OIDC provider settings, the email settings and `APP_URL` — the portal's public address, optional, read by `readAppUrlFromEnv` for the links in comment email and never a boot failure when unset. |
| `routes.ts` | Every API endpoint. One large file, ~133 handlers. |
| `auth.ts` | OpenID Connect login and the session store. Reads its provider settings from `config.ts`. |
| `authz.ts` | Who may do what: `requireActiveUser`, `requirePermission`, the region helpers, upload and maintenance ownership. |
| `audit.ts` | Records the actions somebody may have to account for later. See "Audit log" below. |
| `security.ts` | Helmet headers including the production CSP, plus the upload rate limit. |
| `residentImport.ts` | The roster CSV rules: parsing (header aliases, quoted fields, the two date spellings a spreadsheet exports), per-row validation, and duplicate classification keyed on email **within a property**. Pure — text and existing emails in, findings out — so the file is never stored and the routes only read and write. |
| `walkthroughTemplate.ts` | What a new walkthrough starts out containing. `planFromTemplate` for a property's first, `planFromPreviousWalkthrough` for every one after, `templateRoomItems` for the add-a-room prefill. Pure — rooms and items in, planned rooms out. |
| `maintenanceStatus.ts` | When a maintenance request closed. `closedDateChange` is a pure function over the previous status, the next status and `now`, returning the patch to `completedDate`. Closing stamps it, reopening clears it, and an edit that does not change the status writes nothing. |
| `comments.ts` | The body rule for a request thread: `commentBodyFromClient` tidies whitespace (paragraphs kept) and refuses anything over `MAX_COMMENT_LENGTH` (4,000) as a 400. One function, one call site, so the cap cannot drift per route. |
| `actionItems.ts` | What the dashboard says needs attention, from schedules coming due, unpaid rent and deposits still held, plus the manual `tasks`. `buildActionItems` is pure — records plus `now` — so it tests without a database or a clock. |
| `regionSummary.ts` | The per-region rollup a national admin reads. Also pure. "Health" is operational load only; unpaid rent is reported beside it, never inside it. |
| `aggregates.ts` | Rollups over maintenance history — recurring issues and contractor callbacks. Computed over the caller's own visible requests, so a rollup can never widen what somebody can see. |
| `schedules.ts` | Preventive and safety schedules, and the daily job that turns a due one into an ordinary maintenance request. Idempotent via `lastGeneratedForDue`, so an overdue task does not spawn a request a day. |
| `seasonalTasks.ts` | Calendar-driven reminders (walkthrough season, summer utilities, lease-end utilities) generated as ordinary `tasks`. Idempotent via each task's unique `sourceKey`. |
| `migrateRegions.ts` | Two idempotent startup fix-ups: legacy region spellings in `allowedRegions` to their canonical form, and a billing-region backfill. Runs on every boot; already-correct rows are untouched. |
| `errors.ts` | Error classification, `sendError`, and the final error middleware. |
| `health.ts` | `GET /api/health` for the hosting platform. Unauthenticated, so it reveals nothing. |
| `storage.ts` | Every database query, behind a single `IStorage` interface exported as `storage`. |
| `db.ts` | Drizzle over the standard `pg` pool, plus `pingDatabase` and `closeDatabase`. Throws at import time if `DATABASE_URL` is missing. |
| `objectStorage/` | File storage behind a `FileStore` interface: `local.ts` for development, `supabase.ts` for production. The only code that talks to a bucket. |
| `uploadLimits.ts` | Per-file size limits and the in-flight memory ceiling. |
| `notifications.ts` | The message builders — pure, a record in and a message out. Every builder returns `null` when there is nothing to send, so a caller never has to tell "no message" from a failed one. |
| `commentRecipients.ts` | Who a comment is emailed to. One pure function over the request, the comment and the candidate accounts, deciding through the real `canReadComment` rule; it decides nothing about delivery. |
| `email.ts` | The only code that talks to the email provider (Resend). `sendEmail` never throws — unconfigured and failed sends return a result — and email is off until `RESEND_API_KEY` + `EMAIL_FROM` are both set. |
| `logger.ts` | `log()`. Separate from `vite.ts` so the production bundle never imports Vite. |
| `static.ts` | Serves the built client in production. |
| `vite.ts` | Dev middleware only. Imported dynamically, and only in development — see the note in the file. |

**Three daily jobs run inside the web process**, each started at boot and run once immediately: audit-log retention (`audit.ts`), maintenance-schedule generation (`schedules.ts`), and seasonal reminder tasks (`seasonalTasks.ts`). There is no separate worker and no cron. All three are idempotent, because a restart re-runs them — if you add a fourth, it must be too, and it must not be able to fail the boot.

**Route handlers never touch the database directly.** They go through `storage`. Keep it that way — it is the only reason the data layer is testable and swappable.

### Frontend (`client/src/`)

- **Routing** is Wouter, and it is *role-based*: `App.tsx` renders a completely different `<Switch>` depending on whether the user is an admin/regional administrator or a resident. There is no route guard — unauthenticated users only ever get the `Landing` page. Two paths are carried by both switches: `/walkthroughs/:id`, which the resident switch registers — along with its own `/walkthroughs` index (`MyWalkthroughs.tsx`) — only for an account holding `canCompleteWalkthroughs`; and `/maintenance/:id` (`RequestDetail.tsx`), the page for one request, which every resident account gets because `GET /api/maintenance-requests/:id` already applies the resident read rule. Both registrations are convenience, not security — the server decides which walkthrough or request anybody may open, and the request page shows the shared `AccessDeniedState` off its 403 rather than deciding anything itself.
- **Server state** is TanStack Query, configured in `lib/queryClient.ts` with `staleTime: Infinity`, no refetch on focus, and no retries. This means **you must invalidate queries manually after a mutation** or the UI will show stale data.
- The default query function derives the URL by joining the query key with `/`, so `queryKey: ["/api/assets"]` fetches `/api/assets`.
- `apiRequest(method, url, data)` is the mutation helper. It throws on non-2xx.
- **UI** is shadcn/ui in `components/ui/` (22 generated primitives; the unused ones were removed — add any you need back from shadcn rather than hand-writing them). Treat those as generated — build new things in `components/` instead of editing them.
- **Do not put an early return between hook calls.** A guard like `if (!isAdmin) return <AccessDenied />` placed above a `useQuery` changes the hook count once the auth query resolves, and React throws. Compute the guard from hooks, then return below all of them. This crashed the Settings page once already.
- Path aliases: `@/` → `client/src/`, `@shared/` → `shared/`, `@assets/` → `attached_assets/`.

---

## Data model

Defined in `shared/schema.ts` using Drizzle, with Zod insert schemas generated by `drizzle-zod`. This file is the single source of truth for both server and client types. Thirty-three tables:

| Table | Purpose | Key relationships |
|---|---|---|
| `sessions` | Express session store | Managed by `connect-pg-simple`, not by app code |
| `users` | Accounts. `role` is `admin` / `regional_administrator` / `resident`, plus `isActive`; resident accounts carry a `propertyId` linking them to their house — the house whose maintenance requests that login may read *and* whose walkthroughs it may write. `commentEmailsEnabled` (default true) is the comment email off switch: a preference, not a permission, so it lives here and is not audited | `id` is the identity provider's subject claim; `email` is unique |
| `user_permissions` | One row per user, eighteen boolean flags (including the two finance flags, `canCompleteWalkthroughs` which is the resident-tier walkthrough grant, `canManagePropertySetup` which gates the per-property setup checklist, and `canViewResourceHub` which gates the resident-tier resource hub) plus `allowedRegions` (text array) | `userId` unique, cascades on user delete |
| `maintenance_requests` | The core workflow. `type` is `request` (a repair) / `project` / `capex`, not null, default `request` — **a resident account reads and files type `request` and nothing else**, see "Request types". Priority includes a `wishlist` level, and wishlist is a priority, never a type; status is pending/in_progress/completed/cancelled. `completedDate` is the **close** date, set for `cancelled` as well as `completed`. `photoUrl` is the single photo filed *with* the request; anything added later lives in `maintenance_request_photos` | `submittedBy` stores an **email**, see gotchas |
| `maintenance_request_photos` | Photos added to a request after it was filed, each with its uploader and date | `requestId` → `maintenance_requests`, cascades |
| `maintenance_request_comments` | The thread on a request: body, `isInternal` (default **true**), the author kept three ways (id set-null, email, name) so a comment outlives the account, and the relay pair — `relaySource` is what renders, `relayContactId` the optional link. Posted once, never edited; deletable | `requestId` → `maintenance_requests` cascades; `authorUserId` → `users` set-null; `relayContactId` → `maintenance_contacts` set-null; indexed on `requestId` |
| `maintenance_schedules` | Recurring upkeep on a house — `category` is `safety` or `preventive`, `intervalMonths` sets the cadence. A daily job turns a due schedule into an ordinary maintenance request, so there is no second queue to watch | `propertyId` → `properties` cascades; optional `assetId` → `assets` set-null; `region`/`buildingAddress` denormalised for region scoping |
| `walkthrough_template_rooms` | The national template: the standard rooms, and the catalogue of known room types. `includeByDefault` decides which ones a property's *first* walkthrough starts with | referenced by nothing — a walkthrough owns **copies**, never references |
| `walkthrough_template_items` | The standard items in each template room. Adding a bathroom to a walkthrough copies these | `templateRoomId` → `walkthrough_template_rooms`, cascades |
| `walkthroughs` | A dated inspection event for one house: date, type (move_in/move_out/annual/legacy), status (draft/submitted/reviewed), who performed it. This is what makes a year-over-year comparison possible — rooms used to hang straight off a property | `propertyId` → `properties` cascades; `region`/`buildingAddress` denormalised for region scoping |
| `walkthrough_items` | One line of a room's checklist — the sink, the smoke detector. **Condition and notes live here**, not on a photo, so an item nobody photographed can still be assessed | `roomId` → `walkthrough_rooms`, cascades |
| `walkthrough_rooms` | The rooms of one walkthrough, ordered by `displayOrder`. `requiredQuestions` is legacy — the backfill turned each entry into a `walkthrough_items` row and kept the array | `walkthroughId` → `walkthroughs` cascades; `propertyId` → `properties` (loose, no FK) |
| `walkthrough_photos` | Photos attached to a room. `condition` is **legacy and nullable**: that vocabulary records *change* since the last visit, not *state*, so it is never read as a condition | `roomId` → `walkthrough_rooms`, cascades |
| `assets` | Fixed and movable assets. Beyond age, serial, purchase price and tag: an `acquisitionDate` (nullable — no date means *unrated*, never a guess), a per-asset `expectedLifespanYears` override, an explicit `replacementDueDate`, the four snooze columns, `currentValue`+`valuedOn` **alongside** `purchasePrice`, the three assignment columns plus `expectedReturnDate`, and `acquisitionNotes`+`supplierContactId` | `propertyId` → `properties` (loose, no FK); `snoozedByUserId`/`assignedUserId` → `users` set-null; `assignedResidentId` → `residents` set-null; `supplierContactId` → `maintenance_contacts` set-null |
| `asset_photos` | Photos attached to an asset | `assetId` → `assets`, cascades |
| `maintenance_contacts` | Vendors | Referenced by invoices and request links |
| `contact_notes` | Dated notes on a vendor: what an RA learned working with them. Append-and-delete, never editable — a dated note somebody revised later is no longer the record of what they thought at the time. **Deliberately no rating column** | `contactId` → `maintenance_contacts` cascades; `authorUserId` → `users` set-null, with `authorEmail` kept alongside so a note still says who wrote it after the account is gone |
| `invoices` | Invoice records with amount, status, due/paid dates | `contactId` and `maintenanceRequestId`, both set-null on delete |
| `billing_records` | Vendor billing with three document URLs (contract/invoice, COI, W-9) | `contactId` is a plain column, **not** a foreign key |
| `properties` | Property records. `address` is computed from the four address parts and is unique; `chapter` (free text) records which SPO chapter uses the property; `ownership` (`owned`/`rented`) carries the three lease dates and a `renewalDecision`, plus `leaseDocumentUrl` and `maintenancePortalUrl` (links, never documents or logins) and one of two contact links. `photoUrl` is the front-of-house photo and `notes` is free text | Referenced loosely by rooms and assets; referenced with a real FK by residents and schedules |
| `property_setup_items` | One row per checklist item per house: three states (open/done/not applicable), who set it, when, and an optional note. The item list itself is fixed in code (`shared/propertySetup.ts`), so the row stores an `itemKey` rather than a label | `propertyId` → `properties` cascades; `setByUserId` → `users` set-null; unique on (property, item) |
| `residents` | People living in a house: name, email, optional phone and notes, move-in/move-out dates, `isActive`, and `depositAmountOverride` (null means the house's figure applies). `/residents/:id` collects a person's paperwork, deposit and assigned equipment in one place. Deliberately **not** `users` — a resident on the roster need not have a login | `propertyId` → `properties`, cascades; `region`/`buildingAddress` denormalised |
| `rent_payments` | One row per resident per `YYYY-MM` period: amount, status (`unpaid`/`paid`/`waived`/`failed`), paid date, free-text `reference`. `failed` is a bounced payment and still counts as outstanding. The `reference` is a note like "check #1234" or a processor ID — **never** an account or card number | `residentId` → `residents` cascades; unique on (resident, period) |
| `security_deposits` | One deposit per resident: amount held, status (`held`/`statement_sent`/`returned`/`partially_returned`/`withheld`), amount returned, `statementProvidedOn`, and `closeoutReference` — the QuickBooks or Ramp reference for the transaction, **a reference only**. `deductionsNotes` is now legacy free text kept as history | `residentId` → `residents`, cascades, unique |
| `deposit_deductions` | One line item against one resident's deposit: description, amount, charge date, who recorded it, and optional loose links to the walkthrough item or maintenance request it came from. A split charge is stored as individual per-person rows sharing a `splitGroupId` | `residentId` → `residents` cascades; `recordedByUserId` → `users` set-null, with `recordedByEmail` kept alongside |
| `tasks` | Staff to-dos: title, category, open/done, due date, optional region and assignee. Reminders generated on a calendar carry a unique `sourceKey` so the daily job never duplicates one; hand-created tasks leave it null | `assignedToUserId`, `createdBy` and `completedBy` → `users`, all set-null so a task outlives its author |
| `request_contacts` | Join table linking contacts to maintenance requests | Both sides cascade |
| `uploads` | One row per stored file: random storage key, original name, content type, size, uploader | `uploadedBy` is a user ID; no FK, so the row outlives the account |
| `resource_links` | What SPO publishes to household leaders and stewards: title, URL, description, category. A null `region` means national; a region name limits it to that region's houses. **Links, never documents** | referenced by nothing |
| `resident_documents` | Per resident, per document: `signedOn` (null means not signed), notes, who recorded it. The list of documents is fixed in `shared/residentDocuments.ts`, so the row stores a `documentKey` | `residentId` → `residents` cascades; `recordedByUserId` → `users` set-null; unique on (resident, document) |
| `property_budgets` | One startup-budget figure per house per year, plus notes. An **operating** figure, not deposit or rent data | `propertyId` → `properties` cascades; unique on (property, year) |
| `property_facts` | The house facts (ADR-0002): what a household needs to know about their house. Door, gate and alarm codes, each with a server-set `...UpdatedAt` that moves only when the value does; then security notes, parking rules, surface care, things not to do, rubbish day (free text) and other notes. Written by staff on the property page, read by the household on the resource hub. **Separate from `properties.notes`**, which is staff-only and never merged with this | `propertyId` → `properties` cascades, unique — one row per house |
| `audit_log` | Append-only record of access, money and document events | Actor stored as plain columns, deliberately no FK |

### Rules for schema changes

1. Edit `shared/schema.ts`.
2. Run `npm run db:generate`, then rename the generated file in `migrations/` to something descriptive and update its `tag` in `migrations/meta/_journal.json` to match.
3. Run `npm run db:migrate` to apply it locally.
4. Update the matching `storage.ts` methods and the `IStorage` interface together.
5. Run the full gate: `npm run lint && npm run check && npm test && npm run build`.

`npm run db:push` still exists and is fine for throwaway experimentation, but **anything that has to reach production must be a committed migration** — production is applied by running `npm run db:migrate`, and a schema pushed straight to a development database leaves no record of how to reproduce it.

---

## Authorization model

This is the part that is easiest to get wrong. Three layers are *intended* to apply to every data route:

1. **Authenticated** — `isAuthenticated` middleware on the route.
2. **Active** — `currentUser.isActive` must be true.
3. **Permitted** — either the user is an admin, or their `user_permissions` row grants the relevant flag.

**Do not assume a route is protected because its neighbours are — check.** Every data route currently applies all three layers, and the two historic gaps (the linked-contacts endpoint, and maintenance routes missing the admin bypass) are closed and covered by tests. `server/__tests__/routeAccess.test.ts` is what keeps them closed; a new route with a missing guard will not fail any existing test unless you add one for it.

### The admin bypass pattern

Admins frequently have no `user_permissions` row at all. Any check that only reads the permissions row will lock admins out — this has caused real "Internal Server Error" bugs in the past. **Always compute `isAdmin` and bypass with it.** The helpers in `server/authz.ts` do this for you:

```ts
app.get('/api/things', isAuthenticated, async (req: any, res) => {
  try {
    const ctx = await requireActiveUser(req, res);
    if (!ctx) return;
    if (!requireStaff(res, ctx)) return;
    if (!requirePermission(res, ctx, "canViewThings")) return;

    const things = await storage.getAllThings();
    res.json(filterByRegion(ctx, things));
  } catch (error) {
    sendError(res, error, "Failed to fetch things");
  }
});
```

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
- **Nothing here moves a walkthrough out of `draft`.** The status vocabulary exists on the record and the badge reports it, but no control changes it — the plan has not asked for that step yet, and inventing a submit action would decide on SPO's behalf what "finished" means and who may say so.
- **A note is the half that is easy to lose,** because it is typed over seconds and the moments it can be lost are the moments nothing fires an event you would normally listen for. `ItemRow` writes one four ways — a moment after typing stops, on blur, on `visibilitychange`/`pagehide`, and on unmount. Removing any of the last three loses a note that a real RA would have typed; the reload assertion in `e2e/mobile.spec.ts` is what proves it, and it does fail when they are removed.
- **`GET /api/walkthroughs/:id/items` returns the whole checklist in one request.** Progress across the house has to be readable before any room is opened, and a phone should not make one round trip per room to work that out.
- **Every condition carries its word** — "Good", "Damaged", "Not here". Colour is a second signal and never the only one. `client/src/lib/walkthrough.ts` owns the labels, the progress arithmetic and the manage rule so the header bar and the room switcher cannot disagree; it is pure and tested in `client/src/lib/walkthrough.test.ts`.
- **Adding a room requires a room type.** The type is what brings the standard items with it, and a room added by name alone would arrive empty with nothing to fill it in. Removing an item a house does not have is the editing this screen offers; adding one back, deleting a room and deleting a photo are deliberately absent until a ticket asks for them.
- **Empty is not finished.** A room with no items reports 0%, never 100% — the one lie this screen cannot afford.

`Walkthroughs.tsx` is the staff index: pick a house, see its dated inspections, start a new one. Both indexes start one through `useStartWalkthrough` rather than each holding their own copy of the mutation, so the request, the cache invalidation and the "the checklist came back empty" warning cannot drift apart. `MyWalkthroughs.tsx` is the resident one, and is a separate file rather than a role branch — staff pick out of every house they cover, a leader has exactly one, and the resident page has no house picker and no `/api/properties` call behind it (a resident account cannot read that list). It shows what `GET /api/walkthroughs` returns and never filters again, so the server's house rule and the screen cannot drift. The old room-per-property shape it used to render — along with `RoomCard.tsx` and `RoomDetailDrawer.tsx` — is gone, because two live shapes is how drift starts. The phone-width acceptance criteria live in `e2e/mobile.spec.ts`.

### The flagged-items list

`GET /api/walkthrough-flagged-items` and `client/src/pages/FlaggedItems.tsx` at `/walkthroughs/flagged` answer one stated pain point: a deep hole in a wall should surface without somebody opening every walkthrough one at a time. It lists every item recorded `poor` or `damaged` across the walkthroughs the caller can see, newest first, each row linking to `/walkthroughs/:id?room=<roomId>` so the item opens in the room it came from.

Three things to preserve:

- **Scoped by `visibleWalkthroughs`, never `filterByRegion`.** It is a second read path over walkthrough data, which is the shape of both historic authorization gaps here. A household leader has no regions and must not acquire any on this route: theirs narrows to their own house, and no house claim means an empty list.
- **One query, not N+1.** `storage.getFlaggedWalkthroughItems()` joins item → room → walkthrough and returns the flattened `FlaggedWalkthroughItem` read shape, carrying the house and room so a row reads without a follow-up request. The room's photo count is a correlated subquery, not a join, so a room with three photos still yields one row per item.
- **No summarising and no scoring.** The server sends the items; the screen groups them by house and sorts damage first. AI summaries are deferred deliberately — this list is what that idea was actually for.

### Walkthrough conditions

`WALKTHROUGH_CONDITIONS` in `shared/schema.ts` is the vocabulary. Two of its values look alike and are not:

- **`not_applicable`** — the item does not exist in this house (no smoke detector in that room).
- **`not_recorded`** — the item exists and nobody assessed it. Every item the `0017` backfill created is this.

The reason matters. The old `walkthrough_photos.condition` recorded *change* (`same_as_last_walkthrough` / `additional_damage`), not *state* — and "nothing changed" says nothing about whether a room is good or poor. Mapping it onto a condition scale would invent an assessment nobody made, and the flagged-items view would then under-report the damage it exists to surface. So the backfill mapped `additional_damage` → `damaged` (a real claim about state) and everything else → `not_recorded`, and left `walkthrough_photos.condition` untouched. **Do not reinterpret that column.**

### Region scoping

Non-admins only see records in their `allowedRegions`.

- `filterByRegion(ctx, items)` — filters a list. It takes the whole context, not a region list, and applies the admin bypass itself, so callers pass `ctx` straight through rather than testing `ctx.isAdmin` first. **Returns an empty array when the user's `allowedRegions` is empty or null**, which is deliberate: no regions means no access, not all access. The literal string `"all"` in the list means every region.
- `filterByRelatedRegion(ctx, items, regionOf)` — the same rule for records whose region lives on a related record, such as an asset photo inheriting its asset's region.
- `requireRegion(res, ctx, region)` — single-record check before create or delete.
- `requireRegionMove(res, ctx, existingRegion, incomingRegion)` — on update, checks *both*, so a record cannot be moved into a region the user cannot reach.

Region names are compared in one canonical form, so a stored legacy `west-central` still matches `West Central`.

### Where a maintenance request is, and who fixed it

`CLOSED_MAINTENANCE_STATUSES` and `isClosedMaintenanceStatus` live in `shared/schema.ts`, beside the column they describe, because three places decide what "closed" means: the close-date stamping in `maintenanceStatus.ts`, the resident visibility window in `authz.ts`, and the range filter on the maintenance list. Three copies of that list would mean adding a fifth status silently widens or narrows what a household leader can read.

**The location field suggests, it does not restrict.** `GET /api/maintenance-locations` returns the room names from that house's own walkthroughs, offered through a `<datalist>` so free text still works for anywhere the checklist has no word for. Free text alone will not group "living room" and "Living Rm", and grouping is the point — it is what lets somebody notice that these blinds have broken every year since SPO started renting this house. The staff create dialog uses the same vocabulary: the property picker writes `buildingAddress` and the room goes in `location`. It previously wrote the address into `location`, which meant that column held a room for a resident-filed request and an address for a staff-filed one — and no amount of grouping works across two meanings of one column. **A resident's house is taken from their account and the `propertyId` query parameter is ignored outright**: honouring it would turn this into a way to enumerate another house's rooms, which is a second read path into walkthrough data and the exact shape of both historic authorization gaps here.

**Contractor history is mostly a read over data that already existed.** `request_contacts` has linked vendors to requests all along and `invoices` already carry a `contactId`; there was nowhere to read it from. `/contacts/:id` collects the jobs, the invoices, the billing record and the notes. Two rules:

- **The linked requests are filtered by the *request's* region, not the contact's.** A vendor can work across regions, and reading their page must not become a way to see requests the caller could not otherwise open.
- **There is no rating field, and adding one would be a regression.** A star score on a vendor SPO may have to keep using invites arguments about the number and tells an incoming RA far less than a paragraph does. There is also no separate "project" entity: a project here always traces back to a request, and a second entity to keep in sync would decay.

### The resource hub

`/resources` is the one page a household leader or steward needs, and it is the widest resident-facing surface in the portal. The framing shapes the layout: for many students this is one of their few interactions with SPO as an organisation, so their own house comes first and the general material below it.

- **A resident reaches it on `canViewResourceHub` and nothing else.** It is its own flag rather than a reading of `canCompleteWalkthroughs`, for exactly the reason that flag is separate from `canManageWalkthroughs`: filling in a walkthrough and being given the hub are two grants, and honouring one for the other means a later change to either silently moves the other. It defaults to false for every role, so nobody has it until an admin grants it — the same shape as walkthrough completion. Staff reach it under the property permission, so they can see what their households are being told.
- **A resident's scope is their HOUSE's region**, resolved from their property by `readableRegions` — never from whatever their permissions row happens to say. A resident-tier account has no region path anywhere else and acquires none here. There is a test asserting a leader whose permissions row names another region still cannot see that region's links.
- **A resident with no house claim gets the national links only**, not nothing. This is the one place the fail-closed default is "the widest thing that is safe for everybody" rather than "empty" — a leader with a broken property link should still find the fire extinguisher guidance.
- **Managing the links is `requireAdmin`, not a regional flag** — exactly like the walkthrough template, and for the same reason: a national link reaches every region, so editing one is not a grant over your own houses.
- **Links, never documents.** Most content lives on Drive; duplicating a deep-clean checklist into the portal means two copies that disagree within a term. The URL is scheme-checked by `httpUrlFromClient` because every viewer of this page clicks these, residents included.

`GET /api/my-property` is a deliberately narrow projection of one property for the hub — **named fields, not the row** — so a column added to `properties` later cannot silently start reaching a resident. It carries the same flag.

**A startup budget is an operating figure**, not deposit or rent data — what the house has to furnish and settle itself. That distinction is what lets a leader see their own on the hub without the "residents never see financial data" rule being bent, and the budget list is narrowed for a resident **by property, not by region**, so being in the same region as another house grants nothing.

**Liability paperwork is recorded, not signed.** `shared/residentDocuments.ts` holds the fixed list; an RA records that a document was signed and when. **This is not e-signature** — that is a vendor integration and a separate decision, and a checkbox pretending to be one would be worse than nothing, because it would read as evidence in a dispute and be nothing of the sort. The copy on screen says so. Only a **date** counts as signed: a row existing means somebody looked, which is why clearing the date is always available.

### Request threads

Every request carries a thread — `maintenance_request_comments`, read on the request page at `/maintenance/:id` — so what the handyman said on the phone, who is coming when and what it cost stop evaporating out of text messages. Four rules, and where each lives:

- **Thread access is request access, with one tier gate on top.** `canReadComment` and `canPostComment` in `server/authz.ts` are `canReadMaintenanceRequest(...)` AND (staff OR the comment is shared). Every comment route decides through them and nothing else, so ownership, the house match, region scoping and the 120-day closed window all reach a thread with nothing implemented twice. **Filtering is server-side**: the list route drops internal comments for a resident before responding. A client-side filter over a full fetch would ship "he quoted $4,200" to the browser of somebody who must not have it.
- **Internal by default.** `isInternal` defaults to true in the schema and the composer opens on Internal every time — the mistake this prevents is a cost pasted into an ordinary repair's thread with Shared left on from last time. The composer's visibility control is two buttons with `aria-pressed`, never a checkbox, because the current setting has to be readable at a glance. Visibility is fixed at posting: no route changes it, and no route edits a body. Delete is the author or an admin (`canDeleteComment`), after the read rule — a resident cannot act on an internal comment's id even if the author column were theirs.
- **A relayed comment says so.** `relaySource` ("Dave (handyman)") is what renders, as "Sarah, relaying Dave (handyman)"; `relayContactId` is the optional link to the contractor's record. Costs nothing now and keeps the history honest two years later.
- **No audit event.** A comment is neither access, money nor a document, and logging every one would bury the events the log exists for — the same reasoning that keeps photo downloads out. `routeAccess.test.ts` asserts the audit write is not called on a post.

For now the create route also carries `requireStaff`: a household reads its shared half and posts nothing until resident posting (#120) removes that one line and adds its own tests. The author — id, email and name — comes from the session and never from the body. Every posted comment is emailed to the people who can see it; that rule is under "Outbound email" below, and a resident-posted comment will flow through it without change.

### Request types

Every request is one of three types — `request`, `project`, `capex` — shown as **Repair / Project / Capital project** (`REQUEST_TYPE` in `client/src/lib/requestLabels.ts` is the one label map; `MAINTENANCE_REQUEST_TYPES` in `shared/schema.ts` is the vocabulary). ADR-0001 (`docs/adr/0001-projects-are-a-request-type.md`) records why projects and capital projects are a type on this table rather than a table of their own: they get status, rooms, contractor links and threads for free, and a house gets one list instead of three. **Wishlist stays a priority, never a type** — a wishlist capital project is a coherent thing.

The cost of that decision is the whole reason the type rule exists: bid amounts and contract terms now sit in a table a household leader can already read. So **a resident account reads type `request` and nothing else**, and the two halves — the column and the rule — shipped in one change and must never be split:

- **The rule is the first line of the resident branch of `canReadMaintenanceRequest`**, before the own-submission check and before the house match, because either of those is exactly what would otherwise let a project on the resident's own house through. It is derived from the type column and nothing else — never from status, priority or the request's text — and anything that is not the literal `request` is refused, so a missing type fails closed rather than reading as a repair. Every real call site passes a storage row, which always carries the column. Because every resident read path (the list, the detail route, contacts, photos, the upload route and the thread) goes through that one function, none of them needs a second implementation and none of them can drift.
- **The resident create route forces `type: "request"`** whatever the body says, the same way it forces the region, the house and the submitter. Residents cannot PATCH a request at all (the route is `requireStaff`), which is how "a resident can never set the type on an update" holds — it is asserted as the existing refusal in `routeAccess.test.ts`, with the write never reaching storage, rather than as a branch that would only exist to be tested.
- **Staff with `canManageMaintenance` set the type** in the create and edit dialogs, and the copy beside the control says plainly that projects and capital projects are not shown to residents, because changing a type away from Repair takes the request off the household's screen and somebody doing that should know before they save. Every request card and the request page carry a type badge with its word; the maintenance list has a type filter beside the others, defaulting to all types.

### House facts and access codes

`property_facts` is what a household needs to know on day one: the door, gate and alarm codes, security and camera notes, parking and towing rules, surfaces needing care, things not to do, rubbish day, and whatever else. `docs/adr/0002-access-codes-stored-in-the-portal.md` records why the portal holds a door code at all when it refuses to hold credentials: the alternative is a code living in a text thread through three generations of household leaders because nobody remembers when it was set. Four rules make it safe enough, and each has a test:

- **A separate table, never merged with staff notes.** `properties.notes` is what staff write for each other; the facts are what they write for the household. Two tables is what makes "a staff-only remark never reaches a resident" true by construction. On the property page the two are different cards, and the household's card says on it who reads it. `shared/houseFacts.ts` holds the field vocabulary so the audit summary, the staff card and the hub name a field the same way.
- **The household reads it through the named projection and nothing else.** `GET /api/my-property` gained a `facts` object of named fields (never the row) plus the rental company's name, company and phone and the `maintenancePortalUrl`, both read from the property's own columns rather than retyped. Same gate as the rest of the hub: resident-tier, `canViewResourceHub`, own house only, null with no house link. The staff routes — `GET`/`PUT /api/properties/:id/facts`, under the property permissions with `requireRegion` — refuse a resident outright, even for their own house, so no resident acquires a region path here.
- **A code change is audited without the value.** `PUT` records one `property.access_code_changed` event per code whose value changed — "Door code for Cleveland House (1 Main St) changed", with the column name in the details — and the test asserts the value appears nowhere in the recorded row. Changing the parking rules or the rubbish day records nothing. Routine two-year retention: this is not access history.
- **Last-changed moves on a value change only.** `planHouseFacts` in `server/houseFacts.ts` is a pure function — the stored row, the incoming content and `now` in; the row to write and the codes that changed out. Setting a code for the first time, changing it and clearing it all count; re-saving the same code leaves its date alone. The body carries no dates, so a client cannot make a stale code look freshly rotated. The date is the point of the feature: the realistic failure is not a breach but a code nobody has rotated, and the household seeing "Last changed" three leaders ago is what prompts the question.

### Rollups over maintenance history

`server/aggregates.ts` answers "what keeps happening?", where the Phase 5 filters answer "what happened?". Both are computed over the caller's **own visible requests**, so a rollup can never widen what somebody can see — a link to a request they cannot read contributes nothing, not even a count.

- **A recurring issue is one house, one room, one category, more than once.** The house is part of the key and always will be: "these blinds have broken every year" is a claim about *these* blinds. Room names are folded for case and whitespace as a backstop for what was typed before the location field started suggesting from the walkthrough vocabulary.
- **A callback is a repeat visit to the same problem**, which is a different claim from "did a lot of jobs" and the one that belongs in a conversation about whether to keep using somebody.

### Outbound email

`server/notifications.ts` holds the message builders — pure, a record in and a message out — so the wording is testable without a mail provider and the content rule holds in one place: **names, dates, amounts and descriptions yes; a credential or a banking identifier never.** That is the audit log's rule, applied to email for the same reason: both leave the system and neither can be recalled.

Every builder returns `null` (or an empty list) when there is nothing to send, so a caller never has to tell "no message" from "a message that failed". Sends are fired with `void sendEmail(...)` rather than awaited: `sendEmail` already never throws, and eight round trips to a mail provider should not hold a response open for a courtesy attached to something that has already happened.

- **The acknowledgement is addressed off `submittedBy`, which is an email.** Reading it as a user id would send every acknowledgement to nowhere, silently.
- **A status email fires on the same condition as the audit event** — an actual status change — so an edit to a description emails nobody about nothing.
- **A household email goes to active residents only, one message per person.** A mail-out to people who moved out last spring is the kind of mistake that gets a tool abandoned, and one message per person means nobody's address is disclosed to the rest of the house. The recipients are listed on screen before sending. The audit summary records the house, the subject and the count — **never the body**, because a summary is bounded and a house mail-out can run to pages.
- **The lease renewal reminder** is a seasonal task keyed on the house and the renewal date, raised `LEASE_RENEWAL_NOTICE_DAYS` (60) ahead — the same horizon the dashboard's lease item uses, so the two cannot tell an RA different things about one date. It clears when `renewalDecision` moves off `undecided`, either way.

**Every new comment emails the people who can see it.** `commentEmail` in `notifications.ts` carries the comment, the author line with any relay ("Sarah Lee, relaying Dave (handyman)"), the request's title and house, an "Internal — staff only" marker when it is internal, and a link to `/maintenance/:id` only when `APP_URL` is set. Who gets it is **one pure function**, `commentRecipients` in `server/commentRecipients.ts` — the request, the comment and the candidate accounts in, `{ userId, email }` out — with four guards that are all required:

1. **Never the author.**
2. **Internal comments to staff only.** Not a second rule: every candidate is put through the real `canReadComment` via `authContextFor`, so the tier gate, the repairs-only type rule, the house match, region scoping and the 120-day closed window all reach email with nothing implemented twice. A resident is emailed exactly when the read rule says they could open the comment, and never about a project.
3. **Anyone with `commentEmailsEnabled === false` is dropped**, on either tier. The switch is on the user row; a person flips their own from the account menu (`PATCH /api/auth/me/notifications`) and an admin flips anybody's from the users table in Settings (`PATCH /api/users/:id/notifications`, `requireAdmin` like every account change). Neither is audited — a preference is not access, money or a document. The email-based re-link in `upsertUser` preserves it, so an admin's "off" survives the account's first sign-in.
4. **The function decides nothing about delivery.** Whether email is configured, and whether a send works, is `sendEmail`'s business.

On top of the read rule, staff are narrowed to **those who have already posted in the thread** plus **regional administrators whose regions cover the request and who hold `canViewMaintenance` or `canManageMaintenance`**; an **admin is emailed only for a thread they have posted in**, or every thread nationally would land in one inbox. A participant who has since lost the region is dropped — "the people who can see it" is the rule, not "the people who once did".

The route (`emailThreadAbout` in `routes.ts`) saves the comment first, then resolves the candidates in three queries — every account with its permissions row (`getAllUsersWithPermissions`, one join), the thread so far, and the properties for the house addresses — never one query per person, and fires one message per recipient through `notify`. A failure working out who to write to is logged and the comment still answers 201; a send that never settles does not hold the response. `APP_URL` is optional in `config.ts`: unset means no link, and only a value that is set but not http(s) fails the boot check, because everybody the email reaches clicks it.

### Deposits

**SPO holds a deposit per resident and the portal is a ledger and a reminder — the money moves in QuickBooks and Ramp.** Amounts, dates, descriptions and references only; the financial-data rule applies here without exception.

**Visibility is admins and the finance team only.** Residents never see deposits, deductions, balances or statements, and a household leader or steward sees none of it either — every deduction route carries `requireStaff` on top of the finance flag, and there is a test asserting a leader holding both finance flags is still refused.

`shared/depositLedger.ts` owns the arithmetic, in **cents as integers**: splitting in floating-point dollars is how 33.333333333333336 ends up on a worksheet finance acts on. It is in `shared/` because the split must be shown and edited *before* it is saved, so the browser and the server have to compute it identically.

- **A split is stored as individual per-person line items, never a shared charge with a divisor.** This is the important part: a later edit must not silently re-divide somebody's already-settled balance. `splitGroupId` exists for provenance and display and **nothing ever recomputes from it**. The whole split is written in one `createDepositDeductions` call, so a house is never half-charged.
- **The remainder is spread a cent at a time from the top**, so nobody pays more than a cent above anybody else. $100 across 3 is 33.34/33.33/33.33; $250 across 7 is three of 35.72 then four of 35.71. Those worked examples are in the tests as hand-computed literals, never recomputed the way the code does.
- **A balance may go negative and says so.** Damage can exceed a deposit, and clamping to zero would hide the shortfall from the person who has to decide about it.
- **The legacy `deductionsNotes` is displayed as history and never parsed into rows.** It is free text written by people, and a migration that guessed would be wrong in ways nobody notices until a deposit is short.

**Return deadlines are one admin-set integer per property, `depositReturnDays`, counted from the resident's move-out date** — when possession came back, not lease end; somebody can leave in April on a lease running to July. **Do not build a state-to-deadline lookup table.** The states SPO operates in have materially different rules (Arizona counts business days, Florida and Kansas are two-stage), and a table would bake legal advice into the repo and go stale silently. No setting means **no deadline** rather than a default standing in for one — an invented figure would be a legal determination the portal must not make — though the dashboard still raises the item, because a deposit held for somebody who has gone is worth surfacing either way. `DEPOSIT_LOOKAHEAD_DAYS` raises it 30 days before a move-out so the money is ready rather than chased.

**No setting means no deadline, but not no urgency.** Every house has `depositReturnDays` null the day this ships, and an undated action item sorts *below* every dated one — so a deposit with no deadline falls back to "due now" for a resident who has already left, which is exactly what it said before deadlines existed. Without that fallback, adding deadlines would have quietly pushed every held deposit off the dashboard's top few. Only `held` and `statement_sent` are outstanding: `returned`, `withheld` and `partially_returned` all mean somebody has dealt with it, and leaving a withheld deposit up forever is a permanent false alarm.

**The statement is an internal worksheet for finance, not a document the portal issues.** There is deliberately no send button: delivery happens outside the portal by product decision, not because email is unavailable. Since delivery happens elsewhere, `statementProvidedOn` is set by hand — there is no send action to infer it from. `statement_sent` is progress, not completion: the money is still held and the dashboard keeps saying so until it goes back.

Every deduction added, changed or removed records an audit event naming the resident and the amount — one per person on a split, because one person's balance changing is what somebody may later have to account for. Routine two-year retention: this is money, not access history.

### Asset lifecycle and snooze

`shared/assetLifecycle.ts` owns the category list, the default lifespans, the two thresholds and `assetLifecycle` — pure, an asset plus `now` in, a status out. Everything about it follows from SPO's tracking being admittedly patchy, because a warning system that guesses is worse than one that stays quiet:

- **The category carries the default, the asset carries the correction.** Per-asset entry alone would be mostly blank. Precedence is explicit `replacementDueDate` → acquisition + per-asset lifespan → acquisition + category default.
- **No date means `unrated`.** Never a warning, never a guess, and the badge says *why* rather than leaving a blank somebody reads as "fine". A category deliberately absent from `DEFAULT_LIFESPAN_YEARS` (artwork, instruments) has no default and its assets stay unrated — they do not wear out on a schedule.
- **The lifespan figures are provisional.** Ordinary industry service lives, not figures SPO has confirmed; confirming them is an open item. The per-asset override is the escape hatch, which is why they are ordinary constants rather than a lookup nobody can correct.
- **Amber at `LIFECYCLE_WARN_YEARS` (3), red at `LIFECYCLE_URGENT_YEARS` (1).** The red threshold is not arbitrary: at twelve months a replacement has to enter that year's budget. **Status is never colour alone** — every badge carries its word.
- **A malformed date is `unrated`, not epoch zero.** Parsing one as 1970 would report the whole portfolio decades overdue.

**The snooze routes are the only writers.** `snoozedUntil` and `snoozeReason` are omitted from `insertAssetSchema` alongside the attribution columns, so the ordinary asset PATCH cannot set them. Omitting only the actor and the timestamp was not enough: `assetLifecycle` reads the snooze off `snoozedUntil` alone, so a PATCH could clear an asset from the dashboard with no reason, no actor and no date — every guarantee the dedicated route makes is only worth as much as the sibling paths that cannot make it. A snooze is also **bounded to 24 months**: "it returns" is the whole distinction from editing the replacement date, and an unbounded end date erases it.

**Snooze suppresses an asset on the dashboard only.** It stays on the asset screen and says it is snoozed; hiding it everywhere is how a boiler gets forgotten for three years. `POST /api/assets/:id/snooze` **requires a reason** — an unexplained snooze is just an asset quietly disappearing, and the reason is what makes next year's budget conversation possible — and requires an end date, so a snooze can never be permanent by omission. It writes only the four snooze columns and **never touches `replacementDueDate`**: editing that date is the permanent correction, and conflating the two would let a date be falsified silently. `DELETE` clears the snooze and keeps the reason. Who snoozed it and when come from the session, which is why `updateAsset`'s signature widens past `InsertAsset` exactly as `updateMaintenanceRequest` does for `completedDate`.

`currentValue` sits **alongside** `purchasePrice`, never replacing it: used equipment can be worth more than it cost, insurance cares about value rather than purchase price, and the purchase price is history nothing can rebuild once dropped.

Assignment prefers a real reference — `assignedResidentId` or `assignedUserId` — with `assignedToName` only as the fallback for somebody who is neither. `/assets/assigned` groups by person rather than by thing, because the situation it is for is a staff departure: collect the iPad, the guitar and the laptop before he leaves.

### The property setup checklist

What has to happen when SPO takes on a house. `shared/propertySetup.ts` owns the item list, the three states and `summarizeSetup`; `property_setup_items` holds the per-house state. Four things decided here, recorded so they are not relitigated:

- **A dedicated table, not `tasks`.** `tasks` has no property link, so a house would live as an address inside a title string, and it has no not-applicable state, so insurance on a rented house would have to be marked done when it never happened. `tasks` is recurring calendar work with an owner and a due date; this is one-time per-property state.
- **The four utilities are separate items.** One "utilities" checkbox hides which one is missing, and the missing one is exactly what gets forgotten.
- **Three states, and the third is the point.** `not_applicable` lets an RA say an item does not apply without the record claiming work that never happened.
- **A house with no rows is untracked, not incomplete.** Rows are generated on property creation and deliberately never backfilled. `summarizeSetup` reports zero rows as `tracked: false` **and zeroes the counts**, so a caller reading `open` without checking the flag still cannot put every pre-existing house on the dashboard.

The module lives in `shared/` rather than `server/` because four surfaces read it — the property card, the badge on the property list row, the dashboard action item and the route that validates a write. A second copy on the client is how the screen and the server come to disagree about what a house is asked for.

The dashboard raises **one aggregated item per house** ("Setup incomplete — 3 of 8 still to do"), never one per open check; that space belongs to maintenance triage. It carries no due date, because setting up a house has no deadline SPO has agreed and inventing one would put every new house at the top of the list.

`PUT /api/properties/:propertyId/setup/:itemKey` takes the status and note from the body and **the actor, the timestamp and the region from the server** — "who said the gas was on" is worth nothing if the client is the one saying. An unknown item key, or one belonging to the other kind of house, is a 400 rather than a new row.

### Resident access to walkthroughs

Walkthroughs are the one part of the portal two tiers reach through the same routes by two different rules. A household leader or steward — a `resident` account holding `canCompleteWalkthroughs` — fills in and reads **their own house's** walkthroughs. Staff are scoped by region as everywhere else.

Both halves live in `server/authz.ts` so no handler decides them for itself:

- `hasWalkthroughPermission(ctx, "view" | "manage")` — the tier gate. A resident needs `canCompleteWalkthroughs` and **nothing else will do**: reading `canManageWalkthroughs` off a resident row would hand that account the region path this rule exists to deny. The mirror holds too — `canCompleteWalkthroughs` on a staff account grants nothing.
- `canAccessWalkthrough(ctx, walkthrough, residentHouse)` / `requireWalkthroughAccess` — the scope. Staff by region; a resident by an exact match between the walkthrough's `buildingAddress` and `residentHouseAddress(ctx)`, the same comparison and the same fail-closed cases as the maintenance house rule. **There is no region branch for a resident at any point.**
- `visibleWalkthroughs(ctx, items, residentHouse)` — the list filter. Not `filterByRegion`: a resident with no house claim gets an empty list rather than falling through to the region rule.

What a leader *can* write is exactly what the walkthrough screen offers: conditions and notes on a checklist item, removing an item their house does not have, and adding a room (which is what brings the standard items with it). What the grant does **not** widen: editing or deleting the walkthrough record itself, the `/api/walkthrough-rooms` CRUD routes, `POST /api/walkthrough-items`, photos, and the national template all stay staff-only. Completing a walkthrough is not managing one. Photos are staff-only in both directions — a resident cannot upload one and `canReadUploadReference` will not serve them one — so `client/src/lib/walkthrough.ts` hides the section rather than offering a control every request behind it would refuse.

**Prior years are read-only for a leader**, and that is a date rule, not a status one. `isCurrentWalkthrough` compares a walkthrough's own date against the newest on that house: the current inspection is writable, earlier ones open read-only, ties are writable (a move-in and a move-out can share a day) and an undated walkthrough fails closed. Deliberately not `status` — nothing moves a walkthrough out of `draft`, so a status gate would lock everything or nothing, and inventing a submit step would decide on SPO's behalf what "finished" means, which is the same reason `WalkthroughRun` has no submit button. **Staff are exempt**, and that exemption is what makes the restriction safe: anything a leader gets wrong, their regional administrator can still correct.

`users.propertyId` therefore now decides which house's walkthroughs a login may **write**, not only which house's maintenance requests it may read. It is audited as `user.property_changed` and stays on `AUDIT_ACTIONS_KEPT_INDEFINITELY` — that is access history, and this is why.

### Identity

**Never read `req.user.claims.sub` or any other provider claim directly.** Call `getUserId(req)` from `server/auth.ts`. That accessor exists so the identity provider can be swapped without touching a route handler: handlers reach identity through `requireActiveUser`, which leaves `getUserId` just two call sites in the whole server. It is the only supported way to find out who is signed in. It throws if there is no authenticated user, which cannot happen behind `isAuthenticated` (that middleware requires `claims.sub`).

The frontend gets the user from `/api/auth/user`, which returns the database user plus their permissions. It does **not** return provider claims — read `user.email`, not `user.claims.email`.

---

## Login

Standard OpenID Connect via Passport, configured entirely through `OIDC_*` environment variables and defaulting to Replit Auth. `server/auth.ts` is the only provider-aware file.

Things to preserve if you touch it:

- **Claim mapping leaves absent fields `undefined`, never `null`.** Drizzle's conflict-update filters `undefined` out but writes `null` through, so using `null` would blank stored names and avatars for any provider that omits them.
- **`upsertUser` in `storage.ts` contains email-based account re-linking.** When a sign-in's email matches an existing account under a different ID, it migrates that account, preserving role, active status and permissions. This is what lets an admin pre-create an account before someone's first login, and it is what makes a provider swap survivable. Do not simplify it away.
- **The OAuth callback URL is hard-coded to https except for genuine localhost.** Do not derive it from `req.protocol` — behind a proxy, a request without forwarded-proto headers yields `http`, and because strategies are cached per-domain that wrong callback sticks for the life of the process.
- **A session with no refresh token ends at token expiry with a 401.** That is the correct behaviour, but it means `OIDC_SCOPES` matters: dropping `offline_access` (which Google Workspace requires you to do — it rejects the scope) means staff sign in again when their token expires.

The full provider-change sequence is in `docs/PRODUCTION_MIGRATION.md`.

---

## File uploads

Uploads go through one interface, `server/objectStorage/`, with two drivers chosen by `STORAGE_DRIVER`: a local folder for development and a **private** Supabase bucket for production. Nothing else in the app talks to a bucket, and no route writes to the container filesystem.

Two endpoints store a file, both behind `isAuthenticated` and a permission check, both buffering it in memory with multer and then writing it to the store:

- `POST /api/upload` — images only (jpeg/jpg/png/gif/webp), 10 MB limit.
- `POST /api/upload-doc` — documents and images (pdf/doc/docx + image types), 20 MB limit.

Both validate the extension, the MIME type **and the file's actual magic bytes**, so a renamed executable is rejected before anything is stored. Both generate the storage key server-side — the client's filename survives only in the `uploads` table — and both return `{ url: "/uploads/<key>" }`.

A third route takes a file without storing one: the roster CSV import, below. It goes through `guardedUpload()` like the other two, but it parses the bytes and discards them, so none of the storage-key or magic-byte rules apply to it.

### Upload limits

Because uploads are buffered in memory, `server/uploadLimits.ts` bounds them. It is the single source of truth for the per-file limits (10MB images, 20MB documents, 2MB roster CSVs) — the multer configs import them rather than repeating the numbers.

`guardedUpload()` wraps each upload route with two things:

- **A ceiling on total in-flight upload bytes**, 64MB by default and configurable with `MAX_UPLOAD_BYTES_IN_FLIGHT`. Capacity is reserved from the request's `Content-Length` *before* the body is read and released when the response finishes or the client disconnects. Requests that would exceed the ceiling get `503` with `Retry-After`, so a burst degrades into a retry rather than an out-of-memory crash.
- **Local handling of multer's own errors.** An oversized file returns `413` with the limit stated, rather than the generic message the final error handler in `server/errors.ts` would produce.

Any new upload route should go through `guardedUpload()` too, and its permission check must sit **before** the multer middleware — otherwise a caller with no right to upload still gets their whole body read into memory.

### The roster CSV import

`POST /api/properties/:propertyId/residents/import/preview` and `POST /api/properties/:propertyId/residents/import` are a deliberate pair: **the upload only ever produces a preview, and nothing is written until the second call confirms it.** Three things to preserve if you touch them:

- **The property is in the URL, not a form field**, so the multipart request still carries one part and no text fields — the property the other upload routes rely on to bound what a request can cost.
- **The CSV is never stored.** It is decoded, parsed and dropped. That is also why there is no magic-byte check here: a CSV has no signature, and nothing reaches a bucket for a disguised file to sit in.
- **The confirm step re-derives everything** — it re-reads the roster, re-runs the duplicate check, and takes `propertyId`, `region` and `buildingAddress` from the property rather than from the body. The rows arrive from a client that could have edited them, and the roster can have moved on between the two calls.

**Any URL the portal stores and later renders into an `href` is scheme-checked at the API boundary**, by `httpUrlFromClient` in `shared/schema.ts` — http and https only. `new URL()` on its own accepts `javascript:`, and the property page renders `leaseDocumentUrl` and `maintenancePortalUrl` as clickable links, so a form-only check would leave the API accepting whatever it was sent. An empty string means "cleared" and normalises to null, because an untouched input sends one. Changing either link, or the photo, records `property.documents_changed`.

A property's front-of-house photo is authorized through `findUploadReferences` like every other file, and is **staff-only**: no resident surface shows a house photo yet, and granting reach ahead of the screen that needs it is access widened for nothing. When the resource hub (Phase 8.1) shows a house its own photo, the branch to add is a house match against `residentHouseAddress` — never a region path, exactly as on walkthroughs.

### Reading files back

`GET /uploads/:filename` is **authenticated** — it is not `express.static`. It rejects anything that is not a bare storage key, authorizes against the record that references the file (falling back to the uploader for a file not yet attached to anything), checks existence *after* authorizing so a refusal cannot confirm which filenames are real, and either redirects to a short-lived signed URL or streams the bytes with `Cache-Control: private`. If you add another way to serve uploads, it must keep every one of those properties.

---

## Audit log

`server/audit.ts` records the actions somebody may need to account for later: **user, permission and house-link changes, maintenance status changes, invoice and billing changes, rent charge and security-deposit changes, property document-link changes, a house's door, gate or alarm code changing (`property.access_code_changed` — which code and which house, never the value), and document uploads and downloads.** `AUDIT_ACTIONS` is the full vocabulary; it lives in `shared/audit.ts` (the activity trail on the client needs the labels too) and `server/audit.ts` re-exports it.

Admins read it in the app: the activity trail in Settings, backed by `GET /api/audit-log` and `client/src/components/ActivityLog.tsx`. Reporting beyond that is a separate piece of work. It can also be read with SQL:

```sql
select created_at, actor_email, action, summary from audit_log order by created_at desc limit 50;
```

Two properties to preserve:

- **It never fails a request.** `recordAuditEvent` returns immediately and swallows both a synchronous throw and a rejected write, logging the failure. Somebody deactivating an account must not get an error because the log was unreachable. The trade-off is that an event can be lost, so treat it as a record of what happened, not as proof of it.
- **It never stores a credential.** Callers pass details field by field rather than handing over a request body, and `scrubDetails` redacts any key whose *name* looks like a secret or a banking identifier. Both layers matter: the first keeps the log readable, the second means one careless call cannot leak a token into a table that is never deleted.
- **A summary is bounded.** Summaries deliberately *do* contain filenames, request titles, company names and email addresses — a log that says "user 4f2a changed 8c11" is useless. All of those are ultimately typed by a user, so `recordAuditEvent` flattens whitespace and truncates centrally rather than trusting each call site.

Photo downloads are deliberately not recorded — every list view pulls dozens, and logging them would bury the document downloads that matter.

When you add an event, add it to `AUDIT_ACTIONS` rather than passing a bare string, and write a `summary` a non-technical reader can understand.

Routine audit events are retained for **two years**. Account and access events (`user.created`, `user.deleted`, `user.role_changed`, `user.status_changed`, `user.permissions_changed`, and `user.property_changed`) are kept indefinitely because they are rare and most likely to be needed later. `user.property_changed` is on that list because the house a resident login is linked to decides which house's records it can read — that is access history, not housekeeping. The list lives in `AUDIT_ACTIONS_KEPT_INDEFINITELY`; add to it there, not here alone. The server runs retention cleanup automatically once a day; each delete is capped at 1,000 rows to avoid one large table-locking statement. There is no user-facing clear-log action.

---

## Integrations

**Outbound email via Resend** lives behind `server/email.ts` — plain-text sends only, configured by `RESEND_API_KEY`/`EMAIL_FROM` (`EMAIL_REPLY_TO` optional, `APP_URL` optional for the links in comment email). Unset means email is deliberately off and the server runs normally; a *partial* pair fails the boot check. A send failure must never fail the request that triggered it — callers get a result, not an exception. Keep message content to what the audit log could hold: names and amounts yes, credentials and banking identifiers never.

The JotForm webhook that used to turn form submissions into maintenance requests was **removed** (2026-08-26, SPO decision: nothing JotForm-related) — residents submit through the portal's own form instead. If a webhook ever comes back (e.g. QuickBooks/Ramp), remember what the old one did right: it failed closed without its secret, compared the secret in constant time, and rate-limited the unauthenticated endpoint. The `rawBody` capture in `server/index.ts` was removed with it; webhook signature verification will need it re-added.

---

## Conventions

- **Errors**: every route handler wraps its body in `try/catch` and finishes with `sendError(res, error, "Failed to <do thing>")`. Only messages the app wrote itself reach the client; anything else becomes a generic message. Match the existing wording style.
- **Validation**: parse request bodies with the Zod schema from `shared/schema.ts` (`insertXSchema.parse(...)`, or `.partial().parse(...)` for PATCH). Do not trust `req.body` directly.
- **Typing**: handlers are typed `async (req: any, res)`. That is the existing convention; do not spend effort changing it, but do not let it stop you using `getUserId(req)`.
- **Test IDs**: interactive elements carry `data-testid` attributes. Keep adding them.
- **Dates**: format at the render boundary with `formatDate`/`formatDateTime` from `client/src/lib/format.ts`; Drizzle `timestamp` columns with `defaultNow()` on the backend.
- **Forms**: React Hook Form with the Zod resolver, using the shared insert schemas.
- **The `overrides` block in `package.json` is load-bearing.** `drizzle-kit` still *declares* the deprecated `@esbuild-kit/esm-loader` but no longer loads it (it uses `tsx`), so the override pins that chain's `esbuild` to a patched version to keep `npm audit` clean. Remove the override only once `drizzle-kit` drops the declaration.

---

## Known open issues

1. **Deleting a photo or document leaves the file in storage.** The database row goes; the object stays and keeps costing space.
2. **Files uploaded before the current storage layout are unreachable.** Their URLs no longer resolve. Nothing in the app depends on them.
3. **Out-of-region records answer 403 rather than 404**, which confirms the record exists. Knowingly accepted.
4. **Requests closed before `completedDate` started being written have no close date.** The column existed from the baseline but nothing set it until `maintenanceStatus.ts` landed, so historic rows are closed with a null date and nothing can reconstruct when they closed — `updatedAt` moves on any edit. They are deliberately *not* backfilled: a guessed date is worse than no date once a visibility window depends on it. Anything reading the close date must decide what a null means and say so; the resident visibility window treats it as outside the window, which fails closed.

**`submittedBy` holds an email address, not a user ID.** The create route writes an email, and `ownsRecord` in `authz.ts` compares against `ctx.user.email` to match. That is consistent today, and resident visibility works — but it is the kind of thing a well-meaning "let's key this on user ID" change breaks silently on both sides at once. `server/__tests__/ownership.test.ts` covers it.

**A household leader sees their house's closed requests for 120 days, then no longer.** `RESIDENT_CLOSED_REQUEST_DAYS` in `server/authz.ts` is the one definition. The time dimension is on the **house path only** — what somebody filed themselves they can always read back, because that is their own report rather than a housemate's history — and staff are not subject to it at all. A closed request with no close date, or an unparseable one, **fails closed** and falls outside the window: those are the requests closed before `completedDate` started being written, nothing can reconstruct when they closed, and a guessed date is worse than no date once a visibility window depends on it. The filtering is server-side in both the list and the detail route, and it reaches the request-photo list too — a client-side filter over a full fetch would hand a leader exactly the closed requests this narrowing exists to withhold.

Note the deliberate asymmetry with `closedWithinRange` in `client/src/lib/maintenanceFilters.ts`, which makes the **opposite** call on the same missing value: a closed request with no date stays *visible* to staff there. One is a permission and fails closed; the other is a view filter, and hiding history nothing can rebuild would be the wrong failure.

**Resident visibility is ownership *or* house, never region — and type `request` only.** Before either path is consulted, the resident branch of `canReadMaintenanceRequest` refuses anything whose `type` is not `request`: a project or a capital project on a resident's own house, even one they are recorded as having submitted, is never theirs to read (see "Request types"). Then, alongside the email match, a resident account linked to a property (`users.propertyId`) may read every repair filed for that house — the two resident accounts on a property share one repair history. The house match compares the property's canonical `address` against the request's `buildingAddress` (both copies of the same computed string), is resolved via `residentHouseAddress(ctx)` once per request, and fails closed: no link, a deleted property, or a missing address means email-only visibility, and it never widens staff access or any mutation route. Resident visibility therefore carries two explicit conditions in one place — the type, and the 120-day window on the house path — and both are tested together in `server/__tests__/authz.test.ts`.

---

## Rules

### Financial data — permanent, no exceptions

**The portal must never store raw banking or card credentials.** Specifically, no bank account number, no routing number, no full card number (PAN), no CVV/CVC, no ACH authorization credentials, and no online banking login of any kind — not in the database, not in an uploaded document field, not in a log line, not in the audit log.

That data belongs with a qualified processor. SPO uses **QuickBooks and Ramp**; anything equivalent is a decision, not a default. Any future payments or bookkeeping feature integrates with one of those and stores only:

- a **reference** issued by the processor (customer ID, payment intent ID, invoice ID),
- a **status** (paid, pending, failed),
- **dates**, and
- **amounts**.

**Why:** holding those numbers puts the organisation inside PCI DSS and ACH-authorization obligations that a small portal cannot meet, and it turns an ordinary application bug into a disclosure of donors' and vendors' bank details. Keeping only references means a compromise of this database exposes nothing that can move money.

**How to apply:** if a feature request seems to need one of those fields, the answer is a processor integration, not a new column. `scrubDetails` in `server/audit.ts` redacts fields with these names as a backstop, but the backstop is not permission — nothing should reach it.

### Never commit

- Real secrets, API keys, tokens or connection strings. Everything comes from `process.env`; there are no hardcoded credentials in this repo and it must stay that way.
- A real `.env` file. Update `.env.example` instead, with placeholders only.
- Anything under `uploads/` — those are real user files.
- Contents of `attached_assets/` except the SPO logo, which is deliberately tracked because the sidebar and landing page import it through the `@assets` alias. The `.gitignore` uses `attached_assets/*` plus a negation for exactly this reason; do not replace it with a plain directory ignore.

### Always

- Generate and commit a migration for any `shared/schema.ts` edit, in the same change.
- Run `npm run lint && npm run check && npm test && npm run build` before finishing, and keep lint and check at zero errors.
- After changing a dependency, check `package-lock.json` for `resolved` URLs pointing at an internal package host and rewrite them to `https://registry.npmjs.org/`, or `npm ci` fails everywhere outside this workspace.
- Invalidate the relevant TanStack Query keys after a mutation — caching is set to never refetch on its own.
- Apply the admin bypass in any new permission check.
- Use `getUserId(req)` rather than reading provider claims.
- Record an audit event for anything that changes access, money, or documents.

---

## Agent skills

### Issue tracker

GitHub Issues on `betterportion/PropertyManagement-SPO`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
