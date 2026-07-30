# PRE_GITHUB_AUDIT.md
## SPO Admin Portal — Pre-GitHub Safety Audit
**Audit date:** July 29, 2026  
**Auditor:** Replit Agent (read-only, no code changes made)

> ## ⚠️ Status: mostly resolved — kept only until the last findings close
>
> **Reviewed July 30, 2026.** This audit was written *before* any fixes were made, and the findings below are preserved in their original wording for the record. Most are now closed. **Delete this file once the remaining ones are done.**
>
> **Still open**
> - 🟡 Uploaded files do not survive an autoscale deployment — section 2
> - 🟢 Monday.com board IDs hardcoded in source — section 1
> - 🟢 No error boundary in the frontend — section 2
> - 🟢 `throw err` after the error response in middleware — section 2
>
> **Resolved** — everything else, including both HIGH `uploads/` and `.gitignore` findings, the unauthenticated JotForm webhook, the permissions endpoint, public upload access, both session-store settings, all TypeScript errors, and the Replit-only login dependency.
>
> A separately discovered bug that this audit missed is tracked in `CLAUDE.md`: residents cannot see their own maintenance requests, because `submittedBy` stores an email while the filter compares against a user ID.

---

## Executive Summary

The project is a React + Express + Neon PostgreSQL property-management portal with Replit OIDC authentication, Monday.com integration, and a JotForm webhook. The codebase is generally well-structured and follows good patterns for secret management (all secrets use `process.env`, none are hardcoded). However, there are **six items that must be addressed before pushing**, the most important being that user-uploaded files are currently committed to git and the `.gitignore` is missing critical entries. There are also TypeScript errors in two files and one medium-severity open endpoint that needs attention.

**Final Status: ⚠️ SAFE TO PUSH AFTER FIXING SPECIFIC ITEMS**

---

## 1. Security Findings

### 🔴 HIGH — Uploaded user files committed to git
**File:** `uploads/` directory  
**What:** Five actual user-uploaded image/document files are tracked by git and will be pushed to GitHub.  
**Why it matters:** Real user data (photos, documents) should never live in source control. Anyone with access to the repo can download them.  
**Recommended fix:** Add `uploads/*` to `.gitignore` and run `git rm -r --cached uploads/` to untrack the existing files before the next commit.

---

### 🔴 HIGH — `.gitignore` is missing critical entries
**File:** `.gitignore`  
**Current contents:** `node_modules`, `dist`, `.DS_Store`, `server/public`, `vite.config.ts.*`, `*.tar.gz`  
**What's missing:** `uploads/`, `.env`, `.env.*`, `.cache/`, `.local/`, `.agents/`, `attached_assets/`  
**Why it matters:**
- Without `uploads/` in `.gitignore`, any future file uploads will be committed automatically.
- Without `.env` entries, if a developer ever creates a `.env` file locally it could be accidentally committed with real secrets.
- `.local/` contains Replit agent skills and internal state — not harmful but adds unnecessary noise to the repo.
- `.agents/` contains your agent memory files — not sensitive, but not useful to others.
- `attached_assets/` contains your personal notes/prompts — personal data that doesn't belong in source control.  
**Recommended fix:** Add all of the above to `.gitignore` before pushing.

---

### 🟡 MEDIUM — JotForm webhook is unauthenticated by default
**File:** `server/routes.ts`, line 1407  
**What:** `POST /api/webhooks/jotform` has no authentication. The `JOTFORM_WEBHOOK_SECRET` check only runs if the secret env var is set. If it is not set (which is the current state in this repo), **anyone on the internet can POST to this endpoint and create maintenance requests in your database.**  
**Why it matters:** A malicious actor could flood the system with fake maintenance requests, or probe for information via error messages.  
**Recommended fix:** Set `JOTFORM_WEBHOOK_SECRET` in your environment and treat it as required, not optional. Or add IP allowlisting for JotForm's known server IPs.

