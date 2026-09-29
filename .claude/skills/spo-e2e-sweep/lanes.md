# Sweep lanes

Six lanes, one subagent each, one database `spo_sweep_<lane>` and one server port each (5051 upward, in this order). Every lane gets the **lane brief** below with its section pasted in. After the lanes return, the **verifier brief** at the bottom goes to up to three verifiers.

Each lane's probes are what it must cover, not everything it may try. A lane that finds a thread worth pulling beyond its list pulls it, and says so in its coverage.

## Lane brief

Fill every `<...>` and paste the lane's section where marked.

````
You are one lane of an end-to-end sweep of the SPO Admin Portal, a property
management app. The repo is <repo root>. Read the sections named in your lane
below before touching the app, in CLAUDE.md or, where its "Feature notes" table
says so, in .claude/rules/<file>.md: those sections are the rules you test
against, and "Known open issues" lists what is already known and is not a finding.

Your environment, already running:
- App: http://localhost:<port> (health: /api/health)
- Database: <lane url>, for psql (PGPASSWORD=verify) and for minting personas. Yours alone; mutate freely.
- SESSION_SECRET: sweep-session-secret-at-least-32-chars
- Lane directory: <run>/<lane>/. Write every script, screenshot and note there.
  <run>/node_modules links to the repo's, so scripts in the run directory
  resolve @playwright/test and pg. Run them with `npx tsx <script>` from the repo root.

Personas: mint each one you need with
  SESSION_SECRET=<secret> npx tsx .claude/skills/spo-e2e-sweep/mint-persona.ts \
    --db <lane url> --id <id> --role <admin|regional_administrator|resident> \
    [--regions "A,B"] [--flags canX,canY] [--property <id>] [--inactive] \
    --out <run>/<lane>/<id>.json
The script's header lists every flag. The --out file is Playwright storage state:
`browser.newContext({ storageState })` for the screen, `request.newContext({ baseURL, storageState })`
for the API. Find real ids, regions and houses in the seeded data with psql.

How to work:
- Drive the real app: the screen through Playwright's chromium, the API through
  Playwright's request context. Plain scratch scripts, no new dependencies.
- Read your own screenshots (they are images) when a check is visual.
- For every refused write, prove the write never happened: read the row or the
  count with psql before and after. A 403 alone does not prove the check ran first.
- For every negative check, run one positive control (a persona that should
  succeed, succeeding) so a typo cannot make the negative pass vacuously.
- The repo is read-only for you: the only files you create or change are in
  your lane directory. Never run git commands that change the working tree.
- Leave the app server running; the verify pass works against it after you.

Report two things to team-lead with SendMessage. Long replies get truncated and
the harness may refuse report files from subagents, so send findings in parts
under ~4,000 characters each, labelled "part N of M". Write the coverage list to
<run>/<lane>/coverage.md (send it as a message too if that write is refused).
Your final reply is one line: finding ids with severities.
1. Findings, each in this shape:
   ### <lane>-<n>: <one-line claim>
   - Severity: CRITICAL | HIGH | MEDIUM | LOW (authorization is at least HIGH)
   - Persona: <id and how it was minted>
   - Route: screen | api
   - Steps: <numbered, from a fresh persona>
   - Expected: <behaviour> (<CLAUDE.md or .claude/rules/file>: <section>)
   - Observed: <behaviour, with status codes and values>
   - Evidence: <paths in your lane directory>
2. Coverage: every probe in your lane, marked exercised (with the persona and
   one-line result) or not exercised (with the reason).

Your lane:
<paste the lane's section>
````

## Lanes

### authz-resident

Read: "Authorization model" (all of it), "Request types", "Request threads", "The resource hub", "House facts and access codes", "Resident access to walkthroughs", "Reading files back", "Known open issues".

Personas: a plain resident linked to house H; a household leader on H holding `canCompleteWalkthroughs` and `canViewResourceHub`; a leader with those grants and no `--property`; a resident on H whose permissions row names another region; a resident on house H2 in the same region as H.

Probes:
- Every `GET` in `server/routes.ts` (list them with grep) as each persona: what comes back is exactly what the rules allow, nothing about another house, no project or capital project, no closed request older than the 120-day window on the house path.
- Every write route a resident reaches: accepted where the rules say, refused elsewhere, the refused write absent from the database.
- Query parameters a resident could use to widen a read (`?type=project`, `propertyId` on `/api/maintenance-locations`) change nothing.
- Resident create forces type, region, house and submitter whatever the body says; a shared comment posted with `isInternal: true` is stored shared.
- `/uploads/<key>` for each kind of file (walkthrough photo, bid document, internal comment attachment, W-9, request photo) as each persona.
- The same reads through the screen: resident pages show nothing the API refused, and the leader's `/walkthroughs` opens earlier years read-only.

### authz-staff

Read: "Authorization model" (all of it), "Region scoping", "The admin bypass pattern", "Identity", "Audit log", "Known open issues".

Personas: a regional administrator limited to region R with view flags only; the same with manage flags; one with `--regions ""`; a deactivated staff account (`--inactive`); an admin whose `user_permissions` row you delete with psql after minting; a staff account holding `canCompleteWalkthroughs` and nothing else.

Probes:
- Every list route: region R's records only, none for the empty-regions account, every region for the admin with no row.
- Every create, update and delete: a manage-less account is refused with the row unchanged; a record cannot be moved into a region the account lacks (`requireRegionMove`).
- The deactivated account is refused everywhere, screen and API.
- The admin-only surfaces (walkthrough template, resource links, users, audit log) refuse a regional administrator whatever flags it holds.
- A staff request filed against a house takes the house's region whatever the body says.
- Audit events fire for access, money and document changes and never carry a code, credential or banking identifier (`select action, summary, details from audit_log`).

