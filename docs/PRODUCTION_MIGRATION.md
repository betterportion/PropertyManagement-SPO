# Production migration runbook

How to move the SPO Admin Portal from its Replit workspace onto permanent infrastructure: **Supabase** for the database and file storage, **Google Workspace** for login, **Render** for hosting.

---

## Read this first

**No external infrastructure has been created.** No Supabase project exists, no Google Cloud OAuth client exists, no Render service exists. Every account and resource below has to be created by a person with the right access. This document is the sequence to follow and the settings to use — nothing here has been done in advance.

**Do staging first.** Every step below is written to be done twice: once against a throwaway staging environment, then again for production. Do not skip staging. The two steps most likely to go wrong — the login provider and the storage bucket — both fail in ways you cannot see until a real person tries to sign in or open a document, and in production that means locked-out staff and unreachable files.

**Do not cut over until staging works end to end.** The checklist in step 8 is the bar. If any item fails, fix it in staging.

### What you need before starting

| Access | Needed for | Who typically has it |
|---|---|---|
| Google Workspace **super admin**, or an admin who can manage Google Cloud | Creating the OAuth client that staff sign in with | Better Portion |
| A Google Cloud project in the same organisation | Holding the OAuth client | Better Portion |
| Supabase account | Database and file storage | Whoever will own the infrastructure |
| Render account | Hosting | Whoever will own the infrastructure |
| The GitHub repository | Render deploys from it | — |

Set aside a couple of hours for the staging pass. The Google OAuth verification screen can take longer if the app is not marked internal — see step 5.

### A note on cost

Supabase and Render both have free tiers that are fine for staging. For production, expect the paid entry tier of each: a free Render service sleeps when idle, which means the first person to open the portal in the morning waits for a cold start, and a free Supabase project pauses after a week of inactivity.

---

## Step 1 — Supabase staging project

1. Create a new Supabase project. Name it something clearly temporary, e.g. `spo-portal-staging`.
2. Choose a region close to the users.
3. Save the database password Supabase generates. You cannot retrieve it later.
4. Go to **Project Settings → Database → Connection string → URI** and copy two forms of it:
   - the **Transaction pooler** string — this is what the running app uses,
   - the **Direct connection** string — this is what migrations use.

The pooler exists because the app keeps a connection pool of its own and Render may run more than one instance; going direct from every instance exhausts Postgres' connection limit. Migrations use the direct connection because the transaction pooler does not support everything a migration may do.

Keep both. `DATABASE_URL` for the service is the pooled one.

---

## Step 2 — Create the schema

From a checkout of this repository, with `DATABASE_URL` set to the **direct** connection string:

```bash
npm ci
DATABASE_URL="postgresql://...direct..." npm run db:migrate
```

That applies every file in `migrations/` in order and records them in a `__drizzle_migrations` table.

Verify:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

You should see thirty-three tables — `asset_photos`, `assets`, `audit_log`, `billing_records`, `contact_notes`, `deposit_deductions`, `invoices`, `maintenance_contacts`, `maintenance_request_comments`, `maintenance_request_photos`, `maintenance_requests`, `maintenance_schedules`, `properties`, `property_budgets`, `property_facts`, `property_setup_items`, `rent_payments`, `request_contacts`, `resident_documents`, `residents`, `resource_links`, `security_deposits`, `sessions`, `tasks`, `uploads`, `user_permissions`, `users`, `walkthrough_items`, `walkthrough_photos`, `walkthrough_rooms`, `walkthrough_template_items`, `walkthrough_template_rooms`, `walkthroughs` — plus `__drizzle_migrations`.

> **`sessions` must be in that list.** The app does not create it at startup — the session store is deliberately configured not to — so if the migrations did not run, logging in fails rather than silently starting a fresh store.

**Do not use `npm run db:push` against staging or production.** It pushes the schema with no migration record, so the next `db:migrate` sees an empty history against a full database and tries to create everything again.

### Migrating an existing database instead of a fresh one

> **For the SPO production launch, skip this section.** Issue #6 settled it:
> production starts from an **empty** database and staff enter their own data, so
> there is nothing to baseline. This is kept because the situation it describes —
> a database with the tables but no migration history — is easy to land in by
> accident (a `db:push` against a shared database will do it) and hard to get out
> of without the command below.