---

### 🟡 MEDIUM — Any authenticated user can read any user's permissions
**File:** `server/routes.ts`, line 157  
**What:** `GET /api/users/:id/permissions` has no admin check — any logged-in user can fetch the full permissions object for any other user ID.  
**Why it matters:** Users can discover which colleagues have which admin/management permissions, and enumerate user IDs.  
**Recommended fix:** Add a check so a user can only read their own permissions, or only admins can read any user's permissions.

---

### 🟡 MEDIUM — Uploaded files are publicly accessible without authentication
**File:** `server/routes.ts`, line 1402  
**What:** `app.use('/uploads', express.static(uploadDir))` serves all uploaded files publicly — no login required. Anyone who knows (or guesses) a filename like `/uploads/1774696863220-220045060.jpg` can access it.  
**Why it matters:** Uploaded walkthrough photos, maintenance photos, W-9s, COIs, and contract invoices may contain sensitive information.  
**Recommended fix:** Remove the static middleware and add an authenticated route that pipes the file only to logged-in users. This is a more involved change but important for a production system handling sensitive documents.

---

### 🟢 LOW — Monday.com board IDs hardcoded in source
**File:** `server/monday.ts`, lines 12–19  
**What:** Internal Monday.com board IDs and column IDs are hardcoded as constants.  
**Why it matters:** These are not credentials — they cannot be used to authenticate. However, they expose your Monday.com board structure to anyone reading the source code on GitHub.  
**Recommended fix:** Move them to environment variables if you prefer to keep your Monday.com structure private. Otherwise acceptable to leave.

---

### 🟢 LOW — Sessions created for unauthenticated visitors
**File:** `server/auth.ts` (was `server/replitAuth.ts`)  
**What:** `saveUninitialized: true` causes the session store to save a new session for every request, including unauthenticated ones.  
**Why it matters:** Over time this will grow the `sessions` table with rows for every anonymous visitor. In a low-traffic admin portal this is minor, but it wastes database space.  
**Recommended fix:** Change to `saveUninitialized: false`.

---

### ✅ INFORMATIONAL — No hardcoded secrets found
All secrets (`DATABASE_URL`, `SESSION_SECRET`, `MONDAY_API_KEY`, `REPL_ID`, `JOTFORM_WEBHOOK_SECRET`) are read exclusively from `process.env`. No API keys, passwords, or tokens were found hardcoded anywhere in source code. Good practice.

---

## 2. Bug and Reliability Findings

### 🔴 HIGH — `Invoices.tsx` has broken form fields (TypeScript confirmed)
**File:** `client/src/pages/Invoices.tsx`, lines 67–75  
**What:** The "Add Billing Record" form in `Invoices.tsx` initializes `defaultValues` with fields that **do not exist** on `BillingRecord`: `residentName`, `unit`, `moveInDate`, `region`, and `buildingAddress`. The `handlePropertyChange` function also sets `buildingAddress` and `region` on the form, which are not part of the schema.  
**TypeScript errors confirmed:**
```
Invoices.tsx(67,7): error TS2353 — 'residentName' does not exist
Invoices.tsx(96,21): error TS2345 — 'buildingAddress' not assignable
Invoices.tsx(97,21): error TS2345 — 'region' not assignable
Invoices.tsx(106,57): error TS2339 — Property 'region' does not exist
```
**Why it matters:** The page will appear to render, but the filter on line 106 (`r.region` and `r.buildingAddress`) will silently fail to filter anything because those fields don't exist on `BillingRecord`. The form will also submit unexpected data.  
**Recommended fix:** Audit `Invoices.tsx` to align the form schema and display fields with the actual `BillingRecord` shape from `shared/schema.ts`.

---

