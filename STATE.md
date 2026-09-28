# STATE — SPO Admin Portal (PropertyManagement-SPO)
Updated: 2026-09-28 · Property management portal for Saint Paul's Outreach: one Express server serving a React SPA, for staff (admins/regional admins) and residents.

## What exists
- `server/routes.ts` — ~147 API route handlers, one file, admin bypass + region scoping pattern throughout. Done.
- `server/authz.ts` — permission/region checks (`requireActiveUser`, `requirePermission`, `filterByRegion`, `canSeeActionItemSource`). Done.
- `server/regionSummary.ts` — per-region leadership rollup (`buildRegionSummaries`), pure function. Done, just hardened (see below).
- `server/actionItems.ts` — dashboard action-item feed, source-flag gated. Done.
- Full walkthrough system, maintenance requests/projects/bids, deposits ledger, asset lifecycle, resource hub, request threads, house facts — all done per root CLAUDE.md's architecture section.
- `client/src/components/RegionCard.tsx` — one region's dashboard card, renders on `AdminDashboard.tsx`. Done.
- Test suite: `server/__tests__/*.test.ts`, vitest, no DB needed except one integration test. 1551 tests passing.

## Key decisions
- Visibility/permission gating for rollups must happen *inside* the pure aggregation function, from the same locals the response fields use — not just at the route's fetch layer — so a hidden source's real magnitude can never leak into a derived score even if fed real data. See #171 below.
- `RegionSummary.hidden: RegionSummarySource[]` names which sources (`maintenance`/`schedule`/`lease`/`rent`) a caller can't see; the dashboard must not render "All clear" when this is non-empty, even if the visible score is 0.

## Recent changes
- 2026-09-28: #171 redo — region summary "All clear" no longer masks a hidden permission as genuinely clear, and `attentionScore` is now computed from the same visibility-gated locals as the response counts (prior attempt leaked a hidden source's magnitude into the score). Touched `server/regionSummary.ts`, `server/routes.ts`, `client/src/components/RegionCard.tsx`, plus tests in `regionSummary.test.ts`, `routeAccess.test.ts`, `seasonalTasks.test.ts`.
- 2026-09-28: #179 — deleting records now removes their stored files; resident deletes are audited.
- 2026-09-27/28: Issues #159–#164, #169–#170 shipped (UI sweep, server-side validation gaps, lease-task region leak fix, asset unrated reasons, etc).

## Unfinished / next
- [ ] Issue #37 — clear the 8 remaining React Compiler lint warnings (pre-existing, not blocking, not touched here).
- [ ] Known open issues 1–4 in root CLAUDE.md (orphaned upload files on replace, pre-migration files unreachable, out-of-region 403 vs 404, pre-`completedDate` requests have no close date) — all deliberately accepted, not scheduled work.

## Gotchas
- This worktree ships with no `node_modules`; run `npm ci` before `npm test`/`npm run build` here.
- `RegionSummaryInputs.visibility` is a required field — any direct caller of `buildRegionSummaries` (tests included) must supply it, or it throws (`Object.keys` on undefined).
