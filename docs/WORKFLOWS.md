# Workflows

The single place that tracks **every automated workflow in the portal** and **every piece of setup SPO staff must do outside the code** for it to work.

Anyone changing a workflow, daily job, integration or automated email updates this file in the same change (see the "Always" list in `CLAUDE.md`).

## How to read this

Each workflow has the same fields:

- **Purpose:** what it is for, in one sentence.
- **Trigger:** what starts it. A daily job, a date, or a person doing something.
- **What the portal does.**
- **What SPO must do:** setup outside the code, with an owner and a checkbox per step.
- **Needs:** environment variables and outside accounts.
- **How to check it's working:** where to look in the app, and what healthy looks like.
- **When it fails:** what happens, and who notices.
- **Status:** one of the four below.

| Status | Meaning |
|---|---|
| **planned** | Agreed, not built yet |
| **built** | In the code and working, with nothing for SPO to set up |
| **built-awaiting-SPO-setup** | In the code, but does nothing until SPO finishes the setup listed for it |
| **live** | Built, set up, and running in production |

The daily jobs all run **inside the web server**: there is no separate worker and no cron. Each one starts when the server boots, runs once straight away and then every 24 hours. That gives every job two rules:

- **Idempotent.** A restart re-runs it, so running it twice must change nothing the second time.
- **Can never stop the server from starting.** A failure is written to the server log and the job tries again the next day.

The daily jobs log to the hosting provider's log stream. Nobody watches that log today, which is why the planned workflows below raise a **Needs attention** item in the app when something goes wrong.

---

## Built today

### Audit-log retention

- **Purpose:** keep the activity trail from growing forever, while never losing the record of who changed someone's access.
- **Trigger:** daily job (`server/audit.ts`).
- **What the portal does:** deletes routine activity entries older than **two years**, at most 1,000 rows per delete so the table is never locked for long. Account and access events are kept indefinitely: accounts created or deleted, role, status and permission changes, an account re-linked to a new sign-in, and the house a resident login is linked to (`AUDIT_ACTIONS_KEPT_INDEFINITELY`).
- **What SPO must do:** nothing.
- **Needs:** nothing beyond the database.
- **How to check it's working:** Settings → Activity trail never shows a routine entry older than two years.
- **When it fails:** the error goes to the server log and the job tries again the next day. Nothing is lost; old entries simply stay a little longer. Nobody is notified.
- **Status:** built.

### Preventive and safety maintenance requests

- **Purpose:** turn each house's recurring upkeep (furnace service, filter changes, smoke and CO detector tests and so on) into ordinary maintenance requests when it comes due.
- **Trigger:** daily job (`server/schedules.ts`).
- **What the portal does:** for each schedule that is due, files one maintenance request (submitted by "Preventive schedule"). It remembers which due date it already filed for, so an overdue item is not filed again every day. Marking the work done moves the schedule to its next due date.
- **What SPO must do:**
  - [ ] Apply the standard schedules (or add custom ones) to each house. Owner: each RA.
- **Needs:** nothing beyond the database.
- **How to check it's working:** the Maintenance page and the dashboard's "Safety & preventive" list show the generated requests. The server log says `[schedules] Generated N request(s)`.
- **When it fails:** the error goes to the server log and the job tries again the next day. Nobody is notified.
- **Status:** built.

### Seasonal reminder tasks

- **Purpose:** remind regional administrators of the jobs SPO does on a calendar.
- **Trigger:** daily job (`server/seasonalTasks.ts`), by date.
- **What the portal does:** creates tasks on the Tasks page and the dashboard:
  - **Household walkthroughs:** each April 15 and July 15, per region.
  - **Turn off utilities for the summer:** about two weeks before May 15, per region.
  - **Renew-or-leave decision:** two months before a rented house's lease renewal date, per house.
  - **Turn off utilities at lease end:** two weeks before a rented house's lease ends, per house. Skipped when the house is renewing.

  Each task has a unique key, so it is created once. A cadence more than 60 days in the past is not back-filled.
- **What SPO must do:**
  - [ ] Keep each rented house's lease dates and renewal decision up to date on the property page. Owner: each RA.
- **Needs:** nothing beyond the database.
- **How to check it's working:** the tasks appear on the Tasks page on the dates above. The server log says `[seasonal] Created N recurring reminder task(s)`.
- **When it fails:** the error goes to the server log and the job tries again the next day. Nobody is notified.
- **Status:** built.

### Automated email

- **Purpose:** tell people about their maintenance requests without anyone having to write to them.
- **Trigger:** a person's action.
- **What the portal does:** sends plain-text email through Resend (`server/email.ts`; wording in `server/notifications.ts`):
  - **Request received:** to the person who filed a maintenance request.
  - **Status changed:** to the person who filed it.
  - **New comment:** to the people who can see the request: staff who have posted in the thread, the region's RAs, and (for a shared comment) the residents. Internal comments go to staff only. Never sent to the comment's author, or to anyone who has switched comment email off (`server/commentRecipients.ts`).
  - **Email the household:** staff write to a house's residents from the property page.

  Content is limited to names, dates, amounts and descriptions, never a credential or a banking identifier. A failed send never fails the action that triggered it.
