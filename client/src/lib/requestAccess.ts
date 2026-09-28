/**
 * What the request page says when the server refuses it. A 403 there has
 * more than one cause, and the reason on screen is what the reader takes to
 * their admin, so it has to name the right one.
 *
 * For staff the server checks the maintenance flag first and the region
 * second (`canReadMaintenanceRequest` in server/authz.ts). An account holding
 * neither maintenance flag was refused for that, whatever region the request
 * is in; anything else is the region. An admin is never refused on either.
 */
export interface RequestAccessUser {
  role?: string | null;
  permissions?: { canViewMaintenance?: boolean | null; canManageMaintenance?: boolean | null } | null;
}

export const NO_MAINTENANCE_ACCESS =
  "Your account does not have access to maintenance requests. Ask an admin to grant it.";
export const OUTSIDE_YOUR_REGIONS = "This request belongs to a region you do not cover.";
export const NOT_YOUR_HOUSE =
  "This request belongs to another house, or it was closed long enough ago that it is no longer shown.";

export function requestRefusalMessage(user: RequestAccessUser | null): string {
  const isStaff = user?.role === "admin" || user?.role === "regional_administrator";
  if (!isStaff) return NOT_YOUR_HOUSE;
  const holdsMaintenance =
    user?.role === "admin" ||
    user?.permissions?.canViewMaintenance === true ||
    user?.permissions?.canManageMaintenance === true;
  return holdsMaintenance ? OUTSIDE_YOUR_REGIONS : NO_MAINTENANCE_ACCESS;
}
