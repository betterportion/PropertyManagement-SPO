# Implementation Plan — Property Management Backlog

Plan for the backlog derived from the SPO planning meeting, first reconciled
against the code 2026-08-26 and last updated **2026-08-27, after Phases 1–4
merged to main** (PRs #65, #67, #68, #69, #70, #71). The backlog was written
against a fifteen-table CLAUDE.md; the schema now has twenty-one tables, and
several backlog tasks were already built before this plan existed. The phase
sections below keep their full reasoning as a record; the ✅ marks and this
summary say what is actually left.

**Where things stand (2026-08-27):**

- **Phases 1–4: shipped**, except the items below.
- **Blocked on JR (external, #49 — Resend domain + API key):** 3.5 RA
  notification (#14), deposit-return notices (#41), bounced-payment email
  (backlog 18). The email machinery itself is merged and dormant; each of
  these is a small follow-on once #49 completes.
- **Blocked on SPO decisions:** 4.1 Ramp/QuickBooks (AP/AR mapping, #33);
  4.3 maintenance budget view (per-property vs per-region, open item 4);
  deposit workflow wording (#60).
- **Phase 5 (unscheduled):** spreadsheet import, in-app support request
  (needs only #49 now), Sentry, docs reconciliation.

The issue tracker is GitHub issues on `betterportion/PropertyManagement-SPO`.
Several backlog tasks already have issues — those are linked rather than
duplicated. New issues should follow the existing label conventions
(`[v2]`, `[jr]`, `[jr/spo]`, `[code]`).

---

## Reconciliation: backlog vs. code (read this first)

| Backlog task | Reality in the code |
|---|---|
| 3. Resident records | **Already built** (issue #40, closed). `residents` table with name, email, property, move-in/out dates, `isActive`, denormalised `region`/`buildingAddress`. Routes at `/api/residents` (list/create/patch/delete), `Residents.tsx` page. |
| 4. Household fee charges | **Mostly built** as `rent_payments` (issue #40): one row per resident per `YYYY-MM` period, amount, status, paid date, free-text `reference`, unique on (resident, period), idempotent `/api/rent-payments/generate`. Differences from the backlog: status enum is `unpaid / paid / waived`, not `paid / pending / failed` — there is **no `failed` status**, which task 18 (bounced payments) will need. |
| — | `security_deposits` and `maintenance_schedules` also exist; the backlog doesn't mention either. Deposit questions are with SPO (#60). |
| 1. Ownership + lease dates | **Built on main** (2026-08-26): `ownership` column, three lease dates, plus a `renewal_decision` column, lease UI, and a 2-month renewal reminder. Task 19's renewal visibility largely ships with it. |
| 2. Resident accounts ↔ properties | **Merged** (PR #65): `users.propertyId`, FK set-null, flows through account creation. |
| 5. Finance permission flags | **Merged** (PR #65): `canViewFinancials` / `canManageFinancials`, gated onto every rent/deposit route after `requireStaff`, backfilled `true` for existing staff by the migration, staff defaults updated. Supersedes issue #43's "no finance permission" note — recorded in the route comment. The dashboard's finance-derived surfaces (action items, region summary) follow the flags too. |
| 4a. `failed` rent status | **Merged** (PR #65): added to the enum; a failed (bounced) payment still counts as outstanding in action items and region summaries, and Finances can mark it. Feeds task 18. |
| 7. Property-scoped `ownsRecord` | **Merged** (PR #67, task 2.2): housemates share the house's request history via `users.propertyId`, with the email match kept intact. |
| 8. In-portal resident submission | **Built on main** (2026-08-26): "Make the resident 'Submit a request' flow actually file a request", with e2e coverage. |
| 15. Ramp/QuickBooks | Already tracked: #32 (sync, references only) and #33 (AP/AR mapping decision, blocking). |
| 12/18. Outbound email | Already tracked: #49 (Resend domain + API key, external) and #41 (deposit-return notices). The Resend account exists. |
| 11/14. Turnover / move-out | Already tracked: #38 (household turnover orchestration). |
| 9. RA notification | Already tracked: #14 (email notifications for request activity). |
| 25. Docs reconciliation | **Still owed** (5.4): CLAUDE.md's data-model section lists fifteen tables; twenty-one exist (missing: residents, rent_payments, security_deposits, maintenance_schedules, tasks, maintenance_request_photos). The sections touched by Phases 1–4 (authz, uploads, email, audit) were kept current as they changed. |

---

## Phase 1 — Schema foundation ✅

**Merged 2026-08-27 (PR #65).** One migration — renumbered to
`0014_resident_links_and_finance_flags` after main gained its own 0013 in
parallel, and made idempotent for that reason. 1.1 turned out to already be
on main (lease tracking), so the phase shipped 1.2–1.4. Original plan:

### 1.1 Property ownership and lease dates (backlog 1)
- `properties`: `ownershipType` (`owned` / `rented`, default `owned` for existing rows), `leaseStartDate`, `leaseEndDate`, `leaseRenewalDate`.
- Zod: dates required when `ownershipType === "rented"`, forbidden/ignored when `owned` — use `superRefine` on the insert schema, and keep `.partial()` PATCH semantics working.
- Storage: extend property methods; no new ones needed.

### 1.2 Resident accounts linked to properties (backlog 2)
- Decision needed (below): link table vs. `propertyId` column on `users`. Recommendation: **`propertyId` column on `users`**, nullable, loose reference (matching the codebase's existing loose-FK pattern for properties). Two accounts per property is a convention, not a constraint to enforce in the schema.
- Region follows from the property at read time; do not denormalise onto `users`.

### 1.3 Finance permission flags (backlog 5)
- `user_permissions`: `canViewFinancials`, `canManageFinancials`, default `false`.
- Migration backfills `true` for every existing non-resident user's row (and the admin bypass covers admins with no row).
- Wire into the rent/deposit/finance routes as `requirePermission` **after** `requireStaff`, keeping the staff refusal for residents intact.
- Each grant is a `user.permissions_changed` audit event — already how the permissions route works; verify the two new flags flow through it.
- Update the Settings permissions UI to show the new flags.
- Supersedes the "no finance permission" note from #43; record that in the route comment.

### 1.4 Rent status vocabulary for bounced payments (backlog 4 delta, feeds 18)
- Add `failed` to the `rent_payments` status enum (keep `unpaid`/`paid`/`waived`).
- Small, but it belongs in this phase's migration rather than a later one.

**Not in this phase:** residents table (exists), charges table (exists as `rent_payments`), deposits (exist).

Ship gate per CLAUDE.md: schema edit → `npm run db:generate` → rename migration + `_journal.json` tag → `storage.ts` + `IStorage` together → `npm run lint && npm run check && npm test && npm run build`. New guards get cases in `routeAccess.test.ts`.

## Phase 2 — Maintenance intake

**Decision (2026-08-26): nothing JotForm-related survives.** The original backlog
asked for the JotForms to be collected so their field set could be reproduced
(task 6) and for the webhook to be retired only after in-portal submission
shipped (task 10). Both are overtaken: in-portal submission shipped on main, the
portal form's field set is now the source of truth, and no JotForm field
mapping will ever be needed. Task 6 is dropped outright — do not open the
`[jr/spo]` issue, and the matching "Open items with SPO" entry is withdrawn.

- **2.1** ✅ (merged in PR #67) Remove the JotForm integration entirely (supersedes backlog 10's
  "retire"): delete `POST /api/webhooks/jotform` and
  `GET /api/webhooks/jotform/config`, the field-mapping and keyword
  auto-detection code, the `JOTFORM_*` handling in `server/config.ts`, the
  admin setup dialog, and their tests; strip `JOTFORM_*` placeholders from
  `.env.example`. Update the README and the CLAUDE.md Integrations section in
  the same commit. Nothing blocks this — the webhook already fails closed
  without its secret, so removal only deletes dead surface area.
- **2.2** ✅ (merged in PR #67) Property-scoped maintenance
  visibility (backlog 7). The house match was added **alongside** the email
  comparison, never replacing it — `submittedBy` stays an email; nothing
  re-keys on user ID. Mechanism: `residentHouseAddress(ctx)` resolves
  `users.propertyId` → `properties.address` once per request, and
  `canReadMaintenanceRequest` gains an optional house argument that defaults
  to null (no house claim), so an un-updated call site stays email-only
  rather than silently widening. Applied to the list, detail and contacts
  routes and to photo access through `canReadUploadReference`; mutation
  routes stay staff-only. Fails closed for an unlinked account, a deleted
  property, and staff (a house match never overrides region scoping).
  Covered in `ownership.test.ts` (both accounts on property A read A's
  requests incl. the list route; a resident of property B and an unlinked
  account get 403 with the refused work never fetched), `authz.test.ts`
  (rule + resolver units), and `uploadAccess.test.ts` (housemate photo).
- **2.3** → moved to 3.5 once the email plumbing landed; see Phase 3.

(Backlog 8, in-portal submission, shipped on main on 2026-08-26 and needs no further work here.)

## Phase 3 — Accounts and residents

Reconciled against main 2026-08-27 (after Phases 1–2 merged). **No schema
changes in this phase** — the mechanisms exist; the work is config, one email
module, and UI. Decisions confirmed with the maintainer 2026-08-27:
(a) move-out offers to deactivate a linked login, checkbox defaulted on;
(b) email config is optional at boot while #49 is pending, but a *partial*
set of email variables fails the boot check loudly; (c) 2.3 (RA
notification) folds into this phase if #49 completes in time.

Order: 3.2 first (it is the long pole — #41, #14/2.3 and backlog 18/23 all
wait on it), then 3.1 + 3.3 together (small UI), then 3.4 on its own (it
touches an access decision and gets the same review treatment as 2.2).

- **3.2** ✅ (merged in PR #68) Outbound email plumbing (backlog 12). New `server/email.ts` behind
  a small interface, mirroring the `objectStorage/` driver pattern: the
  official `resend` SDK when configured, and a "not configured" result —
  never a throw — when not. `RESEND_API_KEY` + `EMAIL_FROM` (optional
  `EMAIL_REPLY_TO`) read via `server/config.ts`; both unset means email is
  deliberately off, exactly one set is a boot-time configuration problem.
  `.env.example` placeholders only. Send failures log server-side and return
  a result; a failed email must never fail the request that triggered it.
  External dependency #49 gates the first live send, not the code.
- **3.1** ✅ (merged in PR #69) Steward provisioning (backlog 11). The mechanism shipped in Phase 1
  (`users.propertyId`, re-link preserving it); what's missing is UI: a house
  picker on the Settings create-user form when the role is resident, the
  linked house shown in the user list, and set/clear on an existing resident
  account. Deactivation already exists. Deliberately **not** building #38's
  turnover state machine — this ships the primitives it will orchestrate.
- **3.3** ✅ (merged in PR #69) Fast multi-resident entry (backlog 13). "Save & add another" in the
  Residents add dialog: keeps it open, preserves house and move-in date,
  clears name/email, refocuses, shows a running added-count. No importer —
  that stays Phase 5.
- **3.4** ✅ (merged in PR #70) Move-out with context (backlog 14). Replace today's instant,
  confirmation-free button with a dialog naming the resident and house, an
  editable move-out date, and consequences in plain language: history stays,
  the roster row moves to Former residents. Callers holding a finance flag
  also see outstanding rent charges and any held deposit (existing
  endpoints; section hidden without the flag). **Security piece:** since 2.2
  an active resident login sees the whole house's requests, so the dialog
  detects a matching active resident account and offers to deactivate it,
  checked by default. Deactivation goes through the existing status route so
  the `user.status_changed` audit event fires.
- **3.5** (was 2.3) RA notification on new request — **the one open item
  in Phases 1–3**, blocked solely on #49. First consumer of 3.2, content per
  #14, nothing the audit log would redact.

## Phase 4 — Finance and dashboard

Reconciled 2026-08-27 while starting the phase. Two findings from that pass:

- **The PropertyDetail page had been lost.** `51ab295` (the /properties/:id
  page, its e2e spec, and the Properties-list links to it) sat on the old
  `feat/dashboard-needs-attention` base and was silently dropped when Phase 1
  rebased onto origin/main — main even shipped links to a route that did not
  exist. Restored in PR #71 by cherry-pick (original authorship kept),
  updated for the `failed` rent status that postdates it.
- **`527b26e` (client-side needs-attention queue) stays retired on purpose:**
  main's dashboard is a later, richer implementation of the same idea
  (server-side `/api/action-items` + `/api/region-summary`, which Phases 1–3
  kept extending). `git cherry origin/main 51ab295` confirms these two were
  the only unmerged commits from that old base.

Status:

- **4.1** Ramp/QuickBooks (backlog 15): tracked in #32, **blocked by the
  AP/AR decision #33**. References/status/dates/amounts only.
- **4.2 + 4.4** ✅ (merged in PR #71) Outstanding panel: a
  third Finances tab — and the default one — showing every unpaid **or
  failed** charge from any month grouped by house with per-house totals, a
  summary line that singles out failed payments, held deposits of former
  residents with a Settle shortcut, and Mark-paid inline. Client-side over
  the existing region-scoped, finance-gated endpoints; no new routes, so no
  new guards. 4.4's auto-email waits on #49; the account-less-resident email
  question stays open with SPO.
- **4.3** Maintenance spend by region + annual budget (backlog 17):
  **blocked on SPO** — per-property vs per-region budget (open item 4). The
  budget column follows the migration rules once answered.
- **4.5** ✅ (merged in PR #71) Lease-renewal on the Properties list: the
  renewal date + decision were already displayed (shipped with lease
  tracking); this adds the sort — "Sort: lease renewal" puts rented houses
  with the nearest renewal first.
- **4.6** ✅ (merged in PR #71) Owned/rented badge: the list badge shipped
  with lease tracking; the restored PropertyDetail header now carries an
  Owned/Rented badge plus the renewal date and decision for rented houses.
- **4.7** Audit events per money/access action: nothing in this phase added
  a new money/access *action* (the panel reads existing data), so no new
  events were due. Applies per-ticket to 4.1/4.3 when they unblock.

## Phase 5 — Later

- **5.1** Spreadsheet import for residents (backlog 22): `guardedUpload()`, permission check ahead of multer, preview-and-confirm, duplicate rule = email within a property.
- **5.2** In-app support request (backlog 23) — 3.2 is merged, so this now waits only on #49.
- **5.3** Sentry (backlog 24): CSP allowance in `server/security.ts`, `package-lock.json` `resolved` URL check, PII scrub.
- **5.4** Docs reconciliation (backlog 25) — but do a first pass **now**: CLAUDE.md already understates the schema by four tables, which is exactly how this backlog over-scoped Phase 1.

---

## Decisions made (all resolved)

1. ✅ **`propertyId` column on `users`**, not a link table (1.2) — shipped in PR #65.
2. ✅ **Finance permission flags supersede #43's "no finance permission" note** (1.3) — shipped with a staff backfill in PR #65.
3. ✅ **`rent_payments` is the household-fee table**; the backlog's `pending`/`failed` vocabulary became `unpaid`/`failed`, `waived` kept.
4. ✅ **Nothing JotForm-related survives** (2026-08-26) — removal shipped in PR #67; issues #7 and #13 closed.
5. ✅ **Move-out offers to deactivate the linked login, defaulted on**; **email config optional at boot, partial config fails loudly**; **3.5 folds in when #49 completes** (2026-08-27, Phase 3).

## Open items with SPO

1. ~~Property-management JotForms~~ — withdrawn (2026-08-26): nothing
   JotForm-related is wanted; the portal form's field set is the source of
   truth, so there is nothing to collect.
2. Emails for account-less residents (backlog 18) — the roster column exists and is required; confirm the data is real.
3. Cross-region resident moves (affects `requireRegionMove` on the resident update path).
4. Annual maintenance budget: per property or per region (4.3).
5. Deposit questions already with SPO: #60.
