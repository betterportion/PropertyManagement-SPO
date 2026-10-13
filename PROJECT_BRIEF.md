# SPO Admin Portal — Implementation Brief: Launch Readiness Round

Keep this file at the repo root. Every fresh session reads it after `CLAUDE.md` and before
anything else. `docs/IMPLEMENTATION_PLAN.md` and `docs/IMPLEMENTATION_PLAN_ADDENDUM.md` are context
for *why* the app looks the way it does; they are not the task. The task is this file.
The Phase 0 audit and JR's answers to its questions are in `docs/LAUNCH_READINESS_ROUND.md`;
where this brief and that record disagree about what the repo already holds, the record is current.

**Read order:** `CLAUDE.md` → this brief → the two plan documents only if you need the
history behind a decision.

---

## 0. The three things that will kill this project

**1. Building on top of work that never shipped.** Two prompts (2026-09-09 and 2026-09-19)
are believed to be implemented. Nobody has confirmed the second. If you assume it shipped
and it did not, Phase 3 of this brief lands on a maintenance close-out flow that does not
exist. → Phase 0 is an audit with a hard stop. Nothing in Phases 1–3 begins until I have
approved the audit report.

**2. Widening resident access in the one area with a history of silent holes.** Lifting
the two-accounts-per-house cap to four, and allowing two household leaders on one house at
the same time, touches `users.propertyId` and `residentHouseAddress(ctx)` — the exact path
behind both historic authorization gaps. The failure is not a crash; it is a student who
can see the wrong house, and nothing on screen looks broken. → Section 2 locks the
behaviour as test fixtures; Phase 1's gate is an e2e proof that a fourth account sees
exactly what the first one sees and a fifth is refused.

**3. The close-out prompt becoming a wall.** If marking a request complete demands too
much, RAs stop marking things complete, and the data gets worse than before the feature
existed. → Section 2 caps the prompt at four yes/no questions and one note, and only
requires the four when a contractor is linked. If you find yourself adding a fifth field,
stop.

You cannot verify email delivery or Google sign-in in this environment (Section 4). That is
not a fourth killer, because the design routes around it — but every phase that touches
either has a manual step I perform at the gate, and you must not report those as verified.

---

## 1. What we're building and for whom

Three changes to get the portal into regional administrators' hands, driven by one RA's
honest answers about how contractor history is actually lost and who needs to sign in.

- **A.** Up to four resident accounts per house, admin-managed, with overlap allowed during
  handover.
- **B.** Invitations: an admin enters an email, the person gets an invitation at the
  address they actually check, and their first Google sign-in lands them in the right house.
  Optionally scheduled for a future date.
- **C.** A close-out prompt on maintenance requests that captures what happened when the
  contractor came, as facts rather than opinions, feeding a history on the contractor's
  page.

Users are non-technical SPO staff and students. Plain language everywhere.

---

## 2. Locked decisions

These are settled. They are not open for revision. If you believe one is wrong, **stop and
say so with your reasoning**; do not adjust and continue.

### 2.1 Resident accounts per house — maximum four

Usually one household leader and one or two stewards; four covers the dorm case and July
handover. The cap is a single named constant, `MAX_RESIDENT_ACCOUNTS_PER_PROPERTY = 4`,
enforced server-side at account creation and at property reassignment. The UI reflects it;
the UI is not the enforcement.

Test fixtures:

```
property P has 0 resident accounts → create resident r1..r4 on P → all succeed
property P has 4 resident accounts → create r5 on P → refused, storage write never called
property P has 4, property Q has 2 → move r4 from P to Q → succeeds; P now 3, Q now 3
property P has 4, property Q has 4 → move r1 from Q to P → refused
admin bypass: the cap applies to admins too — this is a data rule, not a permission
```

### 2.2 Overlap is allowed and changes nothing about scoping

Two household leaders on one house at once is normal in late July. Both are ordinary
resident accounts linked to the same `propertyId`. Resident visibility stays **ownership or
house, never region**, exactly as today. No new visibility rule.

Test fixtures:

```
r1 and r2 both linked to P → both read every maintenance request for P
r1 linked to P, r3 linked to Q → r1 cannot read any request for Q, and a refused read
  never calls the storage method
```

### 2.3 Invitations ride on the existing re-link; no new login method

`upsertUser` already re-links an admin-pre-created account to the provider's subject on
first sign-in by email, preserving role, `isActive`, permissions and `propertyId`. An
invitation is: pre-create the account → send an email with a link to the sign-in page.
**No token, no magic link, no passwordless path.** Google OIDC remains the only way in.

