/**
 * Tests for server/roleChange.ts: what a permissions row becomes when an admin
 * changes somebody's role. Pure -- the row out is decided from the role in
 * and the role out, never from what the row held, so a spell as admin cannot
 * leave every flag and every region behind on the way back down.
 */
import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { userPermissions } from "@shared/schema";
import { permissionsAfterRoleChange } from "../roleChange";

// Read off the table, so a flag added later is covered without editing here.
const FLAGS = Object.entries(getTableColumns(userPermissions))
  .filter(([, column]) => column.dataType === "boolean")
  .map(([name]) => name);

describe("permissionsAfterRoleChange", () => {
  it("writes nothing when the role does not change", () => {
    expect(permissionsAfterRoleChange("u-1", "regional_administrator", "regional_administrator")).toBeNull();
    expect(permissionsAfterRoleChange("u-1", "resident", "resident")).toBeNull();
    expect(permissionsAfterRoleChange("u-1", "admin", "admin")).toBeNull();
  });

  it("writes nothing on a promotion to admin, which bypasses every flag and region", () => {
    expect(permissionsAfterRoleChange("u-1", "regional_administrator", "admin")).toBeNull();
    expect(permissionsAfterRoleChange("u-1", "resident", "admin")).toBeNull();
  });

  it("gives a demoted admin no flags and no regions as a regional administrator", () => {
    const row = permissionsAfterRoleChange("u-1", "admin", "regional_administrator")!;
    expect(row.userId).toBe("u-1");
    expect(row.allowedRegions).toEqual([]);
    for (const flag of FLAGS) expect(row[flag as keyof typeof row], flag).toBe(false);
  });

  it("gives a promoted resident no flags and no regions as a regional administrator", () => {
    const row = permissionsAfterRoleChange("u-1", "resident", "regional_administrator")!;
    expect(row.allowedRegions).toEqual([]);
    for (const flag of FLAGS) expect(row[flag as keyof typeof row], flag).toBe(false);
  });

  it("gives a new resident only the maintenance view a resident needs to file a repair", () => {
    for (const from of ["admin", "regional_administrator"] as const) {
      const row = permissionsAfterRoleChange("u-1", from, "resident")!;
      expect(row.allowedRegions).toEqual([]);
      for (const flag of FLAGS) {
        expect(row[flag as keyof typeof row], `${from} -> resident: ${flag}`).toBe(flag === "canViewMaintenance");
      }
    }
  });

  it("names at least the flags this suite already knows about", () => {
    expect(FLAGS).toEqual(expect.arrayContaining(["canManageFinancials", "canManageUsers", "canViewResourceHub"]));
  });
});
