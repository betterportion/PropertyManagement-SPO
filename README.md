# SPO Admin Portal

A property management portal for **Saint Paul's Outreach, Inc. (SPO)**.

Staff use it to manage properties, resident rosters, maintenance requests, walkthrough
inspections, physical assets, preventive and safety schedules, vendor contacts, invoices
and household finances. Residents use it to submit maintenance requests and follow their
progress.

---

## Who uses it

The portal serves three kinds of user, and each sees a completely different set of pages.

| Role | What they can do |
|---|---|
| **Admin** | Full access to everything, including user management and permissions. Bypasses per-feature permission checks. |
| **Regional administrator** | Manages properties, maintenance, walkthroughs, assets, contacts and invoices — but only for the regions they have been granted. |
| **Resident** | Submits maintenance requests and follows them. Reads the resource hub — SPO's general guidance plus their own house's walkthrough, requests and startup budget. Sees the requests they filed *and* every request filed for the house their account is linked to — housemates share one repair history. Granted "Complete Walkthroughs", a household leader or steward also fills in their own house's current walkthrough and reads earlier ones read-only. Never sees another house, and never sees anything by region. |

On top of the role, each user has a row of fine-grained permissions — seventeen view/manage flags, including two that gate the finance screens on their own and one held in reserve for a surface not built yet — and a list of allowed regions. Admins ignore both.

---

## Tech stack

**Frontend** — React 18 + TypeScript, Vite, Wouter for routing, TanStack Query for server state, React Hook Form + Zod for forms, Tailwind CSS with shadcn/ui (New York style) on Radix primitives.

**Backend** — Express on Node 20, TypeScript with ESM, Passport with `openid-client` for OpenID Connect login, `express-session` backed by PostgreSQL, `papaparse` for the roster CSV import.

**Database** — PostgreSQL over the standard `pg` driver, with Drizzle ORM and Drizzle Kit. Any Postgres works: Supabase, Neon, RDS, or one you run yourself. The schema is the single source of truth and lives in `shared/schema.ts`.

**File storage** — either the local filesystem (development) or a private Supabase Storage bucket (production), chosen with `STORAGE_DRIVER`.

**Hosting** — an ordinary Node service. It needs a Postgres connection string and the environment variables below, and nothing specific to any one hosting provider. The intended production home is **Render** with **Supabase** for the database and file storage; `docs/PRODUCTION_MIGRATION.md` is the step-by-step runbook for getting there.

---

## Running it from a fresh clone

### 1. Install dependencies

```bash
npm install
```

### 2. Set the environment variables

`.env.example` lists everything the app reads, grouped by what it is for:

```bash
cp .env.example .env
```

> **Note:** the app does **not** read a `.env` file automatically — there is no `dotenv` in the project. On Replit, values come from the Secrets pane; on Render, from the service's Environment tab. Locally, `set -a && . ./.env && set +a` works.

Required before the app will start:

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string |
| `SESSION_SECRET` | **Yes** | A long random string used to sign session cookies. At least 32 characters in production |
| `OIDC_ISSUER_URL` | **Yes, off Replit** | Identity provider discovery root, e.g. `https://accounts.google.com`. Inside a Replit workspace it defaults to Replit's |
| `OIDC_CLIENT_ID` | **Yes, off Replit** | Client ID from your identity provider. Inside a Replit workspace `REPL_ID` is used automatically |
| `STORAGE_DRIVER` | **Yes, in production** | `local` or `supabase`. Defaults to `local` in development; the server refuses to start without it in production rather than silently lose files |

Everything else is optional and documented in `.env.example`: the remaining `OIDC_*`
settings, the Supabase storage credentials, database TLS and pool tuning,
`MAX_UPLOAD_BYTES_IN_FLIGHT`, `UPLOAD_DIR` and `PORT`.

Outbound email is one of those optional groups and is worth calling out: with
`RESEND_API_KEY` and `EMAIL_FROM` unset the app runs normally and simply sends nothing.
Set **both** to turn it on — setting only one fails the boot check on purpose, because a
half-configured mailer that silently drops messages is worse than one that is off.

If anything required is missing, the server refuses to start and prints **every** missing value at once, rather than failing hours later when someone tries to log in or upload a file.

Never commit a real `.env` — it is gitignored.

### 3. Create the database tables

```bash
npm run db:migrate
```

Every table the app needs, including the `sessions` table the login store depends on, comes from the migrations. The app does **not** create anything at startup, so this step is required before the first sign-in.

