/**
 * ---------------------------------------------------------------------------
 * Authorization helpers
 * ---------------------------------------------------------------------------
 * Every protected route asks the same four questions in the same order:
 *
 *   1. Who is signed in, and does that user still exist?
 *   2. Is their account active?
 *   3. Do they hold a permission that covers this action?
 *   4. Is the record they are touching inside a region they are allowed to see?
 *
 * Before this module those four checks were copy-pasted into every handler,
 * which is exactly how endpoints ended up with only some of them. Route code
 * should now read:
 *
 *     const ctx = await requireActiveUser(req, res);
 *     if (!ctx) return;
 *     if (!requirePermission(res, ctx, "canViewAssets", "canManageAssets")) return;
 *     ...
 *     if (!requireRegion(res, ctx, record.region)) return;
 *
 * Deliberately boring: plain functions, no policy engine, no decorators. A
 * reader should be able to see the whole rule set without following
 * indirection.
 */
import type { Request, Response } from "express";
import { storage, type UploadReference } from "./storage";
import { getUserId } from "./auth";
import { normalizeRegion, normalizeRegions } from "./migrateRegions";
import type { Upload, User, UserPermissions } from "@shared/schema";

/** Names of the boolean permission columns on the user_permissions table. */
export type PermissionName =
  | "canViewMaintenance"
  | "canManageMaintenance"
  | "canViewWalkthroughs"
  | "canManageWalkthroughs"
  | "canViewAssets"
  | "canManageAssets"
  | "canViewBilling"
  | "canManageBilling"
  | "canViewContacts"
  | "canManageContacts"
  | "canManageUsers"
  | "canViewProperties"
  | "canManageProperties"
  | "canViewFinancials"
  | "canManageFinancials";

/**
 * Everything a route handler needs to make an authorization decision, resolved
 * once per request instead of re-queried by each individual check.
 */
export interface AuthContext {
  userId: string;
  user: User;
  permissions: UserPermissions | undefined;
  isAdmin: boolean;
  isResident: boolean;
  /** Raw stored value; may still contain legacy kebab-case entries. */
  allowedRegions: string[];
}

/**
 * Resolves the signed-in user and their permissions.
 *
 * Returns null when the session points at a user that no longer exists or has
 * been deactivated. Only valid behind `isAuthenticated`.
 */
export async function loadAuthContext(req: Request): Promise<AuthContext | null> {
  const userId = getUserId(req);
  const user = await storage.getUser(userId);

  // A deactivated account keeps its session cookie until it expires, so this
  // is the check that actually revokes access at the next request.
  if (!user?.isActive) {
    return null;
  }

  const permissions = await storage.getUserPermissions(userId);

  return {
    userId,
    user,
    permissions,
    isAdmin: user.role === "admin",
    isResident: user.role === "resident",
    allowedRegions: permissions?.allowedRegions ?? [],
  };
}

/**
 * Loads the auth context, or sends 403 and returns null.
 *
 * Usage: `const ctx = await requireActiveUser(req, res); if (!ctx) return;`
 */
export async function requireActiveUser(
  req: Request,
  res: Response,
): Promise<AuthContext | null> {
  const ctx = await loadAuthContext(req);
  if (!ctx) {
    res.status(403).json({ message: "Forbidden" });
    return null;
  }
  return ctx;
}

/**
 * True when the user holds at least one of the named permissions.
 *
 * Admins always pass. This is the admin bypass, and it lives here so it cannot
 * be forgotten on an individual route: an admin whose permissions row is
 * missing (or was never created) must never be locked out of the app they
 * administer.
 */
export function hasPermission(ctx: AuthContext, ...names: PermissionName[]): boolean {
  if (ctx.isAdmin) return true;
  if (!ctx.permissions) return false;
  return names.some((name) => ctx.permissions![name] === true);
}

/** `hasPermission`, but sends 403 and returns false instead of just reporting. */
export function requirePermission(
  res: Response,
  ctx: AuthContext,
  ...names: PermissionName[]
): boolean {
  if (hasPermission(ctx, ...names)) return true;
  res.status(403).json({ message: "Forbidden" });
  return false;
}

/** Rejects residents outright. Used for staff-only actions. */
export function requireStaff(res: Response, ctx: AuthContext): boolean {
  if (!ctx.isResident) return true;
  res.status(403).json({ message: "Forbidden" });
  return false;
}

/** Rejects everyone who is not an admin. */
export function requireAdmin(res: Response, ctx: AuthContext): boolean {
  if (ctx.isAdmin) return true;
  res.status(403).json({ message: "Forbidden" });
  return false;
}

/**
 * Whether the user may act on a record in the given region.
 *
 * Fails closed in every ambiguous case: a record with no region, or a user
 * with no assigned regions, is denied rather than allowed. Both sides are
 * normalised so a legacy kebab-case entry in allowedRegions still matches a
 * Title Case region stored on the record.
 */
