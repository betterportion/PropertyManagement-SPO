# SPO data platform: vision and rules

The same file lives in SPO-Crew-App, PropertyManagement-SPO and DonorCRM-SPO (`docs/SPO-DATA-PLATFORM.md`). Change all three together. JR's notes are in the Obsidian vault at `SPO Data Platform/Getting Off Google Sheets.md`. Last updated 2026-10-09.

## The goal

Saint Paul's Outreach (SPO) wants everyone it serves, at every level, in one place: missionaries, household residents, formation students, donors and staff. Apps, tools and dashboards get built on top of that, and each one shows the right people the right data for their role. Today the data sits in three silos plus Google Sheets, with no shared person ID. One student can be a crew member, a household resident, and later a missionary with donors, and nothing links those rows.

| App | Store today | People it knows |
|---|---|---|
| SPO-Crew-App | SQLite on the phone → Firestore → Google Sheets (each missionary's CREW workbook, the chapter ROSTER) | missionaries, their crews, weekly reports, staff roles |
| PropertyManagement-SPO (Admin Portal) | Postgres (Drizzle). Today on Replit; Supabase + Render planned | household residents, houses, leases, budgets |
| DonorCRM-SPO | Postgres (Django), multi-tenant; SPO is one organization | donors, gifts, pledges, MPD; missionaries as fundraisers |

## The target

- **One shared managed Postgres (Supabase) becomes SPO's system of record.** It has a `people` table and dated fact rows attached to each person: crew relationship, household residency, formation enrollment, missionary service, donor support, staff role.
- **Row-level security encodes the access model below.** Every app reads through the same rules instead of inventing its own.
- **Firestore stays only as the Crew App's offline sync buffer.** Phones keep writing SQLite and Firestore as today. The sync function gains Postgres as a target.
- **Google Sheets becomes a generated view.** Later it is produced from Postgres for anyone who still wants a spreadsheet. Leaving Sheets should mean deleting code, not migrating data.
- **Dashboards are built on Postgres:** chapter, region and national MRBM, plus one admin website across all SPO apps.
- **Design for SPO's data person.** They are gifted with Sheets but are not a programmer, so outputs are Sheets-shaped exports and dashboards. Nothing requires SQL.

## Identity

- **The people layer mints its own permanent person ID.** It is random, never reused, and never derived from a name, email or chapter.
- **Every other ID is an alias, stored as a dated fact.** The ROSTER "Unique ID" (chapter code + full name, e.g. `TC-YA Emily Hanson`) is per year, is not unique, and changes with a name or chapter change. The same goes for a Crew App `crew_members.id`, which is one missionary's relationship with a student, not a person: the same student can be two rows. DonorCRM contact IDs and Admin Portal user IDs are aliases too.
- **Email is never the identity key.** `.edu` addresses vanish after graduation unless SPO's spring "alumni bridge" swap succeeds.
- **Cross-year matching uses name plus phone or email, and a person confirms it.** Never name alone.
- **Normalize identity fields on write** so matching has clean inputs: trimmed names, lowercase trimmed email, digits-only phone. Keep chapter, year and graduation term populated.
- **The Crew App's Firestore `chapters` list (`docs/seed-chapters.json`) is the one canonical chapter list.** It uses short ids, with a region and a type (campus or young adult) on each chapter. ROSTER chapter codes and the Admin Portal's free-text chapter names map onto it. They are not second lists.

## Sources of truth today

- **Google Sheets stays primary** until the gate below is passed. Every app treats it that way.
- **Household residency:** the **HH Paperwork** document is the most accurate record. Joseph Ginzel, head of admin, maintains it. RAs update the household and formation directories in each chapter ROSTER from sign-ups and paperwork. A national roll-up lives in the "7 key mission metrics" document. Neither the ROSTER nor the Admin Portal is the residency truth.
- **Donors:** Raiser's Edge, synced into DonorCRM.
- **Staff roles** (role, chapter, region, gender): set in the Crew App by national admins and supervisors, and written by the server only.

## Who sees what

SPO had no written policy; this is JR's, from 2026-09-26.

| Role | Sees |
|---|---|
| Missionary | their own crew, and their chapter's roster |
| Chapter leader (a man and a woman per chapter) | their own chapter, **their own gender only** |
| Mission supervisor (a man and a woman per region) | the whole region: every chapter, both genders. Supervisors don't file reports |
| National admin (HQ, Mendota Heights, MN) | everything |

Weekly MRBM goals (Meet / Rally / Bring / Move): campus missionary 5/3/3/5, young adult missionary 3/3/3/5, campus chapter leader 5/2/2/2, young adult chapter leader 2/2/2/2, supervisors none.

Never widen a read past this table. Enforce it on the server (a role-checking function now, RLS later), never only in the UI.

## People and retention

- **Nobody SPO tracks is a minor.** They are college students and young adults. The Crew App refuses to record anyone under 18.
- **Records are kept long-term, and deletion is a legal exception, not a user feature.** This is what SPO's privacy notice promises (its section 6): a person can always correct their record, stop alumni and fundraising contact, and withdraw consent to pastoral notes, and the record that they took part stays. Where the law requires deletion, de-identify the person (name and contact details come off, the dated facts stay) rather than hard-delete. Archive, never erase. The Crew App's account purge is the one exception: it removes a missionary's own app data.
- **Consent and contact preferences are facts on the person.** Recorded once (who, when, which form, and any withdrawal) and honored by every app. A student stays with their missionary until a consent is on file; only then can the row reach a chapter roster or a communication list. Fundraising never reads student records. This is SPO HR's recommendation of 2026-10-09 (a signed digital form by QR code), and the shape the people layer must give it.
- **Rows are attributed and dated:** who, when, and which person. A change is a new fact or an audited update, not a silent overwrite.

## Rules for every app, starting now

1. **Never make Sheets a source for anything an app shows.** Sheets are written to. Reading a sheet once to import, behind an admin's review, is allowed. A recurring read is a known debt and must be listed under "Open questions" below.
2. **New data takes a shape Postgres can absorb:** attributed to a person or account id, dated, and no free-form blobs.
3. **Cross-person reads go through a server function that checks role,** never a widened rule or query. That is the shape RLS will take.
4. **No new per-app copies of a person.** If one app needs another's data (the Crew App showing DonorCRM numbers, for example), it reads across apps with the caller's own sign-in and gets only what that screen needs.
5. **Keep alias IDs** (ROSTER ID, sheet row, Raiser's Edge ID, email) on the record, so the people layer can link them later.
6. **Nothing endangers the Crew App's December 1, 2026 pilot.** Week 1 starts Saturday 2026-11-28. The pilot runs on Firestore + Sheets as they are.

## Build order (agreed 2026-09-17)

1. **December 1 pilot** on Firestore + Sheets.
2. **Chapter roster writer:** the Crew App fills the chapter ROSTER from crews (`SPEC-sheets-roster-sync.md` in SPO-Crew-App). This is the last Sheets-shaped output needed.
3. **Shared people layer:** the Postgres `people` table with permanent IDs. Crew rows and weekly reports are written there alongside Sheets, and cross-year matching is confirmed by a person.
4. **DonorCRM read in the Crew App's MPD tab:**
   - missed donors this month, by name, with a tap-to-text button (needs phone numbers on DonorCRM's missed-donor rows);
   - this month's pay (pledges plus the rollover pool, up to the missionary's cap);
   - MPD to-dos and broadcasts from SPO national.

   It reads missionary-scoped numbers only, never the whole donor book. Then DonorCRM and the Admin Portal key their people to the shared person ID.
5. **Admin website across all apps:** roster, crew, region and national MRBM, roles. It reads Postgres through RLS.
6. **Sheets as a view,** then optional.

## The gate

SPO stops treating Sheets as the record only once a data warehouse is funded. The board and Mark Archibald (effectively COO) decide (Maddie, 2026-09-19). JR won't make a proposal until we're confident SPO's data can be organized, which steps 2 and 3 prove.

## Open questions

- **The Admin Portal's daily roster sync** (PropertyManagement #203) reads a master Google Sheet and matches residents by email. That is a recurring Sheets read and an email key. It's safe for now: it never deletes anyone, flags anything unusual, and only runs after an admin has looked. But it's a per-app copy of people that the shared layer must absorb. Is it a deliberate stopgap? And is the master sheet the same as, or fed from, HH Paperwork?
- **Is the Admin Portal's planned Supabase project the shared Postgres,** or a separate one that gets merged later?
- **Not received yet:** the HH Paperwork and "7 key mission metrics" documents, SPO's full leader and supervisor list (only the Northwest supervisors are known: Kevin Hadsall and Rachel Holmes), and the young adult chapter names.
- **Not decided:** a timeline and budget for the warehouse proposal, and who at SPO owns the data layer.
- **DonorCRM is multi-tenant.** Linking SPO's contacts and fundraisers to SPO person IDs must stay inside SPO's tenant and never reach shared product code for other organizations.

## Contacts

- **Maddie (SPO):** operational questions, five or six at a time by email.
- **Joseph Ginzel:** head of admin, HH Paperwork.
- **Mark Archibald:** effectively COO, decides funding with the board.
- **hr@spo.org:** privacy contact for the Crew App and the Admin Portal.
- **JR (Better Portion):** maintains all three apps. SPO owns the Crew App and the Admin Portal; DonorCRM is Better Portion's product.