> Pointing at a database that already has the tables but no migration history? Run `npm run db:baseline -- <tag>` once first, naming the migration whose schema that database already matches — it records everything up to and including that one as applied, so `db:migrate` does not try to create it again. A database matching the app as it stood before the audit log was added should use `npm run db:baseline -- 0002_drop_monday_item_id`. Bare `npm run db:baseline` records only the first migration and is right only for a database that matches `0000` alone. If the tag does not match what is actually there, the command refuses and tells you which table or column is wrong rather than recording a history that is not true.

### 4. Start it

```bash
npm run dev
```

The app serves the API and the frontend together on a single port (5000 by default).

> **First user:** whoever signs in first is created as a `resident`. Promote them to `admin` directly in the database (`users.role`) to unlock the admin pages.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start in development with hot reloading |
| `npm run build` | Build the frontend with Vite and bundle the server with esbuild into `dist/` |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint over the server, the client and the shared code |
| `npm run check` | TypeScript type check. Should always pass with zero errors |
| `npm test` | Run the test suite (Vitest) |
| `npm run test:e2e` | Run the end-to-end tests in a real browser (Playwright). Needs a database with demo data in it, which `npm test` does not |
| `npm run db:generate` | Write a migration file from a change to `shared/schema.ts` |
| `npm run db:migrate` | Apply pending migrations. **This is how schema changes reach production** |
| `npm run db:baseline -- <tag>` | Record existing tables as already migrated, through `<tag>`, for a database that predates `migrations/` |
| `npm run db:seed` | Fill an **empty** database with demo data (properties, requests, vendors, photos). Refuses to run if any properties exist. `SEED_ADMIN_EMAIL=you@spo.org` pre-creates an admin so your first sign-in skips the SQL promotion |
| `npm run db:push` | Push the schema directly with no migration. Development experiments only |

---

## Checks before you push

Four commands, in this order. All four must pass:

```bash
npm run lint     # mistakes: unused variables, conditional hooks, dead code
npm run check    # TypeScript
npm test         # the test suite
npm run build    # the production build actually builds
```

`.github/workflows/ci.yml` runs exactly these four on every push and every pull
request, so anything you skip locally will be caught there instead. CI needs no
secrets and never touches the database, the file store or the login provider.

The end-to-end tests are not among those four. `.github/workflows/e2e.yml` runs
`npm run test:e2e` on its own, driving a real browser against a throwaway
Postgres, because it needs a database and a browser that the four checks above
deliberately do without. Run it locally when you have changed how a screen
behaves and want to watch the whole flow work.

### About the linter

It is configured to catch mistakes, not to enforce a style. Formatting rules
are deliberately left off: switching them on would reformat the whole codebase
in one commit and bury every real change afterwards.

`npm run lint` must report **zero errors**. Warnings are allowed, and there are
currently eight, all from the React Compiler rules. Seven are in our own
components and pages; one is in the generated `components/ui/` files, which are
upstream shadcn/ui code we do not hand-edit. They are worth reading, they do not
block a merge, and clearing them is tracked as issue #37.

### About the tests

`npm test` needs no database, no storage bucket, no login provider and no
secrets — everything external is replaced with a stand-in — so it is safe to
run anywhere and takes a couple of seconds.

The one exception is `auditRetention.integration.test.ts`, which needs real
SQL to be worth anything. It runs only when `TEST_DATABASE_URL` (or
`DATABASE_URL`) is set, and skips silently otherwise, so CI and a fresh
checkout are unaffected. When it does run it works inside a schema it creates
and drops for that run, never the application's own tables.

The suite is weighted towards **who is allowed to do what**, because that is
where a mistake is expensive and silent:

| File | Covers |
|---|---|
| `server/__tests__/authz.test.ts` | The permission and region rules on their own: the admin bypass, region matching including the legacy format, resident ownership |
| `server/__tests__/routeAccess.test.ts` | The same rules over real HTTP, through the real login guard and the real route handlers |
| `server/__tests__/ownership.test.ts` | A resident reaching another resident's maintenance request |
| `server/__tests__/uploadAccess.test.ts` | Which attachments a given account may read |
| `server/__tests__/objectStorage.test.ts` | Storage keys, including the ones that try to escape the uploads folder |
| `server/__tests__/audit.test.ts` | The audit log never storing a credential and never failing a request |
| `server/__tests__/auditRetention.integration.test.ts` | The retention query against a real PostgreSQL database: expired routine entries go in batches, account and permission history stays |
| `server/__tests__/errors.test.ts` | Failures becoming clean responses instead of stack traces |
| `server/__tests__/region.test.ts` | Turning region names into one canonical form |
| `server/__tests__/upsertUserRelink.test.ts` | An account re-linking to a new provider ID by email, keeping its role and permissions |
| `server/__tests__/actionItems.test.ts` | What the dashboard raises, and in what order |
| `server/__tests__/regionSummary.test.ts` | The per-region rollup, including what is deliberately left out of "health" |
| `server/__tests__/schedules.test.ts` | Due schedules generating a request once, not once a day |
| `server/__tests__/seasonalTasks.test.ts` | The reminder calendar, and the `sourceKey` that stops duplicates |
| `server/__tests__/email.test.ts` | Sends failing softly, and never throwing into the request that triggered them |
| `scripts/__tests__/baselineMigrations.test.ts` | The baseline command refusing a tag the database does not actually match |

