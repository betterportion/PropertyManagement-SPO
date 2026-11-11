# Production migration runbook

How to stand the SPO Admin Portal up on permanent infrastructure: **Supabase** for the database and file storage, **Google sign-in** for login, **Render** for hosting.

---

## Read this first

**No external infrastructure has been created.** No Supabase project exists, no Google Cloud OAuth client exists, no Render service exists. Every account and resource below has to be created by a person with the right access. This document is the sequence to follow and the settings to use — nothing here has been done in advance.

**What this is for right now: the two-region pilot** (issue #216 has the launch order). East Central and West Central, each with its regional administrator (RA) and its houses' household leaders and stewards. For the pilot:

- **The production database starts empty.** There is no old data to bring across, so step 9 is skipped and step 12 is a first launch, not a move.
- **Sign-in is by invitation only.** Nobody gets in unless an account is already waiting for their email (step 5). Household leaders sign in with **personal** Google accounts, which is why the Google consent screen is External and no domain restriction is set.
- **The QuickBooks sync and the Google Sheet roster sync stay off.** Their settings are left unset (step 6). Rosters go in by CSV import.
- **Email is optional.** It can be switched on later, once SPO's sending domain is ready (issue #49).
- **Backups and one rehearsed restore come before any real data** (step 11).

**Do staging first.** Every step below is written to be done twice: once against a throwaway staging environment, then again for production. Do not skip staging. The two steps most likely to go wrong — the login provider and the storage bucket — both fail in ways you cannot see until a real person tries to sign in or open a document, and in production that means locked-out staff and unreachable files.

**Do not go live until staging works end to end.** The checklist in step 8 is the bar. If any item fails, fix it in staging.

### What you need before starting

| Access | Needed for | Who typically has it |
|---|---|---|
| A Google account that can create a Google Cloud project, ideally inside SPO's or Better Portion's Google organisation | Creating the OAuth client that everyone signs in with | Better Portion |
| A Google Cloud project | Holding the OAuth client | Better Portion |
| Supabase account | Database and file storage | Whoever will own the infrastructure |
| Render account | Hosting | Whoever will own the infrastructure |
| The GitHub repository | Render deploys from it | — |

Set aside a couple of hours for the staging pass, plus time to invite test accounts (step 8 needs a personal Gmail as well as a staff account).

### A note on cost

Supabase and Render both have free tiers that are fine for staging. For production, expect the paid entry tier of each: a free Render service sleeps when idle, which means the first person to open the portal in the morning waits for a cold start, and a free Supabase project pauses after a week of inactivity. Supabase's automated daily backups also come only with a paid tier, and production needs them (step 11).

---

## Step 1 — Supabase staging project

1. Create a new Supabase project. Name it something clearly temporary, e.g. `spo-portal-staging`.
2. Choose a region close to the users.
3. Save the database password Supabase generates. You cannot retrieve it later.
4. Click **Connect** at the top of the project page, choose the **URI** type, and copy two forms of the connection string from that panel:
   - the **Transaction pooler** string (port 6543) — this is what the running app uses,
   - the **Direct connection** string — this is what migrations use.

   Replace `[YOUR-PASSWORD]` in each with the password from 3. **Use a password of letters and digits only.** A `@`, `:`, `/`, `?` or `#` in it breaks the connection string, and the error ("could not translate host name") does not say why; reset the password in **Project Settings → Database** rather than URL-encoding it by hand.

The pooler keeps the app's connections within Postgres' connection limit, including during a deploy, when the old and new copies of the server briefly run side by side. Migrations use the direct connection because the transaction pooler does not support everything a migration may do.

Keep both. `DATABASE_URL` for the service is the pooled one.

If the direct connection will not connect from your laptop, your network probably has no IPv6, which Supabase's direct address needs (`ENETUNREACH`; WSL2 usually has none). The **Session pooler** string on the same screen (port 5432, host `aws-0-<region>.pooler.supabase.com`) works over IPv4 and is fine for migrations. After a password reset, the poolers can take a minute or two to accept the new password; a `28P01` (password authentication failed) straight after a reset may just mean wait.

5. **Download Supabase's certificate authority.** Supabase signs its database certificates with its own root ("Supabase Root 2021 CA"), which Node does not trust by default, and the app verifies the database certificate. Without the root, every connection fails with `SELF_SIGNED_CERT_IN_CHAIN`, the health check answers 503, and Render never routes to the service (step 6). Download it from **Database → Settings → SSL Configuration** (`prod-ca-2021.crt`) and keep it for steps 4 and 6. It is a public certificate, not a secret. Check it verifies the pooler, with full hostname checking:

   ```bash
   psql "<transaction pooler string>?sslmode=verify-full&sslrootcert=prod-ca-2021.crt" -c 'select 1'
   ```

   That connects. The same command with `sslrootcert=system` fails with `certificate verify failed`, which is the failure the app hits without the file.

---

## Step 2 — Create the schema

From a checkout of this repository, with `DATABASE_URL` set to the **direct** connection string:

```bash
npm ci
DATABASE_URL="postgresql://...direct..." npm run db:migrate
```

That applies every file in `migrations/` in order (forty-nine of them, `0000` through `0048_feedback_reports`) and records them in the `drizzle.__drizzle_migrations` table.

Verify:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

You should see fifty tables — `asset_photos`, `assets`, `audit_log`, `billing_records`, `contact_notes`, `deposit_deductions`, `deposit_return_rules`, `email_log`, `feedback_reports`, `invitations`, `invoices`, `maintenance_contacts`, `maintenance_request_bids`, `maintenance_request_comments`, `maintenance_request_photos`, `maintenance_requests`, `maintenance_schedules`, `move_out_checklists`, `move_out_photos`, `properties`, `property_budgets`, `property_facts`, `property_quickbooks_links`, `property_setup_items`, `property_spend`, `quickbooks_integration`, `region_contacts`, `rent_payments`, `repair_budgets`, `request_closeout_contacts`, `request_closeouts`, `request_contacts`, `resident_documents`, `resident_sheet_links`, `residents`, `resource_links`, `roster_review_items`, `roster_sync_runs`, `security_deposits`, `sessions`, `tasks`, `uploads`, `user_permissions`, `users`, `walkthrough_items`, `walkthrough_photos`, `walkthrough_rooms`, `walkthrough_template_items`, `walkthrough_template_rooms`, `walkthroughs`. The QuickBooks and roster-sheet tables are created even though both syncs stay off; empty, they do nothing. `select count(*) from drizzle.__drizzle_migrations;` should say 49.

> **`sessions` must be in that list.** The app does not create it at startup — the session store is deliberately configured not to — so if the migrations did not run, logging in fails rather than silently starting a fresh store.

**Do not use `npm run db:push` against staging or production.** It pushes the schema with no migration record, so the next `db:migrate` sees an empty history against a full database and tries to create everything again.

**Do not run `npm run db:seed` against production.** It fills an empty database with made-up demo houses, residents and requests. It is fine on staging if you want something to click through, but then staging no longer starts empty the way production will, and it refuses to run once any house exists.

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

The middle row was the old Replit database: it had the `uploads` table (`0001`) and no longer had `monday_item_id` (`0002`), so it baselined through `0002_drop_monday_item_id` and then migrated. Yours will name a different tag — there are forty-nine migrations now, through `0048_feedback_reports`.

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

The server also checks this for you. At startup with `STORAGE_DRIVER=supabase` it asks Supabase whether the bucket is public, and **refuses to start** (the deploy fails and the previous version keeps serving) if the answer is yes. If Supabase cannot be reached or does not answer within 5 seconds, the server starts anyway and logs `Could not confirm the "uploads" storage bucket is private`; treat that line as a reason to check the bucket by hand (step 7's `curl` test), because the check only stops a bucket it can see is public.

The app never relies on bucket-level access rules. It checks permissions itself and then issues a short-lived signed link, which is why the bucket can stay locked down.

Then collect two values from **Project Settings → API**:

- the **Project URL** (`https://<ref>.supabase.co`) → `SUPABASE_URL`
- the **`service_role` key** → `SUPABASE_SERVICE_ROLE_KEY`. Use the **legacy** `service_role` key (a long string starting `eyJ`, under the legacy API keys); the app sends it as a bearer token, which is how that kind of key works. The newer `sb_secret_...` keys have not been tried with the portal.

The service role key bypasses every access rule in the project. It is a server-only secret: it goes in Render's environment, never in a client bundle, never in the repository, never in a chat message. If it is ever exposed, rotate it in the same dashboard.

---

## Step 4 — Prove uploads work before going further

You need to be able to sign in for this, so it comes after step 5 in practice. Either run it on the staging service once step 7 passes, or locally, pointed at staging:

```bash
export DATABASE_URL="postgresql://...pooled..."
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export STORAGE_DRIVER=supabase
export SUPABASE_URL="https://<ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="..."
export SUPABASE_STORAGE_BUCKET=uploads
export NODE_EXTRA_CA_CERTS="$PWD/prod-ca-2021.crt"   # Supabase's root, step 1
# plus the OIDC_* values from step 5
npm run dev
```

Locally, the staging OAuth client needs `http://localhost:5000/api/callback` as an extra redirect URI, and your admin account must already exist (end of step 5). Remove the localhost URI from the client afterwards.

Sign in as that admin, then:

1. Upload a photo to a maintenance request. It should appear.
2. Check **Storage → uploads** in Supabase — a new object with a long random name should be there.
3. Check the database: `select * from uploads order by created_at desc limit 5;` — a matching row.
4. Reload the page. The photo should still display, via a signed URL.
5. Copy the signed URL, wait for it to expire, and open it in a private window. It should be refused.

If a file lands on disk instead of in Supabase, `STORAGE_DRIVER` is not set to `supabase`. Getting this wrong is quiet — the app works perfectly until the host replaces the container and every uploaded file vanishes with it.

---

## Step 5 — Google sign-in

This is the step with the most moving parts.

### What Better Portion must configure

**In Google Cloud Console**, in the project that will hold the sign-in client:

1. **APIs & Services → OAuth consent screen**
   - **User type: External.** Household leaders and stewards sign in with personal Google accounts (Gmail, or a university address made into a Google account), and Internal would turn every one of them away. External lets any Google account *reach* the portal; the portal itself then refuses anyone it has not invited (below), before any account is created.
   - **Publishing status: In production.** Left on "Testing", only the test users listed on the consent screen can sign in. With only the three basic scopes below, Google does not require the app to go through its verification review.
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
   - Authorised JavaScript origins: the portal does not use them, but Google's form may refuse to create the client without one. If it does, add `https://<your-staging-host>` (no path, no trailing slash); it widens nothing.

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
| `OIDC_ALLOWED_DOMAINS` | **Leave unset** |

**Leave `OIDC_ALLOWED_DOMAINS` unset for this deployment.** When set, it refuses any sign-in whose Google hosted-domain (`hd`) claim is not one of the listed domains — and personal Google accounts carry no `hd` claim at all, so it would lock out every household leader. It exists for a deployment where only staff on a Google Workspace domain sign in. Here, invite-only sign-in (below) is what keeps strangers out.

**`OIDC_SCOPES` can be left unset**: the default is already `openid email profile`. Setting it to exactly that does no harm. **Never add `offline_access`** — Google rejects that scope, login fails with `invalid_scope`, and nobody gets in.

The consequence, which is worth stating plainly to whoever supports the portal and to the pilot RAs: **on Google, a session ends after about an hour, and people sign in again.** Without `offline_access` Google issues no refresh token, so the portal cannot renew a session in the background; when Google's one-hour token expires, the next action asks them to sign in. Signing in again is a click or two — the browser is usually still signed in to Google — but it is not invisible, and a half-written form can be lost.

No code changes. `server/auth.ts` reads all of this from the environment.

### Who can sign in

The portal is **invite-only** (`recordSignIn` in `server/auth.ts`). A sign-in gets in only to an account that is already waiting for its email address (capital letters aside). Anyone else lands back on the sign-in page with: *"That Google account hasn't been given access. The portal is by invitation: ask your regional administrator to give you access using the email address you sign in with."* Nothing is written for a refused sign-in. Google must also mark the address as verified, or the sign-in is refused with a different message.

Accounts are waiting for people because somebody made them:

- **The first admin** — by SQL, once, below.
- **Staff** (admins and RAs) — an admin creates them in **Settings**, then sets their permissions and regions.
- **Household leaders and stewards** — their RA opens the resident's page and uses **Portal access → Give portal access**, which uses the email on the roster. At most **4** switched-on household logins per house. The RA needs the "manage properties" permission for that house's region.

The email has to be the exact address the person signs in to Google with. If someone is turned away, compare the two; an alias or a different Gmail will not match.

**When someone leaves the house, their login switches off by itself** (`server/householdLogins.ts`). As soon as no current roster row at the house carries their email — they are moved out, marked inactive or removed, or their stop date passes — the portal switches the login off and unlinks it from the house, which frees one of the house's 4 places. It runs straight after the roster change, and in the daily run for a stop date that simply passes. If they come back, their RA gives access again. `docs/WORKFLOWS.md` ("Household logins end with the stay") has the detail.

### First sign-in on a fresh database

On a fresh database nobody is waiting, so create your own admin account by hand, once, **before** you first sign in. Using the direct connection (Supabase's SQL editor works too):

```sql
insert into users (email, role, is_active) values ('you@spo.org', 'admin', true);
```

Use the address you will sign in to Google with. Your first sign-in attaches to that row (the portal re-links an account by its email the first time a new Google identity signs in with it). From then on, everything else is done in the app.

---

## Step 6 — Render staging service

**New → Web Service**, connected to the GitHub repository.

| Setting | Value |
|---|---|
| Environment | Node |
| Node version | 20 (set `NODE_VERSION=20` if Render picks another) |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm run start` |
| Health check path | `/api/health` |
| Instance type | Free is fine for staging; use a paid instance for production |
| Instance count | **1.** No autoscaling |

The health check endpoint returns 200 only when the process is serving **and** the database answers, so Render will not route traffic to an instance that cannot reach Supabase.

`PORT` is supplied by Render — do not set it yourself. The server reads it and listens on `0.0.0.0`.

**`--include=dev` in the build command is needed** because `NODE_ENV=production` is set below, and with it set, a plain `npm ci` skips the build tools (Vite, esbuild) and the build fails.

### Run exactly one instance

The portal's six daily jobs — audit-log retention, preventive maintenance requests, seasonal reminder tasks (which also creates move-out reminders), the QuickBooks sync, the roster-sheet sync and the invitation sender — run **inside the web server**. There is no separate worker and no cron (`docs/WORKFLOWS.md` lists each one). Each runs once when the server starts and then every 24 hours from that moment, not at a fixed time of day, so a redeploy restarts the clock.

So keep the service at **one instance**. A second instance would run every job twice, and the guards that stop two syncs overlapping, the limit on uploads in progress, and the lock that keeps a house at four logins (`server/houseLock.ts`), only hold within one process. The jobs are written so that running twice changes nothing, which is what makes the brief overlap during a deploy safe — but that is a safety net, not a way to run two copies.

**Time zone:** leave `TZ` unset. Render runs in UTC, and the portal's own date rules (due dates, move-out reminders, "today") are all worked out in UTC whatever `TZ` says, so setting it would only change the times printed in the log. Bear in mind that a UTC day starts in the evening in Ohio and Kansas (between 6 and 8pm local time, depending on the state and daylight saving).

### Environment variables

Set these in **Environment** on the service:

```
NODE_ENV              = production
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
APP_URL               = https://<this service's hostname>
NODE_EXTRA_CA_CERTS   = /etc/secrets/supabase-ca.crt
```

**And one secret file**, added on the service's **Environment** page (it is easy to miss below the variables; check it is listed before deploying): name `supabase-ca.crt`, contents the whole of Supabase's root certificate from step 1, `BEGIN` line to `END` line. Render serves secret files at `/etc/secrets/<name>`, which is what `NODE_EXTRA_CA_CERTS` points at. Without the file, Node logs `Warning: Ignoring extra certs from /etc/secrets/supabase-ca.crt, load failed` and carries on with its default certificate list, so the server starts, every health check answers 503 with `SELF_SIGNED_CERT_IN_CHAIN`, and after about 15 minutes Render marks the deploy `update_failed`, having never sent it a request. Leave `DATABASE_SSL` unset: its default is to verify the certificate, which is what the root makes possible. (`DATABASE_SSL=no-verify` would also get the service up, encrypted but without checking it is talking to Supabase; it is the fallback, not the setup.)

`npm run start` already sets `NODE_ENV=production`; setting it on the service as well makes sure nothing run on the instance (a Render shell, say) falls back to development behaviour. Production mode is what turns on secure cookies, HSTS and the content security policy, which step 8 checks.

**Deliberately left unset for the pilot:**

| Variables | What they switch on | For the pilot |
|---|---|---|
| `OIDC_ALLOWED_DOMAINS` | Limit sign-in to Google Workspace domains | **Unset.** It would refuse every household leader's personal account (step 5) |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`, `QUICKBOOKS_REDIRECT_URI`, `QUICKBOOKS_TOKEN_KEY` (+ optional `QUICKBOOKS_ENVIRONMENT`) | The daily QuickBooks repair & maintenance spend sync | **Unset.** Off for the pilot; house pages say "Spending not connected yet" |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `RESIDENT_SHEET_ID`, `RESIDENT_SHEET_TAB` | The daily sync from SPO's master resident Google Sheet | **Unset.** Off for the pilot; rosters go in by CSV |
| `RESEND_API_KEY`, `EMAIL_FROM` (+ optional `EMAIL_REPLY_TO`) | Outbound email | Unset until SPO's sending domain is ready (issue #49) |

Each group is **all or nothing**: none of it set leaves that feature off and the server runs normally; some but not all of it stops the server at boot, on purpose, so a half-configured feature can never fail silently. The setup for each, when its time comes, is in `docs/WORKFLOWS.md`.

- **Rosters for the pilot** go in by CSV: a house's roster through **Import from spreadsheet** on the Residents page, or a file with the master sheet's columns through **Settings → Resident roster sheet → Import a CSV instead** (**Preview file**, then **Apply file**). Both show what they would do first and write nothing until you confirm. (Even once the sheet variables are set later, the daily sheet sync does nothing until an admin has pressed **Sync now** once.)
- **Email off** means the portal sends nothing and carries on normally. **Settings → Email health** says email isn't set up, and counts the messages it would have sent. When email is switched on, send yourself the test email from that panel.

`APP_URL` is the address people open the portal at. Comment emails use it for their "open this request" link (leave it unset and they go out without one). It must be an `https://` address when set; change it if the portal moves to a custom domain.

`.env.example` documents every one of these, and the optional tuning variables (`DATABASE_SSL`, `DATABASE_POOL_MAX`, `MAX_UPLOAD_BYTES_IN_FLIGHT`).

**Generate a different `SESSION_SECRET` for staging and production.** Sharing one means a staging session cookie is valid in production.

If anything required is missing the service will fail to start and the log will name **every** missing variable at once — that message is the fastest way to find a typo.

### Point Google at the real hostname

Render assigns the hostname only after the service is created. Go back to the Google OAuth client and make sure the authorised redirect URI matches it exactly, including `/api/callback`, and set `APP_URL` to the same `https://` address.

### Migrations on deploy

Render does not run migrations for you, and this project does not run them at startup — a schema change applied by a server as it boots, possibly while the previous copy is still running, is a good way to corrupt a database. Apply migrations deliberately:

```bash
DATABASE_URL="<direct connection string>" npm run db:migrate
```

Render's shell on a paid instance can run it, or run it from a laptop with the direct connection string.

**The order, every time a change adds a file to `migrations/`:**

1. On production, take the safety copy first (next heading).
2. Run `db:migrate`.
3. Only then let the new code deploy.

`scripts/deploy-production.sh` runs these three in order from a clean checkout of GitHub's `main`, and stops at the first that fails: it shows the Supabase project, the commit and the number of pending migrations, asks you to type the project ref, takes and checks the safety copy (into `~/spo-backups`), runs `db:migrate`, then calls the service's **Deploy Hook** (Render → service → Settings) and waits for the new version to answer `/api/health`. With nothing to migrate it skips straight to the deploy. It reads `~/.config/spo/prod-db-session-url` (the shared session pooler string), `~/.config/spo/prod-deploy-hook` and `~/.config/spo/supabase-ca.crt`; the hook URL is a secret, since anyone holding it can deploy. Its `pg_dump` must be at least the database's major version: Supabase runs Postgres 17, and Ubuntu 24.04's default client is 16, so install `postgresql-client-17` first.

**Migrate before the code, never after.** Code that expects a new column or index fails against a database that does not have it yet. The example that caught us: migration `0042_request_contact_unique_link` adds a unique index, and the new "link a contractor to a request" code relies on that index (`onConflictDoNothing` on `request_contacts`). Deploy the code first and every link-contact call answers 500 until someone runs the migration (#264, #282). Running the migration first is safe for the code that is still live, because these migrations only add things (inference: a migration that drops or renames a column would break the old code during the gap, so a pull request with one needs a developer's plan for the order).

#### Safety copy before every production `db:migrate`

A migration that fails halfway rolls itself back and leaves the database as it was. One that finishes but does the wrong thing cannot be undone from inside the portal, so take a copy of the database first, **every time, however small the migration looks**. This is the same dump as in step 11's rehearsal, with the date in the file name:

```bash
pg_dump --no-owner --no-acl --schema=public --schema=drizzle \
  "<production direct connection string>" > spo-pre-migrate-YYYY-MM-DD.sql
```

Replace `YYYY-MM-DD` with today's date (add `-2` if it is the second one that day). Then check it before going on: the file should not be zero bytes (`ls -lh spo-pre-migrate-*.sql`; it was 139K before launch, and grows with the data), and its last lines should say `PostgreSQL database dump complete` (`tail -n 10 spo-pre-migrate-YYYY-MM-DD.sql`; `pg_dump` 17.6 and later put a `\unrestrict` line after it, so it is not the very last line). If `pg_dump` stops with a message that its version is older than the server's, install a newer `pg_dump` rather than carrying on without a copy. A dump from those versions starts with a `\restrict` line, so load it with a `psql` at least as new (17.6 or later), which understands that line.

The file holds every resident's name and email and the finance rows. Keep it somewhere private, not in the repository or a chat, and delete it once the migration has been live and fine for a week. Run the dump immediately before the migration: whatever is entered between the dump and the migration is lost if you restore from it.

#### Auto-deploy: on for both, and production's build refuses a pending migration

- **Production auto-deploys every commit to `main`, and its build is the check** (`docs/adr/0003-production-auto-deploys-behind-a-migration-check.md`). The service's build command is:

  ```bash
  npm ci --include=dev && npm run db:check-pending && npm run lint && npm run check && env -u DATABASE_URL npm test && npm run build
  ```

  Any failing step fails the build, Render does not deploy it, and the version already live keeps serving. `db:check-pending` (`scripts/check-pending-migrations.ts`) fails while production has a migration this commit brings and the database lacks, so a change that adds a migration file merges but does not ship: run `scripts/deploy-production.sh`, which takes the safety copy, migrates and calls the deploy hook, and that hook's build then passes. Every later commit fails the same way until you do. `env -u DATABASE_URL` is load-bearing: two integration tests fall back to `DATABASE_URL`, and the build has production's, so without it `npm test` would run them against production.
- **A failed build is only noticed through Render's failure notification** (the service's `notifyOnFail`, currently Render's default). Nothing in the portal shows it.
- **Staging** auto-deploys from `main` (reported in issue #273; not checked in Render). That is fine there, because nobody's real data is at risk, but it means staging can run new code before its migration. Run `db:migrate` against staging **before merging** a change that adds a migration file, or accept a few minutes of errors on staging.

#### Going back after a bad deploy

Migrations only go forward: there are no "down" files, so nothing undoes one.

- **No migration ran since the earlier deploy:** rolling the service back to that earlier deploy in Render is safe. (The deploys list on the service is where an earlier deploy is chosen; exact button wording not checked.)
- **A migration ran since then:** do **not** roll the code back on its own. The old code meets a database it was not written for. The way back is the safety copy taken just before that migration, restored as a whole database, which **loses everything entered since the copy was taken**. Follow "Restoring production for real" in step 11. Its second step uses Supabase's daily backup; the safety copy is a plain SQL file, loaded the way step 11's rehearsal step 1 loads it, into an empty database. Loading it over the live production database means emptying the `public` and `drizzle` schemas first, which this runbook has not rehearsed, so ask a developer to do it with you.
- If the fix is small, a new migration and a new deploy going forward is usually better than either.

---

## Step 7 — Confirm the configuration matches

Before testing, check the running service reports itself healthy:

```bash
curl https://<staging-host>/api/health
```

Expect `200` and `{"status":"ok","database":"ok",...}`. A `503` here means the app is up but Supabase is not answering — check the service log for the reason: `SELF_SIGNED_CERT_IN_CHAIN` means the `supabase-ca.crt` secret file or `NODE_EXTRA_CA_CERTS` is missing (step 6); anything else, check `DATABASE_URL` and that you used the pooled string. If the request hangs instead of answering, Render has no healthy instance to send it to, which is the same 503 seen from outside: read the log.

Then check the security headers and the session cookie:

```bash
curl -sI https://<staging-host>/            # the page itself
curl -s -D - -o /dev/null https://<staging-host>/api/login   # starts a sign-in, so it sets a cookie
                                                     # (a GET: `curl -I` sends HEAD, which this route answers with 401)
```

- [ ] The page response has `Strict-Transport-Security: max-age=15552000; includeSubDomains` and a `Content-Security-Policy` header that includes `frame-ancestors 'none'`. Neither is sent outside production mode, so a missing one means `NODE_ENV` is not `production`.
- [ ] The `/api/login` response is a redirect to `accounts.google.com`, and its `Set-Cookie: connect.sid=...` line includes `HttpOnly`, `Secure` and `SameSite=Lax`.

And confirm the bucket is private from outside. Take the storage key of any uploaded file (the part after `/uploads/` in the portal's link, or a name from **Storage → uploads**) and ask Supabase for it as a public file:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://<ref>.supabase.co/storage/v1/object/public/uploads/<key>
```

- [ ] It is refused (a 400 or 404), not `200`. A `200` means the bucket is public: switch it to private at once (step 3). The server's own startup check should already have refused to boot on a public bucket, so a `200` here also means that check did not run or could not reach Supabase; look for its warning in the logs.

---

## Step 8 — Test staging properly

This is the bar for going live. Work through it with at least four Google accounts, mirroring the pilot:

- **an admin** (the one inserted by SQL in step 5),
- **a non-admin RA**, created by the admin in Settings, with the property and maintenance permissions and one region,
- **a household leader on a personal Gmail**, given access by that RA from a resident's page on one of the RA's houses,
- **an uninvited personal Gmail** that nobody has added.

**Login**
- [ ] Sign in as the admin. You land in the portal, not on an error.
- [ ] The correct name and email appear in the sidebar.
- [ ] Sign out, then sign in again.
- [ ] Sign in as the RA. Only their region's houses show, and Settings (admins only) shows an access-denied message.
- [ ] As the RA, import a small roster for one house by CSV (Preview, then Apply), open a resident and use **Portal access → Give portal access**.
- [ ] Sign in as that leader on their personal Gmail. They see the resident pages for their own house only: its requests, its walkthroughs and the resource hub, with no admin navigation.
- [ ] Sign in with the **uninvited** Gmail. It is turned back to the sign-in page with "That Google account hasn't been given access. The portal is by invitation…", and `select count(*) from users where email = '<that address>';` is still 0.
- [ ] Give portal access to a fifth person at the same house after four are switched on. It is refused.
- [ ] Move the leader out (Move out takes only today's date or earlier). Their login is switched off: their next action is refused, Settings shows the account as inactive, and the house has a free place again.
- [ ] Leave a session alone for a little over an hour, then click something. You are asked to sign in again, and signing in returns you to the portal (step 5 explains why).

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
- [ ] Create a maintenance request; move it through its statuses, including cancelling one. (There is no delete in the app: requests are kept, and cancelling is how one is withdrawn.)
- [ ] Complete a walkthrough with photos.
- [ ] Add an asset with a photo.
- [ ] Add a vendor contact and a billing record.
- [ ] Create a user, set their permissions and regions, deactivate them.

**Audit log** — confirms the record of who did what is actually being written:
```sql
select created_at, actor_email, action, summary
from audit_log order by created_at desc limit 20;
```
- [ ] The role change, deactivation, portal-access grant, billing record and document actions from above are all listed with the right actor.

**Operational**
- [ ] `/api/health` returns 200.
- [ ] Render shows exactly one instance.
- [ ] Restart the service in Render; it comes back without manual intervention.
- [ ] Sessions survive that restart (they live in Postgres, not in memory).
- [ ] The Render logs contain no stack traces during normal use.
- [ ] **Settings → Email health** says email isn't set up (or, if email is on, the test email from that panel arrives).
- [ ] Settings → QuickBooks and Settings → Resident roster sheet both say they are not set up.

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

Repeat steps 1, 2, 3, 5 and 6 with **separate resources**:

- a **separate Supabase project** (not a second bucket in the staging project), on a **paid tier** so it has daily backups and does not pause,
- a **separate Google OAuth client**, with the production redirect URI (External, In production, exactly as in step 5),
- a **separate Render service**, on a paid instance so it does not sleep, still at **one instance**,
- a **fresh `SESSION_SECRET`**,
- **auto-deploy on, with the gated build command** on that Render service (see "Auto-deploy" under step 6's "Migrations on deploy").

Separate projects, not shared ones. A shared database means a staging mistake damages real data; a shared OAuth client means a staging redirect URI is trusted in production.

Apply the migrations to the empty production database with the direct connection string (`npm run db:migrate`; never `db:seed`), insert the first admin (end of step 5), then deploy. Run the step 7 checks against the production hostname.

### Custom domain

If the portal will live at something like `portal.spo.org`:

1. Add the domain in Render and create the DNS record it asks for.
2. Wait for the certificate to be issued.
3. **Add `https://portal.spo.org/api/callback` to the Google OAuth client.** Login is broken on the new domain until this exists.
4. **Change `APP_URL` to `https://portal.spo.org`**, so email links point at the address people use. (Once QuickBooks is switched on after the pilot, `QUICKBOOKS_REDIRECT_URI` and the Intuit app's redirect URI change to the new domain too.)
5. Test sign-in on the custom domain specifically. The app registers its login strategy per hostname, so a working `onrender.com` address proves nothing about the custom one.

---

## Step 11 — Backups and one rehearsed restore

**Do this before any real data goes into production** (issue #212). Deletes in the portal are permanent: a deleted record's rows are gone, and its photos and documents are removed from the bucket. And **Supabase's database backups do not include Storage files**, so the database and the bucket each need their own backup.

### Database

- [x] The production Supabase project is on a **paid tier**, and **Database → Backups** shows daily backups. Write the retention period here: **7 days** (Pro plan, Betterportion organisation, confirmed 2026-10-27). A mistake noticed later than that cannot be undone from these backups.

### Uploaded files

- [x] A **nightly copy of the private `uploads` bucket** to Backblaze B2, outside Supabase altogether (first production copy 2026-11-06; the object count and total bytes matched the bucket).

  - **What runs it:** a Render cron job, `spo-uploads-backup`, in the Better Portion workspace, from the stock image `docker.io/rclone/rclone:1.75.2`. There is no code for it in this repository. Schedule `0 8 * * *`.
  - **Where it goes:** the private B2 bucket `spo-uploads-backup-pm`, under `uploads/`, with default encryption on, all file versions kept and Object Lock off.
  - **Docker Command**, entered with no quotes round the commands, because Render keeps them as literal characters and the run fails with `not found`:

    ```bash
    /bin/sh -c rclone copy PROD:uploads BACKUP:spo-uploads-backup-pm/uploads --size-only --immutable --log-level INFO && wget -q -O /dev/null "$HEARTBEAT_URL"
    ```

  - **`PROD` and `BACKUP` are rclone remotes defined by the job's environment variables**, not a config file: `RCLONE_CONFIG_PROD_*` (`TYPE=s3`, `PROVIDER=Other`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `ENDPOINT`, `REGION`, `FORCE_PATH_STYLE=true`) and `RCLONE_CONFIG_BACKUP_*` (`TYPE=b2`, `ACCOUNT`, `KEY`). To run any rclone command below from a terminal, set the same variables there, and a third set, `RCLONE_CONFIG_SCRATCH_*`, for a scratch project.
  - **Use `copy`, not `sync`:** a sync would delete from the backup whatever was deleted in the portal, which is exactly the mistake the backup is there to undo.
  - **Keep `--size-only`.** Backblaze rounds a copied file's time up to a whole second, and the two stores share no checksum, so without it rclone sees most files as changed. `--immutable` then fails the run. Size alone is enough because storage keys are random and a stored file is never rewritten.
  - **The two keys are not equally powerful.** Supabase S3 keys cannot be limited: the job's key (`pm-nightly-backup`) can delete live files, so it lives only in the job's variables, like the service role key. The Backblaze key is limited to this bucket with `listBuckets,listFiles,readFiles,writeFiles`, and a permanent delete with it was refused with a 401. It can still hide a file, which is why all versions are kept. The Backblaze console has no option for this set of permissions, so it is made with `b2 key create` and the master key.

- [x] **Who gets told if it fails:** a healthchecks.io check, pinged only after a run succeeds, with a 1-day period and 2 hours' grace. It emails the addresses on the check when a ping is missed, so a job that stops running raises the alarm as well as one that fails. The ping URL is a secret, since anyone holding it can report the backup as successful.
- [ ] **Prove the alert:** suspend the job for a night, confirm the email arrives at both addresses, and resume it.

The backup never removes anything, so files deleted in the portal stay in it. **No retention period has been decided yet**; Object Lock can be turned on later, but never turned off.

### Rehearse a restore

A backup nobody has restored is a guess. Once, before real data, restore both halves into a **scratch** Supabase project, never into production, and prove the portal can read them. **Rehearsed 2026-11-09** (issue #212): about an hour and a half end to end, most of it waiting for the restore and finding keys. The steps below are as they actually went.

Work in a folder outside the repository (the dump and key lists hold residents' names and emails), and use each project's **Session pooler** string where a connection string is asked for (step 1 explains why). First make sure production has something to check: a walkthrough with a photo and a billing record with a document. Wait for a daily backup and a bucket copy to include them, then:

1. **Database:** in the production project, go to **Database → Backups**, choose **restore to a new project**, pick the newest backup and name the project `spo-restore-scratch`. The new project adds a recurring charge until it is deleted, and the estimate appears before you confirm. Supabase does not copy files or API keys. Check it holds production's data before going on:
   ```bash
   psql "<scratch connection string>" -c "select count(*) from properties;" -c "select max(created_at) from uploads;"
   ```
   The house count should match production, and the newest upload should be no later than the backup. If your plan does not offer the restore, create an empty project and load a dump into it as step 5 does.
2. **Bucket:** in the scratch project, open **Storage**. The restore brings the `uploads` bucket back, because the bucket list is a database table; check it is **private**. If it is missing, create it (step 3).
3. **Files:** create an S3 key in the scratch project (Storage → S3), set the `RCLONE_CONFIG_SCRATCH_*` and `RCLONE_CONFIG_BACKUP_*` variables in your terminal (Uploaded files, above; the Backblaze values are on the `spo-uploads-backup` job's Environment page in Render), and copy the backup in:
   ```bash
   rclone copy BACKUP:spo-uploads-backup-pm/uploads SCRATCH:uploads --no-check-dest --log-level INFO
   ```
   **The restored bucket lists every file but holds none of them.** The file list is in the database too, so before the copy `rclone size SCRATCH:uploads` showed the same count and bytes as the backup, while `rclone cat` on any of them failed with `object not found`. `--no-check-dest` copies every file without trusting that list; without it rclone would skip them all as already there. Check the endpoint (`echo "$RCLONE_CONFIG_SCRATCH_ENDPOINT"`) names the scratch project's ref before copying, since a production key and endpoint here would write into live storage.
4. **Check it**, two ways, because rclone's listing of the scratch bucket is that same list and cannot prove the files are there:
   - **Every file the database names is in the backup.** This should print nothing, apart from anything uploaded since the last bucket copy:
     ```bash
     psql "<scratch connection string>" -X -A -t -c "select storage_key from uploads;" | LC_ALL=C sort > db-keys.txt
     rclone lsf BACKUP:spo-uploads-backup-pm/uploads | LC_ALL=C sort > backup-keys.txt
     wc -l db-keys.txt backup-keys.txt
     comm -23 db-keys.txt backup-keys.txt
     ```
   - **The portal can read them.** Run it locally against the scratch project: step 4's variables, with the scratch database, URL and legacy `service_role` key, and `NODE_EXTRA_CA_CERTS` pointing at the certificate from the scratch project's Database → Settings → SSL Configuration. The staging OAuth client needs the localhost redirect URI (step 4), and the restored accounts are what you sign in with. Sign in, open a walkthrough with photos and a billing record with a document (Contacts → Invoices), and confirm both display. In the browser's network panel, check the file requests redirect to the **scratch** project's host: with the production URL or key set by mistake they would display just the same, and the check would prove nothing.

   **Leave `RESEND_API_KEY`, `EMAIL_FROM`, `QUICKBOOKS_CLIENT_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` and `RESIDENT_SHEET_ID` unset in the local settings.** The scratch database is a copy of production, invitation queue included, and the daily jobs run as soon as the portal starts. In the rehearsal the invitation job tried two queued invitations within a second of starting (`email not configured; skipped the "invitation" email`); with a mail key set, those were two emails to real people.
5. **Rehearse the safety copy too.** Take the pre-migrate dump from "Migrations on deploy" on production, with its file name, and load it into an **empty** project. It cannot go into the first scratch project, which already has every table; deleting that one first and creating a fresh one is fine, since steps 1 to 4 are done. Check the target is empty, then load it:
   ```bash
   psql "<empty project connection string>" -c "select count(*) from information_schema.tables where table_schema='public';"   # must be 0
   psql "<empty project connection string>" < spo-pre-migrate-YYYY-MM-DD.sql > load-out.txt 2> load-errors.txt
   cat load-errors.txt
   ```
   Expect exactly one error, `schema "public" already exists`, because every new project has that schema; any other line is a real problem. (So `psql -v ON_ERROR_STOP=1` cannot be used with this dump: it would stop on that line.) Then run the portal against it with `STORAGE_DRIVER` left at `local`, since this checks the database only, sign in and confirm the houses are there. In the rehearsal the dump took 20 seconds and the load 49.
6. Write down the date, how long it took, and anything that did not go as written, and correct this section to match. Then revoke the scratch S3 key, delete the scratch projects, remove the localhost redirect URI from the staging OAuth client, and delete the working folder (dump, `db-keys.txt`, `backup-keys.txt`, load logs). Delete from production only test records you created for the rehearsal.

### Restoring production for real

1. Tell staff the portal is down, and stop the Render service so nothing is written mid-restore.
2. Restore the database from **Database → Backups** (this replaces the current database with the backup; anything entered since that backup is lost and has to be re-entered).
3. Copy the bucket backup back into the `uploads` bucket with `rclone copy BACKUP:spo-uploads-backup-pm/uploads PROD:uploads --size-only`. With `--size-only` it only adds what is missing; every storage key is unique, so nothing current is overwritten. Files uploaded after the last bucket copy cannot come back. If a restored file is still missing afterwards, the restored database listed it and rclone skipped it: run the copy again with `--no-check-dest` in place of `--size-only`.
4. Start the service, run the step 7 checks, and open a few recent photos and documents.

- [x] **Who restores, and how they are reached:** **Matthew Kukla** (Better Portion) restores; a Better Portion email address will be added here once issued. **Second person: JR**, jr@betterportion.org. Approved by JR, 2026-11-10 (issue #212).

### Restore one record (a resident deleted by mistake)

Use this when somebody deleted one resident and everything else in the portal is fine. The whole-database restore above would bring the resident back but throw away every other change made since the backup, so do not use it for this. This section is about a **resident**; a deleted maintenance request, walkthrough or invoice works the same way with its own tables, but the table list below is only for residents.

**Rehearsed 2026-11-11** (issue #212): a test resident with an HH fee, a deposit with a deduction, HH Paperwork, a stop date and a move-out photo was deleted in the portal and brought back whole, photo included. About an hour end to end, most of it waiting for Supabase to restore the scratch project. Two things went wrong and the steps below now guard against both: the first scratch copy was trimmed with the wrong id and lost the resident too (it had to be restored again), and after the load the portal answered every page with "Something went wrong" until the stale database connections were ended (step 5).

**What a resident delete takes with it.** Deleting a resident removes, in the same moment, these rows (all are tied to the resident in `shared/schema.ts` with `onDelete: "cascade"`): `resident_sheet_links`, `move_out_checklists`, `move_out_photos`, `rent_payments` (shown as "HH fees"), `security_deposits`, `deposit_deductions` and `resident_documents` (the HH Paperwork checklist). Also, the files in the move-out photos are removed from the bucket and their `uploads` rows deleted (`server/uploadCleanup.ts`), so the database rows and the files are restored separately. None of those seven tables points at another (only at `residents` and `users`), so once the `residents` row is back they can load in any order. The `residents` row must be loaded first; `pg_dump` writes it first, and step 4 checks that.

**What this does not bring back:**
- Anything about this resident entered after the backup you restore from. Pick the newest backup from before the deletion.
- The link from an asset to this resident (`assets.assigned_resident_id`) and from a roster review item (`roster_review_items.resident_id`). The database sets these to empty when a resident is deleted. Re-pick the resident on the asset if it mattered.
- The resident's portal login, if they had one. It was probably switched off when they left the roster; ask their RA to give portal access again.
- An audit trail entry for the restore. This is done in the database directly, so write the date and what you restored in your own notes. The original `resident.deleted` entry stays in the activity trail.

**Before you start.** Work out the resident's name and house, and check the daily resident sheet sync has not already added them back as a new row (look at the house's roster). If it has, stop and ask a developer: restoring would create a second copy. (This is inference from how the sync works; it has not been tried.)

**Set up the terminal.** Work in a folder outside the repository: the dump and key list hold a resident's name, email and finance rows, and `.gitignore` does not cover them, so one `git add .` inside the repository would publish them. Put both connection strings in variables, so neither is pasted by hand again. Use each project's **Session pooler** string (the project's **Connect** button), not the direct one, which did not connect in the 2026-11-09 rehearsal:
```bash
mkdir -p ~/spo-restore-YYYY-MM-DD && cd ~/spo-restore-YYYY-MM-DD
export SCRATCH_DB='<scratch Session pooler string>'
export PROD_DB='<production Session pooler string>'
```
Mixing them up is the one dangerous mistake here, because step 3 deletes rows. **Step 3 must only ever be run against `$SCRATCH_DB`.** Read the line twice before pressing Enter. Everything below runs on your own computer; nothing needs a shell on the Render service.

1. **Restore a backup from before the deletion into a new scratch project**, as in "Rehearse a restore" steps 1 and 2 above (restore to a new project named `spo-restore-scratch`, check its bucket is private). Skip step 3 there: this restore never reads files from scratch, step 6 copies them from the bucket backup straight into production. If an earlier scratch project still exists, delete it and start again, so it holds the right day's backup.

2. **Find the resident's id** in the scratch database and keep it in a variable. Change the last name:
   ```bash
   psql "$SCRATCH_DB" -c "select id, first_name, last_name, email, property_id from residents where last_name ilike 'Smith%';"
   RID='<the id of the right person>'
   psql "$SCRATCH_DB" -c "select first_name, last_name from residents where id = '$RID';"
   ```
   The last command must print that person. If it prints nothing, `RID` is wrong; do not go on, because step 3 would then delete everybody, this resident included, and the scratch project would have to be restored again. If the resident is not in the scratch copy at all, the backup is from before they were added or after they were deleted; pick another.

3. **In `$SCRATCH_DB` only,** remove everybody else, so what is left is just this resident. Deleting the other residents also removes their fees, deposits and paperwork from the scratch copy (the same cascade), and the second command keeps only the files this resident's move-out photos use. Then check what is left:
   ```bash
   psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -c "delete from residents where id <> '$RID';"
   psql "$SCRATCH_DB" -v ON_ERROR_STOP=1 -c "delete from uploads where storage_key not in (select substr(image_url, 10) from move_out_photos);"
   psql "$SCRATCH_DB" -c "select count(*) from residents;" -c "select count(*) from move_out_photos;" -c "select count(*) from uploads;"
   ```
   The resident count must be 1, and the photo and upload counts match the resident's move-out photos (1 each in the rehearsal). All 0 means the resident was deleted too: restore the scratch project again.

4. **Dump the remaining rows** into a file. `pg_dump` can only dump whole tables, not chosen rows, which is why step 3 trimmed them first. `--on-conflict-do-nothing` means a row production already has is skipped rather than causing an error:
   ```bash
   pg_dump --data-only --column-inserts --on-conflict-do-nothing \
     --table=public.residents \
     --table=public.resident_sheet_links \
     --table=public.move_out_checklists \
     --table=public.move_out_photos \
     --table=public.rent_payments \
     --table=public.security_deposits \
     --table=public.deposit_deductions \
     --table=public.resident_documents \
     --table=public.uploads \
     "$SCRATCH_DB" > restore-one-resident.sql
   grep -o 'INSERT INTO public\.[a-z_]*' restore-one-resident.sql | uniq -c
   ```
   The list must start with `1 INSERT INTO public.residents`, and the other lines should match what the resident had. The rehearsal printed residents 1, deposit_deductions 1, move_out_checklists 1, move_out_photos 1, rent_payments 1, resident_documents 5, security_deposits 1, uploads 1 (no `resident_sheet_links` line, because that resident was added by hand, not from the sheet). If there is no residents line, or more than one, do not load it. A file of about 1.5 KB with no `INSERT` lines is just the header: the tables were empty.

5. **Load it into production** in one go. `--single-transaction` means that if anything fails, nothing is loaded; `ON_ERROR_STOP=1` makes it stop at the first failure. The `RESET ALL` undoes the empty `search_path` the dump sets at its top (see below):
   ```bash
   psql "$PROD_DB" -v ON_ERROR_STOP=1 --single-transaction -f restore-one-resident.sql -c "RESET ALL;"
   ```
   Expect one `INSERT 0 1` per row (12 in the rehearsal); `INSERT 0 0` is a row production already had, which is fine. If it fails with a message about a foreign key, the most likely cause is that the house (or an RA's account recorded on a fee) was deleted since the backup. Nothing was loaded; stop and ask a developer.

   **Then open the portal at once.** In the rehearsal (loaded without the `RESET ALL`), every page then answered `{"message":"Something went wrong on our end. Please try again."}` and the service log said `relation "sessions" does not exist`, although `select count(*) from public.sessions` worked. The tables were fine; the database connections were not. Every `pg_dump` file starts with `set_config('search_path', '', false)`, and the Session pooler appears to have handed connections still carrying that setting on to the portal (inference: it fits everything seen, but was not proven). If it happens, end the other connections; the portal reconnects on its own:
   ```bash
   psql "$PROD_DB" -c "show search_path;"   # a fresh connection: should include public
   psql "$PROD_DB" -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where usename = 'postgres' and pid <> pg_backend_pid();"
   ```
   Do **not** run migrations or `db:push` to "fix" a missing table: check first, with `to_regclass('public.sessions')`, that it is really missing. Restarting the Render service alone may not help, because the pooler keeps the database side of the connection.

6. **Copy the files back** from the bucket backup (not from scratch), only the ones this resident's photos use. Set the `RCLONE_CONFIG_BACKUP_*` and `RCLONE_CONFIG_PROD_*` variables in this terminal first (both sets are on the `spo-uploads-backup` job's Environment page in Render; check `echo "$RCLONE_CONFIG_PROD_ENDPOINT"` names production's project ref). Then list the photos' storage keys from the scratch database, check the backup has them, and copy just those. `--files-from` is what stops other people's deliberately deleted files coming back with them:
   ```bash
   psql "$SCRATCH_DB" -X -A -t -c "select substr(image_url, 10) from move_out_photos;" > restore-keys.txt
   rclone lsf --files-from restore-keys.txt BACKUP:spo-uploads-backup-pm/uploads   # must list every key
   rclone copy --files-from restore-keys.txt --size-only BACKUP:spo-uploads-backup-pm/uploads PROD:uploads -v
   while read -r key; do printf '%s ' "$key"; rclone cat "PROD:uploads/$key" | wc -c; done < restore-keys.txt
   ```
   The last line prints each file's size in production; 0 or an error means it is not there (a bucket listing can name a file that is missing, as the whole-database rehearsal found). A file that was uploaded after the last bucket copy and then deleted cannot come back; the photo's row will exist but the image will not show. Say so to the RA.

7. **Check it in the portal.** Open the resident: the HH fees, the deposit and deductions, the HH Paperwork checklist, the stop date and the move-out photos should all be there, and a photo should display. You can also compare counts, for example `select count(*) from rent_payments where resident_id = '$RID';`, between the scratch and production databases (a row that production already held is skipped on load, so a count in production can be higher, never lower).

8. **Clean up.** Delete the scratch project (it charges until you do) and the working folder (`restore-one-resident.sql`, `restore-keys.txt`), which hold a resident's name, email and finance rows. Close the terminal, or `unset PROD_DB SCRATCH_DB RID` and the `RCLONE_CONFIG_*` variables: production's keys are in it.

**What the rehearsal proved, and what it did not.** Steps 1 to 8 were run as written above on 2026-11-11 against a real daily backup, with `psql` and `pg_dump` 17.11 and rclone 1.76.0, except the `RESET ALL` in step 5 and the `rclone lsf` and per-key size check in step 6, which were added afterwards and have not been run against production. Against a local database, `psql` ran the `-f` file and then the `-c` in one transaction, and `show search_path` afterwards included `public` again. Whether `RESET ALL` prevents the broken connections rests on the pooler explanation, which is inference. Only a resident was restored; a maintenance request, walkthrough or invoice needs its own table list.

---

## Step 12 — Go live

Only after staging has passed step 8 in full and step 11 is done.

**For the pilot there is no old portal to move from**: production starts empty, so there is no freeze and no data dump.

1. Sign in on production as the admin and spot-check the security items from step 8 — the access-control checks, the uninvited-Gmail refusal, and one upload and download.
2. Set the portal up for the pilot (issue #214): the two RAs with their regions, the houses, the rosters by CSV, portal access for the household leaders and stewards, deposit return deadlines, budgets.
3. Tell the RAs, and through them the leaders: sign in with **the Google account whose email the RA gave access to**; and expect to sign in again after about an hour.
4. Watch the Render logs for the first day.

### Moving from an existing deployment instead

If a later move is from a portal that already holds data: agree a quiet window; tell staff the address is changing; stop the old deployment so nobody keeps entering data into it; take the final dump and restore it into production (step 9); update DNS; spot-check as above; and keep the old environment intact, powered down, for a fortnight before deleting anything.

### If it goes wrong

- **Login broken for everyone** — check the redirect URI matches the hostname exactly, and that `OIDC_SCOPES` does not contain `offline_access`.
- **Everyone is told they haven't been given access** — that is invite-only working on accounts nobody has created. Check the first admin row exists (step 5) and that its email is exactly the address being signed in with.
- **One person turned away** — almost always an email mismatch. Compare the email on their account (or their roster row, for a leader) with the Google account they actually sign in with; fix it and have them sign in again. If the RA could not give a leader access at all, the house already has 4 switched-on logins; switch one off first.
- **A Workspace domain restriction refusing leaders** ("This portal only accepts SPO accounts") — `OIDC_ALLOWED_DOMAINS` is set. Remove it and restart.
- **Files not appearing** — check `STORAGE_DRIVER=supabase` and the service role key.
- **Data lost or damaged** — restore from backup (step 11).
- **A bad deploy**: see "Going back after a bad deploy" under step 6's "Migrations on deploy" before rolling anything back.

---

## After the move

- **Rotate the secrets that were used during setup** if any were pasted into a chat, a ticket or a shared document — particularly the Supabase service role key. The full list of secrets the portal holds: `SESSION_SECRET` (changing it signs everyone out), `SUPABASE_SERVICE_ROLE_KEY`, `OIDC_CLIENT_SECRET`, `RESEND_API_KEY` once email is on, the backup job's Supabase S3 key, Backblaze key and healthchecks.io ping URL (all in the `spo-uploads-backup` cron job's variables), and, once those integrations are switched on after the pilot, `QUICKBOOKS_CLIENT_SECRET` and `QUICKBOOKS_TOKEN_KEY` (changing the token key means an admin reconnects QuickBooks) and the Google service-account key in `GOOGLE_SERVICE_ACCOUNT_JSON` (create a new key in Google Cloud, replace the variable, restart, then delete the old key).
- **Decide who holds the accounts.** Supabase, Render, Backblaze and the Google Cloud project should each be owned by an organisation account with more than one administrator, not by an individual's personal login.
- **Keep `.env.example` current.** It is the only complete list of what the app reads, and it is what the next person will follow.
- **Work through the known issues** in `README.md` — particularly that replacing a photo or document on an edit leaves the old file in storage.
