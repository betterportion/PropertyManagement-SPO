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
- **How to check it's working:** Settings → Email health shows each email's sent and failed counts, and has a test button. Until email is set up, the server log says `email not configured; skipped ...` for each message.
- **When it fails:** the failure is recorded in the email log, and admins get a **Needs attention** item (see Email health below).
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

- **Purpose:** keep the portal's roster matching SPO's one master sheet, above all household start and stop dates, which drive move-outs and deposits, without anyone retyping it.
- **Trigger:** a daily job (`server/rosterSheetSync.ts`) that runs at boot and every 24 hours, **but only once an admin has done the first Sync now**. Until then the job does nothing, so setting the variables and restarting never applies the sheet before anyone has looked at it. Admins have **Preview** (changes nothing) and **Sync now** in Settings → Resident roster sheet.
- **What the portal does** (rules in `server/rosterSync.ts`):
  - **Reads only the allowlisted columns.** The header row is read first, and only the columns below are requested from Google.
  - **Refuses banking columns.** If any header looks like a bank, routing, account, card or ACH field, the whole sync is refused: no data cell is read, nothing changes, and admins get a **Needs attention** item naming the column to remove.
  - **Matches by email,** ignoring case and spaces. A new email becomes a new resident on the house its row names: by its address, or by its name **only when exactly one house has that name**. An unknown or shared name creates nothing and is flagged.
  - **The sheet wins.** A changed value is applied. If a person had changed that value in the portal since the last sync, it is still applied, but a review item records the old value, the new one, and who edited it when. The first sync treats every existing value as a person's, which is why the first run should be a Preview.
  - **Returning residents get a new stay** when they have no stay at the row's house, or the row starts after their stay there ended. A row about a house they already have a stay at updates that stay, so a move with a blank start date makes one new stay, not one a day. The earlier stay keeps its own dates, deposit and paperwork, and the resident page lists "Other stays". If the earlier stay has no stop date, that is flagged too.
  - **Never deletes anyone.** An active resident the sheet no longer lists is flagged.
  - **Skips and reports bad rows:** a bad date, a stop date before the start, an unrecognised payment plan or active value, a missing name or email, or an email on two rows. The rest of the sheet carries on.
  - **Running the same sheet twice changes nothing.** Every write of a run happens in one transaction, or none does.
  - **Never touches portal logins.** Switching off a departing resident's login stays a deliberate step in the move-out dialog.
  - **Audit events:** one `resident.sheet_sync` summary per run, plus `resident.sheet_created` and `resident.sheet_updated` for each resident, with old → new dates.
