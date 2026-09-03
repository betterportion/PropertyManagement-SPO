# docs-sync map

Read by the global `docs-sync` skill. It carries the method; this file carries what is true
about *this* repo. When a change lands on a path with no row here, add the row in the same PR.

- **Default branch**: `main` (squash-merge — each commit on main is one PR, numbered in its subject)
- **Gate**: `npm run lint && npm run check && npm test && npm run build`

## Docs

| Doc | What it claims about |
|---|---|
| `CLAUDE.md` | architecture, the backend file table, the data model, authorization, uploads, audit, conventions, known issues |
| `README.md` | setup, env vars, commands, project layout, security model, deployment, known issues |
| `.env.example` | every environment variable, with placeholders |
| `docs/PRODUCTION_MIGRATION.md` | the staging-first runbook: Supabase, Google Workspace login, Render, env tables |
| `docs/IMPLEMENTATION_PLAN.md` | backlog phase status — what shipped, what is blocked |
| `design_guidelines.md`, `docs/spo-design-system.md` | design rules only; they make no claims about code shape |

## Surfaces

| Surface changed | Claims that can go false | How to check |
|---|---|---|
| `shared/schema.ts` | CLAUDE.md data-model table (one row per table), the table count written above it, and any status vocabulary quoted in prose (roles, rent status, ownership, deposit status) | `grep -c 'pgTable(' shared/schema.ts` against the written count; every added, renamed or dropped table has a row, and appears in the `\dt` list in `docs/PRODUCTION_MIGRATION.md` |
| `shared/` outside `schema.ts` | README "Project layout" tree; CLAUDE.md wherever it names a shared module as owning a rule (`depositLedger.ts`, `assetLifecycle.ts`, `propertySetup.ts`, `residentDocuments.ts`) | `ls shared/` against the README tree; the named module still exports what the doc says it owns |
| `package.json` scripts | CLAUDE.md Commands table; README "Commands" and "Checks before you push" | `node -e "console.log(Object.keys(require('./package.json').scripts).join('\n'))"` — every script appears in both docs |
| `package.json` deps or `overrides` | README "Tech stack"; the `overrides` note in CLAUDE.md Conventions | read the hunk |
| `server/` file added, deleted or renamed | CLAUDE.md backend file table; README "Project layout" tree | `ls server/*.ts server/*/` against both lists |
| `server/config.ts` | README "Set the environment variables"; `.env.example`; the env tables in `docs/PRODUCTION_MIGRATION.md` | every var `config.ts` reads appears in all three, with the same required/optional status |
| `server/routes.ts` | the handler count in CLAUDE.md's backend file table; the Authorization model section if guards moved | `grep -cE '^[[:space:]]*app\.(get\|post\|patch\|put\|delete)\(' server/routes.ts` |
| `server/authz.ts` | CLAUDE.md "Authorization model" in full — the three layers, the admin bypass, the region helpers, resident visibility | read the section beside the file |
| `server/auth.ts` | CLAUDE.md "Login" — the claim-mapping rule, `upsertUser` re-linking, the hard-coded callback, refresh-token behaviour | read the section beside the file |
| `server/audit.ts` | CLAUDE.md "Audit log" — the event vocabulary, two-year retention, the indefinitely-kept list | the doc's kept-forever list matches `AUDIT_ACTIONS_KEPT_INDEFINITELY` exactly |
| `server/uploadLimits.ts`, `server/objectStorage/` | CLAUDE.md "File uploads" — the two endpoints, the 10MB/20MB limits, the 64MB in-flight ceiling, the read-back rules | the numbers in the doc match the constants |
| `server/email.ts`, `server/schedules.ts`, `server/seasonalTasks.ts` | CLAUDE.md "Integrations" and the three-daily-jobs paragraph | a fourth job moves that paragraph's count and its idempotency rule |
| `server/storage.ts` | the `IStorage` rule in CLAUDE.md — route handlers never touch the database directly | `grep -n 'db\.' server/routes.ts` should stay empty |
| `client/src/components/ui/` | CLAUDE.md "22 generated primitives" | `ls client/src/components/ui/ \| wc -l` |
| `client/src/components/` (outside `ui/`) | nothing, unless the component is a feature a doc describes in prose — a new dialog behind an existing button is not a claim | read the hunk; check CLAUDE.md and README for prose naming the feature |
| `migrations/` | CLAUDE.md "Rules for schema changes"; the migration count and latest tag quoted in `docs/PRODUCTION_MIGRATION.md` | `ls migrations/*.sql \| wc -l` and the newest tag against what the runbook names |
| `client/src/pages/` added or deleted | README "Project layout"; the role-based routing note in CLAUDE.md if `App.tsx`'s switch changed | read the hunk |
| `.github/workflows/` | CLAUDE.md "the gate" paragraph; README "Checks before you push" | every workflow file is named somewhere |
| `scripts/` | the `npm run db:seed` and `npm run db:baseline` rows in CLAUDE.md's Commands table; README "Create the database tables" | read the hunk against both rows — the refuse-if-populated rule and `SEED_ADMIN_EMAIL` are both written down |
| `e2e/` | CLAUDE.md's walkthrough-screen section names `e2e/mobile.spec.ts` as what proves the note-saving rule; README "Checks before you push" | a renamed or deleted spec file breaks a doc that points at it by name |
| `client/src/lib/` | CLAUDE.md where it names a module as owning a rule (`walkthrough.ts`, `maintenanceFilters.ts`, `format.ts`) | the named module still exports what the doc says it owns |
| a known issue fixed, or a new one accepted | CLAUDE.md "Known open issues"; README "Known issues" | the two lists say the same things |
| a plan item shipped | `docs/IMPLEMENTATION_PLAN.md` phase marks | the phase the PR title names |

## Not claims

Logic inside an existing function, styling, copy, test files, refactors that keep every
exported name, and dependency bumps that change no version the docs quote.
