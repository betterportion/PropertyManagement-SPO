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
| `npm test` | Vitest. Needs no database, no bucket, no secrets. Three tests use a real database: `auditRetention.integration.test.ts` and `properties.integration.test.ts`, which skip unless `TEST_DATABASE_URL` or `DATABASE_URL` is set, and `upsertUserRelink.integration.test.ts`, which writes to the real tables and so runs only with `TEST_DATABASE_URL` pointed at a throwaway, migrated database |
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

## Feature notes

Design notes for individual features live in `.claude/rules/`. Each file loads on its own when you open a file its `paths` list covers, but none of them matches `server/routes.ts` or `server/authz.ts`, so **read the feature's file before changing it** wherever the change lands. A section this file names in quotes and does not contain is in one of these:

| File | Sections |
|---|---|
| `walkthroughs.md` | The walkthrough template · The walkthrough screen · The flagged-items list · Photo comparison · Walkthrough conditions |
| `maintenance.md` | Where a maintenance request is, and who fixed it · Request threads · Request types · Projects and bids · Rollups over maintenance history · Outbound email |
| `resource-hub.md` | The resource hub · House facts and access codes |
| `deposits.md` | Deposits (including the move-out damages worksheet) |
| `assets-and-setup.md` | Asset lifecycle and snooze · The property setup checklist |
| `roster-import.md` | The roster CSV import |

New notes about one feature go in its file, or a new one with its own `paths`. Rules that protect access, money or credentials stay in this file.

---

## Architecture

### Backend (`server/`)

**Three daily jobs run inside the web process**, each started at boot and run once immediately: audit-log retention (`audit.ts`), maintenance-schedule generation (`schedules.ts`), and seasonal reminder tasks (`seasonalTasks.ts`). There is no separate worker and no cron. All three are idempotent, because a restart re-runs them — if you add a fourth, it must be too, and it must not be able to fail the boot.

**Route handlers never touch the database directly.** They go through `storage`. Keep it that way — it is the only reason the data layer is testable and swappable.

### Frontend (`client/src/`)

