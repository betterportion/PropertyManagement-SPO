# ONBOARDING AUDIT — PropertyManagement-SPO

Audit of commit `d585158` (2026-08-23), performed read-only from a fresh clone of
https://github.com/betterportion/PropertyManagement-SPO. Every claim below was
checked against code; documentation was treated as unverified. Where a doc and
the code disagree, the discrepancy is called out with file:line.

> **⚠️ Historical document — do not read this as a description of the code today.**
> It records what a read-only audit found on **2026-08-23**, and it is kept for that
> reason: it says what was wrong and why, which is worth having. The code has moved a
> long way since. In particular, everything JotForm — the webhook, its shared secret,
> its field-mapping variables — was **removed** (2026-08-26, SPO decision); residents
> submit through the portal's own form. The schema has grown from 15 tables to 21,
> and the endpoint and permission-flag counts below are all from that commit.
>
> For how the system works now, read [`CLAUDE.md`](../CLAUDE.md); for what is left to
> build, [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).

> **Status update (2026-08-23, branch `onboarding-fixes`):** the findings below
> describe commit `d585158` as audited — every count and command output in this
> document (lint warnings, file counts, test totals) reflects that commit,
> before the fixes on this branch. On this branch the following have since
> been APPLIED: the §1 test-gate fix (both suites now stub the db module;
> `npm test` passes with no `DATABASE_URL`), the §4 deletions rows 1-7
> (25 ui primitives, 2 dead components, the Replit load-test script,
> `PRE_GITHUB_AUDIT.md`, and 33 npm packages), and the §3.4 doc corrections.
> Still OUTSTANDING: everything in §5A (external provisioning), the
> `drizzle-orm` advisory, the `question_answers` column drop (§4 row 8), the
> Replit-devDependencies decision (§4 row 9), and recovering the SPO design
> system document referenced by `design_guidelines.md`. These are tracked as
> GitHub issues.

---

## 1. DOES IT ACTUALLY WORK

Commands run in order on a fresh clone, Node 25/npm on macOS, no `.env`.

| Command | Result | Detail |
|---|---|---|
| `npm ci` | **PASS** | Clean install. `npm audit` reports **1 high advisory: `drizzle-orm`** (prod dependency). |
| `npm run lint` | **PASS** | `eslint .` — **0 errors, 8 warnings** (React Compiler rules: `MaintenanceEditDialog.tsx:280`, `PhotoUpload.tsx:22`, `ui/carousel.tsx:112`, `ui/sidebar.tsx:613`, `hooks/use-mobile.tsx:14`, `pages/Assets.tsx:204`, `pages/Settings.tsx:86`, `pages/Styleguide.tsx:81`). |
| `npm run check` | **PASS** | `tsc` — 0 errors. |
| `npm test` | **FAIL** (exit 1) | Vitest: **2 test files failed, 7 passed, 1 skipped; 243 tests passed, 4 skipped.** `server/__tests__/ownership.test.ts` and `server/__tests__/region.test.ts` crash **at import time** with `Error: DATABASE_URL must be set...` thrown from `server/db.ts:16`. |
| `npm run build` | **PASS** | Vite client build (691 kB JS chunk, chunk-size warning) + esbuild server bundle `dist/index.js` (137 kB). Cosmetic warnings: stale `caniuse-lite`, a PostCSS `from`-option notice. |

### The test failure (bug — recorded, not fixed)

- Root cause: `server/migrateRegions.ts:9` (`import { db } from "./db"`) runs at
  module load, and `server/db.ts:13-19` throws when `DATABASE_URL` is unset.
  `region.test.ts:2` imports `../migrateRegions` directly;
  `ownership.test.ts` reaches it via `server/authz.ts:29`. The other suites
  survive only because they stub the module (`vi.mock("../db", ...)` at
  `authz.test.ts:18`, `routeAccess.test.ts:24`); these two do not.
