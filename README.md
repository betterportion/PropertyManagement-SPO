# SPO Admin Portal

A property management portal for **Saint Paul's Outreach, Inc. (SPO)**.

Staff use it to manage properties, maintenance requests, walkthrough inspections, physical assets, vendor contacts, and invoices. Residents use it to submit maintenance requests and follow their progress.

---

## Who uses it

The portal serves three kinds of user, and each sees a completely different set of pages.

| Role | What they can do |
|---|---|
| **Admin** | Full access to everything, including user management and permissions. Bypasses per-feature permission checks. |
| **Regional administrator** | Manages properties, maintenance, walkthroughs, assets, contacts and invoices — but only for the regions they have been granted. |
| **Resident** | Submits maintenance requests and tracks their own. Cannot see anyone else's data. |

On top of the role, each user has a row of fine-grained permissions (view/manage per feature) and a list of allowed regions. Admins ignore both.

---

## Tech stack

**Frontend** — React 18 + TypeScript, Vite, Wouter for routing, TanStack Query for server state, React Hook Form + Zod for forms, Tailwind CSS with shadcn/ui (New York style) on Radix primitives.

**Backend** — Express on Node 20, TypeScript with ESM, Passport with `openid-client` for OpenID Connect login, `express-session` backed by PostgreSQL.

**Database** — PostgreSQL over the standard `pg` driver, with Drizzle ORM and Drizzle Kit. Any Postgres works: Supabase, Render, RDS, or one you run yourself. The schema is the single source of truth and lives in `shared/schema.ts`.

**File storage** — either the local filesystem (development) or a private Supabase Storage bucket (production), chosen with `STORAGE_DRIVER`.

**Integrations** — JotForm: a webhook turns form submissions into maintenance requests. Optional.

**Hosting** — an ordinary Node service. It needs a Postgres connection string and the environment variables below, and nothing specific to any one hosting provider.

---

## Running it from a fresh clone

### 1. Install dependencies

```bash
npm install
```

### 2. Set the environment variables

`.env.example` lists everything the app reads:

```bash
cp .env.example .env
```

> **Note:** the app does **not** read a `.env` file automatically — there is no `dotenv` in the project. On Replit, values come from the Secrets pane. Elsewhere, export them in your shell or have your host inject them (`set -a && . ./.env && set +a` works for local use).

Three variables are required before the app will start:

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string |
| `SESSION_SECRET` | **Yes** | A long random string used to sign session cookies |
| `OIDC_CLIENT_ID` *or* `REPL_ID` | **Yes** | Login client ID. On Replit `REPL_ID` is provided automatically; anywhere else set `OIDC_CLIENT_ID` or startup fails |
| `OIDC_ISSUER_URL` | No | Identity provider discovery root. Defaults to `https://replit.com/oidc`. `ISSUER_URL` is accepted as an older alias |
| `OIDC_CLIENT_ID` | No | Client ID from your identity provider. Overrides `REPL_ID` |
| `OIDC_CLIENT_SECRET` | No | Client secret, if your provider issues one |
| `OIDC_PROVIDER_NAME` | No | Internal login strategy label. Defaults to `replitauth` |
| `OIDC_SCOPES` | No | Space-separated scopes. Defaults to `openid email profile offline_access` |
| `JOTFORM_WEBHOOK_SECRET` | Recommended | Shared secret for the JotForm webhook. **Without it the webhook is disabled and returns 503** |
| `JOTFORM_FIELD_*` | No | JotForm field ID mappings (TITLE, DESCRIPTION, CATEGORY, PRIORITY, LOCATION, EMAIL, REGION, BUILDING) |
| `JOTFORM_DEFAULT_*` | No | Fallback values for JotForm submissions (REGION, BUILDING, LOCATION) |
| `MAX_UPLOAD_BYTES_IN_FLIGHT` | No | Ceiling on how much upload data may be processed at once, in bytes. Defaults to 64MB. Uploads beyond it get a "try again in a few seconds" response rather than exhausting memory |
| `PORT` | No | Defaults to 5000 |

Never commit a real `.env` — it is gitignored.

### 3. Create the database tables

```bash
npm run db:push
```

The session table creates itself on first start, but every application table comes from this command, so run it before signing in.

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
| `npm run db:push` | Push `shared/schema.ts` to the database. **Run this after any schema change** |
| `npm run db:generate` | Generate a migration from a schema change |
| `npm run db:migrate` | Apply pending migrations |

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

### About the linter

It is configured to catch mistakes, not to enforce a style. Formatting rules
are deliberately left off: switching them on would reformat the whole codebase
in one commit and bury every real change afterwards.

`npm run lint` must report **zero errors**. Warnings are allowed, and there are
currently about ten. They come from the React Compiler rules and mostly point
at the generated `components/ui/` files, which are upstream shadcn/ui code we
do not hand-edit. They are worth reading, but they do not block a merge.

### About the tests

`npm test` needs no database, no storage bucket, no login provider and no
secrets — everything external is replaced with a stand-in — so it is safe to
run anywhere and takes a couple of seconds.

