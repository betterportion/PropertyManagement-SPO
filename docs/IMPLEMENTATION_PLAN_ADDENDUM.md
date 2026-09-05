# Implementation Plan — Addendum

Three additions from a second regional administrator's feedback, plus amendments to phases
already written. Continues the numbering in `IMPLEMENTATION_PLAN.md`. Everything in that
document's **Cross-cutting rules** and **Access model** sections applies here unchanged.

One thing in the main plan is **revised** by this addendum. Section 5.5 says not to build a
project entity. That judgment was about retrospective contractor history and it stands for
that. It does not cover prospective project tracking, which is what Phase 10 adds.

**Where things stand (2026-09-05):** every item below has shipped. Phase 9 in PRs
#125, #126, #130, #131 and #132; Phase 10 in #127, #133 and #134; Phase 11 in
#128; the 2.6 amendment in #135. The sections keep their full reasoning as a
record; the ✅ marks say what landed and where.

---

## Decisions taken

- **Contractors do not get logins.** RAs relay their updates into the thread.
- **Leaders and stewards can post** in threads for their own house.
- **Every new comment sends an email**, with guards described in 9.4.
- **Projects and CapEx are a type on maintenance requests**, not a separate table.
- **Bids upload into the portal. Signed contracts stay as links** to Drive or Adobe.
- **Door codes are stored in the portal**, with the constraints in 11.2.

---

# Phase 9 — Request threads ✅

The stated problem: everything about a repair currently happens over text and phone calls
and then evaporates. Who was coming, when, what they found, what it cost.

### 9.1 Comments ✅ (merged in PRs #125, #126; the attachment in #132)

One table: request ID, author (a user ID), body, internal flag, created timestamp.
Optional attachment through the existing upload pipeline.

Comments load with the request and are indexed on request ID. Nothing here should require a
second round trip or a background job.

Bodies are user-typed free text, so flatten whitespace and length-cap centrally, the way
`recordAuditEvent` already does for summaries. Do it in one place, not at each call site.

**Do not audit-log ordinary comments.** They are not access, money or document events, and
logging them buries the events that matter — the same reasoning that keeps photo downloads
out of the log. A comment carrying an attachment still records the document upload, because
that already happens at the upload layer.

### 9.2 Internal versus shared ✅ (merged in PR #126)

**Two comment visibilities, defaulting to internal.**

- **Internal** — staff only. Never visible to a resident account, never emailed to one.
- **Shared** — visible to the household leader and steward for that property.

The default matters. RAs will paste "he quoted $4,200" into a thread on an ordinary
maintenance request, not just a CapEx one. If the default is shared, that gets discovered
the wrong way. Make the current visibility obvious in the composer — not a checkbox
someone has to notice.

Filtering happens server-side. A client-side filter over a full fetch ships internal
comments to the browser of someone who should not have them.

### 9.3 Relayed updates ✅ (merged in PR #126)

An RA posting on the handyman's behalf marks the comment as relayed and names the source.
It renders as "Sarah, relaying Dave (handyman)" rather than as Sarah's own words.

Costs nothing now and keeps the history honest when someone reads it two years later.

### 9.4 Email notification ✅ (merged in PR #130)

Every new comment emails the people who can see it. Guards, all four required:

1. **Never email the comment's author.**
2. **Internal comments go to staff only.** This is the one that must not be got wrong —
   test it directly, both that the internal comment does not reach a resident address and
   that a shared one does.
3. **Per-user off switch.** One boolean, respected everywhere.
4. **A send failure must never fail the comment.** `sendEmail` returns a result rather than
   throwing. The comment is saved either way.

Content limits are the audit log's limits: names, dates, amounts, descriptions. Never a
credential.

If this turns out to be noisy in practice, the fix is a daily digest, not turning it off.
Build the off switch now so nobody has to ship an emergency change.

### 9.5 Resident posting ✅ (merged in PR #131)

Leaders and stewards can post shared comments on requests for their own house. They cannot
post internal comments and cannot see them.

This is a **new write path for resident accounts**, which is the shape of both historic
authorization gaps in this codebase. It needs its own tests in `authz.test.ts` and
`routeAccess.test.ts`, with the refused-work assertion rather than just a 403.

Thread access follows request access, including the **120-day closed window** from 5.2. A
leader who can no longer see a closed request cannot see its thread either. State that as
one rule in one place rather than implementing it twice.

---

# Phase 10 — Request types: projects and CapEx ✅

The second RA described work that is not a repair: projects SPO or the handyman initiate,
capital projects with competing bids and signed contracts, and a backlog of things to get
to eventually.

### 10.1 The type field ✅ (merged in PR #127)

Add a type to `maintenance_requests`: **`request` / `project` / `capex`.** Existing rows
become `request`.

Reusing the table gets status, room tagging, contractor links and threads for free, and
gives one list per property instead of three. That was the reason for choosing it.

### 10.2 Visibility — amends 5.2 ✅ (merged in PR #127, in the same change as 10.1)

**This is the catch, and it must land in the same change as 10.1.**

Making CapEx a request type means bid amounts, contract terms and cost discussions sit in a
table household leaders can already read. Without this rule, shipping 10.1 hands two
students the finance conversation.

**Residents see type `request` and nothing else.** Written as its own explicit condition,
not derived from status, priority or anything else that might later change.

