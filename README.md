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

**Database** — PostgreSQL (Neon serverless driver) with Drizzle ORM and Drizzle Kit. The schema is the single source of truth and lives in `shared/schema.ts`.

**File storage** — Replit App Storage (object storage backed by Google Cloud Storage) holds uploaded photos and documents, so they survive restarts and publishes.

**Integrations** — Monday.com (maintenance requests sync to regional boards) and JotForm (a webhook turns form submissions into maintenance requests). Both are optional.

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
| `MONDAY_API_KEY` | No | Monday.com sync. The feature is skipped silently if unset |
| `JOTFORM_WEBHOOK_SECRET` | Recommended | Shared secret for the JotForm webhook. **Without it the webhook is disabled and returns 503** |
| `JOTFORM_FIELD_*` | No | JotForm field ID mappings (TITLE, DESCRIPTION, CATEGORY, PRIORITY, LOCATION, EMAIL, REGION, BUILDING) |
| `JOTFORM_DEFAULT_*` | No | Fallback values for JotForm submissions (REGION, BUILDING, LOCATION) |
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
| `npm run check` | TypeScript type check. Should always pass with zero errors |
| `npm run db:push` | Push `shared/schema.ts` to the database. **Run this after any schema change** |

There is no test suite and no linter configured yet.

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
  db.ts                 Drizzle + Neon connection
  monday.ts             Monday.com integration
  objectStorage.ts      Replit App Storage — where uploaded files are kept
  vite.ts               Dev server / static file wiring
shared/
  schema.ts             Drizzle tables and Zod types — the source of truth
scripts/                One-off maintenance scripts
docs/                   Additional documentation
```

Path aliases: `@/` → `client/src/`, `@shared/` → `shared/`, `@assets/` → `attached_assets/`.

---

## Deployment

The app is deployed on Replit using **autoscale**:

- Build: `npm run build`
- Run: `npm run start`
- Port 5000 internally, exposed on port 80

Autoscale rebuilds the container on every publish and may run several instances at once. Uploaded files are kept in App Storage rather than on the container, so they are unaffected by this.

Files that were uploaded before the move to App Storage were copied across with `node scripts/migrate-uploads-to-object-storage.mjs`. That script is safe to re-run — it verifies every file arrives byte for byte and never deletes the local copies.

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
