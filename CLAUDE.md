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
| `npm run dev` | Development server with hot reload |
| `npm run build` | Vite builds the client, esbuild bundles the server into `dist/` |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint. **Must stay at zero errors**; warnings are allowed |
| `npm run check` | TypeScript check. **Must stay at zero errors** |
| `npm test` | Vitest. Needs no database, no bucket, no secrets |
| `npm run db:generate` | Write a migration from a `shared/schema.ts` change |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:baseline -- <tag>` | Record existing tables as already migrated, through `<tag>` (a database that predates `migrations/`). Bare, it records only `0000` |
| `npm run db:push` | Push the schema directly, without a migration. Development only |

**The gate is `npm run lint && npm run check && npm test && npm run build`.** Run all four before finishing. `.github/workflows/ci.yml` runs the same four on every push and pull request.

The linter catches mistakes, not style — formatting rules are off on purpose, so nothing here should ever produce a large reformatting diff. The ~10 remaining warnings are React Compiler advice, mostly in the generated `components/ui/` files.

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
| `index.ts` | Entry point. Validates configuration before anything else loads, sets `trust proxy`, security headers, JSON body parsing (captures `rawBody` for webhooks), API request logging, graceful shutdown, listens on `PORT`. |
| `config.ts` | Every environment variable the server cannot run without, checked once at boot and reported together. Also owns the OIDC provider settings. |
| `routes.ts` | Every API endpoint. One large file, ~54 handlers. |
| `auth.ts` | OpenID Connect login and the session store. Reads its provider settings from `config.ts`. |
| `authz.ts` | Who may do what: `requireActiveUser`, `requirePermission`, the region helpers, upload and maintenance ownership. |
| `audit.ts` | Records the actions somebody may have to account for later. See "Audit log" below. |
| `security.ts` | Helmet headers including the production CSP, plus the upload and webhook rate limits. |
| `errors.ts` | Error classification, `sendError`, and the final error middleware. |
| `health.ts` | `GET /api/health` for the hosting platform. Unauthenticated, so it reveals nothing. |
| `storage.ts` | Every database query, behind a single `IStorage` interface exported as `storage`. |
| `db.ts` | Drizzle over the standard `pg` pool, plus `pingDatabase` and `closeDatabase`. Throws at import time if `DATABASE_URL` is missing. |
| `objectStorage/` | File storage behind a `FileStore` interface: `local.ts` for development, `supabase.ts` for production. The only code that talks to a bucket. |
| `uploadLimits.ts` | Per-file size limits and the in-flight memory ceiling. |
| `logger.ts` | `log()`. Separate from `vite.ts` so the production bundle never imports Vite. |
| `static.ts` | Serves the built client in production. |
| `vite.ts` | Dev middleware only. Imported dynamically, and only in development — see the note in the file. |

**Route handlers never touch the database directly.** They go through `storage`. Keep it that way — it is the only reason the data layer is testable and swappable.

### Frontend (`client/src/`)

- **Routing** is Wouter, and it is *role-based*: `App.tsx` renders a completely different `<Switch>` depending on whether the user is an admin/regional administrator or a resident. There is no route guard — unauthenticated users only ever get the `Landing` page.
- **Server state** is TanStack Query, configured in `lib/queryClient.ts` with `staleTime: Infinity`, no refetch on focus, and no retries. This means **you must invalidate queries manually after a mutation** or the UI will show stale data.
- The default query function derives the URL by joining the query key with `/`, so `queryKey: ["/api/assets"]` fetches `/api/assets`.
- `apiRequest(method, url, data)` is the mutation helper. It throws on non-2xx.
- **UI** is shadcn/ui in `components/ui/` (47 generated primitives). Treat those as generated — build new things in `components/` instead of editing them.
- **Do not put an early return between hook calls.** A guard like `if (!isAdmin) return <AccessDenied />` placed above a `useQuery` changes the hook count once the auth query resolves, and React throws. Compute the guard from hooks, then return below all of them. This crashed the Settings page once already.
- Path aliases: `@/` → `client/src/`, `@shared/` → `shared/`, `@assets/` → `attached_assets/`.

---

## Data model

Defined in `shared/schema.ts` using Drizzle, with Zod insert schemas generated by `drizzle-zod`. This file is the single source of truth for both server and client types. Fifteen tables:

| Table | Purpose | Key relationships |
|---|---|---|
| `sessions` | Express session store | Managed by `connect-pg-simple`, not by app code |
| `users` | Accounts. `role` is `admin` / `regional_administrator` / `resident`, plus `isActive` | `id` is the identity provider's subject claim; `email` is unique |
| `user_permissions` | One row per user, thirteen boolean flags plus `allowedRegions` (text array) | `userId` unique, cascades on user delete |
| `maintenance_requests` | The core workflow. Priority includes a `wishlist` level; status is pending/in_progress/completed/cancelled | `submittedBy` stores an **email**, see gotchas |
| `walkthrough_rooms` | Inspection room templates, ordered by `displayOrder` | `propertyId` → `properties` (loose, no FK); `buildingAddress` kept for backward compatibility |
| `walkthrough_photos` | Photos attached to a room, with condition and free-form `questionAnswers` JSON | `roomId` → `walkthrough_rooms`, cascades |
| `assets` | Fixed and movable assets, with age, serial, purchase price, asset tag | `propertyId` → `properties` (loose, no FK) |
| `asset_photos` | Photos attached to an asset | `assetId` → `assets`, cascades |
| `maintenance_contacts` | Vendors | Referenced by invoices and request links |
| `invoices` | Invoice records with amount, status, due/paid dates | `contactId` and `maintenanceRequestId`, both set-null on delete |
| `billing_records` | Vendor billing with three document URLs (contract/invoice, COI, W-9) | `contactId` is a plain column, **not** a foreign key |
| `properties` | Property records. `address` is computed from the four address parts and is unique | Referenced loosely by rooms and assets |
| `request_contacts` | Join table linking contacts to maintenance requests | Both sides cascade |
| `uploads` | One row per stored file: random storage key, original name, content type, size, uploader | `uploadedBy` is a user ID; no FK, so the row outlives the account |
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
    res.json(ctx.isAdmin ? things : filterByRegion(things, ctx.allowedRegions));
  } catch (error) {
    sendError(res, error, "Failed to fetch things");
  }
});
```