A scheduled invitation is an invitation row with a `sendAt` in the future and a null
`sentAt`. A daily job sends due ones. It is the fourth in-process daily job and must meet
the standing rule: idempotent (via `sentAt`), and unable to fail the boot.

Test fixtures:

```
invitation with sendAt = yesterday, sentAt = null → job sends it, sets sentAt
invitation with sendAt = yesterday, sentAt = set   → job skips it
invitation with sendAt = tomorrow                  → job skips it
job run twice in one process                       → second run sends nothing
sendEmail returns a failure                        → sentAt stays null, job continues,
                                                     failure logged, boot unaffected
```

### 2.4 Close-out prompt — four facts and a note, nothing more

When a request moves to `completed`:

- **Always shown, optional:** "What was done" (free text), with the existing attachment
  control visible — screenshots of texts and emails are an expected attachment.
- **Shown and required only when a contractor is linked:** four yes/no questions —
  finished on the first visit; final cost matched the quote; needed a callback; would use
  again — plus a required note.

No rating scale. No star field. No score on the contractor, ever. The contractor page shows
**counts and the dated history**, never an average.

Fixture for the contractor page, from nine completed jobs:

```
first-visit yes ×7, no ×2 → "Finished on first visit: 7 of 9"
quote matched yes ×8, no ×1 → "Cost matched quote: 8 of 9"
callback yes ×2, no ×7 → "Needed a callback: 2 of 9"
would use again yes ×8, no ×1 → "Would use again: 8 of 9"
```

The nine rows are listed beneath, newest first, each with its note and a link to the
request.

### 2.5 Things that are not changing

- **No contractor or handyman login.** Decided three times; rotating contractors make
  account lifecycle its own job for little gain.
- **No email-forwarding inbox.** Deferred past launch on purpose; the close-out prompt is
  the cheaper experiment that decides whether it is needed.
- **Residents never see financial data**, and the portal never sends a financial document
  to a resident.
- **The dashboard does not change** in this round.
- **`finance@spo.org` as a shared login** is Joseph's decision and needs no code either
  way. Do not build for it.

---

## 3. Architecture

Everything follows the module map in `CLAUDE.md`. Specifics for this round:

| Concern | Where | Notes |
|---|---|---|
| Account cap | `server/authz.ts` helper + enforced in the user-create and property-reassign routes | One constant, exported, imported by the client for the UI hint |
| Invitations | new `invitations` table in `shared/schema.ts`; `server/invitations.ts` | Pure `selectDueInvitations(rows, now)` so the job tests without a clock |
| Invitation sending | `server/email.ts` only | Plain text. `sendEmail` returns a result; never throws |
| Daily job | started in `server/index.ts` beside the existing three | Runs once at boot then daily; wrapped so a throw cannot fail boot |
| Close-out fields | new columns on `maintenance_requests` or a `request_closeouts` table — your call, justify it in the Phase 0 report | Four booleans + note + what-was-done |
| Contractor rollup | `server/contractorSummary.ts`, pure | Same shape as `regionSummary.ts`; fixture in 2.4 is its test |
| Audit | `AUDIT_ACTIONS` | Invitation created/sent is access history → add to `AUDIT_ACTIONS_KEPT_INDEFINITELY`. Close-out is neither access, money nor documents → not audited |

Boundaries that hold: route handlers never touch the database; `getUserId(req)` is the only
identity accessor; every image or file at close-out goes through the existing upload path.

---

## 4. Environment constraints

**You can run:** `npm run lint`, `npm run check`, `npm test`, `npm run build`, and
`npm run test:e2e` against a throwaway Postgres with headless Chromium (after
`npx playwright install chromium`, `npm run db:migrate`, `npm run db:seed`).

**You cannot run or verify:**

- **Sending email.** No Resend credentials. Design so the send is the last, thinnest step:
  the invitation body is built by a pure function with a snapshot test, the job logic is
  tested with fixtures from 2.3, and the actual send is `sendEmail` whose result you log.
  Report "send path exercised in test mode"; never report "email verified."
- **Google sign-in.** The re-link is covered by `upsertUserRelink.test.ts`; extend it. The
  live flow is mine to verify at the Phase 2 gate.
- **A real phone.** Use Playwright's mobile viewport emulation for the close-out prompt;
  the phone check is mine at the Phase 3 gate.

**Manual steps I perform at each gate** are listed under the gate. Do not mark a gate passed
on my behalf.