- **Routing** is Wouter, and it is *role-based*: `App.tsx` renders a completely different `<Switch>` depending on whether the user is an admin/regional administrator or a resident. There is no route guard — unauthenticated users get the `Landing` page whatever the path, with one exception: `/privacy` (`PrivacyNotice.tsx`), which `App.tsx` checks before the sign-in and account checks (`isPublicPage` in `lib/publicPages.ts`), so it is readable signed out, signed in or deactivated, and never inside the sidebar. A signed-in account whose `isActive` is false gets `AccountInactive` in place of either switch (no sidebar), because every data route refuses it and the staff screens would otherwise render as a page of empty states. Two paths are carried by both switches: `/walkthroughs/:id`, which the resident switch registers — along with its own `/walkthroughs` index (`MyWalkthroughs.tsx`) — only for an account holding `canCompleteWalkthroughs`; and `/maintenance/:id` (`RequestDetail.tsx`), the page for one request, which every resident account gets because `GET /api/maintenance-requests/:id` already applies the resident read rule. Both registrations are convenience, not security — the server decides which walkthrough or request anybody may open, and the request page shows the shared `AccessDeniedState` off its 403 rather than deciding anything itself.
- **Server state** is TanStack Query, configured in `lib/queryClient.ts` with `staleTime: Infinity`, no refetch on focus, and no retries. This means **you must invalidate queries manually after a mutation** or the UI will show stale data.
- The default query function derives the URL by joining the query key with `/`, so `queryKey: ["/api/assets"]` fetches `/api/assets`.
- `apiRequest(method, url, data)` is the mutation helper. It throws on non-2xx, as `"<status>: <body>"` — `isUnauthorizedError`/`isForbiddenError` read that prefix, so the format stays. A toast shows `serverMessage(error)` from `lib/serverMessage.ts` (the route's own words, field reasons first), never `error.message`.
- **UI** is shadcn/ui in `components/ui/` (22 generated primitives; the unused ones were removed — add any you need back from shadcn rather than hand-writing them). Treat those as generated — build new things in `components/` instead of editing them.
- **Do not put an early return between hook calls.** A guard like `if (!isAdmin) return <AccessDenied />` placed above a `useQuery` changes the hook count once the auth query resolves, and React throws. Compute the guard from hooks, then return below all of them. This crashed the Settings page once already.

---

## Data model

Defined in `shared/schema.ts` using Drizzle, with Zod insert schemas generated by `drizzle-zod`. This file is the single source of truth for both server and client types; read it for the tables and columns. What it does not tell you:

- **`rent_payments` is shown on screen as "HH fees"** (household fees, SPO's word). The table, columns, routes, query keys, test ids and audit action names all keep `rent`, and a rename to match the label would be a regression, not a tidy-up. `failed` is a bounced payment and still counts as outstanding. The `reference` is a note like "check #1234" or a processor ID — **never** an account or card number.
- **`residents` is deliberately not `users`** — a resident on the roster need not have a login. `users.id` is the identity provider's subject claim; `users.propertyId` links a resident account to its house.
- **`maintenance_requests.completedDate` is the close date**, set for `cancelled` as well as `completed`. `submittedBy` stores an **email** (see "Known open issues").
- **`maintenance_request_comments.isInternal` defaults to true**, and the author is kept three ways (id set-null, email, name) so a comment outlives the account.
- **Some links are loose on purpose.** `billing_records.contactId` is a plain column, not a foreign key; rooms and assets reference `properties` with no FK; `audit_log` stores its actor as plain columns and `uploads.uploadedBy` has no FK, so both rows outlive the account.
- **`security_deposits.closeoutReference`** is the QuickBooks or Ramp reference for the transaction, **a reference only**. `deductionsNotes` is legacy free text kept as history.
- **`contact_notes` is append-and-delete, never editable, and deliberately has no rating column.** `property_facts` is separate from `properties.notes`, which is staff-only and never merged with it.
- **`sessions`** is managed by `connect-pg-simple`, not by app code.

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

**Do not assume a route is protected because its neighbours are — check.** Every data route currently applies all three layers, and the two historic gaps (the linked-contacts endpoint, and maintenance routes missing the admin bypass) are closed and covered by tests. `server/__tests__/routeAccess.test.ts` is what keeps them closed; a new route with a missing guard will not fail any existing test unless you add one for it. **A summary is no way round a list's flag**: `/api/action-items` and `/api/region-summary` apply layer 3 item by item — each item, and each region-summary count, needs the flag of the list it comes from (`canSeeActionItemSource` in `authz.ts`: maintenance for schedules and open work, properties for leases and setup, assets for replacements, finance for rent and deposits), tasks need only staff (#158), except a lease-derived task (`sourceKey` `lease-renewal:` or `utilities-lease:`), which needs the properties flag too, even for its assignee, because it names a house's lease dates (#170). A personal task has no region (the create route forces it), so one whose owner's account was deleted is a row with no region, author, assignee or `sourceKey`, and is admin-only rather than read as an all-regions broadcast. `canSeeTask` holds that rule, and all three task surfaces (`/api/tasks`, the action items, the region summary's safety count) go through it. The action items are filtered by that rule on the way out; the region summary does not even read a table the caller could not list.

**A role change resets the permissions row.** `permissionsAfterRoleChange` in `server/roleChange.ts` is pure over the two roles: the same role or a promotion to admin writes nothing (an admin bypasses the row), any other change resets it to the new role's minimum — no flags and no regions for a regional administrator, only `canViewMaintenance` for a resident — so a spell as admin leaves nothing behind. The route writes role and row in one transaction and records `user.permissions_changed` beside `user.role_changed`. **A resident's row holds only resident grants**: `PATCH /api/users/:id/permissions` refuses, with a 400, any flag other than `canViewMaintenance`, `canCompleteWalkthroughs` and `canViewResourceHub` switched on, or any region, on a resident account (`fieldsNotForResident` in `shared/permissions.ts`), and Settings offers a resident only those three.

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

### Region scoping

Non-admins only see records in their `allowedRegions`.

- `filterByRegion(ctx, items)` — filters a list. It takes the whole context, not a region list, and applies the admin bypass itself, so callers pass `ctx` straight through rather than testing `ctx.isAdmin` first. **Returns an empty array when the user's `allowedRegions` is empty or null**, which is deliberate: no regions means no access, not all access. The literal string `"all"` in the list means every region.
- `filterByRelatedRegion(ctx, items, regionOf)` — the same rule for records whose region lives on a related record, such as an asset photo inheriting its asset's region.
- `requireRegion(res, ctx, region)` — single-record check before create or delete.
- `requireRegionMove(res, ctx, existingRegion, incomingRegion)` — on update, checks *both*, so a record cannot be moved into a region the user cannot reach.

**A walkthrough room or photo takes its region from its walkthrough**, never from the body or the room's loose `propertyId` (`walkthroughScope` / `roomScope` in `routes.ts`): the create routes overwrite the body's region, house and property from the walkthrough, the edit routes cannot move a room to another walkthrough or a photo to another room, and room edit and delete check the walkthrough's region. The photo's own `region` is what every later read of it trusts, so it has to be written honestly.

**A reference to another record is checked like a link.** An invoice's `contactId`, `maintenanceRequestId` and `buildingAddress` must each exist (the address as a house) and be in a region the caller can reach (`requireInvoiceReferences` in `routes.ts`, the rule `resolveContactLink` applies to request contacts); a value the invoice already holds passes unchanged on an edit.

**Moving a house to another region moves every copy of its region.** `storage.updateProperty` rewrites the region on the house's residents, HH fees, deposits, deductions, resident paperwork, walkthroughs and their photos, schedules, setup items, budgets, assets, lease reminder tasks, and the requests and invoices filed against its address, in the same transaction; a new table that copies a house's region joins that list, and `properties.integration.test.ts`.

Region names are compared in one canonical form, so a stored legacy `west-central` still matches `West Central`.

### Resident access to walkthroughs

Walkthroughs are the one part of the portal two tiers reach through the same routes by two different rules. A household leader or steward — a `resident` account holding `canCompleteWalkthroughs` — fills in and reads **their own house's** walkthroughs. Staff are scoped by region as everywhere else.

Both halves live in `server/authz.ts` so no handler decides them for itself:

- `hasWalkthroughPermission(ctx, "view" | "manage")` — the tier gate. A resident needs `canCompleteWalkthroughs` and **nothing else will do**: reading `canManageWalkthroughs` off a resident row would hand that account the region path this rule exists to deny. The mirror holds too — `canCompleteWalkthroughs` on a staff account grants nothing.
- `canAccessWalkthrough(ctx, walkthrough, residentHouse)` / `requireWalkthroughAccess` — the scope. Staff by region; a resident by an exact match between the walkthrough's `buildingAddress` and `residentHouseAddress(ctx)`, the same comparison and the same fail-closed cases as the maintenance house rule. **There is no region branch for a resident at any point.**
- `visibleWalkthroughs(ctx, items, residentHouse)` — the list filter. Not `filterByRegion`: a resident with no house claim gets an empty list rather than falling through to the region rule.

What a leader *can* write is exactly what the walkthrough screen offers: conditions and notes on a checklist item (the item PATCH refuses any other field from a resident with a 403 — `label` and `displayOrder` carry forward to next year and into the damages worksheet), and adding a room (which is what brings the standard items with it). **Removing an item is staff work** since the 2026-09 RA review: `DELETE /api/walkthrough-items/:id` is `requireStaff` before anything is loaded, `canRemoveWalkthroughItems` in `client/src/lib/walkthrough.ts` hides the control, and a leader marks what the house lacks as "Not here" and asks their RA. `routeAccess.test.ts` asserts the refusal with the storage delete never called, beside the staff delete that proves the spy fires. Beyond walkthroughs, the only other things a resident account writes are its own maintenance requests and a **shared comment on its own house's requests** (see "Request threads"). What the grant does **not** widen: editing or deleting the walkthrough record itself, the `/api/walkthrough-rooms` CRUD routes, `POST /api/walkthrough-items`, photos, and the national template all stay staff-only. Completing a walkthrough is not managing one. Photos are staff-only on the walkthrough itself — a resident cannot upload one and `canReadUploadReference` will not serve them one *as a walkthrough photo* — so `client/src/lib/walkthrough.ts` hides the section rather than offering a control every request behind it would refuse. The single exception is deliberate: a room photo that staff have referenced onto a repair through "send to maintenance" reaches the household through the request rule, and that is the only path.

**Prior years are read-only for a leader**, and that is a date rule, not a status one. `isCurrentWalkthrough` compares a walkthrough's own date against the newest on that house: the current inspection is writable, earlier ones open read-only, ties are writable (a move-in and a move-out can share a day) and an undated walkthrough fails closed. Deliberately not `status` — a submitted walkthrough is still editable (see "The walkthrough screen"), so a status gate would either lock a leader out of fixing a note or lock nothing; the date is what says which inspection is the live one. **Staff are exempt**, and that exemption is what makes the restriction safe: anything a leader gets wrong, their regional administrator can still correct.

`users.propertyId` therefore now decides which house's walkthroughs a login may **write**, not only which house's maintenance requests it may read. It is audited as `user.property_changed` and stays on `AUDIT_ACTIONS_KEPT_INDEFINITELY` — that is access history, and this is why.

### Identity

**Never read `req.user.claims.sub` or any other provider claim directly.** Call `getUserId(req)` from `server/auth.ts`. That accessor exists so the identity provider can be swapped without touching a route handler: handlers reach identity through `requireActiveUser`, which leaves `getUserId` just two call sites in the whole server. It is the only supported way to find out who is signed in. It throws if there is no authenticated user, which cannot happen behind `isAuthenticated` (that middleware requires `claims.sub`).

The frontend gets the user from `/api/auth/user`, which returns the database user plus their permissions. It does **not** return provider claims — read `user.email`, not `user.claims.email`.

---

## Login

Standard OpenID Connect via Passport, configured entirely through `OIDC_*` environment variables and defaulting to Replit Auth. `server/auth.ts` is the only provider-aware file.

Things to preserve if you touch it:

- **Claim mapping leaves absent fields `undefined`, never `null`.** Drizzle's conflict-update filters `undefined` out but writes `null` through, so using `null` would blank stored names and avatars for any provider that omits them.
- **`upsertUser` in `storage.ts` contains email-based account re-linking.** When a sign-in's email matches an existing account under a different ID, it migrates that account, preserving role, active status and permissions. The migration is one UPDATE of the row's id, and every foreign key to `users.id` is `ON UPDATE CASCADE`, so the permissions row and every foreign-key reference move with it or nothing changes (the plain id columns, such as `uploadedBy` and the audit log's actor, keep the old id, as they always did); a new foreign key to `users.id` needs `onUpdate: "cascade"` too (`upsertUserRelink.test.ts` fails without it). This is what lets an admin pre-create an account before someone's first login, and it is what makes a provider swap survivable. Do not simplify it away. **It hands over any account, admins included, so it runs only for a verified email:** `recordSignIn` refuses with a 403, before any account is looked up or written, a sign-in whose email the ID token does not mark `email_verified: true` (absent counts as unverified). That applies even when no account holds the email yet, because the email is also what `ownsRecord` matches, case-insensitively. Every re-link is recorded as `user.relinked`; `server/__tests__/signInRelink.test.ts` covers both.
- **`OIDC_ALLOWED_DOMAINS` (optional, comma-separated) limits sign-in to those Google Workspace domains.** `recordSignIn` in `auth.ts` checks Google's `hd` claim and refuses with a 403 *before* `upsertUser` runs, so a refused sign-in creates or changes no account; never check the email domain instead, since a personal Google account can hold any address. Unset keeps the old behaviour, where the Google consent screen being "Internal" is the only restriction. `server/__tests__/signInDomain.test.ts` covers it.
- **The OAuth callback URL is hard-coded to https except for genuine localhost.** Do not derive it from `req.protocol` — behind a proxy, a request without forwarded-proto headers yields `http`, and because strategies are cached per-domain that wrong callback sticks for the life of the process.
- **A session with no refresh token ends at token expiry with a 401.** That is the correct behaviour, but it means `OIDC_SCOPES` matters: dropping `offline_access` (which Google Workspace requires you to do — it rejects the scope) means staff sign in again when their token expires.

The full provider-change sequence is in `docs/PRODUCTION_MIGRATION.md`.

---

## File uploads

Uploads go through one interface, `server/objectStorage/`, with two drivers chosen by `STORAGE_DRIVER`: a local folder for development and a **private** Supabase bucket for production. Nothing else in the app talks to a bucket, and no route writes to the container filesystem.

Two endpoints store a file, both behind `isAuthenticated` and a permission check, both buffering it in memory with multer and then writing it to the store:

- `POST /api/upload` — images only (jpeg/jpg/png/gif/webp), 10 MB limit. Staff holding a flag for a screen that uploads here: `canViewMaintenance` (filing a request), `canManageMaintenance`, `canManageWalkthroughs`, `canManageAssets` or `canManageProperties`.
- `POST /api/upload-doc` — documents and images (pdf/doc/docx + image types), 20 MB limit. Staff holding `canManageBilling`, since the billing documents are its only caller.

Residents are refused on both, and an admin passes on the bypass. A new screen that uploads through either route needs its flag added to that route's list, or its users will be refused.

Both validate the extension, the MIME type **and the file's actual magic bytes**, so a renamed executable is rejected before anything is stored. Both generate the storage key server-side — the client's filename survives only in the `uploads` table — and both return `{ url: "/uploads/<key>" }`.

Three more store a file for a particular record rather than under the general upload permission: `POST /api/maintenance-request-photos/upload` (images, resident-reachable), `POST /api/maintenance-requests/:id/attachments` (the document set, for a comment on that request — see "Request threads") and `POST /api/maintenance-requests/:id/bid-documents` (the document set, for a bid on a project — staff only, see "Projects and bids"). All three apply the same checks and go through the same `storeUploadedFile`.

**Naming a stored file is checked as strictly as storing one.** A file is served to anyone who can read a record pointing at it, so every column that holds an `/uploads/<key>` reference takes a new value only when the `uploads` row says this caller stored it: comment attachments and bid documents through `ownUploadFromClient`, request `photoUrls` through `attachRequestPhotos`, and every other column (request and house `photoUrl`, walkthrough and asset photo `imageUrl`, the three billing documents) through `requireOwnUploads`, which also refuses anything not in the `/uploads/<key>` shape. An edit that resends the value the row already holds passes, so editing a colleague's record is not refused over their file. A new writer of a file column goes through one of these, with a `routeAccess.test.ts` case.

A further kind of route takes a file without storing one: the roster CSV import, below. It goes through `guardedUpload()` like the others, but it parses the bytes and discards them, so none of the storage-key or magic-byte rules apply to it.

### Upload limits

Because uploads are buffered in memory, `server/uploadLimits.ts` bounds them. It is the single source of truth for the per-file limits (10MB images, 20MB documents, 2MB roster CSVs) — the multer configs import them rather than repeating the numbers.

**Photos are shrunk on the phone, not on the server.** `client/src/lib/resizeImage.ts` re-encodes anything over 1 MB as a JPEG with a 2048 px long edge at quality 0.82 (a hairline drywall crack is still legible; a 12 MB camera photo lands at a few hundred KB), renames it `.jpg` because the server keys every check on the filename, leaves GIFs alone, and hands back the original on any failure so the server's own checks still decide. Both `PhotoUpload` and `CommentAttachmentField` call it before their size check. The server limits are unchanged and remain the ceiling: the resize is a courtesy to the limit, never a substitute for it. This is also the main lever on storage cost, since every walkthrough season is kept (and a file replaced on an edit is left behind, known issue 1).

`guardedUpload()` wraps each upload route with two things:

- **A ceiling on total in-flight upload bytes**, 64MB by default and configurable with `MAX_UPLOAD_BYTES_IN_FLIGHT`. Capacity is reserved from the request's `Content-Length` *before* the body is read and released when the response finishes or the client disconnects. Requests that would exceed the ceiling get `503` with `Retry-After`, so a burst degrades into a retry rather than an out-of-memory crash.
- **Local handling of multer's own errors.** An oversized file returns `413` with the limit stated, rather than the generic message the final error handler in `server/errors.ts` would produce.

Any new upload route should go through `guardedUpload()` too, and its permission check must sit **before** the multer middleware — otherwise a caller with no right to upload still gets their whole body read into memory.

### Stored links and the house photo

**Any URL the portal stores and later renders into an `href` is scheme-checked at the API boundary**, by `httpUrlFromClient` in `shared/schema.ts` — http and https only. `new URL()` on its own accepts `javascript:`, and the property page renders `leaseDocumentUrl` and `maintenancePortalUrl` as clickable links, so a form-only check would leave the API accepting whatever it was sent. An empty string means "cleared" and normalises to null, because an untouched input sends one. Changing either link, or the photo, records `property.documents_changed`.
A property's front-of-house photo is authorized through `findUploadReferences` like every other file, and is **staff-only**: no resident surface shows a house photo yet, and granting reach ahead of the screen that needs it is access widened for nothing. When the resource hub (Phase 8.1) shows a house its own photo, the branch to add is a house match against `residentHouseAddress` — never a region path, exactly as on walkthroughs.
### Reading files back

`GET /uploads/:filename` is **authenticated** — it is not `express.static`. It rejects anything that is not a bare storage key, authorizes against the record that references the file (falling back to the uploader for a file not yet attached to anything), checks existence *after* authorizing so a refusal cannot confirm which filenames are real, and either redirects to a short-lived signed URL or streams the bytes with `Cache-Control: private`. If you add another way to serve uploads, it must keep every one of those properties.

---

## Audit log

`server/audit.ts` records the actions somebody may need to account for later: **user, permission and house-link changes, maintenance status changes, invoice and billing changes, rent charge and security-deposit changes, property document-link changes, a project's contract link changing (`maintenance_request.documents_changed` — which request, never the link), a house's door, gate or alarm code changing (`property.access_code_changed` — which code and which house, never the value), a resident being deleted from the roster (`resident.deleted` — the name and the house, since the row and its cascaded finance and paperwork rows are gone), a house being deleted (`property.deleted` — refused with a 409 while it still has residents, moved-out ones included, or HH fee, deposit or deduction rows), and document uploads and downloads.** `AUDIT_ACTIONS` is the full vocabulary; it lives in `shared/audit.ts` (the activity trail on the client needs the labels too) and `server/audit.ts` re-exports it.

Admins read it in the app: the activity trail in Settings, backed by `GET /api/audit-log` and `client/src/components/ActivityLog.tsx`. Reporting beyond that is a separate piece of work; the `audit_log` table can also be read directly with SQL.

Two properties to preserve:

- **It never fails a request.** `recordAuditEvent` returns immediately and swallows both a synchronous throw and a rejected write, logging the failure. Somebody deactivating an account must not get an error because the log was unreachable. The trade-off is that an event can be lost, so treat it as a record of what happened, not as proof of it.
- **It never stores a credential.** Callers pass details field by field rather than handing over a request body, and `scrubDetails` redacts any key whose *name* looks like a secret or a banking identifier. Both layers matter: the first keeps the log readable, the second means one careless call cannot leak a token into a table that is never deleted.
- **A summary is bounded.** Summaries deliberately *do* contain filenames, request titles, company names and email addresses — a log that says "user 4f2a changed 8c11" is useless. All of those are ultimately typed by a user, so `recordAuditEvent` flattens whitespace and truncates centrally rather than trusting each call site.

Photo downloads are deliberately not recorded — every list view pulls dozens, and logging them would bury the document downloads that matter.

When you add an event, add it to `AUDIT_ACTIONS` rather than passing a bare string, and write a `summary` a non-technical reader can understand.

Routine audit events are retained for **two years**. Account and access events (`user.created`, `user.deleted`, `user.role_changed`, `user.status_changed`, `user.permissions_changed`, `user.property_changed`, and `user.relinked`) are kept indefinitely because they are rare and most likely to be needed later. `user.property_changed` is on that list because the house a resident login is linked to decides which house's records it can read — that is access history, not housekeeping. The list lives in `AUDIT_ACTIONS_KEPT_INDEFINITELY`; add to it there, not here alone. The server runs retention cleanup automatically once a day; each delete is capped at 1,000 rows to avoid one large table-locking statement. There is no user-facing clear-log action.

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

1. **Replacing a file on an edit leaves the old one in storage** (a new house photo, a new W-9). Every delete that owns a file removes it: request, walkthrough and asset photos, a house's photo, billing documents, a comment's attachment, a bid's quote, and whatever files a deleted request, walkthrough, room, asset or house takes with it by cascade. The storage layer's delete returns the URLs the removed rows held, and `removeDeletedRecordFiles` in `server/uploadCleanup.ts` removes each object and its `uploads` row once `findUploadReferences` says nothing else points at it. A storage failure is logged (storage key only) and never fails the delete, because the row is already gone. Comments and bids joined on JR's sign-off (2026-09-28), with their delete confirmations changed to say the file goes too.
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

**Enforced on the finance free text (#51).** An HH fee's `reference` and `notes`, a deposit's `closeoutReference` and `deductionsNotes`, and a deduction's `description` (single and split) refuse, with a 400 that says to record the QuickBooks or Ramp reference and never repeats the value, a 13–19 digit card number typed the way a card is (unbroken, 4-4-4-4 or Amex 4-6-5), starting with an issuer's digit (2–6), not four numbers counting up by one (a list of check numbers), and Luhn-valid, and a banking word (`routing`, `acct`, `account`, `ABA`) next to 6+ digits that are not a date. The rule is `containsBankingDetails` in `shared/bankingDetails.ts`, applied through `financeText` in `shared/schema.ts`, so create and `.partial()` edits both carry it. Deliberately not "any long number": a long QuickBooks, Ramp or check number must pass, and a bare account number with no banking word still gets through (covered by the helper text under each field). A new free-text finance field uses `financeText`.

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
- Update `docs/WORKFLOWS.md` whenever you add or change a workflow, daily job, integration, or automated email.

---

## Agent skills

### Issue tracker

GitHub Issues on `betterportion/PropertyManagement-SPO`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