### 🟡 MEDIUM — Stale example component with TypeScript errors
**File:** `client/src/components/examples/ContactsInvoices.tsx`  
**What:** This file appears to be a leftover example/scaffold with hardcoded mock data typed against an old schema. TypeScript reports 2 errors because the mock data doesn't match the current `MaintenanceContact` and `BillingRecord` types.  
**Why it matters:** It won't affect the running app (it's an example file, not imported by any page), but it fails `tsc --noEmit` and adds noise.  
**Recommended fix:** Delete the `client/src/components/examples/` directory if it's not needed.

---

### 🟡 MEDIUM — Uploaded files will not persist in autoscale deployment
**File:** `server/routes.ts`, lines 25–52 (multer disk storage)  
**What:** Uploaded files (photos, documents) are stored in a local `uploads/` folder on disk using multer's `diskStorage`. In Replit's autoscale deployment, each container instance has its own filesystem — uploads made to one instance will not be visible to others, and will be lost on restart.  
**Why it matters:** In production, any uploaded photo or document could disappear on the next deployment or pod restart.  
**Recommended fix:** Use a cloud storage service (S3, Cloudflare R2, Supabase Storage, or similar) for file uploads in production. This is a significant change that should be planned before going live.

---

### 🟡 MEDIUM — Session store `createTableIfMissing: false` could crash on startup
**File:** `server/auth.ts` (was `server/replitAuth.ts`)  
**What:** The PostgreSQL session store is configured with `createTableIfMissing: false`. If the `sessions` table doesn't exist (e.g., fresh database, new environment), the app will crash at startup.  
**Why it matters:** On a fresh clone with a new database, the app won't start until the sessions table is manually created.  
**Recommended fix:** Change to `createTableIfMissing: true`, or add a note in the README that `npm run db:push` must be run first.

---

### 🟢 LOW — No error boundary in the frontend
**Files:** `client/src/App.tsx`  
**What:** There is no React error boundary wrapping the application routes. An unhandled error in any component will crash the entire app and show a blank screen.  
**Why it matters:** Users will see a blank/broken page rather than a graceful error message.  
**Recommended fix:** Wrap routes in a React `ErrorBoundary` component.

---

### 🟢 LOW — `throw err` after sending error response in middleware
**File:** `server/index.ts`, line 57  
**What:** The global error handler calls `res.status(status).json({ message })` and then `throw err` on line 58. Throwing after responding can produce unhandled rejection noise in logs.  
**Why it matters:** Minor, but can produce confusing log output. The response has already been sent so the throw doesn't help the client.  
**Recommended fix:** Remove `throw err` or replace with `console.error(err)`.

---

### ✅ INFORMATIONAL — No MIME-type check on document uploads
**File:** `server/routes.ts`, line 816  
**What:** The `docUpload` multer config only checks file extension (not MIME type) for document uploads. An attacker could rename a malicious file with a `.pdf` extension to bypass the check.  
**Why it matters:** Low risk since files are stored on disk, not executed. But worth noting.

---

## 3. Test Results

| Category | Status |
|---|---|
| Automated unit tests | ❌ None found — no test files, no test script in `package.json` |
| TypeScript type check (`tsc --noEmit`) | ❌ FAILED — 10+ errors in `Invoices.tsx` and `examples/ContactsInvoices.tsx` |
| Build check (`npm run build`) | ⚪ Not tested (TypeScript errors would likely block the build) |
| Linting (ESLint) | ⚪ Cannot test — no ESLint config found |
| Runtime / E2E tests | ⚪ None exist |

### TypeScript errors summary
- `client/src/pages/Invoices.tsx` — 8+ errors related to fields that don't exist on `BillingRecord`
- `client/src/components/examples/ContactsInvoices.tsx` — 2 errors related to stale mock data types