This is the `ownsRecord` path, which breaks silently on both sides at once. It gets its own
test asserting a resident account cannot read a `project` or `capex` row for their own
house — the house match is exactly what would otherwise let them through.

Also note `submittedBy` holds an **email**, not a user ID, and `ownsRecord` compares against
`ctx.user.email`. Do not re-key it.

### 10.3 Project fields ✅ (merged in PR #133)

Only on `project` and `capex` types:

- **Bids** — vendor contact, amount, date, notes, and an uploaded document. Multiple per
  project. Through `guardedUpload()`, permission check ahead of multer.
- **Signed contract** — a **link** to Drive or Adobe. Not an upload. The authoritative copy
  belongs where the signature lives, and a portal copy that disagrees with it is worse than
  no copy.
- **Estimated cost** and **actual cost.** Amounts only. Money moves in QuickBooks and Ramp.
- **Target period** — a quarter or a year, not a hard date. These slip by design.

Known issue to be aware of: deleting a record leaves the file in storage. A removed bid
document persists in the bucket. Acceptable here, but do not let anyone believe a delete is
a purge.

### 10.4 Wishlist ✅ (merged in PR #134 — kept a priority, as decided)

`maintenance_requests.priority` already has a `wishlist` level, which covers "things we'd
like to get to down the line."

**Leave it as a priority. Do not fold it into the type field.** They answer different
questions — type is what kind of work this is, priority is how urgent. A wishlist CapEx
project is a coherent thing and collapsing the two makes it unrepresentable.

### 10.5 Open work on a property ✅ (merged in PR #134)

The property page shows open items grouped by type: repairs, projects, capital projects,
and the wishlist backlog. This was the explicit ask — see everything open for a house in
one place.

Staff view only. Residents see their repairs, per 10.2.

---

# Phase 11 — Property information for leaders ✅

The first thing a household leader needs and currently has nowhere to find.

### 11.1 The house facts list ✅ (merged in PR #128)

A structured, resident-visible block on the property: door and gate codes, security system
and camera notes, parking and towing rules, surfaces needing specific care (butcher block,
stone), things not to do (don't go on the roof), rubbish collection day, and the rental
company's contact and portal where SPO does not own the house.

Structured fields where they are known, one free-text area for the rest. Editable by staff
only, readable by that property's leader and steward.

Distinct from the staff notes field added in 3.1. That one stays staff-only. Do not merge
them — the first thing someone will do is type something into a staff note that should not
be on a student's screen.

Surfaces on the resource hub built in 8.1.

### 11.2 Door codes ✅ (merged in PR #128)

Fine to store, with three constraints:

1. **Visible to that property's leader and steward, plus staff.** Nobody else, no other
   property.
2. **Changes record an audit event** — a door code is access, which is what the audit log
   exists for. **The event records that it changed, never the value.** `scrubDetails` is a
   backstop, not permission.
3. **A last-updated date, displayed.** The realistic failure is not a breach. It is a code
   that stays the same through three generations of household leaders because nobody
   remembers when it was set.

---

# Amendments to existing phases

**2.6 — year-over-year comparison.** ✅ (merged in PR #135) Add a photo view: pick a room, see its photos across
walkthrough years side by side. Once 2.1 makes walkthroughs dated events with photos
attached per room, the data already supports this. It is a view, not new structure.

Worth telling the RAs plainly: the feature is easy, the discipline is not. It only answers
"has that crack grown" if someone photographs the same wall each year.

**5.2 — resident visibility.** Now carries two conditions, not one: type `request` only, and
closed within 120 days. Both explicit, in one place, tested together.

**5.5 — contractor history.** The "no separate project entity" line stands for retrospective
history. Add a pointer to Phase 10, which covers prospective projects and is a different
question.

**8.1 — resource hub.** Add the Phase 11.1 house facts block to the property-specific
section.

---

# Not changing

**Active shooter paperwork** was already in 8.1's global links, alongside the conduct policy
and fire extinguisher guidance. Already covered.

**Archived requests.** Already covered: range filters out to all-time in 5.3, per-property
triage in 5.4, and recurring-issue aggregates in 8.4. Requests are never deleted. Room
tagging in 5.1 is what makes "how often does this come up" answerable at all.

---

# Suggested order

| Order | Item | Blocked by | Shipped |
|---|---|---|---|
| 1 | 9.1–9.3 threads, internal default, relay attribution | 5 | ✅ #125, #126, #132 |
| 2 | 10.1 + 10.2 together — **never separately** | 5 | ✅ #127 |
| 3 | 11 property information and door codes | 3 | ✅ #128 |
| 4 | 9.4 email notification | 9.1, 7 | ✅ #130 |
| 5 | 9.5 resident posting | 9.2 | ✅ #131 |
| 6 | 10.3–10.5 project fields and property view | 10.1 | ✅ #133, #134 |
| 7 | 2.6 photo comparison | 2.1, second season of data | ✅ #135 |

**Highest-risk item:** 10.2. Shipping the type field without the visibility rule exposes
cost and contract data to student accounts, and it will not be obvious that it happened.

---

# Open items

1. **Whether comment emails should become a digest.** Ship per-comment with the off switch,
   revisit after a month of real use.
2. **Whether the handyman ever needs to post directly.** Closed for now. If it reopens, an
   external-user surface is a serious piece of work and should be planned as one, not added
   to this phase.
3. **Retention for threads.** Requests are not deleted today. Confirm that is still wanted
   once threads make them substantially larger.
