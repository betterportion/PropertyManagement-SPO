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
 * queue and records inserts, so the real migration logic runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, selectQueue, inserted, deleted } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const inserted: Record<string, unknown>[] = [];
  const deleted: unknown[] = [];
  const dbMock = {
    select: () => ({ from: () => ({ where: async () => selectQueue.shift() ?? [] }) }),
    delete: () => ({
      where: async (condition: unknown) => {
        deleted.push(condition);
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
  return { dbMock, selectQueue, inserted, deleted };
});

vi.mock("../db", () => ({ db: dbMock, pool: {} }));

import { storage } from "../storage";

const PRE_CREATED = {
  id: "u-precreated",
  email: "steward@example.com",
  role: "resident",
  isActive: true,
  propertyId: "prop-west",
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
});

describe("upsertUser email re-linking", () => {
  it("migrates role, active status AND the property link to the new identity", async () => {
    // 1st select: the account found by email; 2nd: its permissions row.
    selectQueue.push([PRE_CREATED], [PERMISSIONS_ROW]);

    const user = await storage.upsertUser({
      id: "oidc-sub-123",
      email: "steward@example.com",
      firstName: "Real",
      lastName: "Name",
      // Exactly what the sign-in claims carry: no role, no propertyId.
    });

    expect(deleted).toHaveLength(1); // the old row is removed
    const reinserted = inserted.find((row) => row.id === "oidc-sub-123");
    expect(reinserted).toMatchObject({
      role: "resident",
      isActive: true,
      propertyId: "prop-west",
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

    const reinserted = inserted.find((row) => row.id === "oidc-sub-123");
    expect(reinserted).toMatchObject({ propertyId: "prop-east" });
  });

  it("restores the pre-configured permissions row under the new identity", async () => {
    selectQueue.push([PRE_CREATED], [PERMISSIONS_ROW]);

    await storage.upsertUser({ id: "oidc-sub-123", email: "steward@example.com" });

    const permsInsert = inserted.find((row) => row.userId === "oidc-sub-123");
    expect(permsInsert).toMatchObject({ canViewMaintenance: true });
    // The old row's own id/userId must not follow it to the new account.
    expect(permsInsert).not.toMatchObject({ id: "perm-1" });
  });
});
