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
import { fileURLToPath } from "url";
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
 * The tables and columns the given migrations leave behind when applied in
 * order, so we can confirm the database really does already look that way.
 *
 * Checking table names alone is not enough: a database can have every table and
 * still be missing a column added later, and recording the migration as applied
 * would leave that column missing forever.
 *
 * Crucially this is the schema they *end up with*, not everything they mention.
 * A migration that drops a column means a database at that point should not
 * have it; expecting it anyway would make the one sequence anybody would
 * actually baseline impossible to baseline, and would send them to
 * `db:migrate`, which then fails on a table that already exists.
 */
export function expectedSchema(tags: string[]): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();

  for (const tag of tags) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, `${tag}.sql`), "utf8");

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

    for (const [, table] of sql.matchAll(/DROP TABLE (?:IF EXISTS )?"([^"]+)"/gi)) {
      tables.delete(table);
    }

    for (const [, table, column] of sql.matchAll(
      /ALTER TABLE "([^"]+)"\s+ADD COLUMN (?:IF NOT EXISTS )?"([^"]+)"/gi,
    )) {
      tables.get(table)?.add(column);
    }

    for (const [, table, column] of sql.matchAll(
      /ALTER TABLE "([^"]+)"\s+DROP COLUMN (?:IF EXISTS )?"([^"]+)"/gi,
    )) {
      tables.get(table)?.delete(column);
    }
  }

  return tables;
}

/**
 * Tables that only appear *after* the migration at `throughIndex`.
 *
 * If one of these is already in the database, the database is further along
 * than the tag being claimed. Recording the earlier tag would leave the
 * migration that creates the table unrecorded, and the next `db:migrate` would
 * try to create a table that is already there and stop.
 */
export function tablesAddedAfter(tags: string[], throughIndex: number): Set<string> {
  const now = new Set(expectedSchema(tags.slice(0, throughIndex + 1)).keys());
  return new Set([...expectedSchema(tags).keys()].filter((table) => !now.has(table)));
}

/**
 * How the database differs from the schema those migrations describe. Empty
 * means it matches and the tag can honestly be recorded.
 *
 * The comparison is exact in both directions on purpose. A *missing* column
 * means baselining would record it as created when it never was. An
 * *unexpected* column -- one a later migration drops -- means the database has
 * not reached this point in history yet, and recording the drop as applied
 * would leave the column behind forever with nothing left to remove it.
 */
export function compareSchema(
  expected: Map<string, Set<string>>,
  present: Map<string, Set<string>>,
  laterTables: Set<string>,
): string[] {
  const problems: string[] = [];

  for (const [table, columns] of expected) {
    const found = present.get(table);
    if (!found) {
      problems.push(`table "${table}" is missing entirely`);
      continue;
    }
    const missing = [...columns].filter((column) => !found.has(column));
    if (missing.length > 0) {
      problems.push(`table "${table}" is missing: ${missing.join(", ")}`);
    }
    const unexpected = [...found].filter((column) => !columns.has(column));
    if (unexpected.length > 0) {
      problems.push(
        `table "${table}" still has ${unexpected.join(", ")}, which a migration up to this ` +
          `tag removes -- so this database has not reached that migration yet`,
      );
    }
  }

  for (const table of laterTables) {
    if (present.has(table)) {
      problems.push(
        `table "${table}" already exists, but nothing up to this tag creates it -- this ` +
          `database is further along than the tag you named`,
      );
    }
  }

  return problems;
}

/**
 * The tag whose schema this database actually matches, so a refusal can name
 * the command to run instead of leaving the reader to guess.
 */
export function tagMatching(tags: string[], present: Map<string, Set<string>>): string | undefined {
  for (let index = 0; index < tags.length; index++) {
    const expected = expectedSchema(tags.slice(0, index + 1));
    const problems = compareSchema(expected, present, tablesAddedAfter(tags, index));
    if (problems.length === 0) return tags[index];
  }
  return undefined;
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
    // not. Without this the command could be used on a database that does not
    // match the tag, and would write a migration history that is not true --
    // leaving columns permanently uncreated, or sending the next `db:migrate`
    // at a table that already exists.
    const allTags = entries.map((entry) => entry.tag);
    const expected = expectedSchema(toRecord.map((entry) => entry.tag));

    {
      // Every table, not only the expected ones: a table this tag does not know
      // about yet is exactly how we detect a database that is newer than the
      // tag being claimed.
      const { rows: actual } = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public'`,
      );

      const present = new Map<string, Set<string>>();
      for (const row of actual) {
        const columns = present.get(row.table_name) ?? new Set<string>();
        columns.add(row.column_name);
        present.set(row.table_name, columns);
      }

      const problems = compareSchema(expected, present, tablesAddedAfter(allTags, throughIndex));

      if (problems.length > 0) {
        const suggestion = tagMatching(allTags, present);
        const advice =
          present.size === 0
            ? `This database is empty, so there is nothing to baseline. Run "npm run db:migrate" ` +
              `and let every migration apply for real.`
            : suggestion
              ? `This database matches "${suggestion}". Run:\n\n  npm run db:baseline -- ${suggestion}\n`
              : `This database does not match any point in the migration history, so no tag is ` +
                `correct for it. Compare it against migrations/ by hand before going further; ` +
                `recording a history that is not true is harder to undo than this refusal.`;

        fail(
          `This database does not match "${entries[throughIndex].tag}":\n  ` +
            problems.join("\n  ") +
            `\n\n${advice}\n\nNothing has been written.`,
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

// Only when run as a command. Without this guard, importing anything from this
// file -- as the test for the schema check does -- would connect to a database
// and call process.exit.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