- **The column contract** (exact headers, any order; every other column is ignored):

  | Header | Required | What goes in it |
  |---|---|---|
  | `Full Name` | Yes | First and last name. The last word is taken as the last name |
  | `Email` | Yes | The resident's email, one row per person |
  | `House` | Yes | The house's address exactly as the portal shows it, or its name (e.g. `Como Men's House`) |
  | `Household Start Date` | No | `2026-08-15` or `8/15/2026` |
  | `Household Stop Date` | No | Same formats. Blank means still living there |
  | `Payment Plan` | No | `Monthly` or `Installments` |
  | `Active` | No | `Yes` or `No`. Blank: active unless the stop date has passed |

  **Never add a column for bank, routing, account, card or ACH details.** The sync refuses the whole sheet if one appears.
- **CSV fallback:** Settings → Resident roster sheet → Import a CSV takes a file with the same headers through the same rules (Preview, then Apply). It is for the current spreadsheet, before the master sheet exists. The existing per-house roster import on a property's page is unchanged.
- **What SPO must do:** see "Google Sheet" in the checklist.
- **Needs:** `GOOGLE_SERVICE_ACCOUNT_JSON` (the key file), `RESIDENT_SHEET_ID` and `RESIDENT_SHEET_TAB`, all or none. The sheet must be shared with the service account's email as a **Viewer**.
- **How to check it's working:** Settings → Resident roster sheet shows the last successful sync, each recent run's counts (rows read, added, updated, conflicts, skipped, with reasons), and the review list.
- **When it fails:**
  - A failed run changes nothing, and admins get "Resident sheet sync failed" straight away. **A run that skips every row counts as failed**: that is a sheet the portal can no longer read (a changed date format), not a quiet day.
  - A good run that skipped some rows raises "N resident sheet rows were skipped".
  - If there is no good sync for more than 36 hours, admins get "Resident sheet hasn't synced".
  - Open review items show as "N roster changes to review". Whoever reviews them (see the checklist) marks each one reviewed.
- **Status:** built-awaiting-SPO-setup.

### Move-out reminder and emails (Phase 6)

- **Purpose:** make sure every departure, including one mid-year, is handled before it happens.
- **Trigger:** date-based, 30 days before a resident's stop date (`MOVE_OUT_NOTICE_DAYS`). It is checked by the daily seasonal-task job (`server/moveOut.ts`, run from `server/seasonalTasks.ts`).
- **What the portal does:**
  - Creates one task on the Tasks page for the house's region, e.g. "Rachel Bauer moves out on May 20", keyed `move-out:<resident>:<date>`.
    - **Never duplicated**, and never recreated once marked done.
    - **If the stop date changes,** the open task moves to the new date. If the date is cleared, or moves more than 30 days out, the task is removed.
    - Visible to staff with a property permission, like lease reminders.
  - Emails **the resident** a move-out checklist, and **the house's regional administrators** (active, with a property permission, covering the region) a heads-up. Admins are not emailed. The emails go once per date: when the task is created, or when it moves.
  - **The wording** is in one file, `server/notifications.ts` (`moveOutResidentEmail`, `moveOutStaffEmail`). Change it there to change every move-out email.
  - Never touches the resident's portal login.
- **What SPO must do:** see "Email" in the checklist: approve the wording and the RA checklist items.
- **Needs:** email set up (`RESEND_API_KEY`, `EMAIL_FROM`). Without it, the task is still created and the emails are skipped.
- **How to check it's working:** a resident with a stop date within 30 days has a task on the Tasks page. Email delivery shows in Email health (Phase 7).
- **When it fails:** the failure goes to the server log and the job tries again the next day. Already-created tasks are unaffected.
- **Status:** built (its emails are awaiting email setup).

### Household logins end with the stay

- **Purpose:** a household leader's or steward's portal login is for their house while they live there.
- **Trigger:**
  - straight after a roster change: a resident edit, Move out, a resident removed, or a sheet sync;
  - plus the daily seasonal-task run, for a stop date that simply passes.
- **What the portal does:**
  - Once no current roster row at the house speaks for a login, it switches the login off and unlinks it from the house. A current row means active, with the same email, and its stop date not past (`server/householdLogins.ts`).
  - That frees one of the house's 3 places.
  - Both changes are audited as access history, kept indefinitely.
  - **Move out** takes only a date that has arrived. A planned leaving date is the roster's stop date, which keeps them in until that day.
  - If they come back, the RA gives access again from their resident page.
- **What SPO must do:** nothing.
- **Status:** built.

### RA move-out checklist (Phase 6)

- **Purpose:** a record that the room was checked when someone left.
- **Trigger:** a person's action, on the resident's page. It appears once a stop date is set, or once the resident is inactive.
- **What the portal does:**
  - The RA ticks: room inspected for damage, all belongings removed, keys returned. There are fields for damage found and notes, plus optional photos through the existing upload.
  - "Mark move-out complete" needs all three ticks, and records who and when (audited as `resident.move_out_checklist_completed`).
  - Staff with a property permission in the region can see it; managing it takes `canManageProperties`.
  - Photos are readable only by staff with a property permission in the region, never by residents. A photo's file is removed when the photo or the resident is deleted.
- **What SPO must do:** approve the checklist items (see "Email" in the checklist).
- **Status:** built.

### Deposit-return follow-through (Phase 6)

- **Purpose:** make sure every departing resident's deposit is dealt with. Mid-year departures historically never got theirs back.
- **Trigger:** date-based. A deposit still "held" or "statement sent" after the stop date is a **Needs attention** item; it also appears 30 days *before* the stop date, so the money is ready.
- **What the portal does:**
  - **The return deadline** is the house's own number of days if set, otherwise **its state's**, from Settings → Deposit return deadlines. That list is admin-entered, starts empty, and is audited as `deposit_rule.changed`; no figures are built into the code.
  - **The item escalates with age:**
    - Past the deadline: "Deposit overdue — N days past the return deadline".
    - With no deadline set anywhere, after 14 days: "Deposit still held N days after move-out", noting that no deadline is set.
  - Seen by staff with a finance permission, in their regions.
- **What SPO must do:** see "Deposits" in the checklist, then enter each state's days.
- **Status:** built-awaiting-SPO-setup.

### Email log and Email health (Phase 7)

- **Purpose:** answer "are the automated emails actually going out?"
- **Trigger:** every automated send.
- **What the portal does:**
  - **Records every send's outcome** in `email_log`, through the one seam every email passes (`server/email.ts`): which email (`shared/emailTemplates.ts`), to whom, sent / failed / not set up, and the *kind* of error (e.g. `validation_error`). It never stores the subject, the body or a credential. A failure to record never stops a send.
  - **Keeps the log one year,** removed in capped batches by the daily audit retention run (`server/emailLog.ts`).
  - **Settings → Email health** (admins) shows the last 30 days by email (sent, failed, not sent because email isn't set up), the recent failures, and a **"Send a test email to me"** button. The test goes only to the admin who presses it.
  - **Needs attention** (admins):
    - "N emails failed to send this week", when any send failed in the last 7 days.
    - "Email isn't set up: N messages not sent this week", when a workflow tried to send while email is off.
- **What SPO must do:** see "Email" in the checklist. The last step is sending a test from this panel.
- **Needs:** nothing beyond email itself.
- **How to check it's working:** the panel shows sends with 0 failed. The test email arrives.
- **When it fails:** the failed send is listed in the panel and raises a Needs attention item.
- **Status:** built (it reports "email isn't set up" until the Resend setup is done).

#### Proposed, not built: Resend delivery webhooks

The log knows whether **Resend accepted** a message, not whether it was **delivered**. A bounced address or a spam complaint never reaches the portal today. Resend can report those with a webhook (`email.bounced`, `email.complained`, `email.delivered`). To add it:
- **Re-add the raw request body capture** in `server/index.ts`, for signature verification. It was removed with the JotForm webhook; see "Integrations" in `CLAUDE.md`.
- **Verify the signature** with the webhook secret, failing closed when the secret is unset. Compare in constant time, and rate-limit the unauthenticated endpoint, exactly as the old JotForm webhook did.
- **Record each event** against the `email_log` row, using the message id Resend returns, which would need storing.

Listed under "Deferred to v2".

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
- [ ] Set RESIDENT_SHEET_ID / RESIDENT_SHEET_TAB, restart, Preview (Settings → Resident roster sheet), then press Sync now once. The daily sync starts only after that. **Off for the 2026 pilot**: rosters are loaded by CSV. Owner: TBD
- [ ] Name who reviews sync conflicts. Owner: TBD

### Email
- [ ] Verify the sending domain in Resend (SPF, DKIM, DMARC DNS records). Owner: TBD
- [ ] Set RESEND_API_KEY, EMAIL_FROM (and EMAIL_REPLY_TO). Owner: TBD
- [ ] Approve move-out email wording and the RA checklist items. Owner: TBD
- [ ] Send a test email from the Email health panel and confirm it arrives. Owner: TBD

### Deposits
- [ ] Confirm the legal deposit-return deadline for each state SPO has houses in, and enter it in Settings → Deposit return deadlines. Owner: TBD

---

## Deferred to v2

Recorded so it isn't lost, and **not to be built** until it is picked up again.

- **National / regional management view for Justin.** The "National" region card is hidden from the admin dashboard in v1 (Phase 1). The code behind the region rollup (`server/regionSummary.ts`, `/api/region-summary` and its tests) is kept, so this can return.
- **Household application intake.**
- **Applicant auto-emails.**
- **Interviewer routing by chapter and gender.**
- **Recruitment tracking.**
- **Resend bounce and complaint webhooks.** These would show emails that were accepted but never delivered. They need the `rawBody` capture re-added in `server/index.ts` for signature verification (see "Integrations" in `CLAUDE.md`). Proposed in Phase 7, not built.