### Region scoping

Non-admins only see records in their `allowedRegions`.

- `filterByRegion(items, allowedRegions)` — filters a list. **Returns an empty array when `allowedRegions` is empty or null**, which is deliberate: no regions means no access, not all access. The literal string `"all"` in the list means every region.
- `requireRegion(res, ctx, region)` — single-record check before create or delete.
- `requireRegionMove(res, ctx, existingRegion, incomingRegion)` — on update, checks *both*, so a record cannot be moved into a region the user cannot reach.

Region names are compared in one canonical form, so a stored legacy `west-central` still matches `West Central`.

### Identity

**Never read `req.user.claims.sub` or any other provider claim directly.** Call `getUserId(req)` from `server/auth.ts`. That accessor exists so the identity provider can be swapped without touching 49 route handlers, and it is the only supported way to find out who is signed in. It throws if there is no authenticated user, which cannot happen behind `isAuthenticated` (that middleware requires `claims.sub`).

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

Two endpoints, both behind `isAuthenticated` and a permission check, both buffering the file in memory with multer and then writing it to the store:

- `POST /api/upload` — images only (jpeg/jpg/png/gif/webp), 10 MB limit.
- `POST /api/upload-doc` — documents and images (pdf/doc/docx + image types), 20 MB limit.

Both validate the extension, the MIME type **and the file's actual magic bytes**, so a renamed executable is rejected before anything is stored. Both generate the storage key server-side — the client's filename survives only in the `uploads` table — and both return `{ url: "/uploads/<key>" }`.

### Upload limits

Because uploads are buffered in memory, `server/uploadLimits.ts` bounds them. It is the single source of truth for the per-file limits (10MB images, 20MB documents) — the multer configs import them rather than repeating the numbers.

`guardedUpload()` wraps each upload route with two things:

- **A ceiling on total in-flight upload bytes**, 64MB by default and configurable with `MAX_UPLOAD_BYTES_IN_FLIGHT`. Capacity is reserved from the request's `Content-Length` *before* the body is read and released when the response finishes or the client disconnects. Requests that would exceed the ceiling get `503` with `Retry-After`, so a burst degrades into a retry rather than an out-of-memory crash.
- **Local handling of multer's own errors.** An oversized file returns `413` with the limit stated. This matters beyond tidiness: the global error handler in `server/index.ts` re-throws after responding, so an upload error that reached it would take the process down.

Any new upload route should go through `guardedUpload()` too, and its permission check must sit **before** the multer middleware — otherwise a caller with no right to upload still gets their whole body read into memory.

### Reading files back

`GET /uploads/:filename` is **authenticated** — it is not `express.static`. It rejects anything that is not a bare storage key, authorizes against the record that references the file (falling back to the uploader for a file not yet attached to anything), checks existence *after* authorizing so a refusal cannot confirm which filenames are real, and either redirects to a short-lived signed URL or streams the bytes with `Cache-Control: private`. If you add another way to serve uploads, it must keep every one of those properties.

---

## Audit log

