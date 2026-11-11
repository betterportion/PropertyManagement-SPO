/**
 * Stops a Render build while the database has migrations still to apply.
 *
 * Production auto-deploys from `main`, and new code must never go live before
 * its migration (#264, #282). So the build runs this and fails when anything is
 * pending: the old version keeps serving until somebody runs
 * `scripts/deploy-production.sh`, which takes the safety copy, migrates, and
 * calls the deploy hook, whose build then passes this check.
 *
 * Counts the same way that script does: journal entries against the rows in
 * `drizzle.__drizzle_migrations`. Connects through `server/db`, so it uses the
 * same connection and TLS settings as the running app.
 *
 * Usage: npm run db:check-pending
 */
import fs from "fs";
import path from "path";

/** Why the build must stop, or null when it may go ahead. */
export function pendingMigrationProblem(inRepo: number, applied: number): string | null {
  if (applied > inRepo) {
    return `The database has ${applied} migrations but this commit has only ${inRepo}. ` +
      "The database is ahead of the code; ask a developer before deploying.";
  }
  if (applied < inRepo) {
    return `${inRepo - applied} migration(s) not yet applied to this database. ` +
      "Not deploying: run scripts/deploy-production.sh, which takes the safety copy, " +
      "migrates, and then deploys.";
  }
  return null;
}

async function main(): Promise<void> {
  const journal = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "migrations", "meta", "_journal.json"), "utf8"),
  );
  const inRepo: number = journal.entries.length;

  const { pool, closeDatabase } = await import("../server/db");
  try {
    const { rows } = await pool.query(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
    );
    const applied = rows[0].present
      ? Number((await pool.query("select count(*) from drizzle.__drizzle_migrations")).rows[0].count)
      : 0;

    const problem = pendingMigrationProblem(inRepo, applied);
    if (problem) {
      console.error(`\n${problem}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`Migrations: all ${inRepo} applied.`);
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1]?.endsWith("check-pending-migrations.ts")) {
  main().catch((error) => {
    // An unreachable database fails the build too: no proof, no deploy.
    console.error("Could not check migrations:", error);
    process.exitCode = 1;
  });
}
