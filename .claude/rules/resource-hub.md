---
paths:
  - "**/*esourceHub*"
  - "**/*ouseFacts*"
  - "client/src/components/ResourceLinksSettings.tsx"
  - "client/src/components/PropertyBudgetCard.tsx"
  - "client/src/components/ResidentPaperwork.tsx"
  - "shared/residentDocuments.ts"
  - "client/src/pages/ResidentDashboard.tsx"
---

# Resource hub and house facts

Moved verbatim from CLAUDE.md. Loads when you work with a file matching `paths`; the rest of the repo rules are in CLAUDE.md.

### The resource hub

`/resources` is the one page a household leader or steward needs, and it is the widest resident-facing surface in the portal. The framing shapes the layout: for many students this is one of their few interactions with SPO as an organisation, so their own house comes first and the general material below it.

- **A resident reaches it on `canViewResourceHub` and nothing else.** It is its own flag rather than a reading of `canCompleteWalkthroughs`, for exactly the reason that flag is separate from `canManageWalkthroughs`: filling in a walkthrough and being given the hub are two grants, and honouring one for the other means a later change to either silently moves the other. It defaults to false for every role, so nobody has it until an admin grants it — the same shape as walkthrough completion. Staff reach it under the property permission, so they can see what their households are being told.
- **A resident's scope is their HOUSE's region**, resolved from their property by `readableRegions` — never from whatever their permissions row happens to say. A resident-tier account has no region path anywhere else and acquires none here. There is a test asserting a leader whose permissions row names another region still cannot see that region's links.
- **A resident with no house claim gets the national links only**, not nothing. This is the one place the fail-closed default is "the widest thing that is safe for everybody" rather than "empty" — a leader with a broken property link should still find the fire extinguisher guidance.
- **Managing the links is `requireAdmin`, not a regional flag** — exactly like the walkthrough template, and for the same reason: a national link reaches every region, so editing one is not a grant over your own houses.
- **A link's region is one of `REGIONS`, spelled as the list spells it, or null for national.** Free text let "northwest" through, which reached nobody (#164).
- **Links, never documents.** Most content lives on Drive; duplicating a deep-clean checklist into the portal means two copies that disagree within a term. The URL is scheme-checked by `httpUrlFromClient` because every viewer of this page clicks these, residents included.

**Three named links, by key and never by title.** `shared/resourceHubSlots.ts` fixes the three documents every house is shown by name — Household Code of Conduct, Fire Extinguisher guidelines, Active Shooter Policy — and a link fills one through `resource_links.slotKey`. The hub renders all three in a "From SPO" card whatever is bound: an empty slot reads "Not yet available" with a line saying SPO is still writing it, so a document that does not exist yet (the fire extinguisher guidance, at the time of writing) is visibly waiting on content rather than silently missing. Bound by key so an admin renaming a link cannot empty its slot; unique, so a slot has one holder; national, so a slotted link cannot be narrowed to one region — `hubSlotProblem` is the pure rule and the create and edit routes run it over the merged row, because an edit sends only the field it changes. A slotted link is listed in its slot and not again under its category. No seed row and no placeholder URL: the slots stay empty until an admin binds a real link from Settings.

`GET /api/my-property` is a deliberately narrow projection of one property for the hub — **named fields, not the row** — so a column added to `properties` later cannot silently start reaching a resident. It carries the same flag.

**A startup budget is an operating figure**, not deposit or rent data — what the house has to furnish and settle itself. That distinction is what lets a leader see their own on the hub without the "residents never see financial data" rule being bent, and the budget list is narrowed for a resident **by property, not by region**, so being in the same region as another house grants nothing.

**Liability paperwork is recorded, not signed.** `shared/residentDocuments.ts` holds the fixed list; an RA records that a document was signed and when. **This is not e-signature** — that is a vendor integration and a separate decision, and a checkbox pretending to be one would be worse than nothing, because it would read as evidence in a dispute and be nothing of the sort. The copy on screen says so. Only a **date** counts as signed: a row existing means somebody looked, which is why clearing the date is always available.

### House facts and access codes

`property_facts` is what a household needs to know on day one: the door, gate and alarm codes, security and camera notes, parking and towing rules, surfaces needing care, things not to do, rubbish day, and whatever else. `docs/adr/0002-access-codes-stored-in-the-portal.md` records why the portal holds a door code at all when it refuses to hold credentials: the alternative is a code living in a text thread through three generations of household leaders because nobody remembers when it was set. Four rules make it safe enough, and each has a test:

- **A separate table, never merged with staff notes.** `properties.notes` is what staff write for each other; the facts are what they write for the household. Two tables is what makes "a staff-only remark never reaches a resident" true by construction. On the property page the two are different cards, and the household's card says on it who reads it. `shared/houseFacts.ts` holds the field vocabulary so the audit summary, the staff card and the hub name a field the same way.
- **The household reads it through the named projection and nothing else.** `GET /api/my-property` gained a `facts` object of named fields (never the row) plus the rental company's name, company and phone and the `maintenancePortalUrl`, both read from the property's own columns rather than retyped. Same gate as the rest of the hub: resident-tier, `canViewResourceHub`, own house only, null with no house link. The staff routes — `GET`/`PUT /api/properties/:id/facts`, under the property permissions with `requireRegion` — refuse a resident outright, even for their own house, so no resident acquires a region path here.
- **A code change is audited without the value.** `PUT` records one `property.access_code_changed` event per code whose value changed — "Door code for Cleveland House (1 Main St) changed", with the column name in the details — and the test asserts the value appears nowhere in the recorded row. Changing the parking rules or the rubbish day records nothing. Routine two-year retention: this is not access history.
- **Last-changed moves on a value change only.** `planHouseFacts` in `server/houseFacts.ts` is a pure function — the stored row, the incoming content and `now` in; the row to write and the codes that changed out. Setting a code for the first time, changing it and clearing it all count; re-saving the same code leaves its date alone. The body carries no dates, so a client cannot make a stale code look freshly rotated. The date is the point of the feature: the realistic failure is not a breach but a code nobody has rotated, and the household seeing "Last changed" three leaders ago is what prompts the question.