Three habits worth keeping when you add to them:

- **Test the real module, not a copy of it.** An earlier version of
  `region.test.ts` re-implemented the region rules inside the test file. The
  tests passed for months while the rule that actually runs drifted away from
  them.
- **Assert that refused work never happened**, not just that the status code
  was 403. `expect(putUpload).not.toHaveBeenCalled()` is what proves the check
  ran *before* the file was written rather than after.
- **When ordering is the requirement, instrument the stage itself and add a
  positive control.** Proving an upload is refused before the body is read
  means spying on the multipart parser; and one accepted request has to prove
  the spy actually fires, or every "was not called" assertion is vacuous.

---

## Project layout

```
client/                 React frontend
  src/
    pages/              One file per screen, split by role
                        (Walkthroughs.tsx is the staff index, MyWalkthroughs.tsx
                        the resident one; both open WalkthroughRun.tsx.
                        FlaggedItems.tsx lists what came back poor or damaged)
    components/         Shared components
      ui/               shadcn/ui primitives (generated — avoid hand-editing)
    hooks/              useAuth and friends
    lib/                Query client and helpers
server/                 Express backend
  index.ts              Entry point, middleware, error handler
  routes.ts             Every API endpoint
  auth.ts               OpenID Connect login — the only provider-aware file
  authz.ts              Who may do what: permissions, regions, ownership
  audit.ts              Records access, money and document events
  actionItems.ts        What the dashboard says needs attention (pure, testable)
  maintenanceStatus.ts  When a request closed, from its status transition (pure)
  walkthroughTemplate.ts What a new walkthrough starts out containing (pure)
  residentImport.ts     Roster CSV parsing, validation and duplicates (pure)
  regionSummary.ts      The per-region rollup for a national admin (pure)
  schedules.ts          Preventive/safety schedules and their daily generator
  seasonalTasks.ts      Calendar reminders (walkthroughs, utilities) as tasks
  migrateRegions.ts     Idempotent startup fix-ups for legacy region spellings
  email.ts              The only code that talks to Resend; off until configured
  errors.ts             Error classification and the final error middleware
  storage.ts            All database access, behind one interface
  db.ts                 Drizzle over the standard pg pool
  config.ts             Boot-time configuration checks and OIDC settings
  security.ts           Security headers and rate limits
  uploadLimits.ts       Per-file size limits and the in-flight memory ceiling
  health.ts             GET /api/health for the hosting platform
  objectStorage/        Where uploaded files are kept (local or Supabase)
  static.ts             Serves the built client in production
  vite.ts               Dev server wiring (development only)
  __tests__/            Vitest suites
shared/
  schema.ts             Drizzle tables and Zod types — the source of truth
migrations/             Committed SQL migrations, applied with db:migrate
scripts/                One-off maintenance scripts
docs/                   Additional documentation
```

Path aliases: `@/` → `client/src/`, `@shared/` → `shared/`, `@assets/` → `attached_assets/`.

---

## How the security model works

Worth understanding before changing anything server-side.

- **Every data route requires a session**, and a session alone is not enough: the account must still be active. A deactivated user keeps their cookie until it expires, so the active check is what actually revokes access.
- **Permissions live in the database**, one row of flags per user, plus a list of allowed regions. Admins bypass both — they frequently have no permissions row at all, and any check that reads only the row will lock them out.
- **Regions fail closed.** An empty region list grants access to nothing, not everything. Updates check both the record's current region and the incoming one, so a record cannot be moved somewhere the user cannot reach.
- **Uploaded files are not public.** `GET /uploads/:filename` requires a session and authorizes against the record that references the file. Production hands out a short-lived signed link; the bucket itself is private.
- **Uploads are refused before the body is read.** The permission check sits ahead of the multipart parser, so someone with no right to upload cannot push megabytes into the server's memory.
- **Errors never leak internals.** Only messages the app wrote itself reach the client; everything else becomes a generic message with the detail logged server-side.