### Recommended manual tests (perform yourself)
1. **Login flow** — Confirm the Replit OIDC login/logout cycle works end-to-end
2. **Create a maintenance request** — Fill all 5 required fields and confirm it saves and appears in the list
3. **Upload a photo** to a maintenance request and confirm it shows up after a page reload
4. **Link a contact** to a maintenance request — toggle a contact on and off, confirm the badge count updates
5. **Create a billing record** — Open the Invoices page, click Add, and confirm the form submits without errors (this is the area with known TypeScript errors)
6. **Region filtering** — As a non-admin user, confirm you only see records for your allowed regions
7. **JotForm webhook** — POST to `/api/webhooks/jotform` with no secret and confirm a maintenance request is created (to verify the current unauthenticated behavior)

---

## 4. GitHub Readiness Checklist

| Item | Status | Action Needed |
|---|---|---|
| No hardcoded secrets in source | ✅ Clean | None |
| `.env` file not present | ✅ Clean | None |
| `node_modules` excluded | ✅ In `.gitignore` | None |
| `dist` excluded | ✅ In `.gitignore` | None |
| `uploads/` excluded | ❌ Tracked | Add to `.gitignore`, run `git rm -r --cached uploads/` |
| `.cache/` excluded | ❌ Not in `.gitignore` | Add to `.gitignore` |
| `.local/` excluded | ❌ Not in `.gitignore` | Add to `.gitignore` |
| `.agents/` excluded | ❌ Not in `.gitignore` | Add to `.gitignore` |
| `attached_assets/` excluded | ❌ Not in `.gitignore` | Add to `.gitignore` |
| `.env*` excluded | ❌ Not in `.gitignore` | Add to `.gitignore` |
| TypeScript clean | ❌ Errors present | Fix `Invoices.tsx` and delete `examples/` |
| README / setup docs | ⚠️ Partial | `replit.md` exists but is Replit-focused; add GitHub-specific setup instructions |

---

## 5. Replit-Specific Dependencies

### Required to change before running outside Replit

✅ **All items in this section were resolved on July 30, 2026.** Authentication was made provider-agnostic rather than replaced, so nothing here blocks running outside Replit any more.

| Item | File(s) | Notes |
|---|---|---|
| ~~**Replit OIDC Auth**~~ | `server/auth.ts` | ✅ **RESOLVED** — auth is standard OIDC driven by `OIDC_*` environment variables, defaulting to Replit. Changing provider is configuration only. See "Swapping the identity provider" in `replit.md` |
| ~~`REPL_ID` env var~~ | `server/auth.ts` | ✅ **RESOLVED** — still the default client ID on Replit, but `OIDC_CLIENT_ID` overrides it |
| ~~`ISSUER_URL` env var~~ | `server/auth.ts` | ✅ **RESOLVED** — superseded by `OIDC_ISSUER_URL`; the old name is still honoured |

### Safe to leave but Replit-specific

| Item | File(s) | Notes |
|---|---|---|
| `@replit/vite-plugin-cartographer` | `vite.config.ts`, `package.json` | Dev-only. Guarded by `REPL_ID !== undefined` check — silently disabled outside Replit |
| `@replit/vite-plugin-dev-banner` | `vite.config.ts`, `package.json` | Dev-only. Same guard — safe to leave |
| `@replit/vite-plugin-runtime-error-modal` | `vite.config.ts`, `package.json` | Always loaded, but is purely a dev convenience overlay. Safe to leave |
| `.replit` | `.replit` | Replit workflow/deployment config. Harmless on GitHub |

### Works fine outside Replit

| Item | Notes |
|---|---|
| Neon PostgreSQL (`@neondatabase/serverless`) | Neon is a cloud service — just needs `DATABASE_URL` set |
| Drizzle ORM | Standard SQL ORM, no Replit dependency |
| Monday.com integration | Standard API — just needs `MONDAY_API_KEY` |
| JotForm webhook | Standard HTTP webhook |
| All Radix UI / Tailwind / React | No Replit dependency |

---

## 6. Environment Variables Reference