Everything above assumes an empty Supabase project, where `db:migrate` applies every migration for real. A database that **already has the tables but no migration history** needs one command first, or `db:migrate` will try to create tables that are already there and stop.

```bash
npm run db:baseline -- <tag>     # then npm run db:migrate
```

`<tag>` is the last migration whose changes that database **already contains**. It is not optional in practice: run bare, `npm run db:baseline` records only `0000_baseline_current_schema`, which is correct only for a database that has never had any later change applied.

| The database looks like | Use |
| --- | --- |
| A fresh, empty Supabase project | No baseline. Just `npm run db:migrate` |
| The app as it runs today, before the audit log | `npm run db:baseline -- 0002_drop_monday_item_id` |
| Only the original schema, no `uploads` table | `npm run db:baseline` |

The middle row was the old Replit database: it had the `uploads` table (`0001`) and no longer had `monday_item_id` (`0002`), so it baselined through `0002_drop_monday_item_id` and then migrated. Yours will name a different tag — there are thirty migrations now, through `0029_comment_attachments`.

You do not have to get this right by inspection. Before recording anything, the command compares the database against the migrations in both directions — a missing table or column, a column a later migration should already have dropped, or a table that only a later migration creates — and refuses if anything disagrees. It then works out which tag the database *does* match and tells you:

```
This database does not match "0000_baseline_current_schema":
  table "uploads" already exists, but nothing up to this tag creates it -- this
  database is further along than the tag you named

This database matches "0002_drop_monday_item_id". Run:

  npm run db:baseline -- 0002_drop_monday_item_id

Nothing has been written.
```

Run the command it gives you. The check runs inside a transaction that is rolled back, so a refusal leaves the database exactly as it was.

If it instead says the database matches no point in the migration history, stop and compare it against `migrations/` by hand. That means someone changed the schema outside a migration, and no tag is truthful for it.

**Verify after baselining.** `select count(*) from drizzle.__drizzle_migrations;` should equal the number of migrations recorded, and `db:migrate` should then report applying only the ones that genuinely remain.

> This sequence was rehearsed against a throwaway copy of the pre-audit schema: baseline through `0002_drop_monday_item_id`, then `db:migrate`, ended with the schema as it stood at `0003` and `audit_log` created. The migration list has grown a lot since, but the mechanism is unchanged, and `scripts/__tests__/baselineMigrations.test.ts` locks the check that makes it work.

---

## Step 3 — Private storage bucket

In the Supabase dashboard, **Storage → New bucket**:

- **Name:** `uploads` (or another name — if you change it, set `SUPABASE_STORAGE_BUCKET` to match)
- **Public bucket: OFF**

**The bucket must be private.** This is the single most important setting in this document. The portal holds W-9s, certificates of insurance, contract invoices and photographs of people's homes. A public bucket makes every one of those readable by anyone who knows or guesses the URL, with no sign-in — and because storage keys are the only thing protecting them, nothing else in the app can compensate.

The app never relies on bucket-level access rules. It checks permissions itself and then issues a short-lived signed link, which is why the bucket can stay locked down.

Then collect two values from **Project Settings → API**:

- the **Project URL** (`https://<ref>.supabase.co`) → `SUPABASE_URL`
- the **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY`

The service role key bypasses every access rule in the project. It is a server-only secret: it goes in Render's environment, never in a client bundle, never in the repository, never in a chat message. If it is ever exposed, rotate it in the same dashboard.

---

## Step 4 — Prove uploads work before going further

Still local, pointed at staging:

```bash
export DATABASE_URL="postgresql://...pooled..."
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export STORAGE_DRIVER=supabase
export SUPABASE_URL="https://<ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
export SUPABASE_STORAGE_BUCKET=uploads
npm run dev
```

Sign in (still on Replit login at this point — the provider changes in step 5), then:

1. Upload a photo to a maintenance request. It should appear.
2. Check **Storage → uploads** in Supabase — a new object with a long random name should be there.
3. Check the database: `select * from uploads order by created_at desc limit 5;` — a matching row.
4. Reload the page. The photo should still display, via a signed URL.
5. Copy the signed URL, wait for it to expire, and open it in a private window. It should be refused.

If a file lands on disk instead of in Supabase, `STORAGE_DRIVER` is not set to `supabase`. Getting this wrong is quiet — the app works perfectly until the host replaces the container and every uploaded file vanishes with it.

---

## Step 5 — Google Workspace login

This is the step with the most moving parts, and the only one that requires Google Workspace administrator access.

### What Better Portion must configure

**In Google Cloud Console**, in a project belonging to the Google Workspace organisation:

1. **APIs & Services → OAuth consent screen**
   - **User type: Internal.** This restricts sign-in to the organisation's own Workspace accounts and skips Google's verification review entirely. Choose External only if people outside the Workspace domain need to sign in, and expect a verification process.
   - App name: `SPO Admin Portal`
   - Support email and developer contact email: a monitored address
   - Scopes: `openid`, `email`, `profile` — nothing more. The portal reads nothing from Google beyond who the person is.

2. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Name: `SPO Admin Portal (staging)` — make a second, separate client for production
   - **Authorised redirect URI:** exactly
     ```
     https://<your-staging-host>/api/callback
     ```
     For a Render service that is `https://spo-portal-staging.onrender.com/api/callback`. Google matches this string exactly — scheme, host and path all have to be right, with no trailing slash.
   - Authorised JavaScript origins: not needed.

