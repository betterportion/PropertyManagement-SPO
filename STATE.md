# STATE — PropertyManagement-SPO (SPO Admin Portal)
Updated: 2026-09-28 · property management portal for Saint Paul's Outreach: one Express server serving the REST API and React frontend on one port.

## What exists
- `server/routes.ts` — ~147 API handlers, done
- `server/authz.ts` — authorization rules (active/permission/region/task/action-item visibility), done
- `server/storage.ts` — every DB query behind an `IStorage` interface, done
- `server/regionSummary.ts` / `server/actionItems.ts` — pure rollups for the leadership dashboard, done
- `server/seasonalTasks.ts` — calendar/lease-driven reminder tasks, generated idempotently by sourceKey, done
- `client/src/` — React frontend, role-based routing (staff vs resident), TanStack Query, shadcn/ui, done
- `shared/schema.ts` — Drizzle schema + Zod validators, single source of truth for both sides, done

## Key decisions
- Dashboard summaries (`/api/action-items`, `/api/region-summary`, `/api/tasks`) must never be a way around a source list's own permission flag (#158) — each item/task follows the flag of the list it's drawn from, via `canSeeActionItemSource` / `canSeeTask`.
- Lease-derived tasks (sourceKey `lease-renewal:`/`utilities-lease:`) are gated behind `canViewProperties`/`canManageProperties` inside `canSeeTask` itself (#170), so every caller (`/api/tasks`, `/api/action-items`, `/api/region-summary`) gets the rule for free rather than re-implementing a prefix check.

## Recent changes
- 2026-09-28: #170 — `canSeeTask` (server/authz.ts) now hides lease-derived tasks from staff lacking canViewProperties/canManageProperties (admin bypass preserved, overrides the "assigned to you" bypass); `/api/region-summary` (server/routes.ts) switched from `filterByRegion` to `canSeeTask` for tasks, closing the leak the prior review found in its safety count. Tests added in authz.test.ts and routeAccess.test.ts, confirmed red-without-fix via stash. Full gate (lint/check/test/build) green.
- 2026-09-27/28: issues #158–#164 implemented and merged to main — dashboard authorization flags, server-side validation gaps, recurring-issue exclusions, asset category refusal, lease-reminder category fix, and a UI sweep (see git log for detail).

## Unfinished / next
- [ ] None known for #170; awaiting the pipeline's test/review seats.

## Gotchas
- Region-scoped record lists use `filterByRegion`; tasks are the exception (personal/broadcast/lease-derived visibility) and must go through `canSeeTask` instead — using `filterByRegion` on tasks silently skips both the personal-task rule and the properties-flag rule.