- Introduced in commit `45527db` ("Refactor contact routes and migrate regions
  logic"), which created `authz.ts` and `migrateRegions.ts`.
- **GitHub Actions CI on `main` is currently red for exactly this reason** —
  run 32638881183 ("Clear the esbuild advisory...", 2026-08-23) failed in the
  Tests step with the same `DATABASE_URL` error.
- This directly contradicts three documents:
  - `CLAUDE.md:26` — "`npm test` ... Needs no database, no bucket, no secrets."
  - `README.md:140-142` — "`npm test` needs no database ... safe to run anywhere."
  - `.github/workflows/ci.yml:5-7` — "Nothing here needs a secret."

**Verdict: builds and type-checks cleanly; the test gate the docs describe as
green is broken on a fresh clone and in CI.**

---

## 2. WHAT IT TAKES TO RUN OUTSIDE REPLIT

### 2.1 Complete `process.env` inventory

Client code reads **zero** environment variables (`grep -rn "import.meta.env" client/ shared/` → no hits). Everything is server-side.

**Validated at boot** — `server/index.ts:160` calls `validateConfiguration()` (`server/config.ts:179-199`) before any route/db module loads, and reports all problems at once:

| Variable | Required? | Read by | If missing at boot |
|---|---|---|---|
| `DATABASE_URL` | **Required always** | `server/config.ts:46`, `server/db.ts:13`, `drizzle.config.ts:3`, `scripts/baseline-migrations.ts:206` | Startup aborts with the aggregated config report (`config.ts:47-52`). Also required by `db:migrate`/`db:generate`/`db:push` (`drizzle.config.ts:3-4` throws). |
| `SESSION_SECRET` | **Required always** | `server/config.ts:70`, `server/auth.ts:56` | Startup aborts (`config.ts:72-77`). In production must be ≥32 chars (`config.ts:83-88`). |
| `OIDC_ISSUER_URL` (legacy alias `ISSUER_URL`) | **Required off Replit** | `server/config.ts:26-28` | Startup aborts (`config.ts:108-113`). On Replit defaults to `https://replit.com/oidc` (`config.ts:28`). |
| `OIDC_CLIENT_ID` | **Required off Replit** | `server/config.ts:31` | Startup aborts (`config.ts:100-106`). On Replit falls back to `REPL_ID` (`config.ts:31`). |
| `STORAGE_DRIVER` | **Required in production**; optional in dev (defaults `local`) | `server/objectStorage/index.ts:21` | Production: startup aborts (`objectStorage/index.ts:37-42`, surfaced via `config.ts:137-144`). Development: silently `local` (`index.ts:44`). `local` in production only warns (`config.ts:157-162`). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | **Required when `STORAGE_DRIVER=supabase`** | `server/objectStorage/supabase.ts:28-29`; `SUPABASE_URL` also read for the CSP (`server/security.ts:14`) | Startup aborts via `config.ts:146-152`. |

**Optional (safe defaults):**

| Variable | Default | Read by |
|---|---|---|
| `OIDC_CLIENT_SECRET` | none (public client/PKCE) | `server/config.ts:34` |
| `OIDC_PROVIDER_NAME` | `replitauth` | `server/config.ts:37` |
| `OIDC_SCOPES` | `openid email profile offline_access` | `server/config.ts:40` (Google rejects `offline_access` — must override there) |
| `SUPABASE_STORAGE_BUCKET` | `uploads` | `server/objectStorage/supabase.ts:30` |
| `UPLOAD_DIR` | `uploads` | `server/objectStorage/index.ts:52` |
| `DATABASE_SSL` | `require` for remote hosts | `server/db.ts:45`, `scripts/baseline-migrations.ts:214-216` |
| `DATABASE_POOL_MAX` | `10` | `server/db.ts:72` |
| `PORT` | `5000` | `server/index.ts:203` |
| `MAX_UPLOAD_BYTES_IN_FLIGHT` | 64 MB | `server/uploadLimits.ts:30` |
| `NODE_ENV` | set by npm scripts (`package.json:10,12`) | `server/config.ts:4`, `server/objectStorage/index.ts:37`, `vite.config.ts:12` |
| `JOTFORM_WEBHOOK_SECRET` | unset → webhook returns 503 (fails closed) | `server/routes.ts:1676` |
| `JOTFORM_FIELD_{TITLE,DESCRIPTION,CATEGORY,PRIORITY,LOCATION,EMAIL,REGION,BUILDING}` | keyword auto-detection fallback | `server/routes.ts:1717,1786-1793` |
| `JOTFORM_DEFAULT_{REGION,BUILDING,LOCATION}` | `'Unknown'`/location | `server/routes.ts:1742-1748` |
| `TEST_DATABASE_URL` | unset → integration test skips | `server/__tests__/auditRetention.integration.test.ts:25` |

`.env.example` matches this inventory and correctly states there is **no dotenv** — nothing loads `.env` automatically (`.env.example:4`).

### 2.2 Every Replit branch point

| Location | What Replit supplied | What you must supply now |
|---|---|---|
| `server/config.ts:12` — `onReplit = process.env.REPL_ID !== undefined` | `REPL_ID` (workspace ID, auto-injected) | Nothing — off Replit this is simply false. |
| `server/config.ts:28,31,37` — issuer/clientId/strategy defaults | Replit Auth: issuer `https://replit.com/oidc`, client ID = `REPL_ID`, no client secret (PKCE) | `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` (+ `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` for Google) from your own IdP. Replit Auth cannot be reused off replit.dev/app domains (`config.ts:96-98`). |
| `vite.config.ts:11-23` — dev-only dynamic import of `@replit/vite-plugin-runtime-error-modal`, `-cartographer`, `-dev-banner`, gated on `REPL_ID` and not-production | Editor overlay/banner plugins | Nothing — returns `[]` off Replit; `npm run build` verified working without them. The three packages remain as devDependencies (`package.json:98-100`). |
| `.replit:1` — `modules = [... "postgresql-16"]`, `.replit:48` — `integrations = ["javascript_database" ...]` | **A Replit-managed PostgreSQL database**, with `DATABASE_URL` injected as a secret | Your own Postgres + `DATABASE_URL`. **The data in that Replit database is not in this repo** (see 2.4). |
| `.replit:55-56` — `[objectStorage] defaultBucketID = "replit-objstore-3af58687..."` | A Replit App Storage bucket (used by an earlier storage layout) | Nothing for the code to run — current code only knows `local`/`supabase` drivers (`server/objectStorage/index.ts:11`). Files still in that bucket are unreachable by the current code (acknowledged at `README.md:278`). |
| `.replit:8-13` — autoscale deployment, build/run commands; `.replit:15-21` — port map; `.replit:51-53` — `postMerge` hook running `scripts/post-merge.sh` | Hosting, routing, post-merge npm install | Your own host (README targets Render, `README.md:35`). `scripts/post-merge.sh` is only invoked by Replit (`grep -rn post-merge` → `.replit:52` only). |
| `scripts/upload-concurrency-test.ts:12` — `REPLIT_DEV_DOMAIN` | The workspace's dev URL | Nothing — one-off manual load-test script, referenced by nothing (see §4). |

Runtime server code contains **no** other Replit references (`grep -rn "REPL_ID\|REPLIT\|@replit" server/ client/ shared/` → only `config.ts` and the comment lines cited above).

### 2.3 What breaks first, in order, on a fresh clone with an empty `.env`

1. `npm ci` — succeeds (verified; lockfile resolves entirely to registry.npmjs.org).
2. `npm test` — **fails** (section 1) — this is the first broken promise, before you even try to run it.
3. `npm run dev` — process exits 1 immediately. `server/index.ts:160` → `validateConfiguration()` throws one aggregated report naming **4 problems**: `DATABASE_URL`, `SESSION_SECRET`, `OIDC_CLIENT_ID`, `OIDC_ISSUER_URL` (`config.ts:179-198`; caught and exited at `index.ts:212-217`). In production mode `STORAGE_DRIVER` becomes a 5th (`objectStorage/index.ts:37`).
4. With env set but an empty database — the server starts, but the **first login fails**: the session store is `createTableIfMissing: false` (`server/auth.ts:51`), so the `sessions` table must exist. `npm run db:migrate` is mandatory before first sign-in (`README.md:75-80` is accurate here).
5. With migrations applied — login still requires an **externally registered OIDC client** whose allowed redirect URI is `https://<your-host>/api/callback` (built at `server/auth.ts:197`, https-forced except localhost at `auth.ts:182-187`).
6. First successful sign-in creates a **`resident`** account (`shared/schema.ts:22` — `role ... .default("resident")`). Reaching any admin page requires promoting that row by hand in SQL (`README.md:91` matches the code).

**Must be provisioned outside this repository before a human can log in:**
- A PostgreSQL database (any provider) → `DATABASE_URL`.
- An OpenID Connect client at an identity provider (intended: Google Workspace, per `docs/PRODUCTION_MIGRATION.md:160-228`) with `/api/callback` registered → `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and for Google `OIDC_SCOPES=openid email profile`.
- (Production only) A private Supabase Storage bucket + service-role key → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `STORAGE_DRIVER=supabase`.
- (Optional) JotForm form + shared secret → `JOTFORM_WEBHOOK_SECRET`.

### 2.4 Is schema + migrations enough for an empty database?

**Yes — structurally.** `migrations/0000_baseline_current_schema.sql` creates 14 tables including `sessions` (line 118) with its index (line 193); `0001` adds `uploads`, `0003`/`0004` add `audit_log` and its indexes — all 15 tables in `shared/schema.ts` are covered, and `scripts/baseline-migrations.ts` exists for a database that predates the migration history. Nothing is created at app startup except two idempotent data fix-ups (`server/index.ts:173-176` → `migrateRegionsToTitleCase`, `backfillBillingRegions` in `server/migrateRegions.ts`), both non-fatal on failure.

**No — for data.** The production **records live in the Replit-provisioned Postgres** (`.replit:1` `postgresql-16`, `.replit:48` `javascript_database` integration) and uploaded **files live partly in a Replit object-storage bucket** (`.replit:55-56`) — neither is represented in this repo in any form (no dumps, no seeds). `docs/PRODUCTION_MIGRATION.md:359` ("Step 9 — Bring the data across (optional)") confirms the data migration is a separate, manual step requiring Replit access. Note the current code cannot read the Replit bucket at all (`server/objectStorage/index.ts:11` — only `local | supabase`), so pre-migration files are stranded regardless (`README.md:278`).

---

## 3. WHAT THIS APP ACTUALLY DOES

A property-management portal: staff (admin / regional administrator) manage properties, maintenance requests, walkthrough inspections, assets, vendor contacts, invoices and billing records; residents submit and track their own maintenance requests; JotForm submissions can create requests via webhook. Role-based UI, permission flags + region scoping on every data route, private authenticated file uploads, and an append-only audit log with an admin-facing activity trail.

### 3.1 API endpoints — 59 total

`server/routes.ts` registers **55** handlers (docs say "~54", `CLAUDE.md:53`). All are behind `isAuthenticated` + `requireActiveUser` + a permission/ownership check except where noted.

- **Auth/user**: `GET /api/auth/user` (215 — only route a deactivated user may reach), `GET /api/users` (239), `PATCH /api/users/:id/role` (252), `PATCH /api/users/:id/status` (276), `GET/PATCH /api/users/:id/permissions` (300/318), `POST /api/users` (354), `DELETE /api/users/:id` (380) — all admin-gated except reading your own permissions (300).
- **Audit**: `GET /api/audit-log` (415) — admin-only paged activity trail.
- **Maintenance requests**: `GET` list/one (442/461), `POST` (480), `PATCH` (509), `DELETE` (545); linked contacts `GET/POST/DELETE /api/maintenance-requests/:id/contacts[/:contactId]` (567/591/608). Residents see only their own via ownership on `submittedBy` **email** (`server/authz.ts`, covered by `ownership.test.ts`).
- **Walkthroughs**: rooms CRUD (626/649/673/704), photos list/by-room/create/update/delete (726/740/754/772/795).
- **Assets**: CRUD (817/831/849/872); asset photos (1069/1091/1112/1136).
- **Uploads**: `POST /api/upload` images ≤10MB (969), `POST /api/upload-doc` docs ≤20MB (1052) — rate-limited, permission-checked *before* multer, extension+MIME+magic-byte validated (adm-zip walks docx at 1041); `GET /uploads/:filename` (1567) — authenticated, authorized against the referencing record, signed-URL or stream.
- **Contacts**: CRUD (1162/1176/1194/1217). **Invoices**: CRUD (1239/1253/1280/1316). **Billing records**: CRUD (1347/1361/1406/1441). **Properties**: CRUD (1472/1486/1509/1542).
- **JotForm**: `POST /api/webhooks/jotform` (1672 — shared-secret, no session, fails closed 503 without secret), `GET /api/webhooks/jotform/config` (1773 — staff).
- Plus `server/auth.ts`: `GET /api/login` (209), `/api/callback` (217), `/api/logout` (225); `server/health.ts:18`: `GET /api/health` (unauthenticated DB-backed 200/503).

### 3.2 Pages — 13 files, three role-based switches (`client/src/App.tsx:30-65`)

- Unauthenticated: `Landing` (`App.tsx:33-34`).
- Admin/regional administrator: `AdminDashboard` (/), `Properties`, `Maintenance`, `Walkthroughs`, `Assets`, `Contacts`, `Settings` (users + permissions + activity log), `Styleguide` (/styleguide, internal design reference) (`App.tsx:44-52`), `not-found` catch-all.
- Resident: `ResidentDashboard` (/), `SubmitRequest`, `MyRequests` (`App.tsx:60-63`), `not-found` catch-all.
- There are no route guards beyond the switch: unauthenticated users only ever render `Landing` (`App.tsx:30-37`), matching `CLAUDE.md:72`.

### 3.3 Tables — 15 (matches `CLAUDE.md:84`)

`sessions` (6), `users` (16), `user_permissions` (28 — 13 boolean flags + `allowedRegions`, matching `CLAUDE.md:90`), `maintenance_requests` (68), `walkthrough_rooms` (98), `walkthrough_photos` (119), `assets` (145), `asset_photos` (173), `maintenance_contacts` (194), `invoices` (217), `billing_records` (243), `properties` (280), `uploads` (319), `audit_log` (350), `request_contacts` (393) — all in `shared/schema.ts` at the cited lines. Every table is referenced by live code; one **column** is not (see §4: `walkthroughPhotos.questionAnswers`, `shared/schema.ts:128`).

### 3.4 Docs vs code — the discrepancies (code wins)

**Docs claim things that are FALSE in code (stale "known issues"):**

1. "**No frontend error boundary**" — `CLAUDE.md:250`, `README.md:280`, `docs/PRE_GITHUB_AUDIT.md:11`. False: `client/src/components/ErrorBoundary.tsx` exists and wraps the app at `client/src/main.tsx:10` and each page body at `client/src/App.tsx:109`.
2. "**`throw err` after responding** in the `index.ts` error handler can take the process down" — `CLAUDE.md:251` (and `CLAUDE.md:197`, `PRE_GITHUB_AUDIT.md:12`). False: the final handler lives in `server/errors.ts:231-249` and explicitly does **not** re-throw (comment at `errors.ts:228-230`); `server/index.ts` contains no throw-after-respond.
3. "**Nothing in the application reads the [audit] log back**" — `CLAUDE.md:211`, `README.md:234`, `replit.md:209`. False: `GET /api/audit-log` (`server/routes.ts:415`) is consumed by `client/src/components/ActivityLog.tsx:90-92`, shown to admins in Settings (commit `52c8534`).
4. "**`npm test` needs no database**" — `CLAUDE.md:26`, `README.md:140-142`, `ci.yml:5`. False since commit `45527db` — see section 1.
5. "**Two dependency advisories remain — drizzle-orm and vite**" — `CLAUDE.md:255`, `README.md:281`. Half-stale: vite was upgraded to 6.4.3 (commit `6236d8f`); `npm audit` now reports exactly **one** advisory (`drizzle-orm`, high).
6. "**~10 lint warnings**" — `CLAUDE.md:34`, `README.md:133-134`. Actual: **8**.
7. "**~54 handlers**" — `CLAUDE.md:53`. Actual: **55** in routes.ts.
8. "**Dates: `date-fns` on the frontend**" — `CLAUDE.md:243`. Its only importer is `client/src/components/WalkthroughGallery.tsx`, which nothing renders (see §4) — effectively dead.

**Docs reference things that do not exist in the repo:**

9. The **SPO Design System document** `attached_assets/spo-design-system_1786056605884.md` — cited as the design authority by `design_guidelines.md:9`, `replit.md:202`, and `client/src/index.css:8` — is **not in the repo** (`attached_assets/` contains only the logo PNG; the directory is gitignored with a single negation, `.gitignore:22-24`).

**In code but never mentioned by the docs:**

10. The billing-region backfill that runs on every boot (`server/migrateRegions.ts:41-74`, wired at `server/index.ts:176`).
11. `docs/PRE_GITHUB_AUDIT.md` says of itself "**Delete this file once the remaining two are done**" (`PRE_GITHUB_AUDIT.md:8`) — both remaining items (error boundary, throw-after-respond) are done in code, so by its own rule the file is due for deletion, but it remains.

(Counts that check out: 15 tables, 13 permission flags, 47 `components/ui` files, TanStack Query configured with `staleTime: Infinity`/no refetch/no retry exactly as `CLAUDE.md:73` says — `client/src/lib/queryClient.ts:43-56`.)

---

## 4. OVER-ENGINEERING / DELETE CANDIDATES

Sorted by confidence × lines removed. Nothing was deleted this session. "Grep" = command returning zero references, run from repo root; ui-primitive greps exclude `components/ui/` itself.

| # | What | Path | ~Lines | Evidence (zero-reference grep) | What breaks if removed | Confidence |
|---|---|---|---|---|---|---|
| 1 | **25 unused shadcn/ui primitives**: accordion, alert, aspect-ratio, avatar, breadcrumb, calendar, carousel, chart, collapsible, command, context-menu, drawer, hover-card, input-otp, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, slider, toggle, toggle-group | `client/src/components/ui/` | **~2,376** | Per file: `grep -rl "components/ui/<name>" client/src --include="*.tsx" --include="*.ts" \| grep -v "/components/ui/"` → empty for each. (`toggle.tsx`'s only importer is `toggle-group.tsx`, itself unimported.) | Nothing — no page or component imports them. Two of the 8 lint warnings (`carousel.tsx:112`, though not `sidebar.tsx`) disappear as a side effect. Keep `skeleton.tsx` (imported by used `ui/sidebar.tsx`). | **High** |
| 2 | **~22 npm packages orphaned by row 1**: `@radix-ui/react-{accordion,aspect-ratio,avatar,collapsible,context-menu,hover-card,menubar,navigation-menu,popover,progress,radio-group,scroll-area,slider,toggle,toggle-group}`, `react-day-picker`, `embla-carousel-react`, `recharts`, `cmdk`, `vaul`, `input-otp`, `react-resizable-panels` | `package.json:24-93` | (lockfile + node_modules weight) | Each is imported **only** by a file in row 1 — e.g. `grep -rln "recharts" client/src` → `components/ui/chart.tsx` only. Must keep `@radix-ui/react-slot`, `@radix-ui/react-dialog`, `class-variance-authority` (imported by kept files). | Nothing, **only together with row 1**. | **High** |
| 3 | **10 npm packages nothing imports at all**: `next-themes`, `passport-local`, `@types/passport-local`, `memorystore`, `react-icons`, `zod-validation-error`, `framer-motion`, `tw-animate-css`, `@tailwindcss/vite`, `@jridgewell/trace-mapping` | `package.json` | — | `grep -rn "<pkg>" server/ client/ shared/ scripts/ *.ts *.js` → 0 for each (`framer-motion`'s single hit is a comment, `server/security.ts:43`). ThemeProvider is hand-rolled (`client/src/providers/ThemeProvider.tsx` — no next-themes); auth uses `openid-client/passport` (`server/auth.ts:2` — no passport-local); sessions use `connect-pg-simple` (`server/auth.ts:7` — no memorystore); icons are all `lucide-react`; Tailwind is v3 via PostCSS (`postcss.config.js`), so the v4 `@tailwindcss/vite` plugin and `tw-animate-css` are inert. | Nothing. (`@jridgewell/trace-mapping`: medium — transitive tooling pin.) | **High** (9), medium (1) |
| 4 | **Dead component `WalkthroughGallery`** | `client/src/components/WalkthroughGallery.tsx` | 129 | `grep -rn "WalkthroughGallery" client/src \| grep -v WalkthroughGallery.tsx` → 0 | Nothing. Cascade: **`date-fns`** becomes fully unused (`grep -rln "date-fns" client/ server/ shared/ scripts/` → only this file). | **High** |
| 5 | **Dead component `PropertySelector`** | `client/src/components/PropertySelector.tsx` | 31 | `grep -rn "PropertySelector" client/src \| grep -v PropertySelector.tsx` → 0 | Nothing. | **High** |
| 6 | **One-off Replit load-test script** | `scripts/upload-concurrency-test.ts` | ~90 | `grep -rn "upload-concurrency" package.json scripts docs *.md .github .replit` → 0. Depends on `REPLIT_DEV_DOMAIN` (line 12), which no longer exists for you. | Nothing — not an npm script, not imported, not documented. | **High** |
| 7 | **Historical audit doc past its own expiry** | `docs/PRE_GITHUB_AUDIT.md` | 308 | Self-declared: "Delete this file once the remaining two are done" (`PRE_GITHUB_AUDIT.md:8`); both are done in code (§3.4 items 1-2). Referenced by `README.md:283,295` (links would need removing). | Two README links break. | Medium (doc, not code) |
| 8 | **Unused DB column `question_answers`** | `shared/schema.ts:128` (`walkthrough_photos`) | 1 + migration | `grep -rn "questionAnswers\|question_answers" server/ client/ shared/ scripts/` → only `shared/schema.ts:128`; no code names it and the UI never sends or displays it. Caveat: it is not `.omit()`-ed from `insertWalkthroughPhotoSchema` (`shared/schema.ts:135`), so `POST /api/walkthrough-photos` (`routes.ts:761` → spread insert `storage.ts:408`) would accept and store a value passed explicitly. | Requires a generated migration to drop plus an `.omit()` in the insert schema; any data already in the column in the Replit DB is lost (contents unverified from here). | Medium |
| 9 | **Replit dev-plugin devDependencies** | `package.json:98-100` (`@replit/vite-plugin-*` ×3) | — | Loaded only when `REPL_ID` is set (`vite.config.ts:12`) — i.e. never again, unless you keep developing inside Replit. | `vite.config.ts:16-22` would need its dynamic-import block removed in the same change, or dev inside Replit breaks. | Medium (deliberate portability shim) |
| 10 | **`scripts/post-merge.sh`** | `scripts/post-merge.sh` | 18 | Only referenced by `.replit:52-53` (`[postMerge]`) — a Replit-only hook. Not a git hook (`.git/hooks/` has none). | Nothing off Replit. Goes together with `.replit` itself if you abandon the workspace. | Medium |
| 11 | Minor: `EM_DASH` exported but never imported (`client/src/lib/format.ts:10`, used internally); `AUDIT_ACTION_LABELS` exported but only consumed via `auditActionLabel()` (`shared/audit.ts:41`); `getOidcConfig` re-validates config already rejected at boot (`server/auth.ts:22-29`, self-described as unreachable in normal startup) | — | ~0 | greps in §3 of the working notes | Nothing (export-keyword-level trivia). | High confidence, negligible value |

**Checked and NOT delete candidates:** all 15 tables are queried; all 59 endpoints are reached (the two with no client fetch are `GET /uploads/:filename` — fetched via stored URLs in DB rows — and the JotForm webhook, which is called by JotForm); `esbuild`/`tailwindcss-animate`/`@tailwindcss/typography` are used by build config (`package.json:11`, `tailwind.config.ts:119`); `adm-zip` validates docx magic bytes (`server/routes.ts:28,1041`); `memoizee` caches OIDC discovery (`server/auth.ts:6,20`); `bufferutil` is a transitive `ws` accelerator — leave it. The `IStorage` interface has exactly one implementation (`server/storage.ts:215`) but is load-bearing for the test suite's `vi.mock("../storage")` pattern — noted, not recommended for deletion under the no-refactor rule.

Rough total if rows 1-6 are taken: **~2,700 lines of app code + ~33 npm packages** removed with no behavior change.

---

## 5. THE SHORTEST PATH TO A WORKING APP

### A. Outside the repo (only you / account owners can do these)

| # | Step | Est. |
|---|---|---|
| A1 | Create a Postgres database (Supabase project per `docs/PRODUCTION_MIGRATION.md:33-46`, or any Postgres). Capture the **direct** connection string for migrations and the **pooled** one for the app. | 20-30 min |
| A2 | Create the OIDC client. For Google Workspace: internal OAuth client in Google Cloud, authorized redirect `https://<host>/api/callback` (and `http://localhost:5000/api/callback` for local dev), per `docs/PRODUCTION_MIGRATION.md:160-228`. Note client ID + secret. | 30-60 min |
| A3 | Generate `SESSION_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` per `config.ts:74-75`). | 1 min |
| A4 | *(Production only)* Supabase private bucket `uploads` + service-role key (`docs/PRODUCTION_MIGRATION.md:114-133`). Local dev skips this (`STORAGE_DRIVER` defaults `local`). | 10 min |
| A5 | *(Production only)* Render service: build `npm run build`, start `npm run start`, health check `/api/health`, env vars from §2.1 (`README.md:255-264`). | 30 min |
| A6 | *(Only if the old records matter)* Export data from the Replit-hosted Postgres (requires Replit workspace access; `docs/PRODUCTION_MIGRATION.md:359` step 9) and accept that pre-migration uploaded files in the Replit bucket are already unreachable to the app (`README.md:278`). | 1-3 h, or skip |
| A7 | *(Optional)* Point the JotForm webhook at `/api/webhooks/jotform` and set `JOTFORM_WEBHOOK_SECRET`. | 15 min |