3. Copy the **Client ID** and **Client secret**.

**Add a redirect URI for every hostname the portal answers on.** The app builds its callback from the hostname of the incoming request, so a custom domain added later needs its own entry, or login breaks on that domain only.

### What to set in the app

| Variable | Value |
|---|---|
| `OIDC_ISSUER_URL` | `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | the client ID from above |
| `OIDC_CLIENT_SECRET` | the client secret from above |
| `OIDC_PROVIDER_NAME` | `google` |
| `OIDC_SCOPES` | `openid email profile` |

**`OIDC_SCOPES` must be set explicitly for Google.** The application's default includes `offline_access`, and **Google rejects that scope** — login fails with `invalid_scope` and no user gets in. Google uses its own mechanism for long-lived access, which this app does not need.

The consequence, which is worth stating plainly to whoever supports the portal: **sessions end when the access token expires and staff sign in again.** The app can only refresh a session in the background when the provider issues a refresh token. Signing in again is a click — the browser is already signed in to Google — but it is not invisible.

No code changes. `server/auth.ts` reads all of this from the environment.

### What happens to existing accounts

Accounts re-link **by email address**. On sign-in, if the email matches an existing user under a different provider ID, that account is migrated in place and keeps its role, its active flag and its permissions.

That has one sharp edge: **an address that does not match exactly arrives as a brand-new account with the `resident` role.** Someone whose portal account says `jane@spo.org` but who signs in to Google as `jane.doe@spo.org` will find themselves looking at a resident's empty request list, not the admin pages.

Before switching a provider:

```sql
select email, role, is_active from users order by role, email;
```

Send that list to whoever administers Google Workspace and have them confirm each address is the exact Workspace primary address. Fix mismatches in the `users` table *before* the switch, not after. Aliases do not help — Google reports the primary address.

### First sign-in on a fresh database

Whoever signs in first is created as a `resident`. There is no bootstrap admin. Promote them by hand, once:

```sql
update users set role = 'admin' where email = 'you@spo.org';
```

Sign out and back in for the change to take effect.

---

## Step 6 — Render staging service

**New → Web Service**, connected to the GitHub repository.

| Setting | Value |
|---|---|
| Environment | Node |
| Node version | 20 (set `NODE_VERSION=20` if Render picks another) |
| Build command | `npm ci && npm run build` |
| Start command | `npm run start` |
| Health check path | `/api/health` |
| Instance type | Free is fine for staging; use a paid instance for production |

The health check endpoint returns 200 only when the process is serving **and** the database answers, so Render will not route traffic to an instance that cannot reach Supabase.

`PORT` is supplied by Render — do not set it yourself. The server reads it and listens on `0.0.0.0`.

### Environment variables

Set these in **Environment** on the service:

```
DATABASE_URL          = <Supabase pooled connection string>
SESSION_SECRET        = <fresh 32+ character random string, different per environment>
STORAGE_DRIVER        = supabase
SUPABASE_URL          = https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY = <service role key>
SUPABASE_STORAGE_BUCKET   = uploads
OIDC_ISSUER_URL       = https://accounts.google.com
OIDC_CLIENT_ID        = <Google client ID>
OIDC_CLIENT_SECRET    = <Google client secret>
OIDC_PROVIDER_NAME    = google
OIDC_SCOPES           = openid email profile
```

Outbound email is deliberately **not** in that list. The app runs fine with no mailer and
simply sends nothing. When the Resend domain is ready (issue #49), add `RESEND_API_KEY`
and `EMAIL_FROM` together — and optionally `EMAIL_REPLY_TO`. Setting only one of the pair
fails the boot check on purpose, so a half-configured mailer can never silently swallow
messages.

`APP_URL` is optional too: set it to the address people open the portal at (the Render hostname, once you have it) and comment emails carry an "open this request" link; leave it unset and they go out without one. It must be an `https://` address when set.

