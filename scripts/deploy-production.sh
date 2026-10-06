#!/usr/bin/env bash
# Deploy the portal to production in the runbook's order (docs/PRODUCTION_MIGRATION.md,
# "Migrations on deploy"): safety copy, then db:migrate, then the Render deploy hook.
# Each step runs only if the one before it succeeded. Render's auto-deploy stays off.
#
# Reads three private files (override any with the variable in brackets):
#   ~/.config/spo/prod-db-session-url  the shared session pooler string   [SPO_DB_URL_FILE]
#   ~/.config/spo/prod-deploy-hook     the service's Render deploy hook   [SPO_DEPLOY_HOOK_FILE]
#   ~/.config/spo/supabase-ca.crt      Supabase's root certificate        [SPO_CA_FILE]
# Safety copies go to ~/spo-backups [SPO_BACKUP_DIR]; the portal is checked at
# https://spo-pm.onrender.com [SPO_APP_URL].
#
# Run from a clean checkout of main that matches GitHub: the deploy hook deploys
# GitHub's main, so the migrations applied here must be the ones that ship.

set -euo pipefail

CONFIG_DIR="$HOME/.config/spo"
DB_URL_FILE="${SPO_DB_URL_FILE:-$CONFIG_DIR/prod-db-session-url}"
HOOK_FILE="${SPO_DEPLOY_HOOK_FILE:-$CONFIG_DIR/prod-deploy-hook}"
CA_FILE="${SPO_CA_FILE:-$CONFIG_DIR/supabase-ca.crt}"
BACKUP_DIR="${SPO_BACKUP_DIR:-$HOME/spo-backups}"
APP_URL="${SPO_APP_URL:-https://spo-pm.onrender.com}"
DEPLOY_TIMEOUT_SECONDS=1500

fail() { echo "STOPPED: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

cd "$(dirname "$0")/.."

step "Checking this machine"
for tool in git node npm psql pg_dump curl; do
  command -v "$tool" >/dev/null || fail "$tool is not installed."
done
[ -x node_modules/.bin/drizzle-kit ] || fail "node_modules is missing. Run: npm ci"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || fail "Node $node_major is too old; the portal needs 20 or later."
for f in "$DB_URL_FILE" "$HOOK_FILE" "$CA_FILE"; do
  [ -s "$f" ] || fail "$f is missing or empty."
done

DB_URL=$(head -n 1 "$DB_URL_FILE")
HOOK_URL=$(head -n 1 "$HOOK_FILE")
export PGSSLMODE=verify-full PGSSLROOTCERT="$CA_FILE" NODE_EXTRA_CA_CERTS="$CA_FILE"
# The Supabase project, from the pooler user name (postgres.<ref>); the password is never printed.
project_ref=$(printf '%s' "$DB_URL" | sed -nE 's#^postgres(ql)?://postgres\.([a-z0-9]+):.*#\2#p')
[ -n "$project_ref" ] || fail "$DB_URL_FILE does not look like a Supabase pooler string (user postgres.<ref>)."

step "Checking the code matches GitHub's main"
git fetch --quiet origin main
local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse origin/main)
[ "$local_head" = "$remote_head" ] || fail "this checkout ($local_head) is not GitHub's main ($remote_head). Run: git checkout main && git pull"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "this checkout has uncommitted changes."
[ -z "$(git status --porcelain migrations/)" ] || fail "migrations/ has files git does not know about."

step "Checking the database"
server_major=$(psql "$DB_URL" -X -A -t -c "show server_version_num" | cut -c1-2)
dump_major=$(pg_dump --version | sed -nE 's/.* ([0-9]+)\..*/\1/p')
[ "$dump_major" -ge "$server_major" ] || fail "pg_dump is version $dump_major but the database is Postgres $server_major. Install postgresql-client-$server_major so the safety copy can be taken."
# Two queries, not one: Postgres resolves every table a query names before running it,
# so counting the history table fails on a database that has never been migrated.
applied=0
if [ "$(psql "$DB_URL" -X -A -t -c "select to_regclass('drizzle.__drizzle_migrations') is not null")" = t ]; then
  applied=$(psql "$DB_URL" -X -A -t -c "select count(*) from drizzle.__drizzle_migrations")
fi
in_repo=$(node -p 'require("./migrations/meta/_journal.json").entries.length')
pending=$((in_repo - applied))
[ "$pending" -ge 0 ] || fail "the database has $applied migrations but this checkout has only $in_repo. It is ahead of the code; ask a developer."

echo
echo "  Supabase project:  $project_ref"
echo "  Commit to deploy:  $(git log -1 --format='%h %s')"
echo "  Migrations:        $applied applied, $pending to apply"
echo "  Portal:            $APP_URL"
echo
read -r -p "Type the Supabase project ref above to continue: " answer || true
[ "$answer" = "$project_ref" ] || fail "nothing was done."

if [ "$pending" -gt 0 ]; then
  step "Taking the safety copy"
  umask 077
  mkdir -p "$BACKUP_DIR"
  dump_file="$BACKUP_DIR/spo-pre-migrate-$(date +%F).sql"
  n=2
  while [ -e "$dump_file" ]; do dump_file="$BACKUP_DIR/spo-pre-migrate-$(date +%F)-$n.sql"; n=$((n + 1)); done
  pg_dump --no-owner --no-acl --schema=public --schema=drizzle "$DB_URL" > "$dump_file"
  [ -s "$dump_file" ] || fail "the safety copy $dump_file is empty. Nothing was migrated."
  tail -n 3 "$dump_file" | grep -q "PostgreSQL database dump complete" \
    || fail "the safety copy $dump_file did not finish. Nothing was migrated."
  echo "Saved $dump_file ($(du -h "$dump_file" | cut -f1)). It holds residents' details: keep it private and delete it after a week."

  step "Applying $pending migration(s)"
  DATABASE_URL="$DB_URL" npm run --silent db:migrate
  now_applied=$(psql "$DB_URL" -X -A -t -c "select count(*) from drizzle.__drizzle_migrations")
  [ "$now_applied" -eq "$in_repo" ] || fail "after db:migrate the database has $now_applied migrations, expected $in_repo. Nothing was deployed."
  echo "The database now has all $in_repo migrations."
else
  step "No migrations to apply, so no safety copy is needed"
fi

step "Starting the deploy"
triggered_at=$(date +%s)
curl -fsS -X POST "$HOOK_URL" >/dev/null || fail "the deploy hook refused. Migrations (if any) are applied; deploy by hand from the Render dashboard."
echo "Render is building. Waiting for the new version to answer (up to $((DEPLOY_TIMEOUT_SECONDS / 60)) minutes)..."

# The old version keeps answering until Render switches over, so a 200 alone proves
# nothing: the new process is the one whose uptime is shorter than the wait so far.
while :; do
  elapsed=$(( $(date +%s) - triggered_at ))
  [ "$elapsed" -lt "$DEPLOY_TIMEOUT_SECONDS" ] || fail "no new version after $((elapsed / 60)) minutes. Check the deploy's log in Render."
  uptime=$(curl -fsS -m 20 "$APP_URL/api/health" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const h=JSON.parse(s);console.log(h.status==="ok"&&h.database==="ok"?h.uptimeSeconds:"")}catch{console.log("")}})' || true)
  if [ -n "$uptime" ] && [ "$uptime" -lt "$elapsed" ]; then
    echo "Live: $APP_URL answers healthy from a process started ${uptime}s ago."
    break
  fi
  sleep 15
done

echo
echo "Done. Next: run the step 7 checks in docs/PRODUCTION_MIGRATION.md and read the Render log."