- **What SPO must do:** see "Email" in the setup checklist below.
- **Needs:** `RESEND_API_KEY` and `EMAIL_FROM` (both or neither: setting only one stops the server at boot). Optional: `EMAIL_REPLY_TO`, and `APP_URL` for the "open this request" link. A Resend account with SPO's sending domain verified (issue #49).
- **How to check it's working:** today, only by receiving one. Phase 7 below adds an Email health panel. Until email is set up, the server log says `email not configured; skipped ...` for each message.
- **When it fails:** the failure is written to the server log, and the person simply doesn't get the email. **Nobody notices today**; Phase 7 fixes that.
- **Status:** built-awaiting-SPO-setup.

### Roster CSV import

- **Purpose:** add a house's residents in one go from a spreadsheet, instead of typing them in one at a time.
- **Trigger:** a person's action (Import on the Residents page or a property's page).
- **What the portal does:** reads the CSV (columns: `firstName`, `lastName`, `email`, `phone`, `roomName`, `moveInDate`, `notes`) and shows what it would create, flagging duplicates and bad rows. Nothing is written until someone confirms. The file itself is never stored (`server/residentImport.ts`).
- **What SPO must do:** nothing beyond having the CSV.
- **Needs:** nothing.
- **How to check it's working:** the preview screen lists each row and its outcome.
- **When it fails:** the person importing sees the error on screen.
- **Status:** built.

---

## Planned

The details below are the agreed intent. Each entry is filled in properly in the phase that builds it.

### Repair and maintenance budgets (Phase 2)

- **Purpose:** an R&M budget for each owned house, per fiscal year.
- **Trigger:** a person's action.
- **What the portal does:** an admin sets each owned house's budget for the fiscal year on the property page. The fiscal year runs June 1 to May 31 and is named for the year it ends, so FY2027 is Jun 1 2026 – May 31 2027. Changes are audited as money changes. This is a new table, separate from the startup budget household leaders see. Until QuickBooks is connected, the spend reads "Spending not connected yet", never $0.
- **What SPO must do:** see "Budgets" in the checklist.
- **Needs:** nothing.
- **Status:** planned.

### QuickBooks spend sync (Phase 3)

- **Purpose:** each owned house's repair and maintenance spend for the fiscal year, read from QuickBooks Online once a day, so nobody types it in.
- **Trigger:** daily job, plus an admin "Sync now" button.
- **What the portal does:** for each house mapped to a QuickBooks Class, reads the current fiscal year's spend on the accounts an admin has marked as repair and maintenance. Until July 31 it also refreshes the year before, to catch late entries. It stores amounts, dates and QuickBooks reference IDs only: never vendor bank details, payment methods or memo text. Read-only: the portal never writes to QuickBooks.
- **What SPO must do:** see "QuickBooks" in the checklist.
- **Needs:** a QuickBooks Online company and an Intuit developer app. Environment variables, all or nothing: the Intuit client ID and secret, a redirect URL, and `QUICKBOOKS_TOKEN_KEY` (encrypts the stored connection at rest). Exact names are settled in Phase 3.
- **How to check it's working:** Settings → QuickBooks shows the connected company, the last successful sync and the last error.
- **When it fails:** existing figures are left alone. If the connection is lost, or the last good sync is more than 36 hours old, admins get a **Needs attention** item.
- **Status:** planned.

### Underspend and overspend alert (Phase 4)

- **Purpose:** stewardship. Prompt steady, incremental improvement to every owned house, rather than leaving budget unspent.
- **Trigger:** date-based. Checked whenever the dashboard's action items are worked out.
- **What the portal does:** flags a house whose spend is well behind the year's pace, more strongly from March to May. For example: "$1,000 of $11,000 spent with 2 months left in FY2027". It links to that house's wishlist requests as ideas. Overspend is flagged more quietly. A house that isn't linked to QuickBooks, or whose figures are stale, never triggers the alert.
- **What SPO must do:** nothing beyond QuickBooks and Budgets.
- **Status:** planned.

### Resident roster from the master Google Sheet (Phase 5)

- **Purpose:** keep the portal's resident list, and above all household start and stop dates, matching SPO's one master sheet without anyone retyping it.
- **Trigger:** daily job, plus an admin "Sync now" button.
- **What the portal does:**
  - Reads one tab of the sheet with a read-only Google service account, and only an allowlist of columns.
  - If any column header looks like a bank, routing, account, card or ACH field, it **refuses the entire sync**, changes nothing, and tells admins which column to remove.
  - Matches residents by email. The sheet wins, but a value a person changed in the portal since the last sync becomes a review item.
  - Never deletes a resident who drops off the sheet; they are flagged instead.
  - Bad rows are skipped and reported.
