/**
 * What a user's permissions row becomes when an admin changes their role.
 *
 * Decided from the two roles alone, never from what the row held: the old
 * behaviour kept the existing regions and applied the new role's defaults, so
 * a regional administrator made admin and back came out holding every manage
 * and finance flag and every region, with nothing in the access history to
 * say so. Now:
 *
 * - the same role writes nothing;
 * - a promotion to admin writes nothing, because an admin bypasses every flag
 *   and region -- the row waits, unused, and is reset on the way back down;
 * - any other change resets the row to the new role's minimum: no flags and
 *   no regions for a regional administrator (an admin grants what they need
 *   explicitly), for a resident only `canViewMaintenance`, which a
 *   household needs to file and read its own repairs, and for a maintenance
 *   account its fixed set (`MAINTENANCE_PERMISSION_FLAGS`) with no regions,
 *   so an admin still chooses where they work.
 *
 * Pure: roles in, the row to write (or null) out.
 */
import { getTableColumns } from "drizzle-orm";
import { userPermissions, type InsertUserPermissions, type User } from "@shared/schema";
import { isMaintenancePermissionFlag } from "@shared/permissions";

type Role = User["role"];

// Read off the table, so a flag added later starts false here too.
const FLAGS = Object.entries(getTableColumns(userPermissions))
  .filter(([, column]) => column.dataType === "boolean")
  .map(([name]) => name);

export function permissionsAfterRoleChange(userId: string, from: Role, to: Role): InsertUserPermissions | null {
  if (from === to || to === "admin") return null;
  if (to === "maintenance") return maintenanceDefaultPermissions(userId);
  const flags = Object.fromEntries(FLAGS.map((flag) => [flag, flag === "canViewMaintenance" && to === "resident"]));
  return { ...flags, userId, allowedRegions: [] } as InsertUserPermissions;
}

/** A maintenance account's row: its fixed set on, every other flag off, no regions yet. */
export function maintenanceDefaultPermissions(userId: string): InsertUserPermissions {
  const flags = Object.fromEntries(FLAGS.map((flag) => [flag, isMaintenancePermissionFlag(flag)]));
  return { ...flags, userId, allowedRegions: [] } as InsertUserPermissions;
}