The suite is weighted towards **who is allowed to do what**, because that is
where a mistake is expensive and silent:

| File | Covers |
|---|---|
| `server/__tests__/authz.test.ts` | The permission and region rules on their own: the admin bypass, region matching including the legacy format, resident ownership |
| `server/__tests__/routeAccess.test.ts` | The same rules over real HTTP, through the real login guard and the real route handlers |
| `server/__tests__/ownership.test.ts` | A resident reaching another resident's maintenance request |
| `server/__tests__/uploadAccess.test.ts` | Which attachments a given account may read |
| `server/__tests__/objectStorage.test.ts` | Storage keys, including the ones that try to escape the uploads folder |
| `server/__tests__/errors.test.ts` | Failures becoming clean responses instead of stack traces |
| `server/__tests__/region.test.ts` | Turning region names into one canonical form |

Two habits worth keeping when you add to them:

- **Test the real module, not a copy of it.** An earlier version of
  `region.test.ts` re-implemented the region rules inside the test file. The
  tests passed for months while the rule that actually runs drifted away from
  them.
- **Assert that refused work never happened**, not just that the status code
  was 403. `expect(putUpload).not.toHaveBeenCalled()` is what proves the check
  ran *before* the file was written rather than after.

---

## Project layout

```
client/                 React frontend
  src/
    pages/              One file per screen, split by role
    components/         Shared components
      ui/               shadcn/ui primitives (generated — avoid hand-editing)
    hooks/              useAuth and friends
    lib/                Query client and helpers
server/                 Express backend
  index.ts              Entry point, middleware, error handler
  routes.ts             Every API endpoint
  auth.ts               OpenID Connect login — the only provider-aware file
  storage.ts            All database access, behind one interface
  db.ts                 Drizzle over the standard pg pool
  config.ts             Boot-time configuration checks and OIDC settings
  security.ts           Security headers and rate limits
  health.ts             GET /api/health for the hosting platform
  objectStorage/        Where uploaded files are kept (local or Supabase)
  static.ts             Serves the built client in production
  vite.ts               Dev server wiring (development only)
shared/
  schema.ts             Drizzle tables and Zod types — the source of truth
scripts/                One-off maintenance scripts
docs/                   Additional documentation
```

Path aliases: `@/` → `client/src/`, `@shared/` → `shared/`, `@assets/` → `attached_assets/`.

---

## Deployment

The app is an ordinary Node web service. Any host that can run Node 20 and reach a Postgres database will do.

- **Build:** `npm run build`
- **Start:** `npm run start`
- **Health check:** `GET /api/health` — returns 200 when the process is serving *and* the database answers, 503 otherwise
- **Port:** taken from `PORT`, listening on `0.0.0.0`. Defaults to 5000

The build produces `dist/index.js` (server) and `dist/public/` (frontend). The server bundle depends only on production dependencies — Vite and the other build tools are not needed at runtime, so `npm ci --omit=dev` is enough to run it.

**Before the first start on a new host**, set at least `DATABASE_URL`, `SESSION_SECRET`, `STORAGE_DRIVER`, `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID`. If anything required is missing the server refuses to start and prints every missing value at once, rather than failing later when someone tries to log in or upload a file.

Two things to know about running more than one instance:

- **Uploads must not use `STORAGE_DRIVER=local`.** Local files live on one instance's disk and disappear when the host replaces it. Use `supabase`.
- **Shutdown is graceful.** On `SIGTERM` the server stops accepting connections, lets in-flight requests finish, closes the database pool, and exits — so a rolling deploy does not cut anyone off mid-request.

---

## Known issues

- **Residents see an empty list on "My Requests".** Requests are saved with the submitter's email address, but the resident view looks them up by account ID, so the two never match. Staff pages are unaffected.
- **Vendor contacts linked to a maintenance request are visible to any signed-in user**, including residents, if they know the request's ID. That one endpoint is missing its permission check.
- **Admins with no permissions row are locked out of the maintenance pages.** Every other section lets admins through automatically; maintenance does not.
- **The JotForm webhook is turned off** until `JOTFORM_WEBHOOK_SECRET` is set. It returns 503 rather than accepting unauthenticated submissions.
- **No error boundary in the frontend**, so an unexpected display error shows a blank page rather than a message.

The full list, including lower-priority items, is in [`docs/PRE_GITHUB_AUDIT.md`](docs/PRE_GITHUB_AUDIT.md).

---

## More documentation

| Document | What it covers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Detailed architecture, data model, conventions and gotchas — written for AI coding assistants, but useful to anyone |
| [`replit.md`](replit.md) | Replit-specific setup, the change log, and how to swap the login provider |
| [`design_guidelines.md`](design_guidelines.md) | Typography, spacing, layout and component design rules |
| [`docs/PRE_GITHUB_AUDIT.md`](docs/PRE_GITHUB_AUDIT.md) | Security and reliability audit, with each finding marked resolved or open |
