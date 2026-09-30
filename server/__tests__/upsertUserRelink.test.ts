/**
 * The email-based re-link inside `upsertUser` is what lets an admin pre-create
 * an account before someone's first OIDC sign-in: when the sign-in's email
 * matches an existing account under a different ID, the old row is migrated to
 * the new identity. CLAUDE.md marks it "do not simplify away", but nothing
 * exercised it until a real regression: role and isActive were preserved
 * across the migration while propertyId — the resident account's link to its
 * house — was silently dropped, undoing the link the moment the account it was
 * created for was first used.
 *
 * The database is replaced with a minimal double that answers queries from a
 * queue and records writes, so the real migration logic runs. What the double
 * cannot show -- that every reference to the account follows it, and that a
 * failed re-link leaves the old account whole -- is proved against a real
 * database in `upsertUserRelink.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@shared/schema";

const { dbMock, selectQueue, inserted, deleted, updated } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const inserted: Record<string, unknown>[] = [];
  const deleted: unknown[] = [];
  const updated: Record<string, unknown>[] = [];
  const dbMock = {
    select: () => ({ from: () => ({ where: async () => selectQueue.shift() ?? [] }) }),
    delete: () => ({
      where: async (condition: unknown) => {
        deleted.push(condition);
      },
    }),
    update: () => ({
      set: (row: Record<string, unknown>) => {
        updated.push(row);
        return { where: () => ({ returning: async () => [row] }) };
      },
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          returning: async () => [row],
          onConflictDoUpdate: () => ({ returning: async () => [row] }),
        };
      },
    }),
  };
  return { dbMock, selectQueue, inserted, deleted, updated };
});

vi.mock("../db", () => ({ db: dbMock, pool: {} }));

import { storage } from "../storage";

const PRE_CREATED = {
  id: "u-precreated",
  email: "steward@example.com",
  role: "resident",
  isActive: true,
  propertyId: "prop-west",
  commentEmailsEnabled: false,
  firstName: "Pre",
  lastName: "Created",
};

const PERMISSIONS_ROW = {
  id: "perm-1",
  userId: "u-precreated",
  canViewMaintenance: true,
  allowedRegions: [] as string[],
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  selectQueue.length = 0;
  inserted.length = 0;
  deleted.length = 0;
  updated.length = 0;
});

describe("upsertUser email re-linking", () => {
  it("migrates role, active status, the property link AND the comment email switch to the new identity", async () => {
    // 1st select: the account found by email; 2nd: its permissions row.
    selectQueue.push([PRE_CREATED], [PERMISSIONS_ROW]);

    const user = await storage.upsertUser({
      id: "oidc-sub-123",
      email: "steward@example.com",
      firstName: "Real",
      lastName: "Name",
      // Exactly what the sign-in claims carry: no role, no propertyId.
    });

    // Renamed in place, never deleted: a delete would null every reference.
    expect(deleted).toHaveLength(0);
    const relinked = updated.find((row) => row.id === "oidc-sub-123");
    expect(relinked).toMatchObject({
      role: "resident",
      isActive: true,
      propertyId: "prop-west",
      // An admin who switched email off for a pre-created account did it
      // for a reason; the first sign-in must not switch it back on.
      commentEmailsEnabled: false,
    });
    expect(user.propertyId).toBe("prop-west");
  });

  it("lets an explicit propertyId in the upsert win over the old row's", async () => {
    selectQueue.push([PRE_CREATED], [PERMISSIONS_ROW]);

    await storage.upsertUser({
      id: "oidc-sub-123",
      email: "steward@example.com",
      propertyId: "prop-east",
    });

    const relinked = updated.find((row) => row.id === "oidc-sub-123");
    expect(relinked).toMatchObject({ propertyId: "prop-east" });
  });

  it("keeps the pre-configured permissions row rather than writing a new one", async () => {
    // 2nd select: the permissions lookup under the new identity, which finds
    // the row the database carried across with the account.
    selectQueue.push([PRE_CREATED], [{ ...PERMISSIONS_ROW, userId: "oidc-sub-123" }]);

    await storage.upsertUser({ id: "oidc-sub-123", email: "steward@example.com" });

    expect(inserted).toEqual([]);
  });

  it("gives a pre-created account with no permissions row the defaults for its role", async () => {
    // Positive control for the test above: the permissions lookup is what
    // decides, so an empty one does produce a write.
    selectQueue.push([PRE_CREATED], []);

    await storage.upsertUser({ id: "oidc-sub-123", email: "steward@example.com" });

    expect(inserted).toEqual([
      expect.objectContaining({ userId: "oidc-sub-123", canViewMaintenance: true }),
    ]);
  });
});

describe("foreign keys to users.id", () => {
  it("all follow a re-link: ON UPDATE CASCADE, so renaming the account's id carries every reference", () => {
    // The re-link renames the account's id in place. A new foreign key to
    // users.id without onUpdate "cascade" would make every re-link fail for
    // an account that key points at, so it is caught here instead.
    const keys = Object.values(schema)
      .filter((value): value is PgTable => is(value, PgTable))
      .flatMap((table) => {
        const { name, foreignKeys } = getTableConfig(table);
        return foreignKeys.map((fk) => ({ table: name, fk }));
      })
      .filter(({ fk }) => getTableConfig(fk.reference().foreignTable).name === "users");

    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(
      keys
        .filter(({ fk }) => fk.onUpdate !== "cascade")
        .map(({ table, fk }) => `${table}.${fk.reference().columns.map((c) => c.name).join(",")}`),
    ).toEqual([]);
  });
});
