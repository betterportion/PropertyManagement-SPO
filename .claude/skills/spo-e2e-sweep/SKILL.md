---
name: spo-e2e-sweep
description: End-to-end sweep of the SPO Admin Portal. Runs the Playwright suite, then parallel subagent lanes exploring the real app per area and persona, then an independent verify pass, and reports confirmed findings.
disable-model-invocation: true
---

# SPO end-to-end sweep

Two halves. The **suite** is the existing Playwright run in `e2e/`: one worker, one database, what CI runs. The **sweep** is exploratory: one subagent per **lane**, each with its own database, server and personas, driving the app to find what the suite does not test. The subagents earn their cost only in the sweep: lanes are independent, so they run in parallel, and a **finding** is only reported once a different agent has reproduced it by a **second route**.

The rules a lane tests against are `CLAUDE.md` and the feature notes in `.claude/rules/` (CLAUDE.md's "Feature notes" table says which file holds which section). This skill points at its sections and never restates them, so it cannot drift from them.

## Guardrails

- **Throwaway data only.** Every database this skill touches is named `spo_sweep_*` and lives on the sweep Postgres on port 55432. Any other Postgres on the machine (another project's container, a local Supabase) and any database named `spo` are someone else's.
- **Nothing leaves the machine.** Every server this skill starts runs with email off and local file storage (the server env in step 1), because `npm run dev` also loads `.env` and a value there could point at Resend or a real bucket. Environment variables beat `.env`, which is why they are set explicitly, even when empty.
- **The repo stays as it is.** Lanes and verifiers write only inside the run directory. The sweep reports; turning findings into specs, fixes or issues happens after step 5, on the user's say-so.

## 1. Set up the run

1. **Run directory**: `<session scratchpad>/spo-e2e-sweep-<YYYYMMDD-HHMM>/` (below: `$RUN`). Symlink the repo's `node_modules` into it (`ln -s <repo>/node_modules $RUN/node_modules`) so scratch scripts there resolve `@playwright/test` and `pg`, and write `{"type":"module"}` to `$RUN/package.json` so they can use top-level `await`.
2. **State file** `$RUN/run.md`: phase, lanes with port/database/status, whether this run started the Postgres container, next action. Update it at every step boundary. On resume, read it first and carry on from the recorded phase.
3. **Postgres**: `pg_isready -h localhost -p 55432`. If nothing answers, start one and record that you did:
   `docker run -d --rm --name spo-sweep-pg -e POSTGRES_PASSWORD=verify -p 55432:5432 postgres:16`, then poll `pg_isready` until it answers.
4. **Databases**: one per lane plus `spo_sweep_suite` (lane names are in [`lanes.md`](lanes.md)). For each, with `PGPASSWORD=verify`: `createdb -h localhost -p 55432 -U postgres <name>`, then from the repo root `DATABASE_URL=<url> npm run db:migrate` and `DATABASE_URL=<url> SEED_ADMIN_EMAIL= STORAGE_DRIVER=local UPLOAD_DIR=$RUN/<lane>/uploads npm run db:seed`. The seed stores demo photos through the real storage layer, so without the two storage variables it writes wherever `.env` points, and the lane's server cannot serve them. The URL is `postgres://postgres:verify@localhost:55432/<name>`; the suite's upload directory is `$RUN/suite/uploads`.
5. **Lane servers**: one per lane, ports 5051 upward, started with `run_in_background` and logging to `$RUN/<lane>/server.log`:

   ```
   PORT=<port> DATABASE_URL=<lane url> SESSION_SECRET=sweep-session-secret-at-least-32-chars \
   OIDC_ISSUER_URL=https://accounts.google.com OIDC_CLIENT_ID=sweep-placeholder OIDC_SCOPES="openid email profile" \
   STORAGE_DRIVER=local UPLOAD_DIR=$RUN/<lane>/uploads RESEND_API_KEY= EMAIL_FROM= APP_URL= \
   npm run dev
   ```

   Poll `http://localhost:<port>/api/health` until it answers. OIDC discovery at boot needs network access to Google; a boot failure mentioning discovery is environment, not a finding.

Done when every lane's health check answers and `run.md` lists each lane's port and database.

## 2. Run the suite

From the repo root, with port 5050 free:

```
CI=true TEST_DATABASE_URL=postgres://postgres:verify@localhost:55432/spo_sweep_suite \
SESSION_SECRET=sweep-session-secret-at-least-32-chars STORAGE_DRIVER=local UPLOAD_DIR=$RUN/suite/uploads \
RESEND_API_KEY= EMAIL_FROM= npm run test:e2e 2>&1 | tee $RUN/suite/output.txt
```

`CI=true` makes Playwright start its own server on 5050 and retry once, so a test that passes on retry is reported **flaky**. Label every test that did not pass cleanly as one of:

- **real**: fails on retry and the failure is the app's behaviour. It joins the findings for step 4.
- **flaky**: passed on retry. Note the test and what the first attempt tripped on.
- **environment**: port, browser, database or network. Fix the environment and rerun that spec (`npx playwright test e2e/<spec>`) before labelling anything else.

Done when the pass/fail/flaky counts are in `run.md` and every non-clean test carries one label with its evidence (trace or error line). The sweep runs regardless of the suite result: a red suite is a finding, not a stop.

## 3. Sweep the lanes

Read [`lanes.md`](lanes.md). Spawn one `general-purpose` agent per lane, **all in one message**, each with the brief template filled in for its lane. The brief is the lane's whole context: they have not seen this conversation.

Lanes report by message in labelled parts. Copy each finding into `$RUN/findings.md` under a `## <lane>` heading as it arrives, so the file, not your context, is the record the verifiers read.

Done when every lane's findings are in `findings.md`, its coverage list is in `$RUN/<lane>/coverage.md` or a message, and `run.md` records each lane as returned. A lane that returns without a coverage entry for every probe in its brief gets sent back (SendMessage) for the missing ones.

## 4. Verify

Add the suite's **real** failures to `$RUN/findings.md`. Mark any finding already tracked (`gh issue list --state open`, and the "Unfinished" list in `STATE.md`) with its issue number; it goes in the report as tracked and skips verification. Spawn verifier agents, up to three, splitting the findings by lane, each with the verifier brief from [`lanes.md`](lanes.md). The lane servers are still up, so a verifier works against the same server and database as the lane that found it, with personas it mints fresh.

The **second route** is the point: a finding seen in the screen is reproduced with a direct request to the API, and one seen over the API is reproduced in the screen (or, when the screen has no path to it, by reading the handler in `server/routes.ts` and `server/authz.ts` and citing the line). Reading the lane's own script again and agreeing with it does not count.

Done when every finding carries one verdict: **confirmed**, **not reproduced**, or **different cause** (reproduces, but the lane's explanation is wrong; the verifier states the real one).

## 5. Report and tear down

Write `$RUN/report.md`:

1. **First line**: suite counts, then confirmed findings by severity (CRITICAL/HIGH/MEDIUM/LOW, the code-review scale). An authorization finding is at least HIGH.
2. **Confirmed findings**, most severe first: persona, steps, expected (with the section and the file it is in), observed, evidence path, verifier's second route.
3. **Not reproduced**: one line each.
4. **Coverage**: per lane, what was exercised and what was not, with the reason. What nobody tested is stated as untested.

Then tear down: stop every lane server, `dropdb` every `spo_sweep_*` database, and `docker stop spo-sweep-pg` only if `run.md` says this run started it. Keep `$RUN`.

Tell the user the headline and the path to `report.md`, and offer, ranked: a Playwright spec for each confirmed finding worth guarding, GitHub issues grouped by root cause, publishing the report as a page. Do each only on their go-ahead. The repo is public: authorization and file-access findings go in private draft security advisories (`gh api -X POST repos/<owner>/<repo>/security-advisories`), and only the rest become public issues, with no reproduction steps for anything exploitable.