Variables required to run the app (for documentation in a future README):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ Yes | Neon PostgreSQL connection string |
| `SESSION_SECRET` | ✅ Yes | Random string for signing session cookies |
| `REPL_ID` | ✅ On Replit only | Auto-provided; used for OIDC client ID |
| `ISSUER_URL` | Optional | Defaults to `https://replit.com/oidc` |
| `MONDAY_API_KEY` | Optional | Monday.com integration; feature silently disabled if not set |
| `JOTFORM_WEBHOOK_SECRET` | Optional* | *Should be treated as required for security |
| `JOTFORM_FIELD_TITLE` | Optional | JotForm field ID mappings |
| `JOTFORM_FIELD_DESCRIPTION` | Optional | JotForm field ID mappings |
| `JOTFORM_FIELD_CATEGORY` | Optional | JotForm field ID mappings |
| `JOTFORM_FIELD_PRIORITY` | Optional | JotForm field ID mappings |
| `JOTFORM_FIELD_LOCATION` | Optional | JotForm field ID mappings |
| `JOTFORM_FIELD_EMAIL` | Optional | JotForm field ID mappings |
| `JOTFORM_FIELD_REGION` | Optional | JotForm field ID mappings |
| `JOTFORM_FIELD_BUILDING` | Optional | JotForm field ID mappings |
| `JOTFORM_DEFAULT_REGION` | Optional | Fallback region for JotForm submissions |
| `JOTFORM_DEFAULT_BUILDING` | Optional | Fallback building for JotForm submissions |
| `JOTFORM_DEFAULT_LOCATION` | Optional | Fallback location for JotForm submissions |
| `PORT` | Optional | Defaults to 5000 |

---

## 7. Recommended Fixes in Priority Order

| Priority | Fix | Effort |
|---|---|---|
| 1 | **Stop tracking `uploads/` in git** — add to `.gitignore`, run `git rm -r --cached uploads/`, recommit | 5 min |
| 2 | **Improve `.gitignore`** — add `.env*`, `.cache/`, `.local/`, `.agents/`, `attached_assets/` | 5 min |
| 3 | **Fix `Invoices.tsx` TypeScript errors** — align form fields with actual `BillingRecord` schema | 30–60 min |
| 4 | **Delete `client/src/components/examples/`** — stale files causing TypeScript errors | 2 min |
| 5 | **Set `JOTFORM_WEBHOOK_SECRET`** and treat it as required in the code | 10 min |
| 6 | **Add admin check to `GET /api/users/:id/permissions`** | 10 min |
| 7 | **Change `saveUninitialized: false`** in session config | 2 min |
| 8 | **Change `createTableIfMissing: true`** in session store config | 2 min |
| 9 | **Add a note to README** about needing `npm run db:push` on a fresh install | 5 min |
| 10 | Protect `/uploads` route behind `isAuthenticated` middleware | 30 min |
| 11 | ✅ **RESOLVED (July 30, 2026)** — Replit Auth was made swappable rather than replaced. Provider details are now `OIDC_*` configuration in `server/auth.ts`, and all 49 route handlers read the signed-in user through `getUserId(req)` | Done |
| 12 | Plan migration of file uploads from local disk to cloud storage before autoscale production deployment | Major — plan separately |

---

## Final Status

```
⚠️  SAFE TO PUSH AFTER FIXING SPECIFIC ITEMS
```

**Must fix before pushing (items 1–4 above):**
- Remove `uploads/` from git tracking
- Update `.gitignore`
- Fix or delete the TypeScript-erroring files

**Should fix soon but not a blocker for the initial push:**
- JotForm webhook secret enforcement (item 5)
- Permissions endpoint auth check (item 6)
- Session config tweaks (items 7–8)

**Plan for later (significant work):**
- ~~Replace Replit Auth with a portable auth provider~~ — ✅ resolved July 30, 2026 by making the provider configurable instead of replacing it
- Migrate file uploads to cloud storage for production — **still open**, tracked as its own piece of work