---

## 5. Phases and gates

Do not begin a phase until the previous gate is approved. If a gate fails, propose the
smallest fix or a pivot — do not continue past it.

**This project can legitimately stop at Phase 0.** If the audit shows the 2026-09-19 round
is not shipped, the correct outcome is a report saying so and a halt. That is not a stall;
it is the brief working.

### Phase 0 — What actually exists?

Audit, no code. Report, with file references:

1. Which items from the 2026-09-19 prompt are shipped, partly shipped, or absent. Item by
   item, all eight.
2. Where the current two-per-house cap is enforced — every site, server and client.
3. What happens today when a request moves to `completed`: which route, which UI, whether
   a contractor link exists on the request at that point.
4. What `server/email.ts` can send and what template or body-building pattern exists.
5. Which of the three existing daily jobs is the cleanest model for a fourth, and why.
6. Your recommendation on columns versus a `request_closeouts` table, with reasoning.
7. Numbered questions, each with the default you will use if unanswered.

**Gate:** I approve the report. If the 2026-09-19 round is not fully shipped, stop here.

### Phase 1 — Can a house hold four accounts, with overlap, without widening access?

Implements 2.1 and 2.2. Migration for nothing unless the audit finds the cap is a schema
constraint. Admin user-management UI shows the count and refuses a fifth with a plain
sentence, not an error code.

**Demo condition:** `npm test` passes every fixture in 2.1 and 2.2 in
`server/__tests__/routeAccess.test.ts`, each refusal asserting the storage write was never
called, with one accepted request as the positive control. `npm run test:e2e` includes a
spec that creates four resident accounts on one seeded property, signs in as the first and
the fourth, and shows both the same request list and neither any request from a second
property.

**Gate (manual, me):** on desktop, add a fourth account to a house, attempt a fifth, read
the refusal message. Approve.

### Phase 2 — Does an invited person land in the right house on first sign-in?

Implements 2.3. Admin UI: enter email, choose role and house, optionally choose a send
date. Invitation email body: who invited them, which house, one link to the sign-in page,
plain text.

**Demo condition:** fixtures in 2.3 pass in a new `server/__tests__/invitations.test.ts`;
`upsertUserRelink.test.ts` extended with an invited-then-signed-in case preserving
`propertyId`; the invitation body has a snapshot test; the daily job is registered and the
boot-safety wrapper is tested by making the job throw. Audit events appear in
`AUDIT_ACTIONS_KEPT_INDEFINITELY`.

**Gate (manual, me):** with real Resend credentials, invite my own Gmail to a seeded house,
receive the email, sign in with Google, see that house's requests and nothing else. Approve.

### Phase 3 — Does close-out capture what the next RA needs, without becoming a wall?

Implements 2.4. Prompt appears on the transition to `completed`, on the existing status
control, not as a new page. Contractor page gains the rollup and history.

**Demo condition:** `contractorSummary.test.ts` passes the 2.4 fixture exactly; a request
without a contractor can be completed with every field empty; a request with a contractor
cannot be completed with a yes/no unanswered or the note blank, and the refusal is a
sentence on screen, not a disabled button with no explanation; Playwright mobile-viewport
spec completes a request with four answers and a note in under ten interactions.

**Gate (manual, me):** on a phone, complete a seeded request with a linked contractor, then
open that contractor's page and read the counts. Approve.

### After Phase 3

`CLAUDE.md` and `README.md` were updated in each phase's commit, per the standing rule; the
final check is that the data model table in `CLAUDE.md` matches `shared/schema.ts` exactly.
Full gate: `npm run lint && npm run check && npm test && npm run build`.

---

## 6. Explicitly out of scope

If a task appears to require any of these, **flag and stop**. Do not expand.

- A contractor, handyman or vendor login of any kind.
- An inbound email address or forwarding inbox.
- Magic-link, passwordless or any non-OIDC sign-in.
- A rating, score or star field anywhere, on contractors or jobs.
- Any dashboard change.
- Any resident-visible financial information, or any send of a financial document.
- Renaming `rent_payments` or other tables to match UI labels.
- Raising upload limits in `server/uploadLimits.ts`.
- Anything from the 2026-09-19 round that the audit finds unshipped. Report it; do not
  build it under this brief.
- A finance-team shared account. Needs no code; needs Joseph.

---

## 7. First task

Produce the Phase 0 audit report as described, with the numbered questions at the end.
Then stop and wait for my approval. Do not write code, do not create a migration, do not
begin Phase 1.
