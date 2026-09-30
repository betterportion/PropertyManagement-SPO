/**
 * The sign-in re-link against a real PostgreSQL database.
 *
 * `upsertUserRelink.test.ts` covers which fields the re-link keeps, with the
 * database replaced. What a double cannot show is the part that matters most:
 * that everything pointing at the account (its permissions row, the tasks
 * assigned to it or written by it, and every other foreign key to `users.id`)
 * still points at it afterwards, and that a re-link which fails part-way
 * leaves the old account exactly as it was.
 *
 * Isolation: unlike `auditRetention.integration.test.ts` this cannot run in a
 * schema of its own -- the behaviour under test lives in the foreign keys,
 * which `create table ... (like ...)` does not copy. So it runs against a
 * whole migrated database and is gated on `TEST_DATABASE_URL` alone, never
 * falling back to `DATABASE_URL`: point it at a throwaway database
 * (`createdb spo_relink_test`, then `npm run db:migrate` against it). Every
 * row it writes is keyed to this run and removed afterwards.
 *
 * Skipped when `TEST_DATABASE_URL` is unset, so `npm test` still runs offline.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tasks, userPermissions, users } from "@shared/schema";

const { TEST_DATABASE_URL, RUN } = vi.hoisted(() => ({
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
  // The pid keeps two runs against the same database out of each other's way.
  RUN: `relink-itest-${process.pid}`,
}));

/** Replaces only the pool; `storage.upsertUser` is the real implementation. */
vi.mock("../db", async () => {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  let local = false;
  try {
    const { hostname } = new URL(TEST_DATABASE_URL);
    local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    local = false;
  }
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: true },
    max: 2,
  });
  pool.on("error", () => {
    // A dropped idle connection must not take the test runner down.
  });
  return { db: drizzle(pool), pool };
});

const { storage }: typeof import("../storage") = await import("../storage");
const { db, pool }: typeof import("../db") = await import("../db");

const OLD_ID = `${RUN}-precreated`;
const NEW_ID = `${RUN}-oidc-sub`;
const EMAIL = `${RUN}@example.invalid`;
const TASK_SOURCE = `${RUN}-task`;
const FAIL_FUNCTION = `relink_itest_fail_${process.pid}`;

async function cleanUp() {
  await pool.query(`drop trigger if exists ${FAIL_FUNCTION} on user_permissions`);
  await pool.query(`drop function if exists ${FAIL_FUNCTION}()`);
  await db.delete(tasks).where(eq(tasks.sourceKey, TASK_SOURCE));
  await db.delete(users).where(inArray(users.id, [OLD_ID, NEW_ID]));
}

/** An account an admin set up before its owner ever signed in, with a task on it. */
async function preCreateAccount() {
  await db.insert(users).values({
    id: OLD_ID,
    email: EMAIL,
    firstName: "Pre",
    lastName: "Created",
    role: "regional_administrator",
    isActive: true,
    commentEmailsEnabled: false,
  });
  await db.insert(userPermissions).values({
    userId: OLD_ID,
    canManageBilling: true,
    allowedRegions: ["Northwest"],
  });
  await db.insert(tasks).values({
    title: "Relink test task",
    sourceKey: TASK_SOURCE,
    assignedToUserId: OLD_ID,
    createdBy: OLD_ID,
  });
}

async function taskOwners() {
  const [task] = await db
    .select({ assignedToUserId: tasks.assignedToUserId, createdBy: tasks.createdBy })
    .from(tasks)
    .where(eq(tasks.sourceKey, TASK_SOURCE));
  return task;
}

describe.skipIf(!TEST_DATABASE_URL)("sign-in re-link against PostgreSQL", () => {
  beforeAll(async () => {
    await cleanUp();
  }, 60_000);

  beforeEach(async () => {
    await cleanUp();
    await preCreateAccount();
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("declares every foreign key to users.id ON UPDATE CASCADE in the migrated database", async () => {
    // What the re-link relies on, read from the database the migrations
    // built rather than from the schema file, so a migration that failed to
    // say it cannot hide behind a schema that does.
    const { rows } = await pool.query<{ name: string; onUpdate: string }>(
      `select conrelid::regclass::text || '.' || conname as name, confupdtype as "onUpdate"
         from pg_constraint
        where contype = 'f' and confrelid = 'public.users'::regclass`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.filter((row) => row.onUpdate !== "c")).toEqual([]);
  });

  it("moves the account to the new identity with its permissions and every reference", async () => {
    const user = await storage.upsertUser({ id: NEW_ID, email: EMAIL, firstName: "Real" });

    expect(user).toMatchObject({
      id: NEW_ID,
      email: EMAIL,
      firstName: "Real",
      // A claim the provider did not send is not blanked.
      lastName: "Created",
      role: "regional_administrator",
      isActive: true,
      commentEmailsEnabled: false,
    });
    expect(await storage.getUser(OLD_ID)).toBeUndefined();

    const permissions = await storage.getUserPermissions(NEW_ID);
    expect(permissions).toMatchObject({ canManageBilling: true, allowedRegions: ["Northwest"] });

    // Before the fix these were set null by the delete.
    expect(await taskOwners()).toEqual({ assignedToUserId: NEW_ID, createdBy: NEW_ID });
  });

  it("leaves the old account, its permissions and its references intact when the re-link fails", async () => {
    // Fails the re-link part-way, at the moment the permissions row would be
    // written under the new identity -- after the account row itself has
    // already been renamed (or, as it used to be, deleted and re-inserted).
    await pool.query(
      `create function ${FAIL_FUNCTION}() returns trigger language plpgsql as $$
       begin raise exception 'forced failure part-way through the re-link'; end $$`,
    );
    await pool.query(
      `create trigger ${FAIL_FUNCTION} before insert or update on user_permissions
         for each row when (new.user_id = '${NEW_ID}') execute function ${FAIL_FUNCTION}()`,
    );

    await expect(storage.upsertUser({ id: NEW_ID, email: EMAIL, firstName: "Real" })).rejects.toThrow();

    expect(await storage.getUser(NEW_ID)).toBeUndefined();
    expect(await storage.getUser(OLD_ID)).toMatchObject({
      email: EMAIL,
      firstName: "Pre",
      role: "regional_administrator",
      isActive: true,
    });
    expect(await storage.getUserPermissions(OLD_ID)).toMatchObject({ canManageBilling: true });
    expect(await taskOwners()).toEqual({ assignedToUserId: OLD_ID, createdBy: OLD_ID });
  });

  it("still re-links once the failure has gone (positive control for the trigger)", async () => {
    // The same account and the same call as above, with no trigger: proves the
    // refusal above came from the forced failure and not from the setup.
    const user = await storage.upsertUser({ id: NEW_ID, email: EMAIL });
    expect(user.id).toBe(NEW_ID);
    expect(await taskOwners()).toEqual({ assignedToUserId: NEW_ID, createdBy: NEW_ID });
  });
});