### Audit log

The `audit_log` table records the actions somebody may have to account for later: user, permission and house-link changes, maintenance status changes, invoice and billing changes, rent charge and security-deposit changes, and document uploads and downloads. Photo views are deliberately not recorded — there are far too many of them and they would bury everything else.

Admins can read it in the app: Settings shows the activity trail, backed by
`GET /api/audit-log`. It can also be read directly with SQL:

```sql
select created_at, actor_email, action, summary
from audit_log
order by created_at desc
limit 50;
```

Two guarantees, both covered by tests: it never stores a credential, and a failure to write it never fails the user's request. Entries do contain names, filenames and email addresses — that is what makes the log worth reading — but each one is length-capped before it is stored.

Routine entries (document downloads, uploads, invoice and billing changes, and maintenance status changes) are retained for **two years**. Account and access history (user creation and deletion, role, status and permission changes, and the house a resident login is linked to) is kept indefinitely because it is rare and most likely to be needed later — the house link is on that list because it decides which house's records that login can read. The server runs this cleanup automatically once a day, deleting routine rows in batches of at most 1,000 so it does not issue one large table-locking delete. There is no in-app clear-log action.

### Financial data

The portal **never** stores raw bank account numbers, routing numbers, card numbers, CVVs or ACH credentials. Any future payments work goes through QuickBooks or Ramp, the two SPO uses, and this database keeps only references, statuses, dates and amounts. The reasoning is in `CLAUDE.md` under "Financial data" — treat it as a standing rule, not a preference.

---

## Deployment

The app is an ordinary Node web service. Any host that can run Node 20 and reach a Postgres database will do; **Render** is the intended home.

- **Build:** `npm run build`
- **Start:** `npm run start`
- **Health check:** `GET /api/health` — returns 200 when the process is serving *and* the database answers, 503 otherwise
- **Port:** taken from `PORT`, listening on `0.0.0.0`. Defaults to 5000

The build produces `dist/index.js` (server) and `dist/public/` (frontend). The server bundle depends only on production dependencies — Vite and the other build tools are not needed at runtime, so `npm ci --omit=dev` is enough to run it.

**Before the first start on a new host**, set at least `DATABASE_URL`, `SESSION_SECRET`, `STORAGE_DRIVER`, `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID`, and apply the migrations with `npm run db:migrate`.

Two things to know about running more than one instance:

- **Uploads must not use `STORAGE_DRIVER=local`.** Local files live on one instance's disk and disappear when the host replaces it. Use `supabase`.
- **Shutdown is graceful.** On `SIGTERM` the server stops accepting connections, lets in-flight requests finish, closes the database pool, and exits — so a rolling deploy does not cut anyone off mid-request.

**Going to production for the first time?** Follow [`docs/PRODUCTION_MIGRATION.md`](docs/PRODUCTION_MIGRATION.md) rather than improvising. It is staging-first and lists what has to be configured inside Google Workspace and Supabase, which are the two steps nobody can do from this repository.

---

## Known issues

- **Deleting a photo or document leaves the file in storage.** The record disappears from the app, but the file stays in the bucket and keeps costing space.
- **Files uploaded before the current storage layout are unreachable.** Their links no longer resolve. Nothing in the app depends on them.
- **A record outside your regions answers 403, not 404**, which confirms it exists. Knowingly accepted: the people using this portal all work for the same organisation.
- **Maintenance requests closed before the close date was recorded have none.** The portal only started writing a close date recently, and there is no way to work out when an older request was closed. They are deliberately not backfilled, because a guessed date is worse than none once a resident's view depends on it.

---

## More documentation

| Document | What it covers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Detailed architecture, data model, conventions, standing rules and gotchas — written for AI coding assistants, but the most useful document here for any engineer |
| [`docs/PRODUCTION_MIGRATION.md`](docs/PRODUCTION_MIGRATION.md) | The staging-first runbook for standing up Supabase, Google Workspace login and Render |
| [`design_guidelines.md`](design_guidelines.md) | Typography, spacing, layout and component design rules |
| [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) | The current backlog: what has shipped, what is blocked and on whom, and what is deliberately left for later |
| [`docs/spo-design-system.md`](docs/spo-design-system.md) | The shared SPO design system — the authority behind `design_guidelines.md` |