export function canAccessRegion(ctx: AuthContext, region: string | null | undefined): boolean {
  if (ctx.isAdmin) return true;
  if (!region) return false;
  if (ctx.allowedRegions.length === 0) return false;
  const allowed = normalizeRegions(ctx.allowedRegions);
  if (allowed.includes("all")) return true;
  return allowed.includes(normalizeRegion(region));
}

/** `canAccessRegion`, but sends 403 and returns false. */
export function requireRegion(
  res: Response,
  ctx: AuthContext,
  region: string | null | undefined,
  message = "Forbidden - Region not accessible",
): boolean {
  if (canAccessRegion(ctx, region)) return true;
  res.status(403).json({ message });
  return false;
}

/**
 * Guards a region change on update: the user must be able to reach both where
 * the record is now and where it is being moved to. Without the second check a
 * user could push a record into a region they cannot see, and lose track of it.
 */
export function requireRegionMove(
  res: Response,
  ctx: AuthContext,
  currentRegion: string | null | undefined,
  nextRegion: string | null | undefined,
): boolean {
  if (!requireRegion(res, ctx, currentRegion)) return false;
  if (nextRegion && nextRegion !== currentRegion) {
    return requireRegion(res, ctx, nextRegion, "Forbidden - Cannot move to this region");
  }
  return true;
}

/**
 * Region-filters a list of records.
 *
 * A user with no assigned regions receives an empty list, never the full one.
 */
export function filterByRegion<T extends { region?: string | null }>(
  ctx: AuthContext,
  items: T[],
): T[] {
  if (ctx.isAdmin) return items;
  if (ctx.allowedRegions.length === 0) return [];
  const allowed = normalizeRegions(ctx.allowedRegions);
  if (allowed.includes("all")) return items;
  return items.filter((item) => item.region && allowed.includes(normalizeRegion(item.region)));
}

/**
 * Region-filters records whose region lives on a related record (for example
 * an asset photo, which inherits the region of its asset).
 */
export function filterByRelatedRegion<T>(
  ctx: AuthContext,
  items: T[],
  regionOf: (item: T) => string | null | undefined,
): T[] {
  if (ctx.isAdmin) return items;
  if (ctx.allowedRegions.length === 0) return [];
  const allowed = normalizeRegions(ctx.allowedRegions);
  if (allowed.includes("all")) return items;
  return items.filter((item) => {
    const region = regionOf(item);
    return region ? allowed.includes(normalizeRegion(region)) : false;
  });
}

/**
 * Whether a task is visible to a user.
 *
 * A task is not an ordinary region-scoped record, so it does not go through
 * `filterByRegion`: its region is nullable (an all-regions broadcast), and it
 * can be personal to one user. The rules, in order:
 *   - admins see everything;
 *   - you always see a task you created or one assigned to you;
 *   - a task assigned to someone else is private to them;
 *   - an all-regions broadcast (region null) is visible to every staff member;
 *   - otherwise it is a region broadcast, visible to that region's leads.
 */
export function canSeeTask(
  ctx: AuthContext,
  task: { region: string | null; assignedToUserId: string | null; createdBy: string | null },
): boolean {
  if (ctx.isAdmin) return true;
  if (task.createdBy === ctx.userId || task.assignedToUserId === ctx.userId) return true;
  if (task.assignedToUserId) return false;
  if (task.region === null) return true;
  return canAccessRegion(ctx, task.region);
}

/**
 * Whether a resident submitted the record in question.
 *
 * `submittedBy` stores the submitter's email address, not their user ID — the
 * two are different values and comparing against the wrong one silently
 * disables the check rather than failing loudly. Compared case-insensitively
 * because email case is not meaningful and an identity provider may return a
 * different case than the one originally stored.
 */
export function ownsRecord(ctx: AuthContext, submittedBy: string | null | undefined): boolean {
  const email = ctx.user.email;
  if (!email || !submittedBy) return false;
  return submittedBy.trim().toLowerCase() === email.trim().toLowerCase();
}

/**
 * The address of the house a resident's account is linked to, or null when
 * there is nothing to resolve: a staff account, an account nobody has linked
 * to a property yet, or a link whose property has since been deleted. Every
 * null fails closed — the caller simply gets no house claim.
 *
 * Resolved on demand rather than in loadAuthContext because only the
 * maintenance read paths need it, and loading it for every request on every
 * route would cost a property lookup per API call.
 */
export async function residentHouseAddress(ctx: AuthContext): Promise<string | null> {
  if (!ctx.isResident) return null;
  const propertyId = ctx.user.propertyId;
  if (!propertyId) return null;
  const property = await storage.getProperty(propertyId);
  return property?.address ?? null;
}

/**
 * Whether a request was filed for the resident's own house.
 *
 * Both sides are copies of the same canonical string: `properties.address` is
 * computed server-side and unique, the roster's buildingAddress is copied from
 * it, and a request's buildingAddress is copied from one of those in turn. So
 * the comparison is exact — deliberately not case-folded or trimmed, unlike
 * ownsRecord's email match. The address column's uniqueness is only
 * case-sensitive, so "123 Main St" and "123 MAIN ST" can be two different
 * properties; a folded comparison would let one house read the other's
 * history, whereas drift between two copies of the same house's address
 * merely fails closed.
 */
