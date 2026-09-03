# SPO Admin Portal

Property management for Saint Paul's Outreach: staff look after houses, and the students living in them report what breaks. This glossary holds the words the portal uses for that, so screens, routes, tests and tickets say the same thing.

## People

**Staff**:
An admin or a regional administrator. Everyone who manages houses rather than lives in one.
_Avoid_: employee, manager, RA (when the reader might not know it means regional administrator)

**Regional administrator**:
A staff member responsible for the houses in one or more regions.
_Avoid_: RA in user-facing text

**Household**:
The people living in one house. Two of them hold resident accounts: the household leader and the steward.

**Household leader** / **Steward**:
The two residents of a house who hold a resident account and speak for the household in the portal.
_Avoid_: tenant, occupant

**Resident account**:
A login linked to one house. It reads and writes that house's records and nothing about any other house.
_Avoid_: student account, tenant login

**Contractor**:
Somebody outside SPO who does work on a house: a handyman, a plumber, a rental company's crew. Contractors never have a login.
_Avoid_: vendor (the portal's contacts list is where a contractor's details live; the contractor is the person)

## Requests

**Request**:
One piece of work on a house, of one of three types, with a status, a priority, a room and a thread.
_Avoid_: ticket, job, work order

**Repair**:
The request type for something broken that needs fixing. The only type a resident account ever sees or files.
_Avoid_: maintenance request (when contrasting with the other types), issue

**Project**:
The request type for work SPO or a contractor initiates that is not a repair: a fence, a repaint, a new shed.

**Capital project**:
The request type for large work with competing bids, a signed contract and a budget line. Never visible to a resident account.
_Avoid_: CapEx in user-facing text (fine as the stored value)

**Wishlist**:
The lowest priority: something to get to eventually. A priority, never a type — a wishlist capital project is a coherent thing.
_Avoid_: backlog, someday

**Open work**:
Everything on one house that is not yet closed, grouped once by kind: repairs, projects, capital projects and the wishlist. Each item appears in exactly one group.

## Threads

**Thread**:
The comments on one request, in order. Where the who-came-when-and-what-it-cost of a job is kept instead of in text messages.
_Avoid_: conversation, chat, activity

**Comment**:
One entry in a thread: an author, a body, a time, optionally one attached file. Posted once, never edited; deletable.
_Avoid_: note, message, update, reply

**Internal** comment:
Visible to staff only. Never shown to a resident account, never emailed to one. The default for anything staff post.
_Avoid_: private, hidden, staff-only (as a label — "Internal" is the word on screen)

**Shared** comment:
Visible to the household of that house as well as staff. The only kind a resident account can post.
_Avoid_: public, external, visible

**Relayed** comment:
A comment staff post on a contractor's behalf, carrying the contractor's name as its source. Reads as "Sarah, relaying Dave (handyman)", never as Sarah's own words.
_Avoid_: forwarded, quoted, on behalf of (as a field name)

**Source**:
Who a relayed comment actually came from.

## Projects

**Bid**:
One contractor's offer to do a project: who, how much, when, with the quote document attached. A project holds many.
_Avoid_: quote, estimate, proposal

**Accepted bid**:
The one bid a project went ahead with. At most one per project.
_Avoid_: winning bid, chosen bid

**Signed contract**:
A link to where the signed agreement lives (Drive or Adobe). Never a copy held in the portal.

**Estimated cost** / **Actual cost**:
What a project was expected to cost and what it came to. Amounts only; the money moves in QuickBooks and Ramp.
_Avoid_: budget (that word belongs to the house's startup budget)

**Target period**:
When a project is meant to happen: a year, or a quarter of a year. Never a hard date, because these slip by design.
_Avoid_: due date, deadline

## The house

**House facts**:
What a household needs to know about their house: access codes, security, parking, surfaces needing care, things not to do, rubbish day. Written by staff, read by the household.
_Avoid_: property info, house notes, house details

**Staff notes**:
The free-text notes on a property that only staff see. Distinct from house facts and never merged with them.
_Avoid_: notes (unqualified)

**Access code**:
A door, gate or alarm code for a house. Stored, shown to the household and staff, and carrying the date it was last changed.
_Avoid_: password, PIN, key code

**Photo comparison**:
One room's walkthrough photos laid side by side across years, to answer "has that crack grown".
_Avoid_: year-over-year view, diff
