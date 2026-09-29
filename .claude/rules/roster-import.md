---
paths:
  - "**/residentImport*"
  - "client/src/components/RosterImportDialog.tsx"
  - "client/src/pages/Residents.tsx"
---

# Roster CSV import

Moved verbatim from CLAUDE.md. Loads when you work with a file matching `paths`; the rest of the repo rules are in CLAUDE.md.

### The roster CSV import

`POST /api/properties/:propertyId/residents/import/preview` and `POST /api/properties/:propertyId/residents/import` are a deliberate pair: **the upload only ever produces a preview, and nothing is written until the second call confirms it.** It is reachable from two places — the Residents page with a house picker, and **the property page's roster card with the house fixed**, because that is the screen an RA is standing on in August (an RA reviewing the app could not find it anywhere else). Beside both is a **blank template** download: `shared/residentImportTemplate.ts` holds its headers and one example row, and `residentImport.test.ts` parses that exact file, so the template can never drift from what the parser accepts. Three things to preserve if you touch them:

- **The property is in the URL, not a form field**, so the multipart request still carries one part and no text fields — the property the other upload routes rely on to bound what a request can cost.
- **The CSV is never stored.** It is decoded, parsed and dropped. That is also why there is no magic-byte check here: a CSV has no signature, and nothing reaches a bucket for a disguised file to sit in.
- **The confirm step re-derives everything** — it re-reads the roster, re-runs the duplicate check **and the row checks** (`checkImportRow`, the same rule the preview runs, so a date like 2026-02-30 is refused rather than rolled into March), and takes `propertyId`, `region` and `buildingAddress` from the property rather than from the body. Any unusable row refuses the whole confirm with a 400, and the rows go in with one `createResidents` insert, so a failure never leaves a roster half-imported. The rows arrive from a client that could have edited them, and the roster can have moved on between the two calls.
