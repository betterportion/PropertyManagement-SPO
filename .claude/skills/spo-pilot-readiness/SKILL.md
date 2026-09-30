---
name: spo-pilot-readiness
description: Pilot-readiness go/no-go audit of the SPO Admin Portal before real SPO staff, residents and data go on it. Use when asked whether the portal is ready for a pilot, launch or real data, or to run the pre-pilot audit. (Not the DonorCRM `pilot-readiness-audit`.)
---

# SPO pilot-readiness audit

The deliverable is a **verdict**: GO, GO-WITH-CAVEATS or NO-GO on putting real SPO residents, staff, access codes, HH fees and deposits into the portal. Everything before step 6 exists to make that verdict evidence, not opinion.

The rules the audit holds the code to are `CLAUDE.md` and the feature notes in `.claude/rules/` (CLAUDE.md's "Feature notes" table says which file holds which section). This skill points at their sections and never restates them. Where the code contradicts one of them, the gap is itself a finding.

## Guardrails

- **The repo stays as it is.** Everything this skill writes goes in the run directory, including a disposable `git worktree` for the checks that must edit code. Tests, fixes and issues come after the verdict, on the user's say-so.
- **Findings stay private.** The repo is public and a finding can be a working exploit, which is why the run directory sits under `.local/` (gitignored). Nothing leaves the machine: no issue, advisory, PR or comment until step 7.
- **Local data only.** A database the audit needs is a throwaway one on the sweep Postgres (step 1 of `.claude/skills/spo-e2e-sweep/SKILL.md` has the setup). Never the `DATABASE_URL` in `.env`, never staging or production.

## 1. Set up the run

`$RUN` is `.local/pilot-audit/<YYYY-MM-DD>/` at the repo root. Its state file `$RUN/audit.md` holds: current step, the commit audited, each lane's status, blockers found so far, next action. Update it at every step boundary. On resume, read it first and carry on from the recorded step; settled findings stay settled.

Create the worktree: `git worktree add $RUN/wt HEAD`, then `ln -s <repo>/node_modules $RUN/wt/node_modules`. Check schema drift in it before any lane touches it: `DATABASE_URL=postgres://unused@localhost/unused npm run db:generate` from `$RUN/wt` (it compares files and never connects), then `git -C $RUN/wt status --porcelain migrations`. Any new file, or an interactive rename prompt, means `shared/schema.ts` has changed without a committed migration: a finding. Reset with `git -C $RUN/wt clean -fd migrations && git -C $RUN/wt checkout -- migrations` (safe here: the worktree holds no work).

Done when `audit.md` holds the audited commit's hash and the drift result.

## 2. Establish what the pilot starts from

The code on `main` is not what the pilot runs. Record in `audit.md`:

- **Deployed commit.** Ask the user which commit is live on staging and production; the repo cannot tell you. Every fix merged after it is a **blocker** until deployed.
- **Unfinished work.** Each item in STATE.md's "Unfinished / next" (undeployed security fixes, unapplied migrations, unpublished advisories, open decisions), classified blocker or not, with the reason.
- **Open issues.** `gh issue list --state open --json number,title,labels`; classify the same way.
- **The data plan.** Whether the pilot starts on a reset database (the expectation so far) or carries existing rows across. Carrying rows across puts every pre-launch data bug back in scope.

Done when every Unfinished item and open issue has a classification.

## 3. Build the route inventory

The access lane's completion criterion is only as good as its list. Build `$RUN/routes.md` yourself, one row per route registered in `server/` (`grep -nE "app\.(get|post|put|patch|delete)\(" server/*.ts`): method, path, `file:line`, the guards it applies in order (login, active, staff, flag, region or house scope, file ownership, upload guard), and the `routeAccess.test.ts` or `authz.test.ts` case that proves its refusal, or `none`.

Done when the row count equals the grep count. A second route: count `isAuthenticated` occurrences in the same files and reconcile any route without one against the public list it belongs to (`/api/health`, the login routes).

## 4. Run the audit lanes

Dispatch the five lanes in [`lanes.md`](lanes.md) as parallel read-only subagents in one message, each with the lane brief and its section. While they run, run the gate yourself from the repo root (not the worktree, which the `tests` lane is mutating) and record the output in `audit.md`:

```
npm run lint && npm run check && npm test && npm run build
```

Done when every lane has returned a coverage list that accounts for every item its section names, and the gate result is recorded. A lane whose coverage has a gap goes back out for the gap.

## 5. Verify

Every CRITICAL and HIGH finding goes to a verifier (the verifier brief in `lanes.md`), a different agent from the lane that raised it, which reproduces it by a **second route**: read, then run. A finding reproduced is CONFIRMED; one the verifier can argue but not run is PLAUSIBLE and says what would settle it; one it cannot reproduce is dropped and listed as dropped. MEDIUM and LOW go into the report as raised.

Then the dynamic half the lanes do not cover: ask the user for the latest `/spo-e2e-sweep` report, or to run it (it is user-invoked, so only they can). Its confirmed findings join the list at their own severity.

Done when every CRITICAL and HIGH carries CONFIRMED, PLAUSIBLE or dropped.

## 6. Verdict

Write `$RUN/report.md`, then give the user, in this order:

1. **PILOT-READINESS VERDICT: GO / GO-WITH-CAVEATS / NO-GO.** Any unresolved CRITICAL, confirmed or plausible, is NO-GO. So is any blocker from step 2.
2. **Blockers**, each with `file:line` (or the STATE.md item), why it blocks, and the smallest change that clears it.
3. **Risks accepted for a pilot**, stated plainly, including which "Known open issues" in CLAUDE.md weigh differently once real data is on the site.
4. **Human-only checks still open**: the items in `docs/PRODUCTION_MIGRATION.md` "Step 8 — Test staging properly" and anything else no agent here can observe (backups, the Workspace consent screen, the bucket's privacy setting). Name each as unverified.
5. **What this audit did not cover**, and every load-bearing claim below *read* labelled as inferred or assumed.

Done when the user has the verdict and `report.md` holds everything behind it.

## 7. After the verdict

Offer, and wait for approval:

- **Security findings**: while the live site holds only test data, the user has chosen ordinary PRs with neutral titles (the rule, not the exploit, and no GHSA ids). Once real data is on the site, ask again before anything public; a GitHub draft security advisory is the private route.
- **Everything else**: one issue per finding per `docs/agents/issue-tracker.md`, label `needs-triage`, with `file:line` and the fix.
- **Fixes**: separate work, one PR each, test first. Not part of this skill.

Then remove the worktree (`git worktree remove $RUN/wt`) and keep `$RUN` for the next run to compare against.
