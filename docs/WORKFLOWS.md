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
- **What the portal does:** an admin sets each owned house's budget on the property page, for the current fiscal year or the next. The fiscal year runs June 1 to May 31 and is named for the year it ends, so FY2027 is Jun 1 2026 – May 31 2027 (`shared/fiscalYear.ts`). There is no default amount.
  - Staff with a property permission can see the budgets for their regions. Residents never see them.
  - It is stored in the `repair_budgets` table, separate from the startup budget household leaders see.
  - Rented houses have no R&M budget.
  - Every change is audited as `property.repair_budget_set`, with the old and new amounts.
  - Until QuickBooks is connected, the spend reads "Spending not connected yet", never $0.
- **What SPO must do:** see "Budgets" in the checklist.
- **Needs:** nothing.
- **How to check it's working:** the property page of an owned house shows "Repair & maintenance budget" with this year's figure. Settings → Activity trail lists each change.
- **When it fails:** the admin sees an error when saving, and nothing is changed.
- **Status:** built-awaiting-SPO-setup.

### QuickBooks spend sync (Phase 3)

- **Purpose:** each owned house's repair and maintenance spend for the fiscal year, read from QuickBooks Online once a day, so nobody types it in.
- **Trigger:** a daily job (`server/quickbooksSync.ts`) that runs at boot and every 24 hours, plus an admin "Sync now" button.
- **What the portal does:**
  - For each owned house linked to a QuickBooks **Class**, reads that fiscal year's spend on the accounts an admin ticked as repair and maintenance. Ticking a parent account includes its sub-accounts.
  - Until July 31 it also re-reads the year just ended, so late entries land in the right year.
  - It uses QuickBooks's **Profit and Loss report, summarized by class**, for the fiscal year's dates. That is the same figure SPO's bookkeeper sees, on the company's own accounting basis. It already includes every kind of transaction (bills, checks, expenses, card charges, journal entries, vendor credits), and one call covers every house.
  - Read-only: the portal never writes to QuickBooks. It stores only amounts, dates and QuickBooks's own ids for classes and accounts. It never stores vendor bank details, payment methods or memo text.
  - The connection is a refresh token, stored **encrypted** with `QUICKBOOKS_TOKEN_KEY`. Intuit replaces it on use, so the newest one is saved the moment it arrives. It is never logged, audited or sent to the browser.
  - A failed sync changes no figures; the last good ones stay, marked out of date.
  - Linking houses by QuickBooks **Location** instead of Class later would be a new link "kind" and a different report column (`property_quickbooks_links.kind`). Nothing else changes.
  - Audit events: `quickbooks.connected`, `quickbooks.disconnected`, `quickbooks.mapping_changed`, `quickbooks.accounts_changed`, and one `quickbooks.sync` per run (counts only).
- **What SPO must do:** see "QuickBooks" in the checklist. Also, whoever manages the server:
  - [ ] Creates an app in the Intuit Developer portal with the accounting scope, and sets its redirect URI to `https://<portal address>/api/quickbooks/callback`. Owner: TBD
  - [ ] Sets the four `QUICKBOOKS_*` variables on the server, then restarts it. Owner: TBD
- **Needs:** `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI` and `QUICKBOOKS_TOKEN_KEY` (all or none; some but not all stops the boot). Optional: `QUICKBOOKS_ENVIRONMENT=sandbox` for an Intuit test company.
- **How to check it's working:** Settings → QuickBooks shows the connected company, the last successful sync (within the last day) and "Last error: None". An owned house's page shows "From QuickBooks, <date>" under Spent so far.
- **When it fails:**
  - If the connection is refused, admins immediately get a **Needs attention** item, "QuickBooks connection lost". Reconnecting fixes it.
  - If there has been no good sync for more than 36 hours, admins get "QuickBooks spend is out of date", with the last error.
  - Either way, the house pages say the figure is out of date.
  - If `QUICKBOOKS_TOKEN_KEY` changes, the stored connection can't be read and must be reconnected.
- **Status:** built-awaiting-SPO-setup.

### Budget dashboards and the underspend alert (Phase 4)

- **Purpose:** stewardship. Prompt steady, incremental improvement to every owned house, rather than leaving budget unspent.
- **Trigger:** date-based, worked out whenever the dashboard or Tasks page loads (`repairBudgetItems` in `server/actionItems.ts`; the pace rule is in `shared/budgetPace.ts`).
- **What the portal does:**
  - **Admin dashboard:** a "Repair & maintenance budget" section between Regions and Needs attention. Each region shows its budget, spend, % used and how many houses are behind pace, and opens to list its houses.
  - **Regional administrator's dashboard:** their own houses.
  - **Each owned house:** a budget page (`/properties/<id>/budget`) with budget, spend, % used, % of the year gone, open work and wishlist, and what was finished this year.
  - **Behind pace:** a house has spent under half the share of the year that has gone (`UNDERSPEND_PACE_RATIO`). Nobody is called behind in June or July (`UNDERSPEND_QUIET_MONTHS`).
  - **The alert** reads, for example, "$1,000 of $11,000 spent with 2 months left in FY2027 — Como Men's House", and counts the house's open wishlist requests as ideas. From March to May it becomes overdue (`LAST_QUARTER_MONTHS`).
  - **Spending past the budget** gets a quiet item with no due date.
  - **Never alerted:** a house with no QuickBooks link, an out-of-date figure, or no budget.
  - Visible to staff with a property permission, for their regions.
- **What SPO must do:** nothing beyond QuickBooks and Budgets.
- **Needs:** QuickBooks connected (Phase 3). Without it, the section shows budgets with "Not connected" and raises no alert.
- **How to check it's working:** the dashboard section shows spend for linked houses. A house well behind pace appears in the section's list and on the Tasks page.
- **When it fails:** it can't fail on its own. If the QuickBooks figures go stale, alerts stop rather than misfire, and the QuickBooks out-of-date alert takes over.
- **Status:** built-awaiting-SPO-setup.

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