`.env.example` documents every one of these, and the optional tuning variables (`DATABASE_SSL`, `DATABASE_POOL_MAX`, `MAX_UPLOAD_BYTES_IN_FLIGHT`).

**Generate a different `SESSION_SECRET` for staging and production.** Sharing one means a staging session cookie is valid in production.

If anything required is missing the service will fail to start and the log will name **every** missing variable at once — that message is the fastest way to find a typo.

### Point Google at the real hostname

Render assigns the hostname only after the service is created. Go back to the Google OAuth client and make sure the authorised redirect URI matches it exactly, including `/api/callback`.

### Migrations on deploy

Render does not run migrations for you, and this project does not run them at startup — a schema change on boot with several instances starting at once is a good way to corrupt a database. Apply migrations deliberately:

```bash
DATABASE_URL="<direct connection string>" npm run db:migrate
```

Do this **before** deploying code that depends on the new columns. Render's shell on a paid instance can run it, or run it from a laptop with the direct connection string.

---

## Step 7 — Confirm the configuration matches

Before testing, check the running service reports itself healthy:

```bash
curl https://<staging-host>/api/health
```

Expect `200` and a body indicating the database is reachable. A `503` here means the app is up but Supabase is not answering — check `DATABASE_URL` and that you used the pooled string.

---

## Step 8 — Test staging properly

This is the bar for cutover. Work through it with at least two accounts: an admin and a non-admin.

**Login**
- [ ] Sign in with a Google Workspace account. You land in the portal, not on an error.
- [ ] The correct name and email appear in the sidebar.
- [ ] Sign out, then sign in again.
- [ ] An existing pre-migration account keeps its role and its permissions.
- [ ] A Google account from **outside** the Workspace organisation cannot sign in (if the consent screen is Internal, Google refuses it).

**Access control** — the part worth being slow about
- [ ] A resident account sees only resident pages, with no admin navigation.
- [ ] A regional administrator sees only records for their allowed regions.
- [ ] A regional administrator cannot open a record from another region (expect a refusal, not a blank page).
- [ ] An admin with no permissions row can still reach the admin pages.
- [ ] Deactivate an account in Settings; while still signed in on another browser, that account is refused on its next action.
- [ ] Signed out, opening `https://<staging-host>/api/maintenance-requests` directly returns 401, not data.
- [ ] Signed out, opening a `/uploads/<key>` URL returns 401, not the file.

**Files**
- [ ] Upload a photo to a maintenance request; it appears.
- [ ] Upload a PDF as a billing document; it appears.
- [ ] Both objects are in the Supabase bucket, and the bucket is still private.
- [ ] Downloading a document works for a user who should see it.
- [ ] A file over the size limit is refused with a clear message, not a crash.
- [ ] Renaming an `.exe` to `.pdf` and uploading it is refused.

**Core workflows**
- [ ] Create, edit and delete a property.
- [ ] Create a maintenance request; move it through its statuses; delete it.
- [ ] Complete a walkthrough with photos.
- [ ] Add an asset with a photo.
- [ ] Add a vendor contact, an invoice and a billing record.
- [ ] Create a user, set their permissions and regions, deactivate them.

**Audit log** — confirms the record of who did what is actually being written:
```sql
select created_at, actor_email, action, summary
from audit_log order by created_at desc limit 20;
```
- [ ] The role change, deactivation, invoice and document actions from above are all listed with the right actor.

**Operational**
- [ ] `/api/health` returns 200.
- [ ] Restart the service in Render; it comes back without manual intervention.
- [ ] Sessions survive that restart (they live in Postgres, not in memory).
- [ ] The Render logs contain no stack traces during normal use.

---

## Step 9 — Bring the data across (optional)

