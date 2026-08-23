/**
 * Retention against a real PostgreSQL database.
 *
 * `audit.test.ts` covers the policy with the storage layer mocked, which proves
 * the loop and the cutoff but not the query. The query is the part that decides
 * whether two-year-old routine entries actually disappear and whether account
 * and permission history actually survives, and a mock cannot tell the
 * difference between correct SQL and SQL that deletes the wrong rows.
 *
 * Isolation: everything runs inside a schema created for this run and dropped
 * afterwards, on the connection string in `TEST_DATABASE_URL` (falling back to
 * `DATABASE_URL`). The table is copied from `public.audit_log` with LIKE, so it
 * cannot drift from the real one, and the connection's `search_path` names only
 * the test schema -- the unqualified `audit_log` in `server/storage.ts` can
 * therefore only ever resolve to the copy, never to the real table.
 *
 * Skipped when no database is reachable, so `npm test` still runs offline.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { auditLog } from "@shared/schema";

const { TEST_SCHEMA, TEST_DATABASE_URL } = vi.hoisted(() => ({
  // The pid keeps two runs against the same database out of each other's way.
  TEST_SCHEMA: `audit_retention_itest_${process.pid}`,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
}));

/**
 * Replaces the application's pool with one pinned to the test schema. This is
 * the only thing substituted: `storage.deleteExpiredAuditEvents` and
 * `purgeExpiredAuditEvents` are the real implementations, generating real SQL.
 */
vi.mock("../db", async () => {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");

  // Mirrors server/db.ts: encrypt anything that is not on this machine.
  const configured = process.env.DATABASE_SSL?.trim().toLowerCase();
  let ssl: false | { rejectUnauthorized: boolean };
  if (configured === "disable") {
    ssl = false;
  } else if (configured === "no-verify") {
    ssl = { rejectUnauthorized: false };
  } else if (configured === "require") {
    ssl = { rejectUnauthorized: true };
  } else {
    let local = false;
    try {
      const { hostname } = new URL(TEST_DATABASE_URL);
      local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    } catch {
      local = false;
    }
    ssl = local ? false : { rejectUnauthorized: true };
  }

  // `options` is sent at connection startup rather than as a later `set`, so
  // there is no window in which a query could run against the wrong schema --
  // every statement this suite issues sees the test schema and nothing else.
  // `gen_random_uuid` and `now` live in pg_catalog, which is always searched,
  // so the defaults copied from the real table still resolve.
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    ssl,
    max: 2,
    options: `-c search_path="${TEST_SCHEMA}"`,
  });

  pool.on("error", () => {
    // A dropped idle connection must not take the test runner down.
  });

  return { db: drizzle(pool), pool };
});

const {
  storage,
}: typeof import("../storage") = await import("../storage");
const { db, pool }: typeof import("../db") = await import("../db");
const {
  purgeExpiredAuditEvents,
  auditRetentionCutoff,
  AUDIT_ACTIONS_KEPT_INDEFINITELY,
  AUDIT_RETENTION_BATCH_SIZE,
}: typeof import("../audit") = await import("../audit");

/** Fixed, so the test never sits on a boundary that moves with the clock. */
const NOW = new Date("2026-08-21T00:00:00.000Z");
const CUTOFF = auditRetentionCutoff(NOW);

/** Ages relative to NOW, in days, for readability at the call sites. */
const daysBefore = (from: Date, days: number) =>
  new Date(from.getTime() - days * 24 * 60 * 60 * 1_000);

const THREE_YEARS_OLD = daysBefore(NOW, 365 * 3);
const TEN_YEARS_OLD = daysBefore(NOW, 365 * 10);
const ONE_YEAR_OLD = daysBefore(NOW, 365);

async function insertEvent(action: string, createdAt: Date, summary?: string) {
  const [row] = await db
    .insert(auditLog)
    .values({
      action,
      entityType: "test",
      entityId: "test-entity",
      createdAt,
      summary: summary ?? action,
    })
    .returning({ id: auditLog.id });
  return row.id;
}

async function remainingActions(): Promise<string[]> {
  const rows = await db.select({ action: auditLog.action }).from(auditLog);
  return rows.map(({ action }) => action).sort();
}

async function remainingCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>("select count(*)::int as count from audit_log");
  return Number(rows[0].count);
}

