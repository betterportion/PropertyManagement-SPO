/**
 * The permission flags a resident account may hold, and nothing else.
 *
 * These are the only flags a resident-reachable route reads:
 * - `canViewMaintenance` -- filing and reading the household's repairs;
 * - `canCompleteWalkthroughs` -- filling in the house's own walkthrough
 *   (`hasWalkthroughPermission` in `server/authz.ts`);
 * - `canViewResourceHub` -- the resource hub (`/api/my-property`,
 *   `/api/resource-links`, `/api/property-budgets`).
 *
 * Every other flag, and any region, is a staff grant. On a resident row it
 * grants nothing while every staff route also checks the role, and would hand
 * over a region path the moment one of those checks went missing -- so the
 * permissions route refuses it rather than storing it.
 */
export const RESIDENT_PERMISSION_FLAGS = [
  "canViewMaintenance",
  "canCompleteWalkthroughs",
  "canViewResourceHub",
] as const;

const RESIDENT_FLAGS: ReadonlySet<string> = new Set(RESIDENT_PERMISSION_FLAGS);

export function isResidentPermissionFlag(flag: string): boolean {
  return RESIDENT_FLAGS.has(flag);
}

/**
 * The fields of a permissions change a resident account may not take: a staff
 * flag switched on, or a non-empty region list. Switching a staff flag off, or
 * clearing the regions, is allowed, so a row left over from before this rule
 * can be cleaned up.
 */
export function fieldsNotForResident(change: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(change)
    .filter(([field, value]) =>
      field === "allowedRegions"
        ? Array.isArray(value) && value.length > 0
        : value === true && !isResidentPermissionFlag(field),
    )
    .map(([field]) => field);
}

/**
 * The permission flags a maintenance account may hold, which are also its
 * defaults: SPO's own payroll maintenance staff (JR, 2026-11-06). Repairs,
 * walkthroughs, assets and contractors, by region like a regional
 * administrator. Never the house page, the roster, leases, move-outs,
 * invoices or money: cost goes in the thread or the close-out, and an admin
 * enters the invoice.
 */
export const MAINTENANCE_PERMISSION_FLAGS = [
  "canViewMaintenance",
  "canManageMaintenance",
  "canViewWalkthroughs",
  "canManageWalkthroughs",
  "canViewAssets",
  "canManageAssets",
  "canViewContacts",
  "canManageContacts",
] as const;

const MAINTENANCE_FLAGS: ReadonlySet<string> = new Set(MAINTENANCE_PERMISSION_FLAGS);

export function isMaintenancePermissionFlag(flag: string): boolean {
  return MAINTENANCE_FLAGS.has(flag);
}

/**
 * The flags a maintenance account may not take: any other flag switched on.
 * Regions are allowed (they are how the account is scoped), and switching a
 * flag off is allowed, so an old row can be cleaned up.
 */
export function fieldsNotForMaintenance(change: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(change)
    .filter(([field, value]) => field !== "allowedRegions" && value === true && !isMaintenancePermissionFlag(field))
    .map(([field]) => field);
}