### maintenance

Read: "Where a maintenance request is, and who fixed it", "Request types", "Projects and bids", "Request threads", "Outbound email", "Rollups over maintenance history", "Known open issues".

Personas: admin; regional administrator for one region with maintenance manage; a resident on a house in that region.

Probes:
- Full lifecycle in the screen: create, edit, status to completed (close date stamped), reopen (cleared), cancel.
- Type changes: repair to project shows the five project fields; project back to repair clears them; the PATCH refuses them on a repair; a quarter without a year is refused.
- Bids: record with a contact and with a typed vendor, edit, accept (the others un-accept), delete; document upload through the bid-document route.
- Threads: internal default in the composer, shared post, attachment on a comment, delete by author and by admin, relay line.
- Filters on `/maintenance` and on a property's history table agree about type and range; the Open work tab groups add up to the open total.
- Recurring issues and callbacks read sensibly over the seeded history.

### walkthroughs

Read: "The walkthrough template", "The walkthrough screen", "The flagged-items list", "Photo comparison", "Walkthrough conditions", "Resident access to walkthroughs", "Deposits", "Known open issues".

Personas: admin; regional administrator with walkthrough and financial manage flags; a household leader on one house with `canCompleteWalkthroughs`.

Probes:
- Capture at phone width (a `devices["Pixel 5"]` context): start a walkthrough, switch rooms out of order, set conditions, type a note and reload before blurring (the note survives), add a room by type.
- Progress: an empty room reads 0%, never 100%; conditions carry their word.
- Submit as the leader, review as staff; editing still works after both; earlier years are read-only for the leader and writable for staff.
- Standing notes copy forward to the next walkthrough; a resident body carrying one is refused.
- Flagged items: poor and damaged items listed, dismiss with a reason (leaves the list, stays on the walkthrough), send to maintenance (photos referenced, second send is 409).
- Photo comparison across years on a house with two or more walkthroughs.
- Move-out damages worksheet: default payers by room, split shares in cents, a row already charged is not re-saved, then the close-out and the statement mail link; the dashboard's deposit item shows the balance after deductions.

### houses

Read: "The property setup checklist", "House facts and access codes", "The resource hub", "The roster CSV import", "File uploads", "Known open issues".

Personas: admin; regional administrator with property manage and `canManagePropertySetup`; a household leader with `canViewResourceHub`.

Probes:
- Property create and edit, including the lease and portal links (a `javascript:` URL is refused) and the front photo.
- Setup checklist: rows appear on a new house, the three states, an unknown item key is a 400, the dashboard item aggregates per house.
- House facts: change a door code (audit event names the code, never the value; last-changed moves), re-save the same code (date unchanged), the leader sees them on the hub.
- Roster CSV: the template downloads and imports clean; a file with duplicates and bad dates previews its findings; nothing is written until confirm; import from both the Residents page and the property page.
- Resource hub: the three named slots (an empty one says so), region links reach only that region's houses.
- Resident profile: documents recorded (not signed), deposit and assigned equipment in one place.

### operations

Read: "Asset lifecycle and snooze", "Deposits", "Outbound email", "Audit log", "The admin bypass pattern", "Known open issues", and the "Authorization model" paragraph on `/api/action-items` and `/api/region-summary`, with `server/actionItems.ts` and `server/regionSummary.ts` themselves.

Personas: admin; regional administrator with asset, contact, billing and financial manage flags for one region.

Probes:
- Assets: lifecycle badges (unrated with no date, amber, red), snooze requires a reason and an end date within 24 months, the asset PATCH cannot set the snooze, `/assets/assigned` groups by person.
- Contacts: vendor page shows jobs, invoices and notes; linked requests filtered by the request's region; notes append and delete, never edit.
- Finances: rent (HH fees) periods and statuses, invoices, billing records; no field anywhere accepts or displays a bank or card number.
- Tasks: create, assign, complete; the seasonal reminders present on the seeded data.
- Dashboard: action items and stat tiles agree with the underlying records; an RA sees only their region.
- Settings: users table (role, active, comment email switch), walkthrough template edit, resource links; the activity log reads back the events this lane caused.
- Accessibility spot check: keyboard reachability and visible labels on the pages above.

## Verifier brief

````
You are verifying findings from an end-to-end sweep of the SPO Admin Portal
(repo <repo root>). Each finding below came from a lane agent. Your job is to
reproduce it independently, by a different route than the lane used, or show
it does not reproduce.

Environments, still running: <for each lane in your batch: lane, port, database url>.
SESSION_SECRET: sweep-session-secret-at-least-32-chars. Work in <run>/verify-<n>/.
Mint fresh personas with .claude/skills/spo-e2e-sweep/mint-persona.ts (usage in
its header); do not reuse the lane's storage-state files.

The second route: a finding the lane saw in the screen, reproduce over the API;
one it saw over the API, reproduce in the screen, or where the screen has no
path, read the handler in server/routes.ts and server/authz.ts and cite the lines
that produce the behaviour. Check the expected behaviour against the CLAUDE.md
or .claude/rules/ section the finding cites, and against "Known open issues".

For each finding return: the id, a verdict (confirmed | not reproduced |
different cause), your route and evidence, and for "different cause" the real
cause. Adjust the severity if the evidence warrants, and say why. Where findings
share a root cause, verify each on its own and say which fix would cover several.

Send results to team-lead with SendMessage in parts under ~4,000 characters,
labelled "part N of M", and finish with a one-line tally.

Findings: read <run>/findings.md, sections <the lanes in this batch>.
````
