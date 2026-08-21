/**
 * Marks migrations as already applied, without running them.
 *
 * The first migration describes the schema as it already exists in the
 * prototype database. Running it there would fail on the first CREATE TABLE,
 * but leaving it unrecorded would make every later `npm run db:migrate` try to
 * create those tables again. This records it as done so the database and the
 * migration history agree, and later migrations apply normally.
 *
 * A brand new database -- a fresh Supabase project -- does not need this. Run
 * `npm run db:migrate` there instead and let every migration apply for real.
 *
 * Usage:
 *   npm run db:baseline                  mark the first migration as applied
 *   npm run db:baseline -- <tag>         mark every migration up to <tag>
 *   npm run db:baseline -- <tag> --force record them even if some are recorded
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const MIGRATIONS_SCHEMA = "drizzle";
const MIGRATIONS_TABLE = "__drizzle_migrations";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function readJournal(): JournalEntry[] {
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    fail(`No migration journal at ${journalPath}. Run "npm run db:generate" first.`);
  }
  const { entries } = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("The migration journal is empty; there is nothing to baseline.");
  }
  return entries;
}

/**
 * Must match how Drizzle identifies a migration, or it would treat the same
 * file as new and try to run it: the SHA-256 of the file's entire contents.
 */
function hashOf(tag: string): string {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  return crypto.createHash("sha256").update(sql).digest("hex");
}

/**
 * The tables and columns a migration creates, so we can confirm the database
 * really does already look the way the migration describes.
 *
 * Checking table names alone is not enough: a database can have every table
 * and still be missing a column added later, and recording the migration as
 * applied would leave that column missing forever.
 */
function schemaCreatedBy(tag: string): Map<string, Set<string>> {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  const tables = new Map<string, Set<string>>();

  const createTable = /CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"\s*\(([\s\S]*?)\n\);/gi;
  for (const match of sql.matchAll(createTable)) {
    const [, table, body] = match;
    const columns = new Set<string>();
    for (const line of body.split("\n")) {
      // Column definitions start with a quoted name. Table-level constraints
      // (CONSTRAINT ..., PRIMARY KEY (...)) start with a keyword instead.
      const column = line.trim().match(/^"([^"]+)"\s+\S/);
      if (column) columns.add(column[1]);
    }
    tables.set(table, columns);
  }

  return tables;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const requestedTag = args.find((a) => !a.startsWith("--"));

  const entries = readJournal();
  const throughIndex = requestedTag
    ? entries.findIndex((e) => e.tag === requestedTag)
    : 0;

  if (throughIndex === -1) {
    fail(
      `No migration named "${requestedTag}". Available:\n  ${entries.map((e) => e.tag).join("\n  ")}`,
    );
  }

  const toRecord = entries.slice(0, throughIndex + 1);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("DATABASE_URL must be set.");
  }

  const client = new pg.Client({
    connectionString,
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : process.env.DATABASE_SSL === "no-verify"
          ? { rejectUnauthorized: false }
          : { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    // Everything below runs as one transaction, so an interrupted run records
    // either all of these migrations or none. A half-written history is worse
    // than no history: the next `db:migrate` would try to re-run whatever did
    // not get recorded.
    await client.query("BEGIN");

    // Blocks a second baseline, or a migration, from running against this
    // database at the same time. Released automatically when the transaction
    // ends, including if this process is killed.
    const { rows: lock } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('spo:baseline-migrations')) AS locked",
    );
    if (!lock[0]?.locked) {
      fail("Another migration or baseline is already running against this database.");
    }

    // Refuse to pretend a migration ran against a database where it plainly did
    // not. Without this the command could be used on an incomplete database and
    // would leave it permanently missing tables or columns with no way to
    // notice.
    const expected = new Map<string, Set<string>>();
    for (const entry of toRecord) {
      for (const [table, columns] of schemaCreatedBy(entry.tag)) {
        const merged = expected.get(table) ?? new Set<string>();
        for (const column of columns) merged.add(column);
        expected.set(table, merged);
      }
    }

    if (expected.size > 0) {
      const { rows: actual } = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...expected.keys()]],
      );

      const present = new Map<string, Set<string>>();
      for (const row of actual) {
        const columns = present.get(row.table_name) ?? new Set<string>();
        columns.add(row.column_name);
        present.set(row.table_name, columns);
      }

      const problems: string[] = [];
      for (const [table, columns] of expected) {
        const found = present.get(table);
        if (!found) {
          problems.push(`table "${table}" is missing entirely`);
          continue;
        }
        const missingColumns = [...columns].filter((c) => !found.has(c));
        if (missingColumns.length > 0) {
          problems.push(`table "${table}" is missing: ${missingColumns.join(", ")}`);
        }
      }

      if (problems.length > 0) {
        fail(
          `This database does not match the migrations you are trying to baseline:\n  ` +
            problems.join("\n  ") +
            `\n\nBaselining would record them as applied and the missing pieces would ` +
            `never be created. Run "npm run db:migrate" instead.`,
        );
      }
    }

    await client.query(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (
         id SERIAL PRIMARY KEY,
         hash text NOT NULL,
         created_at bigint
       )`,
    );

    const { rows: existing } = await client.query<{ hash: string }>(
      `SELECT hash FROM "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
    );
    if (existing.length > 0 && !force) {
      fail(
        `${existing.length} migration(s) are already recorded. This database has ` +
          `a migration history, so baselining is not needed -- run "npm run db:migrate". ` +
          `Pass --force only if you know the history is incomplete.`,
      );
    }

    const alreadyRecorded = new Set(existing.map((r) => r.hash));
    let recorded = 0;

    for (const entry of toRecord) {
      const hash = hashOf(entry.tag);
      if (alreadyRecorded.has(hash)) {
        console.log(`skip  ${entry.tag} (already recorded)`);
        continue;
      }
      await client.query(
        `INSERT INTO "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}" (hash, created_at) VALUES ($1, $2)`,
        [hash, entry.when],
      );
      console.log(`ok    ${entry.tag} recorded as applied`);
      recorded++;
    }

    await client.query("COMMIT");

    console.log(
      `\n${recorded} migration(s) marked as applied. ` +
        `"npm run db:migrate" will now apply only what comes after.`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