- **Column contract:** *to be finalized in Phase 5.* It covers full name, email, house, household start date, household stop date, payment plan (monthly / installments) and an active flag. The exact headers will be written here, and are what SPO builds the sheet to.
- **What SPO must do:** see "Google Sheet" in the checklist.
- **Needs:** environment variables, all or nothing: `GOOGLE_SERVICE_ACCOUNT_JSON` (or key and email), `RESIDENT_SHEET_ID`, `RESIDENT_SHEET_TAB`.
- **How to check it's working:** Settings shows the last run and its counts: rows read, created, updated, conflicts, skipped (with reasons).
- **When it fails:** nothing is changed, and admins get a **Needs attention** item. A last good sync more than 36 hours old also raises one.
- **Status:** planned.

### Move-out reminder and emails (Phase 6)

- **Purpose:** make sure every departure, including one mid-year, is handled before it happens.
- **Trigger:** date-based, 30 days before a resident's stop date. Checked by a daily job.
- **What the portal does:**
  - Creates one task for the house's RA, such as "Rachel Bauer moves out in 30 days". It is never duplicated, and it is corrected if the date changes.
  - Emails the resident a move-out checklist and gives the RA a heads-up.
- **What SPO must do:** see "Email" in the checklist (approve the wording).
- **Status:** planned.

### RA move-out checklist (Phase 6)

- **Purpose:** a record that the room was checked when someone left.
- **Trigger:** a person's action.
- **What the portal does:** the RA completes a checklist in the app: room inspected for damage, all belongings removed, keys returned, notes, and optional photos. It records who completed it and when.
- **Status:** planned.

### Deposit-return follow-through (Phase 6)

- **Purpose:** make sure every departing resident's deposit is dealt with. Mid-year departures historically never got theirs back.
- **Trigger:** date-based. Once a stop date has passed, a deposit still marked "held" is flagged.
- **What the portal does:** raises a **Needs attention** item that escalates as the deposit gets older. The return deadline is a per-region or per-state setting, not a fixed number.
- **What SPO must do:** see "Deposits" in the checklist.
- **Status:** planned.

### Email log and Email health (Phase 7)

- **Purpose:** answer "are the automated emails actually going out?"
- **Trigger:** every automated send.
- **What the portal does:** records each send's outcome: which email, to whom, sent / failed / not set up, the kind of error, and when. It never stores a message body or a credential, and keeps the record for one year. An admin Email health panel shows the last 30 days by email type, recent failures, and a "Send test email to me" button. A failed send, or a workflow trying to send while email is not set up, raises a **Needs attention** item.
- **Status:** planned.

---

## SPO setup checklist

Everything that has to happen outside the code. Tick an item when it's done and write the owner's name in place of "TBD".

### QuickBooks
- [ ] Create one Class per owned house in QuickBooks Online. Owner: TBD
- [ ] Tag all repair & maintenance spend to the house's Class going forward. Owner: TBD
- [ ] Retro-tag R&M transactions since June 1, 2026 (start of FY2027). Owner: TBD
- [ ] Decide which QuickBooks accounts count as "repair & maintenance". Owner: TBD
- [ ] A QuickBooks admin connects the portal (Settings → QuickBooks) and maps each house. Owner: TBD
- [ ] Name an owner for reconnecting if the connection lapses. Owner: TBD

### Budgets
- [ ] Set the FY2027 R&M budget for every owned house. Owner: TBD

### Google Sheet
- [ ] Workspace admin creates the Google Cloud service account and shares its key securely with whoever sets the env vars. Owner: TBD
- [ ] Build the master resident tab with the exact column headers in this doc. No banking columns, ever. Owner: TBD
- [ ] Share the sheet with the service account email (Viewer only). Owner: TBD
- [ ] Set RESIDENT_SHEET_ID / RESIDENT_SHEET_TAB and run the first sync in dry-run review. Owner: TBD
- [ ] Name who reviews sync conflicts. Owner: TBD

### Email
- [ ] Verify the sending domain in Resend (SPF, DKIM, DMARC DNS records). Owner: TBD
- [ ] Set RESEND_API_KEY, EMAIL_FROM (and EMAIL_REPLY_TO). Owner: TBD
- [ ] Approve move-out email wording and the RA checklist items. Owner: TBD
- [ ] Send a test email from the Email health panel and confirm it arrives. Owner: TBD

### Deposits
- [ ] Confirm the legal deposit-return deadline for each state SPO has houses in. Owner: TBD

---

## Deferred to v2

Recorded so it isn't lost, and **not to be built** until it is picked up again.

- **National / regional management view for Justin.** The "National" region card is hidden from the admin dashboard in v1 (Phase 1). The code behind the region rollup (`server/regionSummary.ts`, `/api/region-summary` and its tests) is kept, so this can return.
- **Household application intake.**
- **Applicant auto-emails.**
- **Interviewer routing by chapter and gender.**
- **Recruitment tracking.**
- **Resend bounce and complaint webhooks.** These would show emails that were accepted but never delivered. They need the `rawBody` capture re-added in `server/index.ts` for signature verification (see "Integrations" in `CLAUDE.md`). Proposed in Phase 7, not built.