### B. In the repo (code/ops steps a developer or I can do)

| # | Step | Est. |
|---|---|---|
| B1 | **Fix the broken test gate** — the only code change required to make the documented gate true again: stop `region.test.ts`/`ownership.test.ts` from importing the real `server/db.ts` (the sibling suites already show the `vi.mock("../db")` pattern at `authz.test.ts:18`). This also turns GitHub CI green. | 15-30 min |
| B2 | Write `.env` from `.env.example` with A1-A4 values; export it (`set -a && . ./.env && set +a` — no dotenv, `.env.example:4-7`). | 5 min |
| B3 | `npm ci && npm run db:migrate` against the direct connection (creates all 15 tables incl. `sessions`; verify per `docs/PRODUCTION_MIGRATION.md:60-70`). If importing the old Replit DB instead, `npm run db:baseline -- <tag>` first (`README.md:81`). | 10 min |
| B4 | `npm run dev`, sign in once, then promote the first account: `update users set role='admin' where email='<you>';` (`shared/schema.ts:22`, `README.md:91`). | 10 min |
| B5 | Re-run the full gate `npm run lint && npm run check && npm test && npm run build` and confirm all four pass. | 5 min |
| B6 | *(Recommended, separate change)* Update the stale docs found in §3.4 and take the §4 deletions — none block running. | 1-2 h |

**Critical path to a working local app: A1 + A2 + A3 → B2 → B3 → B4 — roughly 1.5-2 hours, dominated by the Google/OIDC console work.** Production adds A4 + A5 (+A6 if the old data matters).

---

## Bugs recorded (not fixed, per session rules)

1. **Fresh-clone/CI test failure** — `server/migrateRegions.ts:9` imports `db` at module scope; `server/db.ts:16` throws without `DATABASE_URL`; `region.test.ts` and `ownership.test.ts` crash at import. Introduced in `45527db`; GitHub Actions run 32638881183 on `main` is red with this exact error. Contradicts `CLAUDE.md:26`, `README.md:140`, `ci.yml:5`.
2. **`drizzle-orm` high-severity npm advisory** in production dependencies (docs at `CLAUDE.md:255` acknowledge it; the companion "vite" advisory they mention is already cleared).
3. Doc rot itself (§3.4) — eight materially false or stale claims across `CLAUDE.md`, `README.md`, `replit.md`, `design_guidelines.md`, plus a missing design-system source document referenced from three places.
