# Launch readiness round

The record behind `PROJECT_BRIEF.md`: what the Phase 0 audit found (2026-10-09), the
decisions JR took on it (2026-10-10), and a ledger of what each phase landed. Where the
brief and this file disagree about what the repository already holds, this file is current.

---

## Decisions taken (JR, 2026-10-10)

Numbered as the audit's questions were.

1. **The cap constant is `MAX_RESIDENT_ACCOUNTS_PER_PROPERTY = 4`** in `shared/residents.ts`,
   renamed from `HOUSE_PORTAL_ACCOUNT_LIMIT = 3` (which had landed with invite-only sign-in,
   #217, PR #220, 2026-10-01). The brief's premise that the cap was two was already out of date.
2. **The cap binds every path that links an active resident account to a house**, admins
   included: the RA's portal-access grant, and the admin's create, move and reactivate in
   Settings. An admin-created resident login with no current roster row at its house still
   reads nothing and is switched off by the next daily run (#222); that rule is untouched.
3. **An invitation goes to the roster email, and sign-in must use it**, as today. "The address
   they actually check" means the RA puts that address on the roster row first. A separate
   contact address that is not the login would change `isCurrentRosterMember` and is not
   being built.
4. **Who invites:** the two existing pre-create paths send the email: the RA's portal-access
   grant and the admin's create user in Settings. Same template; the house line is omitted for
   staff. No new "enter an email" screen beyond a send-date field on each.
5. **A scheduled invitation pre-creates the account now; only the email waits for `sendAt`.**
6. **One set of four close-out answers per request**, recorded against every contractor linked
   at completion. Not one set per contractor.
7. **"What was done" is a thread comment**, internal by default like the composer, with its
   attachment through the existing route. The four facts and the note go in `request_closeouts`.
8. **No prompt on `cancelled`**, only on `completed`.
9. **One close-out per request**: completing again edits it; reopening leaves it in place.
10. **The prompt applies to all three request types.**
11. **The rollup denominator** is close-outs that answered the four for that contractor. Jobs
    completed before the feature, or with no contractor linked at the time, are not counted.
12. **Which jobs count:** close-outs the caller can see, filtered by the request's region, as
    the contractor page is today.
13. **The invitation sender is its own daily job**, started in `server/index.ts` beside the
    existing five, and listed in `docs/WORKFLOWS.md`.
14. **The brief lives at the repo root**, with its read order pointing at the two plan
    documents under `docs/`.
15. **The Phase 1 browser spec mints its own sessions** with the helper in `e2e/global-setup.ts`.
16. **Phase 1 needs no migration**: the cap is a constant.

---

## What the Phase 0 audit found (2026-10-09)

**Premises in the brief that had moved on.** The 2026-09-19 RA review round is shipped: all
eleven PRs (#142–#152) merged on 2026-09-25, every merge commit an ancestor of `main`
(the item-by-item ledger is in `docs/IMPLEMENTATION_PLAN_ADDENDUM.md`). The cap was three,
not two. Most of "invitations" already existed as portal access from the roster; what was
missing was the email, a scheduled send and the invitation table. There are five daily jobs,
not three. `CLAUDE.md` has no data-model table; that section is prose.

**Where the cap was enforced.** One server site, the portal-access grant. Not on the three
admin paths (`POST /api/users`, `PATCH /api/users/:id/property`, reactivation through
`PATCH /api/users/:id/status`). Overlap (two leaders linked to one house) already held: both
pass the house match in `canReadMaintenanceRequest`, and region is never consulted for a
resident.

**Moving a request to `completed`.** One route, `PATCH /api/maintenance-requests/:id`, with
`status` as one field of the edit form's partial body; the status select sits in
`MaintenanceEditDialog`. No prompt, nothing required. A contractor link exists at that point
and is many-to-many (`request_contacts`), so a request can have zero, one or several
contractors at completion. The only attachment path is a comment or a bid. Callbacks are
inferred in `server/aggregates.ts` from repeat visits, not recorded.

**Email.** `sendEmail` is plain text, returns a result and never throws; every message names a
template from `shared/emailTemplates.ts`; builders in `server/notifications.ts` are pure.
`server/moveOut.ts` already awaits sends inside a daily job, the precedent for an invitation
sender.

**Which job to copy.** The move-out pair in `server/moveOut.ts`: a pure planner over rows and
`now`, an injectable storage pick, idempotence by a stored key, awaited sends. None of the five
`start…Job` functions had a unit test for the boot-safety wrapper.

**Columns or a table for the close-out.** A `request_closeouts` table, one row per request:
the request row already carries five sometimes-meaningful nullable columns the general edit
route must refuse on a repair; the close-out is written at one moment by one narrow route; the
contractor rollup becomes a read over close-outs for one contact; re-completion is one row
overwritten.

---

## Ledger

| Phase | PR | What landed | Migration |
|---|---|---|---|
| 1 | — | Four resident accounts per house: `MAX_RESIDENT_ACCOUNTS_PER_PROPERTY = 4`, `residentAccountCapProblem` in `server/authz.ts` applied by the grant and the three admin paths, Settings house pickers show each house's count, brief 2.1 and 2.2 fixtures in `routeAccess.test.ts`, `e2e/house-accounts.spec.ts` | — |

**Phase 1 gate (manual, JR):** on desktop, add a fourth account to a house, attempt a fifth,
read the refusal. Not yet performed.