Only if the existing data has to be preserved. If the portal is going live with fresh data, skip this.

> **SPO's V1 skips this step.** Issue #6 settled that there is no Replit data to bring
> across: production starts empty and staff enter properties, residents and contacts as
> they go. The step stays here for any later move between hosts.

1. **Put the current portal into read-only use** while you copy — announce a short freeze. Anything entered after the dump is taken will be lost.
2. Dump the current database:
   ```bash
   pg_dump --no-owner --no-acl --data-only \
     --exclude-table=sessions --exclude-table=__drizzle_migrations \
     "<current DATABASE_URL>" > spo-data.sql
   ```
   Data only: the schema on the new database already came from the migrations. `sessions` is excluded deliberately — copying live sessions to a new host is both useless and a bad idea.
3. Restore into staging first, never straight into production:
   ```bash
   psql "<staging direct connection string>" < spo-data.sql
   ```
4. Check the row counts match table by table, then work through step 8 again against the imported data.
5. **Files do not come across with the database.** Uploaded objects live in the storage bucket, and the `uploads` table only records where they are. If historic photos and documents matter, copy the objects into the Supabase bucket under the same storage keys — otherwise the records will point at files that are not there. Files predating the current storage layout are already unreachable and cannot be recovered.

---

## Step 10 — Production

Repeat steps 1, 3, 5 and 6 with **separate resources**:

- a **separate Supabase project** (not a second bucket in the staging project),
- a **separate Google OAuth client**, with the production redirect URI,
- a **separate Render service**, on a paid instance so it does not sleep,
- a **fresh `SESSION_SECRET`**.

Separate projects, not shared ones. A shared database means a staging mistake damages real data; a shared OAuth client means a staging redirect URI is trusted in production.

Apply the migrations to the production database with the direct connection string, then deploy.

### Custom domain

If the portal will live at something like `portal.spo.org`:

1. Add the domain in Render and create the DNS record it asks for.
2. Wait for the certificate to be issued.
3. **Add `https://portal.spo.org/api/callback` to the Google OAuth client.** Login is broken on the new domain until this exists.
4. Test sign-in on the custom domain specifically. The app registers its login strategy per hostname, so a working `onrender.com` address proves nothing about the custom one.

---

## Step 11 — Cutover

Only after staging has passed step 8 in full.

1. Agree a window when nobody is using the portal.
2. Tell staff: the address is changing, and they will sign in with their Google Workspace account from now on.
3. Freeze the old portal — stop the Replit deployment so nobody keeps entering data into it.
4. Take the final data dump and restore it into production (step 9).
5. Update DNS if a custom domain is in use.
6. Sign in on production as an admin and spot-check the security items from step 8 — the access-control checks, and one upload and download.
7. Watch the Render logs for the first day.
8. Keep the old environment intact, powered down, for a fortnight. Do not delete anything until the new one has been through a full working week.

### If it goes wrong

Nothing about the migration is one-way as long as the old environment still exists:

- **Login broken for everyone** — check the redirect URI matches the hostname exactly, and that `OIDC_SCOPES` does not contain `offline_access`.
- **One person locked out** — almost always an email mismatch. Compare `users.email` with their Workspace primary address; fix the row and have them sign in again.
- **Everyone lands as a resident** — the emails in `users` do not match the Workspace addresses. Stop, fix the addresses, and remove the duplicate accounts that were created.
- **Files not appearing** — check `STORAGE_DRIVER=supabase` and the service role key.
- **Total failure** — bring the old deployment back up and point DNS back at it. Anything entered on the new system since cutover has to be re-entered, which is why the window should be quiet.

---

## After the move

- **Rotate the secrets that were used during setup** if any were pasted into a chat, a ticket or a shared document — particularly the Supabase service role key.
- **Turn on backups.** Supabase's paid tiers include automated daily backups; confirm they are enabled and note the retention period. A backup nobody has restored is a guess, so restore one into a scratch project once.
- **Decide who holds the accounts.** Supabase, Render and the Google Cloud project should each be owned by an organisation account with more than one administrator, not by an individual's personal login.
- **Keep `.env.example` current.** It is the only complete list of what the app reads, and it is what the next person will follow.
- **Work through the known issues** in `README.md` — particularly the orphaned files left in storage when a photo or document is deleted, and the frontend's missing error boundary.