describe.skipIf(!TEST_DATABASE_URL)("audit retention against PostgreSQL", () => {
  beforeAll(async () => {
    await pool.query(`drop schema if exists "${TEST_SCHEMA}" cascade`);
    await pool.query(`create schema "${TEST_SCHEMA}"`);
    // A copy of the real table, so a schema change cannot leave this passing
    // against a shape the application no longer uses.
    await pool.query(
      `create table "${TEST_SCHEMA}".audit_log (like public.audit_log including all)`,
    );

    // If this ever fails, the unqualified `audit_log` in storage.ts would be
    // resolving somewhere else -- possibly the real table -- and the deletes
    // below must not run.
    const { rows } = await pool.query<{ schema: string; isolated: boolean }>(
      `select current_schema() as schema,
              to_regclass('audit_log')::oid
                = to_regclass('"${TEST_SCHEMA}".audit_log')::oid as isolated`,
    );
    expect(rows[0].schema).toBe(TEST_SCHEMA);
    expect(rows[0].isolated).toBe(true);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("truncate table audit_log");
  });

  afterAll(async () => {
    try {
      await pool.query(`drop schema if exists "${TEST_SCHEMA}" cascade`);
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("removes routine entries past the cutoff and leaves newer ones alone", async () => {
    await insertEvent("invoice.created", THREE_YEARS_OLD);
    await insertEvent("document.uploaded", THREE_YEARS_OLD);
    // Exactly on the cutoff: the boundary is exclusive, so this stays.
    await insertEvent("invoice.updated", CUTOFF);
    await insertEvent("maintenance_request.updated", ONE_YEAR_OLD);

    await expect(purgeExpiredAuditEvents(NOW)).resolves.toBe(2);

    expect(await remainingActions()).toEqual(["invoice.updated", "maintenance_request.updated"]);
  });

  it("keeps account and permission history however old it is", async () => {
    for (const action of AUDIT_ACTIONS_KEPT_INDEFINITELY) {
      await insertEvent(action, TEN_YEARS_OLD);
    }
    await insertEvent("invoice.created", TEN_YEARS_OLD);

    await expect(purgeExpiredAuditEvents(NOW)).resolves.toBe(1);

    expect(await remainingActions()).toEqual([...AUDIT_ACTIONS_KEPT_INDEFINITELY].sort());
  });

  it("deletes no more than one batch per query, oldest first", async () => {
    const ids: string[] = [];
    for (let age = 5; age >= 1; age--) {
      ids.push(await insertEvent("invoice.created", daysBefore(CUTOFF, age)));
    }

    const deleted = await storage.deleteExpiredAuditEvents(
      CUTOFF,
      AUDIT_ACTIONS_KEPT_INDEFINITELY,
      2,
    );

    expect(deleted).toBe(2);
    const survivors = await db.select({ id: auditLog.id }).from(auditLog);
    // The two oldest went; the three newest are still here.
    expect(survivors.map(({ id }) => id).sort()).toEqual(ids.slice(2).sort());
  });

  it("keeps taking batches until nothing expired is left", async () => {
    const expired = AUDIT_RETENTION_BATCH_SIZE + 5;
    await db.insert(auditLog).values(
      Array.from({ length: expired }, (_, index) => ({
        action: "invoice.created",
        entityType: "test",
        entityId: `bulk-${index}`,
        createdAt: daysBefore(CUTOFF, index + 1),
      })),
    );
    await insertEvent("user.role_changed", TEN_YEARS_OLD);
    await insertEvent("invoice.created", ONE_YEAR_OLD);

    // Calls through to the real query; the spy only counts the round trips.
    const deleteBatch = vi.spyOn(storage, "deleteExpiredAuditEvents");

    await expect(purgeExpiredAuditEvents(NOW)).resolves.toBe(expired);

    // A full batch, then the remainder -- proof the work is bounded rather than
    // one unbounded DELETE.
    expect(deleteBatch).toHaveBeenCalledTimes(2);
    await expect(deleteBatch.mock.results[0].value).resolves.toBe(AUDIT_RETENTION_BATCH_SIZE);
    await expect(deleteBatch.mock.results[1].value).resolves.toBe(5);
    deleteBatch.mockRestore();

    expect(await remainingCount()).toBe(2);
    expect(await remainingActions()).toEqual(["invoice.created", "user.role_changed"]);
  }, 60_000);
});
