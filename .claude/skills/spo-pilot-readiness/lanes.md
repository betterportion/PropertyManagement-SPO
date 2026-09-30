# Audit lanes

Five lanes, one read-only subagent each. Every lane gets the **lane brief** with its section pasted in. Only the `tests` lane may write, and only inside `$RUN/wt`.

Each lane's list is what it must cover, not everything it may look at. A thread worth pulling beyond the list gets pulled and named in the coverage.

## Lane brief

Fill every `<...>` and paste the lane's section where marked.

````
You are one lane of a pilot-readiness audit of the SPO Admin Portal, a
property management app about to hold real residents' names, house access
codes, household fees and deposits. The repo is <repo root>; work read-only
there. Your notes go in <run>/<lane>.md.

Read before auditing: CLAUDE.md in full, then the sections your lane names
(a section CLAUDE.md does not contain is in the .claude/rules/ file its
"Feature notes" table points to). Those are the rules you audit against.
"Known open issues" in CLAUDE.md is already known: report one only if real
data changes its weight, and say why. The route inventory is <run>/routes.md.

Severity:
- CRITICAL: someone reads or changes a record outside their region, house
  or tier; a file, access code or personal detail reaches someone it should
  not; a banking or card credential can be stored; real data can be lost
  with no way back.
- HIGH: a wrong amount or date on a record staff act on; a failure that is
  silent; a guard no test would catch being removed.
- MEDIUM: a gap that needs a second mistake to hurt. LOW: everything else.

Each finding: title, file:line, what goes wrong (the concrete request or
input and what comes back), who is affected (role and flags), severity, the
smallest fix, and the test that should exist. Cite only code you read at
that line; a risk you suspect but have not traced is a question, listed
separately. Where the code contradicts the doc, that gap is a finding.

Finish with a coverage list: every item in your lane below, marked checked
(with where you looked) or not reached (with why).

<lane section>
````

## access

- Every row of `routes.md` against CLAUDE.md "Authorization model": the three layers, the admin bypass, the region helpers. A row whose guards differ from its neighbours' pattern gets traced to the handler's end.
- Region scoping on lists, single reads, creates, updates (`requireRegionMove`) and deletes; references to another record (`requireInvoiceReferences`, `resolveContactLink`).
- Summaries: `/api/action-items`, `/api/region-summary`, tasks through `canSeeTask`.
- Residents: the maintenance read rule (type, ownership or house, the 120-day window) in list, detail and photo routes; "Resident access to walkthroughs" (tier gate, house match, prior years, the item PATCH allow-list); the shared-comment path in "Request threads".
- Account lifecycle: deactivation mid-session, `permissionsAfterRoleChange`, `upsertUser` re-linking by email (who can pre-create an account that captures a stranger's first sign-in), `users.propertyId` changes.
- CLAUDE.md "Identity" and "Login": `getUserId` the only reader of claims, the callback URL, session expiry.

## files-and-secrets

- CLAUDE.md "File uploads" through "Reading files back": the permission check before multer, magic bytes, server-side keys, every file column's ownership check, `GET /uploads/:filename` authorizing before existence.
- "House facts and access codes": who can read a code, that the audit event never holds the value, that no list or summary carries one; ADR `docs/adr/0002-access-codes-stored-in-the-portal.md`.
- CLAUDE.md "Financial data": grep `shared/schema.ts` and every free-text field a user fills for anything shaped like an account, routing or card number; the `reference` columns.
- What leaves the process: `sendError` and `server/errors.ts`, `server/logger.ts` call sites, audit summaries and `scrubDetails`, outbound email content ("Outbound email").
- Stored links: `httpUrlFromClient` on every URL column rendered into an `href`.

## money-dates-jobs

- HH fees (`rent_payments`, see CLAUDE.md "Data model") and deposits (`deposits.md`, `shared/depositLedger.ts`): amount types and rounding, what counts as outstanding, the damages worksheet totals.
- Dates: every date-only value from the form to the database and back to `formatDate`; month and season boundaries in Central time; the open question in STATE.md about `server/schedules.ts` raising at UTC midnight.
- The three daily jobs (CLAUDE.md "Backend"): idempotent across a restart, unable to fail the boot, bounded on a real-sized table.
- Rollups (`maintenance.md` "Rollups over maintenance history") and roster import (`roster-import.md`): what a malformed or duplicate row does.
- Migrations: the drift result in `audit.md`; any migration that drops or rewrites data; that `npm run db:migrate` on a fresh database reaches the current schema.

## tests

You may edit files inside <run>/wt only. Back a file up with `cp` before changing it and restore from the copy; never `git checkout --`.

- Every `routes.md` row with `none` in its test column: is the refusal covered anywhere else, by what?
- The 5 highest-risk guards (your pick, justified from `routes.md`): remove each in `<run>/wt`, run the narrowest test, and record whether it goes **red**. A guard whose removal stays green is a HIGH finding.
- CLAUDE.md's three test conventions: find tests that re-implement the code under test, that assert only a status code, or that carry a "not called" assertion with no positive control.
- `e2e/`: which of the Step 8 access checks in `docs/PRODUCTION_MIGRATION.md` a spec already covers.

## production

- `server/config.ts` and `server/index.ts`: what the boot refuses, what it silently defaults; every variable against `.env.example` and the env tables in `docs/PRODUCTION_MIGRATION.md`.
- Sessions and headers: cookie flags, `trust proxy`, `server/security.ts`, rate limits on login and upload routes, what an unauthenticated caller can reach.
- Login: `OIDC_*` defaults, what stops a Google account outside SPO's Workspace from signing in (in code, or only in Google's console: say which).
- Storage: the Supabase driver's bucket privacy assumption and signed-URL lifetime.
- `npm audit --omit=dev` output, and the `overrides` note in CLAUDE.md "Conventions".
- Recovery: backups, restore, rollback of a bad migration. Most of this lives outside the repo; list what the runbook says and what nobody has written down.

## Verifier brief

````
You are verifying findings from a pilot-readiness audit of the SPO Admin
Portal at <repo root>. You did not raise them. For each finding below,
reproduce it by a second route: if it was found by reading, run something
(a vitest case or script in <run>/wt, or a request against a throwaway local
server per .claude/skills/spo-e2e-sweep/SKILL.md step 1); if it was found by
running, read the code path end to end. Write only inside <run>.

Return each finding as CONFIRMED (with the command and output), PLAUSIBLE
(the argument, and exactly what would settle it), or DROPPED (why it does
not hold). Adjust severity if the reproduction shows it higher or lower, and
say so.

<findings>
````