`server/audit.ts` records the actions somebody may need to account for later: **user and permission changes, maintenance status changes, invoice and billing changes, and document uploads and downloads.** `AUDIT_ACTIONS` is the full vocabulary.

Nothing in the application reads the log back — that is deliberate, and building reporting on top of it is a separate piece of work. Read it with SQL:

```sql
select created_at, actor_email, action, summary from audit_log order by created_at desc limit 50;
```

Two properties to preserve:

- **It never fails a request.** `recordAuditEvent` returns immediately and swallows both a synchronous throw and a rejected write, logging the failure. Somebody deactivating an account must not get an error because the log was unreachable. The trade-off is that an event can be lost, so treat it as a record of what happened, not as proof of it.
- **It never stores a credential.** Callers pass details field by field rather than handing over a request body, and `scrubDetails` redacts any key whose *name* looks like a secret or a banking identifier. Both layers matter: the first keeps the log readable, the second means one careless call cannot leak a token into a table that is never deleted.
- **A summary is bounded.** Summaries deliberately *do* contain filenames, request titles, company names and email addresses — a log that says "user 4f2a changed 8c11" is useless. All of those are ultimately typed by a user, so `recordAuditEvent` flattens whitespace and truncates centrally rather than trusting each call site.

Photo downloads are deliberately not recorded — every list view pulls dozens, and logging them would bury the document downloads that matter.

When you add an event, add it to `AUDIT_ACTIONS` rather than passing a bare string, and write a `summary` a non-technical reader can understand.

Routine audit events are retained for **two years**. Account and permission events (`user.created`, `user.deleted`, `user.role_changed`, `user.status_changed`, and `user.permissions_changed`) are kept indefinitely because they are rare and most likely to be needed later. The server runs retention cleanup automatically once a day; each delete is capped at 1,000 rows to avoid one large table-locking statement. There is no user-facing clear-log action.

---

## Integrations

**JotForm** (`POST /api/webhooks/jotform`) — turns form submissions into maintenance requests. It **fails closed**: with no `JOTFORM_WEBHOOK_SECRET` configured it returns 503 rather than accepting anonymous submissions, and the secret is compared in constant time via `secretsMatch()`. Field IDs map through `JOTFORM_FIELD_*` variables with keyword auto-detection as a fallback, and `JOTFORM_DEFAULT_*` supplies values for missing fields. `GET /api/webhooks/jotform/config` exposes the current mapping to the admin setup dialog.

---

## Conventions

- **Errors**: every route handler wraps its body in `try/catch` and finishes with `sendError(res, error, "Failed to <do thing>")`. Only messages the app wrote itself reach the client; anything else becomes a generic message. Match the existing wording style.
- **Validation**: parse request bodies with the Zod schema from `shared/schema.ts` (`insertXSchema.parse(...)`, or `.partial().parse(...)` for PATCH). Do not trust `req.body` directly.
- **Typing**: handlers are typed `async (req: any, res)`. That is the existing convention; do not spend effort changing it, but do not let it stop you using `getUserId(req)`.
- **Test IDs**: interactive elements carry `data-testid` attributes. Keep adding them.
- **Dates**: `date-fns` on the frontend; Drizzle `timestamp` columns with `defaultNow()` on the backend.
- **Forms**: React Hook Form with the Zod resolver, using the shared insert schemas.

---

## Known open issues

1. **No frontend error boundary.** Any render error blanks the whole page.
2. **`throw err` after responding** in the `index.ts` error handler can take the process down.
3. **Deleting a photo or document leaves the file in storage.** The database row goes; the object stays and keeps costing space.
4. **Files uploaded before the current storage layout are unreachable.** Their URLs no longer resolve. Nothing in the app depends on them.
5. **Out-of-region records answer 403 rather than 404**, which confirms the record exists. Knowingly accepted.
6. **Two dependency advisories remain** — `drizzle-orm` (fix needs a version bump) and `vite` (fix needs a major upgrade, dev tooling only).

**`submittedBy` holds an email address, not a user ID.** Both the create route and the JotForm webhook write an email, and `ownsRecord` in `authz.ts` compares against `ctx.user.email` to match. That is consistent today, and resident visibility works — but it is the kind of thing a well-meaning "let's key this on user ID" change breaks silently on both sides at once. `server/__tests__/ownership.test.ts` covers it.

---

## Rules

### Financial data — permanent, no exceptions

**The portal must never store raw banking or card credentials.** Specifically, no bank account number, no routing number, no full card number (PAN), no CVV/CVC, no ACH authorization credentials, and no online banking login of any kind — not in the database, not in an uploaded document field, not in a log line, not in the audit log.

That data belongs with a qualified processor: **QuickBooks, Stripe, or an equivalent**. Any future payments or bookkeeping feature integrates with one of those and stores only:

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