function isOwnHouse(
  residentHouse: string | null,
  buildingAddress: string | null | undefined,
): boolean {
  if (!residentHouse || !buildingAddress) return false;
  return buildingAddress === residentHouse;
}

/**
 * The read rule for a maintenance request, which is the one place where the
 * resident and staff rules diverge:
 *
 *   - a resident may read requests they submitted, regardless of region, and
 *     requests filed for the house their account is linked to — the two
 *     resident accounts on a property (steward and household leader) share
 *     one repair history
 *   - everyone else is bound by their allowed regions
 *
 * `residentHouse` is the caller's house from residentHouseAddress, resolved
 * once by the route rather than per record. It defaults to null — no house
 * claim — so a call site that never passes it keeps the old email-only
 * behaviour rather than silently widening.
 */
export function canReadMaintenanceRequest(
  ctx: AuthContext,
  request: { region?: string | null; submittedBy?: string | null; buildingAddress?: string | null },
  residentHouse: string | null = null,
): boolean {
  if (ctx.isAdmin) return true;
  if (ctx.isResident) {
    return (
      ownsRecord(ctx, request.submittedBy) ||
      isOwnHouse(residentHouse, request.buildingAddress)
    );
  }
  return canAccessRegion(ctx, request.region);
}

/**
 * Whether the user may read the file a record displays.
 *
 * The rule is that a file inherits the visibility of the record pointing at it:
 * if you are entitled to see the maintenance request, you are entitled to see
 * its photo. Anything else would either hide a photo from someone looking at
 * the record it belongs to, or invent a second, separate rule to keep in step
 * with the first.
 */
export async function canReadUploadReference(
  ctx: AuthContext,
  reference: UploadReference,
): Promise<boolean> {
  switch (reference.kind) {
    case "maintenanceRequest":
      // The photo inherits the request's visibility, house match included:
      // a housemate who can open the request can see the photo on it.
      return canReadMaintenanceRequest(ctx, reference.record, await residentHouseAddress(ctx));

    case "maintenanceRequestPhoto": {
      // A request photo inherits the request's visibility: the resident who
      // submitted it or their housemate, or staff in the request's region. A
      // missing request resolves to no access.
      const request = await storage.getMaintenanceRequest(reference.record.requestId);
      return !!request && canReadMaintenanceRequest(ctx, request, await residentHouseAddress(ctx));
    }

    case "walkthroughPhoto":
      return (
        !ctx.isResident &&
        hasPermission(ctx, "canViewWalkthroughs", "canManageWalkthroughs") &&
        canAccessRegion(ctx, reference.record.region)
      );

    case "assetPhoto": {
      if (ctx.isResident) return false;
      if (!hasPermission(ctx, "canViewAssets", "canManageAssets")) return false;
      // A photo carries no region of its own; it inherits the asset's. A
      // missing asset resolves to no region, which canAccessRegion denies.
      const asset = await storage.getAsset(reference.record.assetId);
      return canAccessRegion(ctx, asset?.region);
    }

    case "billingRecord":
      return (
        !ctx.isResident &&
        hasPermission(ctx, "canViewBilling", "canManageBilling") &&
        canAccessRegion(ctx, reference.record.region)
      );
  }
}

/**
 * Whether the user may download a stored file.
 *
 * A file inherits the visibility of whatever record points at it. The one
 * exception is a file nothing points at yet: uploading happens before the
 * record that will display it is saved, so for that window the uploader is the
 * only possible claim, and without it the preview shown while filling in the
 * form would be refused.
 *
 * That exception ends the moment a record references the file. Otherwise
 * uploading would grant permanent personal access to a document: the uploader
 * would keep reading a vendor's tax form after losing billing permission,
 * after being moved out of the region, or after being demoted to a resident.
 * Access has to follow the record, not the person who happened to attach it.
 */
export async function canReadUpload(
  ctx: AuthContext,
  storageKey: string,
  upload: Upload | undefined,
): Promise<boolean> {
  if (ctx.isAdmin) return true;

  const references = await storage.findUploadReferences(`/uploads/${storageKey}`);

  if (references.length === 0) {
    return upload?.uploadedBy === ctx.userId;
  }

  for (const reference of references) {
    if (await canReadUploadReference(ctx, reference)) {
      return true;
    }
  }
  return false;
}

/** `canReadMaintenanceRequest`, but sends 403 and returns false. */
export function requireMaintenanceRequestAccess(
  res: Response,
  ctx: AuthContext,
  request: { region?: string | null; submittedBy?: string | null; buildingAddress?: string | null },
  residentHouse: string | null = null,
): boolean {
  if (canReadMaintenanceRequest(ctx, request, residentHouse)) return true;
  res.status(403).json({ message: "Forbidden" });
  return false;
}
