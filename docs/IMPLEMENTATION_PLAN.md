# Implementation Plan — Property Management Backlog

Plan for the backlog derived from the SPO planning meeting, reconciled against the
code as it stands on `feat/backlog-phase-1-schema` (branched from
`feat/dashboard-needs-attention`, 2026-08-26). The backlog was written against a
fifteen-table CLAUDE.md; the schema now has **nineteen tables**, and several
backlog tasks are already built. This plan records what actually remains, in what
order, and which decisions still need SPO or a maintainer.

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
| 2. Resident accounts ↔ properties | **Done on this branch**: `users.propertyId`, FK set-null, flows through account creation. |
| 5. Finance permission flags | **Done on this branch**: `canViewFinancials` / `canManageFinancials`, gated onto every rent/deposit route after `requireStaff`, backfilled `true` for existing staff by the migration, staff defaults updated. Supersedes issue #43's "no finance permission" note — recorded in the route comment. The dashboard's finance-derived surfaces (action items, region summary) follow the flags too. |
| 4a. `failed` rent status | **Done on this branch**: added to the enum; a failed (bounced) payment still counts as outstanding in action items and region summaries, and Finances can mark it. Feeds task 18. |
| 7. Property-scoped `ownsRecord` | Current `ownsRecord` is email-only, as the backlog says. Task 2 is now done, so this is unblocked. |
| 8. In-portal resident submission | **Built on main** (2026-08-26): "Make the resident 'Submit a request' flow actually file a request", with e2e coverage. |
| 15. Ramp/QuickBooks | Already tracked: #32 (sync, references only) and #33 (AP/AR mapping decision, blocking). |
| 12/18. Outbound email | Already tracked: #49 (Resend domain + API key, external) and #41 (deposit-return notices). The Resend account exists. |
| 11/14. Turnover / move-out | Already tracked: #38 (household turnover orchestration). |
| 9. RA notification | Already tracked: #14 (email notifications for request activity). |
| 25. Docs reconciliation | CLAUDE.md is stale *today* (fifteen tables listed, nineteen exist). Worth an early pass, not a last one. |

---

## Phase 1 — Schema foundation (this branch)

One migration, not five. Order within the phase:

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

- **2.1** ✅ (done 2026-08-26 on this branch) Remove the JotForm integration entirely (supersedes backlog 10's
  "retire"): delete `POST /api/webhooks/jotform` and
  `GET /api/webhooks/jotform/config`, the field-mapping and keyword
  auto-detection code, the `JOTFORM_*` handling in `server/config.ts`, the
  admin setup dialog, and their tests; strip `JOTFORM_*` placeholders from
  `.env.example`. Update the README and the CLAUDE.md Integrations section in
  the same commit. Nothing blocks this — the webhook already fails closed
  without its secret, so removal only deletes dead surface area.
- **2.2** Property-scoped `ownsRecord` (backlog 7). Unblocked by 1.2 (done). Add a property match **alongside** the existing email comparison — `submittedBy` stays an email; nothing re-keys on user ID. New cases in `ownership.test.ts`: both accounts on property A read A's requests; neither reads B's. Highest-risk change in the backlog; smallest possible diff.
- **2.3** RA notification on new request (backlog 9) — behind outbound email (3.2, and external #49). Tracked in #14. Keep the content free of anything the audit log would redact.

(Backlog 8, in-portal submission, shipped on main on 2026-08-26 and needs no further work here.)

## Phase 3 — Accounts and residents

- **3.1** Steward provisioning + turnover (backlog 11): admin pre-creates the two resident accounts per property (email-based re-linking in `upsertUser` is the intended mechanism); deactivation via `isActive`. UI on Settings or Residents. Coordinate with #38 (turnover orchestration) rather than duplicating it.
- **3.2** Outbound email plumbing (backlog 12): Resend vars in `server/config.ts` (boot-time validation) + `.env.example` placeholders. External dependency: #49. Unblocks 2.4, backlog 18 and 23, and #41.
- **3.3** Fast multi-resident entry (backlog 13): the CRUD exists; the work is the "enter a full house in one sitting" flow on `Residents.tsx`.
- **3.4** Move-out with context (backlog 14): confirmation states resident, property, and what happens to records and outstanding charges. History already survives — moving out sets `moveOutDate` + clears `isActive`; nothing is deleted.

## Phase 4 — Finance and dashboard

- **4.1** Ramp/QuickBooks (backlog 15): tracked in #32, **blocked by the AP/AR decision #33**. References/status/dates/amounts only.
- **4.2** Outstanding fees + deposits panel (backlog 16): data and region scoping exist on `/api/rent-payments` and `/api/security-deposits`; `Finances.tsx` exists. Work is the "outstanding" rollup view, gated on `canViewFinancials` (from 1.3).
- **4.3** Maintenance spend by region + annual budget (backlog 17): needs a budget column (per property or region — SPO input pending); schema change follows the migration rules. The signal to surface is *underspend*.
- **4.4** Bounced-payment visibility (backlog 18): mark a payment `failed` (from 1.4), surface in 4.2's panel. Auto-email later, after 3.2. Confirm SPO holds emails for account-less residents — `residents.email` is `notNull`, so the column is there; whether the data is real is the question.
- **4.5** Lease renewal column on Properties list, filter/sort (backlog 19). Depends on 1.1.
- **4.6** Owned/rented `Badge` on PropertyDetail header + list (backlog 20). Depends on 1.1. This branch already carries the PropertyDetail page.
- **4.7** Audit events for every new money/access action (backlog 21): via `AUDIT_ACTIONS`, plain-language summaries. Applies per-ticket above, not as a sweep at the end.

## Phase 5 — Later

- **5.1** Spreadsheet import for residents (backlog 22): `guardedUpload()`, permission check ahead of multer, preview-and-confirm, duplicate rule = email within a property.
- **5.2** In-app support request (backlog 23) — after 3.2.
- **5.3** Sentry (backlog 24): CSP allowance in `server/security.ts`, `package-lock.json` `resolved` URL check, PII scrub.
- **5.4** Docs reconciliation (backlog 25) — but do a first pass **now**: CLAUDE.md already understates the schema by four tables, which is exactly how this backlog over-scoped Phase 1.

---

## Decisions needed before or during Phase 1

1. **Link table vs. `propertyId` on `users`** (1.2). Recommended: `propertyId` column, per the codebase's existing loose-reference pattern. Cheap to revisit before anything depends on it.
2. **Reversing #43's "no finance permission" decision** (1.3). The meeting's call stands unless the maintainer objects; the plan implements the flags with a staff backfill.
3. **`rent_payments` is the household-fee table** (no new charges table). The backlog's task 4 vocabulary (`pending`/`failed`) maps onto `unpaid`/new `failed`; `waived` stays.

## Open items with SPO

1. ~~Property-management JotForms~~ — withdrawn (2026-08-26): nothing
   JotForm-related is wanted; the portal form's field set is the source of
   truth, so there is nothing to collect.
2. Emails for account-less residents (backlog 18) — the roster column exists and is required; confirm the data is real.
3. Cross-region resident moves (affects `requireRegionMove` on the resident update path).
4. Annual maintenance budget: per property or per region (4.3).
5. Deposit questions already with SPO: #60.
